import { UnrealAssetOpenError, type OpenUnrealAssetInput } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { executeUnrealPython } from "./unrealPythonRemote.ts";
const OpenReply = Schema.Struct({
  reason: Schema.Union([UnrealAssetOpenError.fields.reason, Schema.Literal("opened")]),
});
const decodeOpenReply = Schema.decodeUnknownEffect(Schema.fromJsonString(OpenReply));

const readOptionalConfig = Effect.fn("unrealAsset.readOptionalConfig")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
    }),
  );
});

function pythonSettings(
  config: string,
  fallback: { group: string; port: number; enabled: boolean },
): { group: string; port: number; enabled: boolean } {
  let active = false;
  const result = { ...fallback };
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("["))
      active = line.toLowerCase() === "[/script/pythonscriptplugin.pythonscriptpluginsettings]";
    if (!active) continue;
    const match =
      /^RemoteExecutionMulticastGroupEndpoint\s*=\s*"?([\d.]+):(\d+)"?\s*(?:;.*)?$/i.exec(line);
    if (match) {
      result.group = match[1]!;
      result.port = Number(match[2]);
    }
    const enabled = /^bRemoteExecution\s*=\s*(True|False)\s*(?:;.*)?$/i.exec(line);
    if (enabled) result.enabled = enabled[1]!.toLowerCase() === "true";
  }
  return result;
}

const resolveAsset = Effect.fn("unrealAsset.resolveAsset")(function* (input: OpenUnrealAssetInput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (
    !path.isAbsolute(input.path) ||
    !/\.(uasset|umap)$/i.test(input.path) ||
    /[\u0000-\u001f]/.test(input.path)
  ) {
    return yield* new UnrealAssetOpenError({ reason: "invalid-path" });
  }
  const file = yield* fs.realPath(input.path);
  if ((yield* fs.stat(file)).type !== "File")
    return yield* new UnrealAssetOpenError({ reason: "invalid-path" });
  let directory = path.dirname(file);
  let pluginRoot: string | undefined;
  let pluginName: string | undefined;
  let contentRoot: string | undefined;
  while (true) {
    const entries = yield* fs.readDirectory(directory);
    const projects = entries.filter((name) => name.toLowerCase().endsWith(".uproject"));
    if (projects.length > 1)
      return yield* new UnrealAssetOpenError({ reason: "project-not-found" });
    if (projects.length === 1) {
      const projectFile = path.join(directory, projects[0]!);
      const gameContent = path.join(directory, "Content");
      const pluginsRoot = path.join(directory, "Plugins");
      const inside = (root: string, candidate: string) => {
        const relative = path.relative(root, candidate);
        return (
          relative !== "" &&
          !path.isAbsolute(relative) &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`)
        );
      };
      const mountedPlugin =
        pluginRoot !== undefined &&
        contentRoot !== undefined &&
        inside(pluginsRoot, pluginRoot) &&
        inside(contentRoot, file);
      const root = mountedPlugin ? contentRoot! : gameContent;
      if (!inside(root, file)) return yield* new UnrealAssetOpenError({ reason: "invalid-path" });
      const assetPath = `${mountedPlugin ? `/${pluginName}` : "/Game"}/${path
        .relative(root, file)
        .replaceAll("\\", "/")
        .replace(/\.(uasset|umap)$/i, "")}`;
      let remote = pythonSettings(
        yield* readOptionalConfig(path.join(directory, "Config", "DefaultEngine.ini")),
        { group: "239.0.0.1", port: 6766, enabled: true },
      );
      const platform = yield* HostProcess.Platform;
      const platformFolder =
        platform === "win32"
          ? "WindowsEditor"
          : platform === "darwin"
            ? "MacEditor"
            : "LinuxEditor";
      remote = pythonSettings(
        yield* readOptionalConfig(
          path.join(directory, "Saved", "Config", platformFolder, "Engine.ini"),
        ),
        remote,
      );
      const octets = remote.group.split(".").map(Number);
      if (
        !remote.enabled ||
        !Number.isInteger(remote.port) ||
        remote.port < 1024 ||
        remote.port > 65535 ||
        octets.length !== 4 ||
        octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255) ||
        octets[0]! < 224 ||
        octets[0]! > 239
      )
        return yield* new UnrealAssetOpenError({ reason: "editor-unavailable" });
      return {
        projectFile,
        projectRoot: directory,
        assetPath,
        file,
        ...remote,
        caseInsensitive: platform === "win32",
      };
    }
    const plugins = entries.filter((name) => name.toLowerCase().endsWith(".uplugin"));
    if (plugins.length === 1 && contentRoot !== undefined) {
      pluginRoot = directory;
      pluginName = plugins[0]!.slice(0, -".uplugin".length);
    }
    if (path.basename(directory).toLowerCase() === "content") contentRoot = directory;
    const parent = path.dirname(directory);
    if (parent === directory)
      return yield* new UnrealAssetOpenError({ reason: "project-not-found" });
    directory = parent;
  }
});

function openAssetCommand(asset: { projectFile: string; assetPath: string; file: string }): string {
  const payload = JSON.stringify(JSON.stringify(asset));
  return `import json, os, unreal
def _t3_open_asset():
    request = json.loads(${payload})
    if not hasattr(unreal, 'EditorAssetLibrary'):
        return {'reason': 'editor-unavailable'}
    canonical = lambda p: os.path.normcase(os.path.realpath(unreal.Paths.convert_relative_path_to_full(p)))
    if canonical(unreal.Paths.get_project_file_path()) != canonical(request['projectFile']):
        return {'reason': 'project-mismatch'}
    asset_path = request['assetPath']
    if not unreal.EditorAssetLibrary.does_asset_exist(asset_path):
        return {'reason': 'asset-not-found'}
    if request['file'].lower().endswith('.umap'):
        editor = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)
        if editor.get_game_world() or unreal.EditorLoadingAndSavingUtils.get_dirty_map_packages():
            return {'reason': 'map-busy'}
    asset = unreal.EditorAssetLibrary.load_asset(asset_path)
    if not asset:
        return {'reason': 'asset-not-found'}
    unreal.EditorAssetLibrary.sync_browser_to_objects([asset.get_path_name()])
    opened = unreal.get_editor_subsystem(unreal.AssetEditorSubsystem).open_editor_for_assets([asset])
    return {'reason': 'opened' if opened else 'open-failed'}
try:
    print('T3_UNREAL_ASSET_RESULT ' + json.dumps(_t3_open_asset()))
except Exception:
    print('T3_UNREAL_ASSET_RESULT ' + json.dumps({'reason': 'open-failed'}))
del _t3_open_asset
`;
}

export const openUnrealAsset = Effect.fn("externalLauncher.openUnrealAsset")(
  function* (input: OpenUnrealAssetInput) {
    const asset = yield* resolveAsset(input).pipe(
      Effect.catchTags({
        PlatformError: () => Effect.fail(new UnrealAssetOpenError({ reason: "invalid-path" })),
      }),
    );
    const python = yield* executeUnrealPython({ ...asset, command: openAssetCommand(asset) });
    if (!python.success) return yield* new UnrealAssetOpenError({ reason: "open-failed" });
    const marker = "T3_UNREAL_ASSET_RESULT ";
    const result = python.output
      .flatMap((item) => item.output.split(/\r?\n/))
      .find((line) => line.startsWith(marker));
    const opened = yield* decodeOpenReply(result?.slice(marker.length)).pipe(
      Effect.mapError(() => new UnrealAssetOpenError({ reason: "open-failed" })),
    );
    if (opened.reason !== "opened")
      return yield* new UnrealAssetOpenError({ reason: opened.reason });
  },
  Effect.timeout("15 seconds"),
  Effect.catchTags({
    TimeoutError: () => Effect.fail(new UnrealAssetOpenError({ reason: "editor-unavailable" })),
  }),
);
