// @effect-diagnostics nodeBuiltinImport:off - A tiny loopback HTTP proxy needs node:http/https.
//
// Some Codex relays (e.g. api666) reject T3's codex sessions with
// "This account only allows Codex official clients" because they gate on the
// presence of the `X-Codex-Turn-Metadata` request header. `codex exec` sends it,
// but the `codex app-server` process T3 spawns does not, and it ignores
// `model_providers.*.http_headers`. So T3 runs this loopback proxy, points the
// provider base_url at it via `-c`, and the proxy re-adds the official-client
// headers before forwarding to the real relay.

import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const CODEX_CLIENT_UA =
  "codex_exec/0.170.0 (Windows 10.0.26200; x86_64) dumb (codex_exec; 0.170.0)";

const INJECTED_HEADERS: NodeHttp.OutgoingHttpHeaders = {
  "x-codex-turn-metadata": "{}",
  originator: "codex_exec",
  "user-agent": CODEX_CLIENT_UA,
};

interface RelayOverride {
  readonly args: ReadonlyArray<string>;
}

let override: RelayOverride | null = null;

const isOfficialOpenAiHost = (hostname: string): boolean =>
  hostname === "api.openai.com" ||
  hostname === "chatgpt.com" ||
  hostname.endsWith(".openai.com") ||
  hostname.endsWith(".chatgpt.com");

/**
 * Pulls the active custom provider's base_url out of a codex `config.toml`.
 * Returns null when the provider is the built-in `openai` (nothing to proxy)
 * or the fields are missing/unparseable.
 */
export function parseCodexRelayConfig(
  text: string,
): { readonly providerId: string; readonly baseUrl: string } | null {
  const providerMatch = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(text);
  const providerId = providerMatch?.[1]?.trim();
  if (!providerId || providerId === "openai") return null;

  const escaped = providerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionStart = new RegExp(`^\\s*\\[model_providers\\.${escaped}\\]\\s*$`, "m").exec(text);
  if (!sectionStart || sectionStart.index === undefined) return null;

  const after = text.slice(sectionStart.index + sectionStart[0].length);
  const nextSection = /^\s*\[[^\]]+\]\s*$/m.exec(after);
  const section = nextSection ? after.slice(0, nextSection.index) : after;
  const baseMatch = /^\s*base_url\s*=\s*"([^"]+)"/m.exec(section);
  const baseUrl = baseMatch?.[1]?.trim();
  if (!baseUrl) return null;
  return { providerId, baseUrl };
}

function startProxy(providerId: string, baseUrl: string): void {
  let target: URL;
  try {
    target = new URL(baseUrl);
  } catch {
    return;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return;
  if (isOfficialOpenAiHost(target.hostname)) return;

  const base = baseUrl.replace(/\/+$/, "");
  const server = NodeHttp.createServer((req, res) => {
    const forwardUrl = base + (req.url ?? "/");
    const headers: NodeHttp.OutgoingHttpHeaders = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];
    delete headers.connection;
    Object.assign(headers, INJECTED_HEADERS);

    const transport =
      target.protocol === "https:" ? (NodeHttps as unknown as typeof NodeHttp) : NodeHttp;
    const upstream = transport.request(forwardUrl, { method: req.method, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => {
      try {
        res.writeHead(502);
        res.end();
      } catch {
        /* client already gone */
      }
    });
    req.pipe(upstream);
  });
  server.on("error", () => {
    override = null;
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (typeof address !== "object" || address === null) return;
    override = {
      args: ["-c", `model_providers.${providerId}.base_url="http://127.0.0.1:${address.port}"`],
    };
  });
  const close = () => {
    try {
      server.close();
    } catch {
      /* already closed */
    }
  };
  process.once("exit", close);
}

/**
 * Starts the loopback relay proxy when the codex provider is a non-official relay.
 * Idempotent and fail-soft; call once at server boot, not at import, so tests
 * never open a port.
 */
export function ensureCodexRelayHeaderProxy(): void {
  if (override !== null || process.env.VITEST || process.env.NODE_ENV === "test") return;
  try {
    const home = process.env.CODEX_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".codex");
    const text = NodeFS.readFileSync(NodePath.join(home, "config.toml"), "utf8");
    const config = parseCodexRelayConfig(text);
    if (!config) return;
    startProxy(config.providerId, config.baseUrl);
  } catch {
    /* no config.toml or unreadable: leave the proxy disabled */
  }
}

/** `-c model_providers.<id>.base_url=...` tokens to append to codex argv, or []. */
export function codexBaseUrlOverrideArgs(): ReadonlyArray<string> {
  return override?.args ?? [];
}
