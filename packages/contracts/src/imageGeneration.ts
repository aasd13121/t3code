import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ListImageGeneratorsInput = Schema.Struct({
  enabledOnly: Schema.optionalKey(Schema.Boolean),
  generatorId: Schema.optionalKey(ProviderInstanceId),
});
export type ListImageGeneratorsInput = typeof ListImageGeneratorsInput.Type;

export const ImageGeneratorListResult = Schema.Struct({
  generators: Schema.Array(
    Schema.Struct({
      id: ProviderInstanceId,
      label: Schema.String,
      baseUrl: Schema.String,
      enabled: Schema.Boolean,
    }),
  ),
  models: Schema.optionalKey(
    Schema.Struct({
      generatorId: ProviderInstanceId,
      ids: Schema.Array(Schema.String),
      capabilitiesVerified: Schema.Literal(false),
    }),
  ),
});
export type ImageGeneratorListResult = typeof ImageGeneratorListResult.Type;

export const GenerateImageInput = Schema.Struct({
  generatorId: ProviderInstanceId,
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(16000)),
  size: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(40))),
  quality: Schema.optionalKey(Schema.Literals(["auto", "low", "medium", "high", "standard", "hd"])),
});
export type GenerateImageInput = typeof GenerateImageInput.Type;

export const GeneratedImageResult = Schema.Struct({
  generatorId: ProviderInstanceId,
  model: Schema.String,
  path: Schema.String,
  mimeType: Schema.Literals(["image/png", "image/jpeg", "image/webp"]),
  sizeBytes: PositiveInt,
  width: PositiveInt,
  height: PositiveInt,
});
export type GeneratedImageResult = typeof GeneratedImageResult.Type;

export class ImageGenerationError extends Schema.TaggedError<ImageGenerationError>()(
  "ImageGenerationError",
  {
    reason: Schema.Literals([
      "settings_unavailable",
      "not_found",
      "disabled",
      "secret_unavailable",
      "invalid_endpoint",
      "invalid_request",
      "request_failed",
      "http_error",
      "invalid_response",
      "models_unavailable",
      "response_too_large",
      "write_failed",
      "timeout",
    ]),
    status: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "settings_unavailable":
        return "Could not read image generator settings.";
      case "not_found":
        return "That image generator does not exist. Call list_image_generators first.";
      case "disabled":
        return "That image generator is disabled. Enable it in Settings → Providers.";
      case "secret_unavailable":
        return "The image generator's API key could not be read.";
      case "invalid_endpoint":
        return "The image generator or returned image URL is invalid.";
      case "invalid_request":
        return "Image generation requires a configured generator, an explicit model and a prompt.";
      case "request_failed":
        return "The image API could not be reached. Check its URL and connection.";
      case "http_error":
        return `The image API returned HTTP ${this.status}. Check its key, model and parameters.`;
      case "invalid_response":
        return "The image API returned no supported PNG, JPEG or WebP image.";
      case "models_unavailable":
        return "This API does not expose a readable model list. Use an image model ID from its documentation.";
      case "response_too_large":
        return "The image API response exceeded the image size limit.";
      case "write_failed":
        return "The generated image could not be saved.";
      case "timeout":
        return "Image generation timed out. No other provider was tried.";
    }
  }
}
