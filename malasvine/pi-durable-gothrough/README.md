# Ranger

A durable agent host you drive from your phone.

```
        phone (browser, over Tailscale)
                    │  http + SSE
                    ▼
   ┌────────────────────────────────┐        ┌──────────────────────────────┐
   │ RANGER  — the brain            │  ssh   │ OUTPOST — the hands          │
   │ home machine, long-lived       │───────▶│ throwaway VM / box / container│
   │                                │        │                                │
   │  model + credentials (pi-ai)   │        │  pi-env daemon (Rust):         │
   │  durable SQLite transcript     │        │   bash · read · write · edit   │
   │  Harness / Conversation        │        │   grep · find · ls             │
   │  watchEvents → SSE             │        │   (code, repo, your work)      │
   └────────────────────────────────┘        └──────────────────────────────┘
```

`ranger.mjs` is 292 lines on top of [`@earendil-works/pi-durable`](../pi/packages/durable) +
[`@earendil-works/pi-ai`](../pi/packages/ai) + [`@earendil-works/pi-env`](../pi/packages/env).
`ui/index.html` is a single-file phone client. Nothing else.

## Run it

```bash
npm install

# offline plumbing test, no key needed
node ranger.mjs --faux

# real model — reuses whatever pi already has in ~/.pi/agent/auth.json
node ranger.mjs                      # http://127.0.0.1:8787
node ranger.mjs --model openrouter/anthropic/claude-haiku-5.5
node ranger.mjs --model trask/general   # any endpoint pi already knows: models.json is loaded too
RANGER_MODEL=trask/general node ranger.mjs  # same, without repeating the flag
node ranger.mjs --cwd ~/work/somerepo     # where the tools operate (default: this dir)

# are the hands reachable? (no model, no server, no credentials)
node ranger.mjs probe
node ranger.mjs probe --ssh worker@100.87.213.95 --remote-cwd /srv/work
```

Model choice is **per conversation**, fixed when the conversation is created: `--model` / `RANGER_MODEL` only
seeds new ones, so an existing conversation keeps its model after you restart Ranger with a different one.
The UI header shows the conversation's model (from the stream snapshot), not the server default; `+ new`
is how you switch. Custom endpoints come from `~/.pi/agent/models.json` — read with pi's own defaults
(`$ENV` key, `128k`/`16k` windows, zero cost) for `openai-completions` and `anthropic-messages` APIs.

Outpost mode: same process, tools run somewhere else. Ranger uploads its `pi-env` daemon over
plain `ssh` on first use and keeps one connection for every tool call.

```bash
node ranger.mjs trust worker@100.87.213.95      # one-time host-key pin (writes outpost.known_hosts)
node ranger.mjs --ssh worker@100.87.213.95 --remote-cwd /srv/work
```

From the phone: Ranger prints the URLs to open, token included, so nothing to assemble by hand —
bind a wildcard and it lists the machine's real addresses (LAN now, Tailscale once installed).

```bash
$ RANGER_TOKEN=$(openssl rand -hex 16) node ranger.mjs --host 0.0.0.0 --cwd ~/work/repo
ranger anthropic/claude-sonnet-5-5
  brain: /Users/ts/GIT/ai/pi-durable-gothrough/ranger.sqlite
  hands: a local sandbox (cwd /Users/ts/work/repo)
  http://127.0.0.1:8787/?token=9f1c…(the real token, not truncated)
  http://192.168.0.200:8787/?token=9f1c…
```

For anything beyond one LAN, put it behind Tailscale: `--host <tailscale-ip>` for the same plain HTTP,
or `tailscale serve --bg --https=443 http://127.0.0.1:8787` for TLS and tailnet ACLs.

`--token` / `RANGER_TOKEN` gates every route; the client picks `?token=` off its own URL and puts it back on
every request it makes (query string, because `EventSource` cannot set headers). Bookmark the tokenized URL.
Without a token, Ranger still answers — bind `127.0.0.1` (the default) and it is local-only by construction.

## What the phone can do while a task runs

* **steer** — inject into the current generation; it lands at the next tool boundary.
* **follow-up** — queue for after the run.
* **abort** — cancel the run; the conversation stays intact.
* close the tab, kill the Wi-Fi, reboot Ranger: the transcript is SQLite, the run resumes
  (`harness.resume()`), and `/api/stream` replays committed entries before following live, so a
  late joiner sees exactly what it missed. That is the whole point of durable: the agent survives
  its own process.

## Brain/hands vs agent-in-orb

**Built: brain/hands.** Model, credentials, prompt assembly and the durable transcript stay on the
machine you control (Ranger); only tool execution moves to the outpost. This is the split pi-durable
already assumes — `Harness({ env })` takes an `ExecutionEnv`, and `RemoteExecutionEnv` is a drop-in
for `NodeExecutionEnv` — so it cost ~6 lines, and the sandbox never sees your API keys, your model
spend, or your history.

**Agent-in-orb** (the whole worker inside the microVM) is strictly better at one thing: containing a
worker that reads hostile input, since then even the model's context lives outside the outpost. It
also costs you: the DB and tokens sit in the VM, so a firecracker snapshot/rebuild loses the thread
or you move the durable store elsewhere — at which point you have Ranger plus a second agent loop to
operate.

Do both without a second codebase: run `ranger.mjs` **inside** the outpost and point your phone at
it over Tailscale (orb), or run it at home with `--ssh` into the outpost (brain/hands). Same file,
same durable store, one knob.

## Outpost = Firecracker

Ranger only needs a generic SSH endpoint, so the outpost is whatever you like. For a Firecracker box
on a Linux host (not this Mac — `firecracker`, `docker` and `tailscale` are absent here, so these
steps are untested from this checkout):

```bash
curl -LO https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/$ARCH/rootfs-$VER.img.bz2   # ext4 image
firecracker --api-sock /tmp/fc.sock
# PUT  /machine-config  {vcpu_count: 2, mem_size_mib: 2048}
# PUT  /boot-source     {kernel_image_path: vmlinux, boot_args: "console=ttyS0 reboot=k panic=1 pci=off ip=dhcp"}
# PUT  /drives          {drive_id: rootfs, path_on_host: rootfs.img, is_root_device: true, is_read_only: false}
# PUT  /actions         {action_type: InstanceStart}
```

Inside the image you need only: `sshd` on a port, one user, and its public key in
`authorized_keys` (pi-env uploads its own daemon — no Node, no npm, no docker on the outpost).
`--remote-cwd` should be a mounted/shared or disposable path; the transcript stays home.

## Layout

| path | role |
| --- | --- |
| `ranger.mjs` | serve / probe / trust: harness, HTTP + SSE |
| `credentials.mjs` | pi-compatible `~/.pi/agent/auth.json` store (`CredentialStore`), locked read-modify-write |
| `ui/index.html` | one-file client: conversations, live tool cards, steer/abort/reset |
| `ui/render.test.mjs` | feeds `test/faux-run.sse` through the client's render logic in a fake DOM |
| `test/credentials.test.mjs` | two processes bumping one credential file; contract, stale-lock and atomicity checks |
| `test/faux-run.sse` | recorded Ranger stream: snapshot plus two live runs with tool calls |
| `~/.ranger/ranger.sqlite` | the durable store — created on first run, `--db` overrides |
| `outpost.known_hosts` | pinned host keys for `--ssh` |

`npm test` runs both files (17 assertions, no browser, no network).

## Verified here

`--faux` end-to-end: `bash` executed, output committed as `pi.tool-result`, streamed over SSE, server
restarted, and the same conversation replayed from SQLite with the run already finished.
`probe` on macOS: `uname`, `pwd`, write+read+remove round-trip through `NodeExecutionEnv`.
`probe --ssh bob@example.invalid:2200`: the target parses to host `example.invalid`, port 2200, user
`bob`, and `ssh` really is spawned (it fails at DNS with a one-line message, not a stack).
Token gate: 401 without, 200 with, on `/`, `/api/boot` and `/api/stream`; `--host 0.0.0.0` prints the
LAN URL with the token embedded and that exact URL answers 200.
Real provider call: credentials load from pi's `auth.json`, the request leaves the process, and a
provider error lands in the transcript as a `stopReason: "error"` message the client shows (this
account's credit ran out — the success path is pi-ai's, the plumbing here is verified).
Real completion, `--model trask/general` (pi's own `models.json` endpoint): 2 `bash` tool calls, results
committed, final answer streamed, usage booked under `trask/general`.
Credential locking is tested in the failing direction too: with `crossProcessLock` replaced by a
pass-through, 8+8 concurrent bumps from two processes lose 6 updates (`got 10`); with it, 16/16.

One `--db`, one writer: a second process on the same store is refused at boot (`already open in pid N`),
because two brains allocating entry ids corrupt the transcript. A lock left by a killed process is broken
automatically. The default store lives in `~/.ranger/`, not in this checkout — it is the only copy of every
transcript, so it stays out of reach of `git clean -fdx`.

**Not verified here:** a real `--ssh` outpost session (no SSH server reachable from this laptop, no
Remote Login enabled) and the Firecracker bring-up above.
