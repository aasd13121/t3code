import {
  type EnvironmentId,
  ImageGeneratorConfig,
  isSecretReference,
  type ProviderInstanceId,
  type SecretReference,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { MoreVertical, PlusIcon } from "lucide-react";
import { useState } from "react";
import { T, useGT, Var } from "gt-react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const decodeImageGenerator = Schema.decodeUnknownOption(ImageGeneratorConfig);
type Saved = { readonly id: ProviderInstanceId; readonly config: ImageGeneratorConfig };

export function ImageGeneratorsSettings({
  environmentId,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
}) {
  const setting = useSearchableSetting();
  const gt = useGT();
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [editing, setEditing] = useState<Saved | "new" | null>(null);
  const [removing, setRemoving] = useState<ProviderInstanceId | null>(null);
  const entries = Object.entries(settings.imageGenerators) as Array<
    [ProviderInstanceId, ImageGeneratorConfig]
  >;
  const nextId = (() => {
    const existingIds = new Set(Object.keys(settings.imageGenerators));
    let id = "image-api";
    let suffix = 2;
    while (existingIds.has(id)) id = `image-api-${suffix++}`;
    return id as ProviderInstanceId;
  })();
  const removingConfig = removing === null ? undefined : settings.imageGenerators[removing];

  return (
    <>
      <SettingsSection
        {...setting("image-generators")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setEditing("new")}>
              <PlusIcon className="size-3" aria-hidden />
              <T>Add API</T>
            </Button>
          ) : null
        }
      >
        {entries.length === 0 ? (
          <SettingsRow
            title={gt("No image APIs yet")}
            description={gt("Save image generation API URLs and keys for this environment.")}
          />
        ) : null}
        {entries.map(([id, config]) => {
          const name = config.label ?? new URL(config.baseUrl).host;
          return (
            <SettingsRow
              key={id}
              title={name}
              description={
                <span className="block truncate">
                  {config.enabled ? "" : `${gt("Off")} · `}
                  {config.baseUrl}
                </span>
              }
              control={
                readOnly ? null : (
                  <div className="flex items-center gap-2">
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="ghost-muted"
                            aria-label={gt("More actions for {name}", { name })}
                          />
                        }
                      >
                        <MoreVertical />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuItem onClick={() => setEditing({ id, config })}>
                          <T>Edit</T>
                        </MenuItem>
                        <MenuItem variant="destructive" onClick={() => setRemoving(id)}>
                          <T>Remove</T>
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                    <Switch
                      checked={config.enabled}
                      onCheckedChange={(enabled) =>
                        updateSettings({ imageGenerators: { [id]: { ...config, enabled } } })
                      }
                      aria-label={gt("Enable {name}", { name })}
                    />
                  </div>
                )
              }
            />
          );
        })}
      </SettingsSection>
      {editing !== null ? (
        <ImageGeneratorDialog
          environmentId={environmentId}
          editing={editing}
          newId={nextId}
          onClose={() => setEditing(null)}
          onSave={(id, config) => {
            updateSettings({ imageGenerators: { [id]: config } });
            setEditing(null);
          }}
        />
      ) : null}
      <AlertDialog
        open={removingConfig !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Remove <Var>{removingConfig?.label ?? removingConfig?.baseUrl ?? ""}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>This deletes the API key stored on this environment.</T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing !== null) updateSettings({ imageGenerators: { [removing]: null } });
                setRemoving(null);
              }}
            >
              <T>Remove</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function ImageGeneratorDialog({
  environmentId,
  editing,
  newId,
  onClose,
  onSave,
}: {
  readonly environmentId: EnvironmentId;
  readonly editing: Saved | "new";
  readonly newId: ProviderInstanceId;
  readonly onClose: () => void;
  readonly onSave: (id: ProviderInstanceId, config: ImageGeneratorConfig) => void;
}) {
  const gt = useGT();
  const existing = editing === "new" ? null : editing;
  const secretSources = useSecretSources(environmentId);
  const [id, setId] = useState<ProviderInstanceId>(existing?.id ?? newId);
  const [label, setLabel] = useState(existing?.config.label ?? "");
  const [baseUrl, setBaseUrl] = useState(existing?.config.baseUrl ?? "");
  const storedKey = typeof existing?.config.apiKey === "string" ? existing.config.apiKey : "";
  const [keyDraft, setKeyDraft] = useState<string | SecretReference>(
    isSecretReference(existing?.config.apiKey) ? existing.config.apiKey : "",
  );
  const config = decodeImageGenerator({
    ...(label.trim() ? { label: label.trim() } : {}),
    baseUrl: baseUrl.trim(),
    apiKey: typeof keyDraft === "string" ? keyDraft.trim() || storedKey : keyDraft,
    enabled: existing?.config.enabled ?? true,
  });
  const valid = Option.isSome(config) && id.trim().length > 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{existing ? gt("Edit image API") : gt("Add image API")}</DialogTitle>
          <DialogDescription>
            {gt("Save an image generation API endpoint and key on this environment.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid && Option.isSome(config))
                onSave(id.trim() as ProviderInstanceId, config.value);
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="image-generator-id">
                <T>Identifier</T>
              </Label>
              <Input
                id="image-generator-id"
                value={id}
                disabled={existing !== null}
                onChange={(event) => setId(event.target.value as ProviderInstanceId)}
                placeholder="my-image-api"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="image-generator-url">
                <T>API URL</T>
              </Label>
              <Input
                id="image-generator-url"
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://api.example.com/v1/images/generations"
                spellCheck={false}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="image-generator-key">
                <T>API key (optional)</T>
              </Label>
              <SecretSourceInput
                id="image-generator-key"
                aria-label={gt("API key")}
                value={keyDraft}
                configured={storedKey !== ""}
                sources={secretSources}
                onChange={(event) => setKeyDraft(event.target.value)}
                onSecretChange={(secret) => setKeyDraft(secret ?? "")}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="image-generator-label">
                <T>Name (optional)</T>
              </Label>
              <Input
                id="image-generator-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={gt("e.g. Image service")}
              />
            </div>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              if (valid && Option.isSome(config))
                onSave(id.trim() as ProviderInstanceId, config.value);
            }}
          >
            <T>Save</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
