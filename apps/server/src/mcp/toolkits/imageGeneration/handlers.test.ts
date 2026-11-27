import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ImageGenerators from "../../../imageGeneration/ImageGenerators.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as ImageHandlers from "./handlers.ts";
import { ImageGenerationToolkit } from "./tools.ts";

const ID = ProviderInstanceId.make("images");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("images-test"),
  requestNamespace: "images-test",
  thread: {
    threadId: ThreadId.make("images-test"),
    providerSessionId: "images-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "images-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "images-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("advertises configured image APIs and returns generated file metadata through MCP", () =>
  Effect.gen(function* () {
    const result = {
      generatorId: ID,
      model: "image-model",
      path: "/server/generated-images/image.png",
      mimeType: "image/png" as const,
      width: 1,
      height: 1,
      sizeBytes: 10,
    };
    const server = yield* McpServer.McpServer;
    expect(server.tools.map(({ tool }) => tool.name)).toContain("generate_image");
    const list = yield* server
      .callTool({ name: "list_image_generators", arguments: { enabledOnly: true } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(list.isError).not.toBe(true);
    expect(list.structuredContent).toEqual({
      generators: [
        { id: ID, label: "Images", enabled: true, baseUrl: "https://images.example/v1" },
      ],
    });
    const generated = yield* server
      .callTool({
        name: "generate_image",
        arguments: { generatorId: ID, model: "image-model", prompt: "A boat." },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(generated.isError).not.toBe(true);
    expect(generated.structuredContent).toEqual(result);
  }).pipe(
    Effect.provide(
      McpHttpServer.toolkitRegistration(ImageGenerationToolkit, ImageHandlers.layer).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(liveThreadsLayer),
        Layer.provide(Layer.succeed(McpInvocationContext.McpInvocationContext, scope)),
        Layer.provide(Layer.succeed(McpSchema.McpServerClient, client)),
        Layer.provide(
          Layer.mock(ImageGenerators.ImageGenerators)({
            list: (input) =>
              Effect.succeed({
                generators: [
                  { id: ID, label: "Images", enabled: true, baseUrl: "https://images.example/v1" },
                  {
                    id: ProviderInstanceId.make("off"),
                    label: "Off",
                    enabled: false,
                    baseUrl: "https://off.example",
                  },
                ].filter((entry) => input?.enabledOnly !== true || entry.enabled),
              }),
            generate: (input) =>
              Effect.succeed({
                generatorId: input.generatorId,
                model: input.model,
                path: "/server/generated-images/image.png",
                mimeType: "image/png",
                width: 1,
                height: 1,
                sizeBytes: 10,
              }),
          }),
        ),
      ),
    ),
  ),
);

it.effect(
  "refuses image generation from an outside client even if it calls the hidden tool directly",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "generate_image",
          arguments: { generatorId: ID, model: "image-model", prompt: "A boat." },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            ...scope,
            thread: undefined,
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(result).toMatchObject({ code: -32602 });
    }).pipe(
      Effect.provide(
        McpHttpServer.toolkitRegistration(ImageGenerationToolkit, ImageHandlers.layer).pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(liveThreadsLayer),
          Layer.provide(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              ...scope,
              thread: undefined,
            }),
          ),
          Layer.provide(Layer.succeed(McpSchema.McpServerClient, client)),
          Layer.provide(
            Layer.mock(ImageGenerators.ImageGenerators)({
              generate: () => Effect.die("An outside caller must not spend this API's credit"),
            }),
          ),
        ),
      ),
    ),
);
