// @effect-diagnostics nodeBuiltinImport:off - a local UDP/TCP fixture exercises Unreal's official wire protocol.
import * as NodeDgram from "node:dgram";
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import { openUnrealAsset } from "./unrealAsset.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-unreal-" });
  const project = path.join(root, "Project 空格 'quoted'");
  yield* fs.makeDirectory(path.join(project, "Content", "Abilities"), { recursive: true });
  yield* fs.writeFileString(path.join(project, "Game.uproject"), "{}");
  const asset = path.join(project, "Content", "Abilities", "Combo2.uasset");
  yield* fs.writeFileString(asset, "");
  return { fs, path, root, project, asset };
});

const editorFixture = (project: string, reason: string, hold = false) =>
  Effect.gen(function* () {
    const commands: string[] = [];
    const commandReceived = Deferred.makeUnsafe<void>();
    const closed = Deferred.makeUnsafe<void>();
    const connections = new Set<NodeNet.Socket>();
    const udp = yield* Effect.acquireRelease(
      Effect.callback<NodeDgram.Socket>((resume) => {
        const socket = NodeDgram.createSocket({ type: "udp4", reuseAddr: true });
        socket.on("error", () => {});
        socket.bind(0, "127.0.0.1", () => {
          socket.setMulticastInterface("127.0.0.1");
          socket.setMulticastTTL(0);
          socket.setMulticastLoopback(true);
          socket.addMembership("239.0.0.1", "127.0.0.1");
          resume(Effect.succeed(socket));
        });
      }),
      (socket) =>
        Effect.callback<void>((resume) => {
          for (const connection of connections) connection.destroy();
          socket.close(() => resume(Effect.void));
        }),
    );
    const port = udp.address().port;
    const send = (payload: unknown) =>
      udp.send(Buffer.from(JSON.stringify(payload)), port, "239.0.0.1");
    udp.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString());
      if (request.source === "fixture-editor" || request.source === "unrelated-editor") return;
      if (request.type === "ping") {
        send({
          version: 1,
          magic: "ue_py",
          type: "pong",
          source: "unrelated-editor",
          dest: request.source,
          data: { project_root: project + "/other" },
        });
        send({
          version: 1,
          magic: "ue_py",
          type: "pong",
          source: "fixture-editor",
          dest: request.source,
          data: { project_root: project + "/" },
        });
      }
      if (request.type === "close_connection" && request.dest === "fixture-editor")
        Deferred.doneUnsafe(closed, Effect.void);
      if (request.type !== "open_connection" || request.dest !== "fixture-editor") return;
      assert.equal(request.data.command_ip, "127.0.0.1");
      const connection = NodeNet.connect(request.data.command_port, request.data.command_ip);
      connections.add(connection);
      connection.on("error", () => {});
      connection.on("close", () => connections.delete(connection));
      let commandBytes = "";
      connection.on("data", (chunk) => {
        commandBytes += chunk.toString();
        let command;
        try {
          command = JSON.parse(commandBytes);
        } catch {
          return;
        }
        assert.equal(command.magic, "ue_py");
        assert.equal(command.type, "command");
        assert.equal(command.dest, "fixture-editor");
        assert.equal(command.data.exec_mode, "ExecuteFile");
        assert.equal(command.data.unattended, true);
        commands.push(command.data.command);
        Deferred.doneUnsafe(commandReceived, Effect.void);
        if (hold) return;
        const reply = Buffer.from(
          JSON.stringify({
            version: 1,
            magic: "ue_py",
            type: "command_result",
            source: "fixture-editor",
            dest: command.source,
            data: {
              success: reason !== "python-error",
              output: [
                { output: "日志".repeat(5000) },
                {
                  output:
                    reason === "bad-result"
                      ? "invalid"
                      : `T3_UNREAL_ASSET_RESULT ${JSON.stringify({ reason })}\r\n`,
                },
              ],
            },
          }),
        );
        // The official TCP protocol can split large replies inside a UTF-8 sequence.
        const split = reply.indexOf(Buffer.from("日志")) + 1;
        connection.write(reply.subarray(0, split), () => connection.end(reply.subarray(split)));
      });
    });
    return { port, commands, commandReceived, closed };
  });

const configure = (f: Effect.Success<typeof fixture>, port: number) =>
  Effect.gen(function* () {
    yield* f.fs.makeDirectory(f.path.join(f.project, "Config"), { recursive: true });
    yield* f.fs.writeFileString(
      f.path.join(f.project, "Config", "DefaultEngine.ini"),
      `[/Script/PythonScriptPlugin.PythonScriptPluginSettings]\nbRemoteExecution=True\nRemoteExecutionMulticastGroupEndpoint=239.0.0.1:${port}\n[Other]\nRemoteExecutionMulticastGroupEndpoint=239.0.0.1:12\n`,
    );
  });

it.live("uses built-in discovery and fragmented TCP replies for project and plugin assets", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const editor = yield* editorFixture(f.project, "opened");
    yield* configure(f, editor.port);
    const plugin = f.path.join(f.project, "Plugins", "Nested", "DifferentFolder");
    yield* f.fs.makeDirectory(f.path.join(plugin, "Content", "Data"), { recursive: true });
    yield* f.fs.writeFileString(f.path.join(plugin, "ActualPlugin.uplugin"), "{}");
    const pluginAsset = f.path.join(plugin, "Content", "Data", "Item.uasset");
    yield* f.fs.writeFileString(pluginAsset, "");
    for (const asset of [f.asset, pluginAsset]) yield* openUnrealAsset({ path: asset });
    const payloads = editor.commands.map((command) => {
      const line = command.split("\n").find((item) => item.includes("request = json.loads("))!;
      return JSON.parse(JSON.parse(line.trim().slice("request = json.loads(".length, -1)));
    });
    assert.deepEqual(
      payloads.map((p) => p.assetPath),
      ["/Game/Abilities/Combo2", "/ActualPlugin/Data/Item"],
    );
    assert.equal(payloads[0].projectFile, f.path.join(f.project, "Game.uproject"));
    assert.include(editor.commands[0]!, "canonical(unreal.Paths.get_project_file_path())");
    yield* Deferred.await(editor.closed);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects invalid paths and disabled remote execution before using the network", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const nonContent = f.path.join(f.project, "Source", "Wrong.uasset");
    yield* f.fs.makeDirectory(f.path.dirname(nonContent));
    yield* f.fs.writeFileString(nonContent, "");
    for (const target of [
      "Content/Relative.uasset",
      f.asset + ".txt",
      nonContent,
      f.path.join(f.project, "Content", "Missing.uasset"),
    ]) {
      assert.equal((yield* Effect.flip(openUnrealAsset({ path: target }))).reason, "invalid-path");
    }
    yield* configure(f, 6766);
    yield* f.fs.writeFileString(
      f.path.join(f.project, "Config", "DefaultEngine.ini"),
      "[/Script/PythonScriptPlugin.PythonScriptPluginSettings]\nbRemoteExecution=False\n",
    );
    assert.equal(
      (yield* Effect.flip(openUnrealAsset({ path: f.asset }))).reason,
      "editor-unavailable",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("preserves editor rejections without exposing arbitrary Python output", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    for (const [reason, expected] of [
      ["project-mismatch", "project-mismatch"],
      ["asset-not-found", "asset-not-found"],
      ["map-busy", "map-busy"],
      ["open-failed", "open-failed"],
      ["python-error", "open-failed"],
      ["bad-result", "open-failed"],
    ]) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const editor = yield* editorFixture(f.project, reason!);
          yield* configure(f, editor.port);
          const error = yield* Effect.flip(openUnrealAsset({ path: f.asset }));
          assert.equal(error.reason, expected);
          assert.notInclude(JSON.stringify(error), "日志");
        }),
      );
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("closes the official command connection when a request is cancelled", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const editor = yield* editorFixture(f.project, "opened", true);
    yield* configure(f, editor.port);
    const running = yield* Effect.forkChild(openUnrealAsset({ path: f.asset }));
    yield* Deferred.await(editor.commandReceived);
    yield* Fiber.interrupt(running);
    yield* Deferred.await(editor.closed);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
