import {
  GenerateImageInput,
  GeneratedImageResult,
  ImageGenerationError,
  ImageGeneratorListResult,
  ListImageGeneratorsInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as ImageGenerators from "../../../imageGeneration/ImageGenerators.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: Schema.Union([ImageGenerationError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    ImageGenerators.ImageGenerators,
  ],
};

const ListImageGeneratorsTool = Tool.make("list_image_generators", {
  ...shared,
  description:
    "Find configured image-generation APIs and enabled state. With generatorId, fetch that API's /models IDs; the list may include chat models and does not verify image support. Choose an image model documented by that API or named by the user, never invent one. Keys stay on the server. Call before generate_image.",
  parameters: ListImageGeneratorsInput,
  success: ImageGeneratorListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const GenerateImageTool = Tool.make("generate_image", {
  ...shared,
  description:
    "Generate one image through a configured OpenAI-compatible Images API or Google's official Gemini API, even when your chat model cannot generate images. Only when the user requests an image. Supply an enabled generatorId from list_image_generators and an explicit API model. Google: size auto/1K/2K/4K, omit quality. May incur the provider's charge; failure never switches providers. Returns a saved absolute path and metadata; show or link that file, never inline base64.",
  parameters: GenerateImageInput,
  success: GeneratedImageResult,
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const ImageGenerationToolkit = Toolkit.make(ListImageGeneratorsTool, GenerateImageTool);
