// Concurrency check for the credential file pi and Ranger share: node test/credentials.test.mjs
// A lost update here burns a rotated OAuth token, so the lock directory is worth a test.
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileCredentials } from "../credentials.mjs";

const dir = await mkdtemp(join(tmpdir(), "ranger-auth-"));
const file = join(dir, "auth.json");
const writes = 8;
const slow = () => new Promise((done) => setTimeout(done, 20)); // widen the read-modify-write window so the two processes really overlap
const bump = async (store) => {
	await Promise.all(Array.from({ length: writes }, () => store.modify("counter", async (current) => (await slow(), { ...current, n: current.n + 1 }))));
};

await writeFile(file, JSON.stringify({ counter: { type: "api_key", key: "secret", n: 0 } }));

// One process bumps the same credential through the same file, at the same time as this one.
const childSource = `
import { fileCredentials } from ${JSON.stringify(join(process.cwd(), "credentials.mjs"))};
const store = fileCredentials(${JSON.stringify(file)});
await Promise.all(Array.from({ length: ${writes} }, () => store.modify("counter", async (current) => { await new Promise((done) => setTimeout(done, 20)); return { ...current, n: current.n + 1 }; })));
`;
const other = spawn(process.execPath, ["--input-type=module", "-e", childSource], { stdio: ["ignore", "inherit", "inherit"] });
await Promise.all([bump(fileCredentials(file)), new Promise((done, fail) => other.on("exit", (code) => (code === 0 ? done() : fail(new Error(`child exit ${code}`)))))]);

const assert = (what, condition, seen) => {
	if (!condition) {
		console.error(`FAIL: ${what}${seen === undefined ? "" : ` (got ${JSON.stringify(seen)})`}`);
		process.exit(1);
	}
	console.log(`ok: ${what}`);
};

const after = JSON.parse(await readFile(file, "utf8"));
assert("no lost updates across two processes", after.counter.n === writes * 2, after.counter.n);
assert("credential body survives", after.counter.key === "secret");

const store = fileCredentials(file);
assert("read of a missing provider resolves undefined", (await store.read("nope")) === undefined);
assert(
	"modify(fn → undefined) keeps the entry and returns it",
	(await store.modify("counter", async () => undefined)).n === writes * 2 && (await store.read("counter")).n === writes * 2,
);
assert("list exposes types, not secrets", JSON.stringify(await store.list()) === '[{"providerId":"counter","type":"api_key"}]', await store.list());
assert("delete removes the entry", (await store.delete("counter"), (await store.read("counter")) === undefined));

// a process that died holding the lock must not wedge the store forever
const lock = `${file}.lock`;
await mkdir(lock);
const old = (Date.now() - 60_000) / 1000;
await utimes(lock, old, old);
assert("stale lock is broken", (await store.modify("counter", async () => ({ type: "api_key", key: "k", n: 1 }))).n === 1);
assert("lock released", (await stat(lock).catch(() => undefined)) === undefined);
await rm(lock, { recursive: true, force: true });
assert("no temp file left behind", (await stat(`${file}.ranger-tmp`).catch(() => undefined)) === undefined);
