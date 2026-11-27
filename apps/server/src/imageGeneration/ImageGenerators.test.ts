// @effect-diagnostics nodeBuiltinImport:off -- The URL-response test serves a local HTTP fixture.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ImageGeneratorConfig,
  SecretProviderId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as ImageGenerators from "./ImageGenerators.ts";

const ID = ProviderInstanceId.make("image-api");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7dwAAAAASUVORK5CYII=",
  "base64",
);
const request = {
  generatorId: ID,
  model: "configured-image-model",
  prompt: "A blue boat.",
  size: "1024x1024",
} as const;
const layer = (
  config: Partial<ImageGeneratorConfig> = {},
  resolver?: SecretResolver.SecretResolver["Service"],
  rawSettings?: ImageGeneratorConfig,
) =>
  Layer.effect(ImageGenerators.ImageGenerators, ImageGenerators.make).pipe(
    Layer.provideMerge(
      rawSettings === undefined
        ? Settings.layerTest({
            imageGenerators: { [ID]: { baseUrl: "https://images.example/v1", ...config } },
          })
        : Layer.mock(Settings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              imageGenerators: { [ID]: rawSettings },
            }),
          }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-image-generation-" })),
    Layer.provide(
      Layer.succeed(
        SecretResolver.SecretResolver,
        resolver ?? {
          read: () => Effect.succeed([]),
          invalidate: () => Effect.void,
          label: () => Effect.succeed("Test secrets"),
        },
      ),
    ),
    Layer.provide(FetchHttpClient.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

it.effect.each([
  "https://images.example",
  "https://images.example/v1/",
  "https://images.example/v1/images/generations",
])("generates an image through %s and returns a file without the payload or key", (baseUrl) =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://images.example/v1/images/generations");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer resolved-key");
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: request.model,
        prompt: request.prompt,
        n: 1,
        size: request.size,
      });
      return Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
    });
    const images = yield* ImageGenerators.ImageGenerators;
    const fileSystem = yield* FileSystem.FileSystem;
    const listed = yield* images.list();
    expect(listed.generators).toEqual([
      { id: ID, label: "Images", baseUrl: baseUrl.replace(/\/$/, ""), enabled: true },
    ]);
    const result = yield* images
      .generate(request)
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    expect(result).toMatchObject({
      generatorId: ID,
      model: request.model,
      mimeType: "image/png",
      sizeBytes: PNG.byteLength,
      width: 1,
      height: 1,
    });
    expect(Buffer.from(yield* fileSystem.readFile(result.path))).toEqual(PNG);
    expect(JSON.stringify(result)).not.toContain(PNG.toString("base64"));
    expect(JSON.stringify(listed)).not.toContain("resolved-key");
  }).pipe(
    Effect.provide(
      layer(
        {
          baseUrl,
          label: "Images",
          apiKey: {
            provider: SecretProviderId.make("vault"),
            reference: "images",
          },
        },
        {
          read: () => Effect.succeed(["resolved-key"]),
          invalidate: () => Effect.void,
          label: () => Effect.succeed("Vault"),
        },
      ),
    ),
  ),
);

it.effect.each([
  { config: { enabled: false }, reason: "disabled" },
  {
    config: {},
    input: { ...request, generatorId: ProviderInstanceId.make("missing") },
    reason: "not_found",
  },
  {
    config: {
      apiKey: {
        provider: SecretProviderId.make("vault"),
        reference: "missing",
      },
    },
    reason: "secret_unavailable",
  },
])("does not call or fall back when $reason", ({ config, input, reason }) =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>();
    const images = yield* ImageGenerators.ImageGenerators;
    const failure = yield* Effect.flip(
      images
        .generate(input ?? request)
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
    );
    expect(failure.reason).toBe(reason);
    expect(upstream).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer(config))),
);

it.effect(
  "never includes saved URL credentials, query parameters or fragments in API metadata",
  () =>
    Effect.gen(function* () {
      const images = yield* ImageGenerators.ImageGenerators;
      expect((yield* images.list()).generators[0]?.baseUrl).toBe("https://images.example/v1");
    }).pipe(
      Effect.provide(
        layer({}, undefined, {
          baseUrl: "https://user:password@images.example/v1?key=private#private",
          apiKey: "stored-key",
          enabled: true,
        }),
      ),
    ),
);

it.effect("lists model IDs from the selected API without claiming their image capability", () =>
  Effect.gen(function* () {
    const images = yield* ImageGenerators.ImageGenerators;
    const upstream = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://images.example/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer key");
      return Response.json({
        data: [{ id: "image-model" }, { id: "chat-model" }, { id: "image-model" }],
      });
    });
    const listed = yield* images
      .list({ generatorId: ID })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    expect(listed.models).toEqual({
      generatorId: ID,
      ids: ["chat-model", "image-model"],
      capabilitiesVerified: false,
    });
    upstream.mockResolvedValueOnce(
      Response.json({ error: { message: "private detail" } }, { status: 404 }),
    );
    const failure = yield* Effect.flip(
      images.list({ generatorId: ID }).pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
    );
    expect(failure.reason).toBe("models_unavailable");
    expect(JSON.stringify(failure)).not.toContain("private detail");
  }).pipe(Effect.provide(layer({ apiKey: "key" }))),
);

it.effect("lists Google's native model catalog with a header key and pagination", () =>
  Effect.gen(function* () {
    const images = yield* ImageGenerators.ImageGenerators;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1beta/models");
      expect(url.searchParams.get("key")).toBeNull();
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("google-key");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return url.searchParams.has("pageToken")
        ? Response.json({ models: [{ name: "models/image-model" }] })
        : Response.json({ models: [{ name: "models/chat-model" }], nextPageToken: "page-two" });
    });
    const result = yield* images
      .list({ generatorId: ID })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    expect(result.models).toEqual({
      generatorId: ID,
      ids: ["chat-model", "image-model"],
      capabilitiesVerified: false,
    });
    expect(upstream).toHaveBeenCalledTimes(2);
  }).pipe(
    Effect.provide(
      layer({ baseUrl: "https://generativelanguage.googleapis.com", apiKey: "google-key" }),
    ),
  ),
);

it.effect.each([
  "https://generativelanguage.googleapis.com",
  "https://generativelanguage.googleapis.com/v1beta",
  "https://generativelanguage.googleapis.com/v1beta/models",
])("uses Google's native image protocol for %s", (baseUrl) =>
  Effect.gen(function* () {
    const images = yield* ImageGenerators.ImageGenerators;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1beta/models/image-model:generateContent");
      expect(url.search).toBe("");
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("google-key");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(JSON.parse(String(init?.body))).toEqual({
        contents: [{ parts: [{ text: request.prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { imageSize: "1K" } },
      });
      return Response.json({
        candidates: [
          {
            content: {
              parts: [
                { text: "Image caption" },
                { inlineData: { mimeType: "image/png", data: PNG.toString("base64") } },
              ],
            },
          },
        ],
      });
    });
    const result = yield* images
      .generate({ ...request, model: "models/image-model", size: "1K" })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    expect(result).toMatchObject({
      mimeType: "image/png",
      width: 1,
      height: 1,
      sizeBytes: PNG.byteLength,
    });
    expect(JSON.stringify(result)).not.toContain(PNG.toString("base64"));
    const fileSystem = yield* FileSystem.FileSystem;
    expect(Buffer.from(yield* fileSystem.readFile(result.path))).toEqual(PNG);
  }).pipe(Effect.provide(layer({ baseUrl, apiKey: "google-key" }))),
);

it.effect("reports Google's 429 quota response without retrying or changing providers", () =>
  Effect.gen(function* () {
    const images = yield* ImageGenerators.ImageGenerators;
    const upstream = vi.fn<typeof fetch>(async () =>
      Response.json(
        { error: { code: 429, message: "free quota limit 0; private provider text" } },
        { status: 429 },
      ),
    );
    const failure = yield* Effect.flip(
      images
        .generate({ ...request, size: "auto" })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
    );
    expect(failure).toMatchObject({ reason: "http_error", status: 429 });
    expect(JSON.stringify(failure)).not.toContain("private provider text");
    expect(upstream).toHaveBeenCalledTimes(1);
  }).pipe(
    Effect.provide(
      layer({ baseUrl: "https://generativelanguage.googleapis.com", apiKey: "google-key" }),
    ),
  ),
);

it.effect("refuses OpenAI-only parameters before spending Google API credit", () =>
  Effect.gen(function* () {
    const images = yield* ImageGenerators.ImageGenerators;
    const upstream = vi.fn<typeof fetch>();
    const failure = yield* Effect.flip(
      images.generate(request).pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
    );
    expect(failure.reason).toBe("invalid_request");
    expect(upstream).not.toHaveBeenCalled();
  }).pipe(
    Effect.provide(
      layer({ baseUrl: "https://generativelanguage.googleapis.com", apiKey: "google-key" }),
    ),
  ),
);

it.effect("bounds the response and refuses invalid image bytes or provider error text", () =>
  Effect.gen(function* () {
    const images = yield* ImageGenerators.ImageGenerators;
    for (const [response, reason] of [
      [
        Response.json({ error: { message: "sensitive provider detail" } }, { status: 401 }),
        "http_error",
      ],
      [
        Response.json({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] }),
        "invalid_response",
      ],
      [new Response(new Uint8Array(28 * 1024 * 1024 + 1)), "response_too_large"],
    ] as const) {
      const upstream = vi.fn<typeof fetch>(async () => response);
      const failure = yield* Effect.flip(
        images.generate(request).pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
      );
      expect(failure.reason).toBe(reason);
      expect(JSON.stringify(failure)).not.toContain("sensitive provider detail");
      expect(upstream).toHaveBeenCalledTimes(1);
    }
  }).pipe(Effect.provide(layer())),
);

it.effect.each([
  "file:///etc/passwd",
  "https://user:password@images.example/result.png",
  "http://127.0.0.1/result.png",
  "https://127.0.0.1/result.png",
])("refuses an unsafe image download URL: %s", (url) =>
  Effect.gen(function* () {
    const images = yield* ImageGenerators.ImageGenerators;
    const upstream = vi.fn<typeof fetch>(async () => Response.json({ data: [{ url }] }));
    const failure = yield* Effect.flip(
      images.generate(request).pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
    );
    expect(failure.reason).toBe("invalid_endpoint");
    expect(upstream).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(layer())),
);

it.live("downloads a returned image URL without forwarding the API credential", () =>
  Effect.gen(function* () {
    const requests: Array<{ path: string; authorization: string | undefined }> = [];
    const server = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<NodeHttp.Server>((resolve) => {
            const fixture = NodeHttp.createServer((req, res) => {
              requests.push({ path: req.url ?? "", authorization: req.headers.authorization });
              if (req.url === "/v1/images/generations") {
                const address = fixture.address();
                res.setHeader("content-type", "application/json");
                res.end(
                  JSON.stringify({
                    data: [
                      {
                        url: `http://127.0.0.1:${typeof address === "object" ? address?.port : 0}/result.png?sig=private`,
                      },
                    ],
                  }),
                );
              } else {
                res.setHeader("content-type", "image/png");
                res.end(PNG);
              }
            });
            fixture.listen(0, "127.0.0.1", () => resolve(fixture));
          }),
      ),
      (fixture) =>
        Effect.promise(() => new Promise<void>((resolve) => fixture.close(() => resolve()))),
    );
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === "object" ? address?.port : 0}`;
    const result = yield* ImageGenerators.ImageGenerators.pipe(
      Effect.flatMap((images) => images.generate(request)),
      Effect.provide(layer({ baseUrl, apiKey: "api-key" })),
    );
    expect(result.mimeType).toBe("image/png");
    expect(requests).toEqual([
      { path: "/v1/images/generations", authorization: "Bearer api-key" },
      { path: "/result.png?sig=private", authorization: undefined },
    ]);
    expect(JSON.stringify(result)).not.toContain("sig=private");
  }).pipe(Effect.scoped),
);
