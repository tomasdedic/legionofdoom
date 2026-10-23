// Load pi's own ~/.pi/agent/models.json so `--model trask/general` names the same endpoint here as in pi.
//
// What you write there is honored verbatim — but you usually do not have to write it: on boot we ask the
// endpoint (`GET <baseUrl>/models`) and take its `max_input_tokens`/`max_output_tokens` as contextWindow/maxTokens.
// A models.json value always wins over the report, so `contextWindow: 128000` there is what you get; delete it
// and the endpoint's own answer (1M for trask/general) is what you get. An unreachable endpoint falls back to
// pi's defaults and says so at boot.
// `apiKey` must be "$ENV_NAME" (a key stored in auth.json under the same provider id wins over the env).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { envApiKeyAuth } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";

export const PI_MODELS_JSON = join(homedir(), ".pi/agent/models.json");

const STREAM_APIS = {
  "openai-completions": openAICompletionsApi,
  "anthropic-messages": anthropicMessagesApi,
};

// pi's provider-composer defaults, kept here so a one-line `{"id": "general"}` still behaves like it does in pi.
const MODEL_DEFAULTS = {
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 16384,
};

// What the endpoint reports about itself, when it reports anything. OpenAI-compatible /models listings carry
// max_input_tokens/max_output_tokens on many gateways, and those numbers beat anything hand-typed in a config.
// One request per provider, serially: an unreachable endpoint costs its timeout at boot, no more.
async function listedLimits(baseUrl, key, id, log) {
  let body;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      log.error(`  ${id}: /models returned HTTP ${res.status} — using the numbers in models.json`);
      return new Map();
    }
    body = await res.json();
  } catch (error) {
    log.error(`  ${id}: /models unreachable (${error.message}) — using the numbers in models.json`);
    return new Map();
  }
  return new Map((body?.data ?? []).filter((d) => d?.id).map((d) => [d.id, d]));
}

export async function piCustomProviders(file = PI_MODELS_JSON, log = console) {
  if (!existsSync(file)) return [];
  let providers = {};
  try {
    providers = JSON.parse(readFileSync(file, "utf8")).providers ?? {};
  } catch (error) {
    log.error(`  skip ${file}: ${error.message}`);
    return [];
  }
  const out = [];
  for (const [id, cfg] of Object.entries(providers)) {
    const api = cfg.api ?? "openai-completions";
    const impl = STREAM_APIS[api];
    if (!impl) {
      log.error(`  skip models.json ${id}: no ${api} stream impl wired`);
      continue;
    }
    if (!cfg.baseUrl) {
      log.error(`  skip models.json ${id}: baseUrl required`);
      continue;
    }
    const envName = String(cfg.apiKey ?? "").replace(/^\$\{?/, "").replace(/\}$/, "");
    const key = cfg.unauthorized ? undefined : envName && process.env[envName];
    const limits = await listedLimits(cfg.baseUrl, key, id, log);
    out.push(
      createProvider({
        id,
        name: cfg.name ?? id,
        baseUrl: cfg.baseUrl,
        auth: {
          apiKey: envApiKeyAuth(`${id} API key`, [envName].filter(Boolean)),
        },
        api: impl(),
        models: (cfg.models ?? []).flatMap((m) => {
          const reported = limits.get(m.id) ?? {};
          if (reported.mode && reported.mode !== "chat") {
            log.error(`  skip models.json ${id}/${m.id}: endpoint calls it a ${reported.mode} model`);
            return [];
          }
          if (m.type && m.type !== "chat") {
            log.error(`  skip models.json ${id}/${m.id}: type ${m.type} is not a chat model`);
            return [];
          }
          // Declared in models.json wins; otherwise take what the endpoint says; otherwise pi's defaults.
          const filled = {
            ...MODEL_DEFAULTS,
            contextWindow: reported.max_input_tokens ?? MODEL_DEFAULTS.contextWindow,
            maxTokens: reported.max_output_tokens ?? MODEL_DEFAULTS.maxTokens,
          };
          return [{ ...filled, ...m, api: m.api ?? api, provider: id, baseUrl: m.baseUrl ?? cfg.baseUrl, headers: m.headers ?? cfg.headers }];
        }),
      }),
    );
  }
  return out;
}
