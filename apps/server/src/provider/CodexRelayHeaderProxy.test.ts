import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { codexBaseUrlOverrideArgs, parseCodexRelayConfig } from "./CodexRelayHeaderProxy.ts";

const relayConfig = `
model_provider = "custom"
model = "gpt-6-astra"

[model_providers.custom]
name = "Sub2API"
base_url = "https://api666.zzzcoding.org"
wire_api = "responses"
`;

describe("parseCodexRelayConfig", () => {
  it("reads the custom provider base_url", () => {
    NodeAssert.deepStrictEqual(parseCodexRelayConfig(relayConfig), {
      providerId: "custom",
      baseUrl: "https://api666.zzzcoding.org",
    });
  });

  it("returns null for the built-in openai provider", () => {
    NodeAssert.equal(parseCodexRelayConfig(`model_provider = "openai"\n`), null);
  });

  it("returns null when model_provider is absent", () => {
    NodeAssert.equal(
      parseCodexRelayConfig(`[model_providers.custom]\nbase_url = "https://x"\n`),
      null,
    );
  });

  it("returns null when the provider section has no base_url", () => {
    NodeAssert.equal(
      parseCodexRelayConfig(`model_provider = "custom"\n[model_providers.custom]\nname = "x"\n`),
      null,
    );
  });
});

describe("codexBaseUrlOverrideArgs", () => {
  it("is empty until the proxy starts", () => {
    NodeAssert.deepStrictEqual(codexBaseUrlOverrideArgs(), []);
  });
});
