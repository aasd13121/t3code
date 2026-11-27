import * as Effect from "effect/Effect";
import * as ImageGenerators from "../../../imageGeneration/ImageGenerators.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { ImageGenerationToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ImageGenerationToolkit, {
  list_image_generators: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const images = yield* ImageGenerators.ImageGenerators;
      return yield* images.list(input);
    }),
  ),
  generate_image: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const images = yield* ImageGenerators.ImageGenerators;
      return yield* images.generate(input);
    }),
  ),
});
