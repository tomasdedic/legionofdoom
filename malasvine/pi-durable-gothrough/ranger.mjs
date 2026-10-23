#!/usr/bin/env node
// Ranger — the brain. Durable agent host whose hands live somewhere else.
//
//   node ranger.mjs serve                     tools run here (local sandbox)
//   node ranger.mjs serve --ssh outpost       tools run in the outpost (pi-env over ssh)
//   node ranger.mjs probe [--ssh outpost]     run a command through the hands, no model involved
//   node ranger.mjs trust outpost             record the outpost host key once
//
// Storage, model credentials and transcript stay in this process either way.
// Run this same file *inside* the microVM for the agent-in-orb model. See README.md.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import {
  createRegistry,
  defineExtension,
  Harness,
  section,
  watchEvents,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { fileCredentials } from "./credentials.mjs";
import { piCustomProviders } from "./providers.mjs";
import {
  acceptHostKey,
  RemoteExecutionEnv,
  scanHostKey,
  sshConnection,
} from "@earendil-works/pi-env";

const HERE = dirname(fileURLToPath(import.meta.url));
const ctx = BACKGROUND_CONTEXT;

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "serve";
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i < 0 || argv[i + 1] === undefined ? fallback : argv[i + 1];
};

const opts = {
  host: flag("--host", "127.0.0.1"),
  port: Number(flag("--port", 8787)),
  // Outside the checkout on purpose: this file is the only copy of every transcript, so it must not
  // live where `git clean -fdx` or a stray `rm ranger.sqlite*` during a test reaches it.
  db: resolve(flag("--db", join(homedir(), ".ranger", "ranger.sqlite"))),
  cwd: resolve(flag("--cwd", HERE)),
  ssh: flag("--ssh"),
  remoteCwd: flag("--remote-cwd", "/root"),
  model: flag("--model", process.env.RANGER_MODEL),
  knownHosts: resolve(flag("--known-hosts", join(HERE, "outpost.known_hosts"))),
  auth: resolve(flag("--auth", join(homedir(), ".pi/agent/auth.json"))),
  token: flag("--token", process.env.RANGER_TOKEN ?? ""),
  faux: argv.includes("--faux"),
};

// `user@host`, `host`, or `user@host:port` — everything pi-env's ssh connection needs. A bracketed IPv6 keeps
// its address and a bare one is taken as-is, since guessing which colon starts the port is how you SSH to "fe80:".
// `knownHostsFile` is the pin: pi-env refuses a host key that is not in it, and `trust` writes it under a stable alias.
function sshTarget() {
  const at = opts.ssh.lastIndexOf("@");
  const spec = (at < 0 ? opts.ssh : opts.ssh.slice(at + 1)).replace(
    /^\[(.*)\](?::(\d+))?$/,
    (_, host, port) => (port ? `${host}:${port}` : host),
  );
  const parts = /^([^:]+):(\d+)$/.exec(spec);
  const host = parts ? parts[1] : spec;
  return {
    host,
    user: at < 0 ? undefined : opts.ssh.slice(0, at),
    port: parts ? Number(parts[2]) : undefined,
    knownHostsFile: opts.knownHosts,
    hostKeyAlias: `ranger-${host}`,
  };
}

if (cmd === "trust") {
  opts.ssh = argv[1];
  if (!opts.ssh) {
    console.error("usage: node ranger.mjs trust <ssh host>");
    process.exit(2);
  }
  const target = sshTarget();
  try {
    const { lines, fingerprints } = await scanHostKey(target);
    console.log(`accepting ${opts.ssh}:\n${fingerprints.join("\n")}`);
    await acceptHostKey(target, lines);
  } catch (error) {
    console.error(
      `cannot pin ${opts.ssh}: ${String(error.message ?? error).split("\n")[0]}`,
    );
    process.exit(1);
  }
  console.log(`pinned ${target.hostKeyAlias} in ${opts.knownHosts}`);
  process.exit(0);
}

if (cmd !== "serve" && cmd !== "probe") {
  console.error(
    "usage: node ranger.mjs [serve|probe] [--ssh <host>] | node ranger.mjs trust <host>",
  );
  process.exit(2);
}

const models = createModels({ credentials: fileCredentials(opts.auth) });
models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());
models.setProvider(openrouterProvider());
const custom = await piCustomProviders();
for (const provider of custom) models.setProvider(provider);

if (opts.faux) {
  // Scripted model: proves the plumbing (storage, tools, streaming, restart) without a key or network.
  const faux = fauxProvider({ tokensPerSecond: 300 });
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 25 }, () => [
      fauxAssistantMessage(
        [
          fauxToolCall(
            "bash",
            { command: "pwd && ls" },
            { id: `demo-${Math.random().toString(36).slice(2)}` },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([
        fauxText(
          "Listed the directory. (faux model: queue another 25 rounds by restarting)",
        ),
      ]),
    ]).flat(),
  );
}

// Pick --model provider/id, else the first model we have credentials for.
async function pickModel() {
  if (opts.faux) return { provider: "faux", modelId: "faux-1" };
  if (opts.model) {
    const slash = opts.model.indexOf("/");
    return {
      provider: opts.model.slice(0, slash),
      modelId: opts.model.slice(slash + 1),
    };
  }
  for (const provider of ["anthropic", "openai", "openrouter", ...custom.map((p) => p.id)]) {
    const chat = await models.getAvailableOfType("chat", provider);
    const best =
      [...chat]
        .reverse()
        .find((model) => /sonnet|gpt-5|gemini|flash/.test(model.id)) ??
      chat.at(-1);
    if (best) return { provider, modelId: best.id };
  }
  throw new Error(
    "no usable model: export ANTHROPIC_API_KEY / OPENAI_API_KEY, run `pi /login`, or use --model or --faux",
  );
}

// Brain/hands: one remote connection for every tool call; the outpost daemon starts on first use.
const where = opts.ssh
  ? `the outpost ${opts.ssh} (cwd ${opts.remoteCwd})`
  : `a local sandbox (cwd ${opts.cwd})`;
const remote = opts.ssh
  ? new RemoteExecutionEnv({
      connection: sshConnection(sshTarget()).connection,
      id: `ranger:${opts.ssh}`,
      cwd: opts.remoteCwd,
    })
  : undefined;
const envFor = (cwd) =>
  remote ?? new NodeExecutionEnv({ cwd: cwd ?? opts.cwd });

// No model, no server: prove the hands are reachable before you trust them to an agent.
if (cmd === "probe") {
  const env = envFor();
  const run = async (argv) => {
    let out = "";
    const done = await env.exec(
      argv,
      { onOutput: (text) => (out += text) },
      ctx,
    );
    if (!done.ok) throw done.error;
    console.log(
      `$ ${argv.join(" ")}\n  exit ${done.value.exitCode}  ${out.trim().split("\n")[0]?.slice(0, 100) ?? ""}`,
    );
  };
  try {
    await run(["uname", "-a"]);
    await run(["pwd"]);
    const written = await env.writeFile(
      "ranger-probe.txt",
      "from the brain",
      ctx,
    );
    const read =
      written.ok === false
        ? written
        : await env.readTextFile("ranger-probe.txt", ctx);
    console.log(
      `write+read: ${read.ok === true && read.value === "from the brain" ? "ok" : JSON.stringify(read)}`,
    );
    await env.remove("ranger-probe.txt", { force: true }, ctx);
  } catch (error) {
    console.error(
      `hands unreachable: ${String(error.message ?? error).split("\n")[0]}`,
    );
    if (
      opts.ssh &&
      /host key|unknown host|known hosts/i.test(String(error.message))
    ) {
      console.error(`pin it first: node ranger.mjs trust ${opts.ssh}`);
    }
    await env.cleanup(ctx);
    process.exit(1);
  }
  await env.cleanup(ctx);
  process.exit(0);
}

const model = await pickModel();

// ------------------------------------------------------------------- harness
const Ranger = defineExtension({
  name: "ranger",
  sections: [
    section(
      "ranger",
      () => `You are a Ranger worker. Your tools execute in ${where}.`,
      { tag: true },
    ),
  ],
});

const registry = createRegistry();
registry.install(CodingTools);
registry.install(Ranger);

// One brain, one writer: two Rangers on the same store allocate colliding entry ids and submit then fails
// with "ID 7 already belongs to entry". A dead owner's lock is broken; a live one is a hard stop.
function lockDb(db) {
  const lock = `${db}.lock`;
  try {
    writeFileSync(lock, `${process.pid}\n`, { flag: "wx" }); // exclusive create = claimed
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = Number(readFileSync(lock, "utf8").trim());
    let alive = false;
    try {
      process.kill(owner, 0);
      alive = true;
    } catch (error) {
      alive = error.code === "EPERM"; // exists, just not ours to signal
    }
    if (alive && owner !== process.pid) {
      console.error(`${db} is already open in pid ${owner} — start this one with a different --db`);
      process.exit(1);
    }
    writeFileSync(lock, `${process.pid}\n`);
  }
  process.on("exit", () => rmSync(lock, { force: true }));
}

// The brain's store is created on first run; ~ mkdir happens here because the default lives outside the repo.
mkdirSync(dirname(opts.db), { recursive: true });
if (cmd === "serve" || cmd === "probe") lockDb(opts.db);

const harness = await Harness.open(
  await openNodeSqliteStorage(opts.db),
  {
    models,
    registry,
    env: ({ cwd }) => envFor(cwd),
    settings: { compaction: { enabled: true } },
  },
  ctx,
);
harness.resume();
await harness.root(ctx, { agent: { model } });

// ponytail: a read taken on the mutation line; fine for one host and tens of conversations.
const listConversations = async () => {
  const page = await harness.commit(
    (tx) => tx.scanConversations({ order: "descending" }, 200),
    ctx,
  );
  return page.items.filter((item) => !item.owner).map((item) => item.id);
};

// ------------------------------------------------------------------------ api
const json = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
};
const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch (error) {
    throw Object.assign(new Error("body must be JSON"), {
      status: 400,
      cause: error,
    });
  }
};
// Every route that names a conversation goes through here, so a junk id is a 400 instead of a durable-layer 500.
// "provider/id" — model ids may themselves contain slashes (openrouter/anthropic/…).
const modelRef = (value) => {
  const text = String(value ?? "").trim();
  const slash = text.indexOf("/");
  if (slash < 1 || slash === text.length - 1) return undefined;
  return { provider: text.slice(0, slash), modelId: text.slice(slash + 1) };
};

const conversationId = (value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1)
    throw Object.assign(
      new Error(`bad conversation id ${JSON.stringify(value)}`),
      { status: 400 },
    );
  return id;
};
const getConversation = async (id) => {
  const conversation = await harness.conversation(conversationId(id), ctx);
  if (!conversation)
    throw Object.assign(new Error(`unknown conversation ${id}`), {
      status: 404,
    });
  return conversation;
};

async function events(req, res, id) {
  const stream = await watchEvents(harness, conversationId(id), ctx);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  send(stream.snapshot);
  await stream.start(async (batch) => batch.forEach(send));
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(ping);
    void stream.stop();
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://ranger");
  if (
    opts.token &&
    url.searchParams.get("token") !== opts.token &&
    req.headers["x-ranger-token"] !== opts.token
  ) {
    return json(res, 401, { error: "bad token" });
  }
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(await readFile(join(HERE, "ui/index.html"), "utf8"));
    }
    if (url.pathname === "/api/boot") {
      return json(res, 200, {
        mode: opts.ssh ? "outpost" : "local",
        hands: opts.ssh ?? opts.cwd,
        cwd: opts.ssh ? opts.remoteCwd : opts.cwd,
        model,
        conversations: await listConversations(),
      });
    }
    if (url.pathname === "/api/models") {
      // Everything this process has credentials for, so the phone can pick a model without a restart.
      const available = await models.getAvailable();
      return json(res, 200, available.map((m) => ({ id: `${m.provider}/${m.id}`, contextWindow: m.contextWindow, maxTokens: m.maxTokens, reasoning: m.reasoning })).sort((a, b) => a.id.localeCompare(b.id)));
    }
    if (req.method === "POST" && url.pathname === "/api/new") {
      const body = await readBody(req);
      const created = await harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { model: modelRef(body.model) ?? model } },
        ctx,
      );
      return json(res, 200, { id: created.id, model: modelRef(body.model) ?? model });
    }
    if (req.method === "POST" && url.pathname === "/api/model") {
      const body = await readBody(req);
      const wanted = modelRef(body.model);
      if (!wanted) return json(res, 400, { error: `bad model ${JSON.stringify(body.model)}, expected provider/id` });
      await (await getConversation(body.id)).configure({ model: wanted }, ctx);
      return json(res, 200, { ok: true, model: wanted });
    }
    if (req.method === "POST" && url.pathname === "/api/input") {
      const body = await readBody(req);
      const conversation = await getConversation(body.id);
      const submission = await conversation.submit(
        {
          type: "input",
          content: String(body.text ?? ""),
          whenBusy: body.whenBusy,
        },
        ctx,
      );
      if (body.wait) await submission.wait(ctx);
      return json(res, 200, { id: submission.id });
    }
    if (req.method === "POST" && url.pathname === "/api/abort") {
      const body = await readBody(req);
      await (await getConversation(body.id)).abort(ctx);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/reset") {
      const body = await readBody(req);
      await (
        await getConversation(body.id)
      ).reset(body.handoff ? String(body.handoff) : undefined, ctx);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/stream")
      return await events(req, res, url.searchParams.get("id") ?? "1");
    return json(res, 404, { error: "not found" });
  } catch (error) {
    // durable reports an unknown conversation by throwing; a client typo should read as 404, not 500
    const status =
      error.status ??
      (/does not exist/i.test(String(error?.message)) ? 404 : 500);
    if (!res.headersSent)
      json(res, status, { error: String(error?.message ?? error) });
    else res.end();
  }
});

server.listen(opts.port, opts.host, async () => {
  // Boot output exists so you can copy a working URL onto the phone — token included.
  const wildcard = opts.host === "0.0.0.0" || opts.host === "::";
  const reachable = wildcard
    ? [...new Set(Object.values(networkInterfaces()).flat().filter((n) => n.family === "IPv4" && !n.internal).map((n) => n.address))]
    : [opts.host];
  console.log(`ranger ${model.provider}/${model.modelId}\n  brain: ${opts.db}\n  hands: ${where}`);
  for (const host of reachable) {
    console.log(`  http://${host}:${opts.port}${opts.token ? `/?token=${opts.token}` : ""}`);
  }
  if (!reachable.includes("127.0.0.1") && !opts.token) {
    console.log("  warn: bound beyond loopback without RANGER_TOKEN — keep it behind tailscale/ACLs");
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await harness.close(ctx);
    await remote?.cleanup(ctx);
    process.exit(0);
  });
}
