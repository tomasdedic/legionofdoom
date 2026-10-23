// pi-compatible credential file: { providerId: credential }, the shape ~/.pi/agent/auth.json uses.
// Reuse it and Ranger needs no separate secrets; OAuth refresh writes back through the same modify().
//
// The contract is pi-ai's CredentialStore (packages/ai/src/auth/types.ts): read resolves undefined for
// missing entries, modify is the only write path and resolves with the post-write credential, and an
// `fn` returning undefined leaves the entry unchanged.
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function fileCredentials(path) {
	let queued = Promise.resolve();
	const load = async () => {
		try {
			return JSON.parse(await readFile(path, "utf8"));
		} catch {
			return {};
		}
	};
	const save = async (data) => {
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.ranger-tmp`;
		await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
		await rename(tmp, path); // readers never see a half-written file
	};
	// pi and Ranger share this file: an OAuth refresh that loses a concurrent write burns a rotated token.
	// The in-process queue cannot stop that, so hold a lock directory across the read-modify-write too.
	const crossProcessLock = async (work) => {
		const dir = `${path}.lock`;
		for (let tries = 0; ; tries++) {
			try {
				await mkdir(dir);
				break;
			} catch {
				const stale = Date.now() - (await stat(dir).catch(() => undefined))?.mtimeMs > 15_000;
				if (stale) await rm(dir, { recursive: true, force: true });
				else if (tries > 100) throw new Error(`credential file locked: ${dir}`);
				else await new Promise((done) => setTimeout(done, 20 + Math.floor(Math.random() * 60)));
			}
		}
		try {
			return await work();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	};
	const serialize = (work) => {
		const run = queued.then(() => crossProcessLock(work), () => crossProcessLock(work));
		queued = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
	return {
		read: async (providerId) => (await load())[providerId],
		list: async () => Object.entries(await load()).map(([providerId, credential]) => ({ providerId, type: credential?.type })),
		modify: (providerId, fn) =>
			serialize(async () => {
				const data = await load();
				const next = await fn(data[providerId]);
				if (next === undefined) return data[providerId];
				data[providerId] = next;
				await save(data);
				return next;
			}),
		delete: (providerId) =>
			serialize(async () => {
				const data = await load();
				delete data[providerId];
				await save(data);
			}),
	};
}

