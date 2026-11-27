import {
  GenerateImageInput,
  type GeneratedImageResult,
  ImageGenerationError,
  type ImageGeneratorListResult,
  type ListImageGeneratorsInput,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import * as ServerConfig from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import * as McpWebhookTransport from "../mcp/McpWebhookTransport.ts";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as ServerSettings from "../serverSettings.ts";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 28 * 1024 * 1024;
const ImageReply = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      b64_json: Schema.optionalKey(Schema.String),
      url: Schema.optionalKey(Schema.String),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
});
const decodeGeneratorId = Schema.decodeSync(GenerateImageInput.fields.generatorId);
const decodeInput = Schema.decodeEffect(GenerateImageInput);
const decodeReply = Schema.decodeEffect(Schema.fromJsonString(ImageReply));
const decodeModels = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Array(Schema.Struct({ id: Schema.String.check(Schema.isMaxLength(200)) })).check(
        Schema.isMaxLength(2000),
      ),
    }),
  ),
);
const decodeGoogleModels = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      models: Schema.Array(
        Schema.Struct({ name: Schema.String.check(Schema.isMaxLength(200)) }),
      ).check(Schema.isMaxLength(2000)),
      nextPageToken: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
    }),
  ),
);
const decodeGoogleReply = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      candidates: Schema.Array(
        Schema.Struct({
          content: Schema.Struct({
            parts: Schema.Array(
              Schema.Struct({
                inlineData: Schema.optionalKey(
                  Schema.Struct({
                    mimeType: Schema.Literals(["image/png", "image/jpeg", "image/webp"]),
                    data: Schema.String,
                  }),
                ),
              }),
            ),
          }),
        }),
      ),
    }),
  ),
);

const isGoogle = (url: URL) => url.hostname === "generativelanguage.googleapis.com";

const authenticate = (
  request: HttpClientRequest.HttpClientRequest,
  apiKey: string,
  google: boolean,
) =>
  !apiKey
    ? request
    : google
      ? HttpClientRequest.setHeader(request, "x-goog-api-key", apiKey)
      : HttpClientRequest.bearerToken(request, apiKey);

export class ImageGenerators extends Context.Service<
  ImageGenerators,
  {
    readonly list: (
      input?: ListImageGeneratorsInput,
    ) => Effect.Effect<ImageGeneratorListResult, ImageGenerationError>;
    readonly generate: (
      input: GenerateImageInput,
    ) => Effect.Effect<GeneratedImageResult, ImageGenerationError>;
  }
>()("t3/imageGeneration/ImageGenerators") {}

const endpoint = (baseUrl: string) => {
  const url = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid image generator URL");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (isGoogle(url)) {
    if (url.protocol !== "https:") throw new Error("Google image APIs require HTTPS");
    const version = /^\/(v1(?:beta|alpha)?)(?:\/|$)/.exec(path)?.[1] ?? "v1beta";
    url.pathname = `/${version}/models`;
    return url;
  }
  url.pathname = path.endsWith("/images/generations")
    ? path
    : path === ""
      ? "/v1/images/generations"
      : `${path}/images/generations`;
  return url;
};

const readBytes = Effect.fn("ImageGenerators.readBytes")(function* (
  response: HttpClientResponse.HttpClientResponse,
  limit: number,
) {
  if (response.status < 200 || response.status >= 300) {
    return yield* new ImageGenerationError({ reason: "http_error", status: response.status });
  }
  let size = 0;
  const chunks = yield* response.stream.pipe(
    Stream.mapEffect((chunk) => {
      size += chunk.byteLength;
      return size > limit
        ? Effect.fail(new ImageGenerationError({ reason: "response_too_large" }))
        : Effect.succeed(chunk);
    }),
    Stream.runCollect,
    Effect.mapError((error) =>
      error._tag === "ImageGenerationError"
        ? error
        : new ImageGenerationError({ reason: "request_failed" }),
    ),
  );
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
});

const execute = Effect.fn("ImageGenerators.execute")(function* (
  request: HttpClientRequest.HttpClientRequest,
) {
  const http = yield* HttpClient.HttpClient;
  return yield* http.execute(request).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.mapError(() => new ImageGenerationError({ reason: "request_failed" })),
  );
});

/** @public */
export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const random = yield* SecureRandom.SecureRandom;
  const http = yield* HttpClient.HttpClient;
  const getSettings = Effect.suspend(() => settings.getSettings).pipe(
    Effect.mapError(() => new ImageGenerationError({ reason: "settings_unavailable" })),
  );
  const list = Effect.fn("ImageGenerators.list")(
    function* (input: ListImageGeneratorsInput = {}) {
      const current = yield* getSettings;
      const generators = Object.entries(current.imageGenerators)
        .filter(([, entry]) => input.enabledOnly !== true || entry.enabled)
        .map(([id, entry]) => {
          let baseUrl = "<invalid>";
          let host = "Image API";
          try {
            const url = new URL(entry.baseUrl);
            if (["http:", "https:"].includes(url.protocol)) {
              url.username = "";
              url.password = "";
              url.search = "";
              url.hash = "";
              baseUrl = url.href.replace(/\/$/, "");
              host = url.host;
            }
          } catch {
            /* A malformed saved URL is never included in model output. */
          }
          return {
            id: decodeGeneratorId(id),
            label: entry.label ?? host,
            baseUrl,
            enabled: entry.enabled,
          };
        });
      if (input.generatorId === undefined) return { generators };
      const generator = current.imageGenerators[input.generatorId];
      if (generator === undefined) return yield* new ImageGenerationError({ reason: "not_found" });
      if (!generator.enabled) return yield* new ImageGenerationError({ reason: "disabled" });
      const url = yield* Effect.try({
        try: () => endpoint(generator.baseUrl),
        catch: () => new ImageGenerationError({ reason: "invalid_endpoint" }),
      });
      url.pathname = url.pathname.replace(/\/images\/generations$/, "/models");
      const apiKey = yield* requireSettingsSecret(secrets, generator.apiKey).pipe(
        Effect.mapError(() => new ImageGenerationError({ reason: "secret_unavailable" })),
      );
      const google = isGoogle(url);
      const ids = new Set<string>();
      let pageToken: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        if (google) {
          url.searchParams.set("pageSize", "1000");
          if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
        }
        const request = authenticate(HttpClientRequest.get(url.href), apiKey, google);
        const bytes = yield* execute(request).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.flatMap((response) => readBytes(response, 1024 * 1024)),
          Effect.mapError((error) =>
            error.status === 404 || error.status === 405
              ? new ImageGenerationError({ reason: "models_unavailable", status: error.status })
              : error,
          ),
        );
        const body = new TextDecoder().decode(bytes);
        if (google) {
          const models = yield* decodeGoogleModels(body).pipe(
            Effect.mapError(() => new ImageGenerationError({ reason: "models_unavailable" })),
          );
          for (const { name } of models.models) {
            const id = name.replace(/^models\//, "").trim();
            if (id) ids.add(id);
          }
          pageToken = models.nextPageToken;
          if (!pageToken) break;
          if (page === 9) return yield* new ImageGenerationError({ reason: "models_unavailable" });
        } else {
          const models = yield* decodeModels(body).pipe(
            Effect.mapError(() => new ImageGenerationError({ reason: "models_unavailable" })),
          );
          for (const { id } of models.data) if (id.trim()) ids.add(id.trim());
          break;
        }
      }
      return {
        generators,
        models: {
          generatorId: input.generatorId,
          ids: [...ids].sort(),
          capabilitiesVerified: false as const,
        },
      };
    },
    Effect.timeoutOrElse({
      duration: "25 seconds",
      orElse: () => Effect.fail(new ImageGenerationError({ reason: "timeout" })),
    }),
  );
  const generate = Effect.fn("ImageGenerators.generate")(
    function* (input: GenerateImageInput) {
      const parsed = yield* decodeInput(input).pipe(
        Effect.mapError(() => new ImageGenerationError({ reason: "invalid_request" })),
      );
      const current = yield* getSettings;
      const generator = current.imageGenerators[parsed.generatorId];
      if (generator === undefined) return yield* new ImageGenerationError({ reason: "not_found" });
      if (!generator.enabled) return yield* new ImageGenerationError({ reason: "disabled" });
      const url = yield* Effect.try({
        try: () => endpoint(generator.baseUrl),
        catch: () => new ImageGenerationError({ reason: "invalid_endpoint" }),
      });
      const apiKey = yield* requireSettingsSecret(secrets, generator.apiKey).pipe(
        Effect.mapError(() => new ImageGenerationError({ reason: "secret_unavailable" })),
      );
      const google = isGoogle(url);
      if (
        google &&
        (parsed.quality !== undefined ||
          (parsed.size !== undefined && !["auto", "1K", "2K", "4K"].includes(parsed.size)))
      ) {
        return yield* new ImageGenerationError({ reason: "invalid_request" });
      }
      if (google)
        url.pathname += `/${encodeURIComponent(parsed.model.replace(/^models\//, ""))}:generateContent`;
      const body = google
        ? {
            contents: [{ parts: [{ text: parsed.prompt }] }],
            generationConfig: {
              responseModalities: ["IMAGE"],
              ...(parsed.size === undefined || parsed.size === "auto"
                ? {}
                : { imageConfig: { imageSize: parsed.size } }),
            },
          }
        : {
            model: parsed.model,
            prompt: parsed.prompt,
            n: 1,
            ...(parsed.size === undefined ? {} : { size: parsed.size }),
            ...(parsed.quality === undefined ? {} : { quality: parsed.quality }),
          };
      const request = authenticate(
        HttpClientRequest.post(url.href).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
        apiKey,
        google,
      );
      const response = yield* execute(request).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const json = yield* readBytes(response, MAX_RESPONSE_BYTES);
      let item: { readonly b64_json?: string; readonly url?: string };
      if (google) {
        const reply = yield* decodeGoogleReply(new TextDecoder().decode(json)).pipe(
          Effect.mapError(() => new ImageGenerationError({ reason: "invalid_response" })),
        );
        const image = reply.candidates.flatMap(({ content }) =>
          content.parts.flatMap(({ inlineData }) => (inlineData === undefined ? [] : [inlineData])),
        )[0];
        if (image === undefined)
          return yield* new ImageGenerationError({ reason: "invalid_response" });
        item = { b64_json: image.data };
      } else {
        const reply = yield* decodeReply(new TextDecoder().decode(json)).pipe(
          Effect.mapError(() => new ImageGenerationError({ reason: "invalid_response" })),
        );
        item = reply.data[0]!;
      }
      let bytes: Uint8Array;
      if (item.b64_json !== undefined) {
        const base64 = parseBase64DataUrl(`data:image/png;base64,${item.b64_json}`);
        if (base64 === null) return yield* new ImageGenerationError({ reason: "invalid_response" });
        bytes = Buffer.from(base64.base64, "base64");
      } else if (item.url !== undefined) {
        const download = yield* Effect.try({
          try: () => new URL(item.url!),
          catch: () => new ImageGenerationError({ reason: "invalid_endpoint" }),
        });
        if (
          download.username ||
          download.password ||
          download.hash ||
          (download.protocol !== "https:" &&
            !(download.protocol === "http:" && download.origin === url.origin))
        ) {
          return yield* new ImageGenerationError({ reason: "invalid_endpoint" });
        }
        // Only the configured host may be private; other returned URLs connect to checked public IPs.
        const transport = McpWebhookTransport.make([url.hostname.replace(/^\[|\]$/g, "")]);
        yield* transport
          .check(download)
          .pipe(Effect.mapError(() => new ImageGenerationError({ reason: "invalid_endpoint" })));
        bytes = yield* execute(HttpClientRequest.get(download.href)).pipe(
          Effect.flatMap((result) => readBytes(result, MAX_IMAGE_BYTES)),
          Effect.provide(transport.layerClient),
        );
      } else return yield* new ImageGenerationError({ reason: "invalid_response" });
      if (bytes.byteLength > MAX_IMAGE_BYTES)
        return yield* new ImageGenerationError({ reason: "response_too_large" });
      const dimensions = readImageDimensions(bytes);
      const format =
        bytes[0] === 0x89 && bytes[1] === 0x50
          ? { extension: "png", mimeType: "image/png" as const }
          : bytes[0] === 0xff && bytes[1] === 0xd8
            ? { extension: "jpg", mimeType: "image/jpeg" as const }
            : bytes[0] === 0x52 && bytes[8] === 0x57
              ? { extension: "webp", mimeType: "image/webp" as const }
              : undefined;
      if (dimensions === null || format === undefined)
        return yield* new ImageGenerationError({ reason: "invalid_response" });
      const directory = path.join(config.stateDir, "generated-images");
      const outputPath = path.join(directory, `${yield* random.uuidV4()}.${format.extension}`);
      yield* fileSystem
        .makeDirectory(directory, { recursive: true })
        .pipe(Effect.mapError(() => new ImageGenerationError({ reason: "write_failed" })));
      yield* fileSystem
        .writeFile(outputPath, bytes, { flag: "wx" })
        .pipe(Effect.mapError(() => new ImageGenerationError({ reason: "write_failed" })));
      return {
        generatorId: parsed.generatorId,
        model: parsed.model,
        path: outputPath,
        mimeType: format.mimeType,
        sizeBytes: bytes.byteLength,
        ...dimensions,
      };
    },
    Effect.timeoutOrElse({
      duration: "5 minutes",
      orElse: () => Effect.fail(new ImageGenerationError({ reason: "timeout" })),
    }),
  );
  return ImageGenerators.of({ list, generate });
});

export const layer = Layer.effect(ImageGenerators, make).pipe(
  Layer.provide([SecretResolverLayer.layer, FetchHttpClient.layer]),
);
