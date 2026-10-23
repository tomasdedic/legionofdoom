// Runnable check for the models.json loader — no server, no real endpoint:
//   node test/providers.test.mjs
import { defaultProviderAuthContext } from "@earendil-works/pi-ai";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { piCustomProviders } from "../providers.mjs";

process.env.TRASK_API_KEY = "sk-from-env";

const REPORT = {
  data: [
    { id: "general", mode: "chat", max_input_tokens: 1000000, max_output_tokens: 32768 },
    { id: "tuned", mode: "chat", max_input_tokens: 1000000, max_output_tokens: 32768 },
    { id: "embed-text", mode: "embedding", max_input_tokens: 4096 },
  ],
};

let seen;
const load = async (providers, fetchImpl = () => ({ ok: true, json: async () => REPORT })) => {
  const file = join(mkdtempSync(join(tmpdir(), "ranger-providers-")), "models.json");
  writeFileSync(file, JSON.stringify({ providers }));
  const skipped = [];
  seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    seen.push({ url, init });
    return Promise.resolve().then(fetchImpl);
  };
  try {
    return [await piCustomProviders(file, { error: (m) => skipped.push(m) }), skipped];
  } finally {
    globalThis.fetch = real;
  }
};

let failed = 0;
const assert = (what, condition) => {
  if (condition) console.log(`ok: ${what}`);
  else {
    console.error(`FAIL: ${what}`);
    failed = 1;
  }
};

const trask = {
  baseUrl: "https://llm-api.trask.cz/v1",
  api: "openai-completions",
  apiKey: "${TRASK_API_KEY}",
  models: [{ id: "general" }, { id: "tuned", contextWindow: 200000 }, { id: "unlisted" }, { id: "embed-text" }],
};

const [providers, skipped] = await load({
  trask,
  weird: { baseUrl: "https://example.invalid", api: "grpc", models: [{ id: "m" }] },
  nourl: { api: "openai-completions", models: [{ id: "m" }] },
});

assert("only providers it can stream are registered", providers.length === 1);
assert("limits are taken from the endpoint", providers[0].getModels().find((m) => m.id === "general").contextWindow === 1000000);
assert("what you declare beats the endpoint", providers[0].getModels().find((m) => m.id === "tuned").contextWindow === 200000);
assert("max_output_tokens becomes maxTokens", providers[0].getModels().find((m) => m.id === "general").maxTokens === 32768);
assert("a model the endpoint does not list keeps pi's defaults", providers[0].getModels().find((m) => m.id === "unlisted").contextWindow === 128000);
assert("the endpoint's own name for a model is passed through", providers[0].getModels().find((m) => m.id === "general").id === "general");
assert("models the endpoint calls non-chat are skipped, loudly", !providers[0].getModels().some((m) => m.id === "embed-text") && skipped.some((m) => m.includes("embedding")));
assert("unsupported api is skipped, loudly", skipped.some((m) => m.includes("grpc")));
assert("missing baseUrl is skipped, loudly", skipped.some((m) => m.includes("baseUrl")));
assert("the listing is fetched with the resolved key", seen[0]?.url === "https://llm-api.trask.cz/v1/models" && seen[0]?.init?.headers?.authorization === "Bearer sk-from-env");

const auth = await providers[0].auth.apiKey.resolve({ ctx: defaultProviderAuthContext(), signal: new AbortController().signal });
assert("${VAR} and $VAR both name the env key", auth?.auth?.apiKey === "sk-from-env");

const [quiet, quietSkipped] = await load({ trask: { ...trask, apiKey: undefined } }, () => ({ ok: true, json: async () => REPORT }));
assert("a keyless endpoint is still asked, without an auth header", quiet[0].getModels()[0].contextWindow === 1000000 && seen.length === 1 && seen[0].init.headers === undefined);

const [broken, brokenSkipped] = await load({ trask }, () => {
  throw new Error("ECONNREFUSED");
});
assert("an unreachable endpoint falls back instead of failing the boot", broken[0].getModels()[0].contextWindow === 128000 && brokenSkipped.some((m) => m.includes("ECONNREFUSED")));

assert("no models.json is not an error", (await piCustomProviders(join(tmpdir(), "ranger-absent-models.json"), { error: () => {} })).length === 0);

process.exit(failed);
