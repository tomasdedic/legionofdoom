// Runnable check for the UI's event → DOM logic, without a browser:
//   node ui/render.test.mjs
// Feeds test/faux-run.sse (a real Ranger event stream: committed snapshot + one live run) into the page script.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");
const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));

class Node {
	constructor(tag) {
		this.tagName = tag;
		this.children = [];
		this.style = {};
		this.classList = { toggle: () => {} };
		this._text = "";
	}
	set textContent(value) {
		this._text = String(value);
		this.children = [];
	}
	get textContent() {
		return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text;
	}
	append(...kids) {
		this.children.push(...kids);
	}
	replaceChildren(...kids) {
		this.children = kids;
		this._text = "";
	}
	addEventListener() {}
}

const ids = Object.fromEntries(
	["log", "meta", "convs", "usage", "send", "new", "reset", "stop", "model", "setmodel", "modelids"].map((id) => [id, new Node("div")]),
);
ids.input = Object.assign(new Node("textarea"), { value: "" });
ids.steer = { checked: false };

const sources = [];
const posted = [];
const sandbox = {
	document: { body: { scrollHeight: 1e6 }, createElement: (tag) => new Node(tag), getElementById: (id) => ids[id] },
	window: { innerHeight: 1000, scrollY: 1e6, scrollTo: () => {} },
	location: { search: "" },
	alert: (message) => {
		throw new Error(`alert: ${message}`);
	},
	fetch: async (url, init) => ({
		ok: true,
		json: async () => {
			const u = String(url);
			if (init?.body) posted.push({ url: u, body: JSON.parse(init.body) });
			if (u.includes("/api/boot")) return { mode: "local", cwd: "/tmp", model: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, conversations: [1] };
			if (u.includes("/api/models")) return [{ id: "faux/faux-1", contextWindow: 128000 }, { id: "trask/general", contextWindow: 1000000 }];
			if (u.includes("/api/model")) return { ok: true, model: { provider: "trask", modelId: "general" } };
			return { id: 1 };
		},
	}),
	EventSource: class {
		constructor(url) {
			this.url = url;
			sources.push(this);
		}
		close() {}
	},
};

const events = readFileSync(join(here, "..", "test", "faux-run.sse"), "utf8")
	.split("\n")
	.filter((line) => line.startsWith("data:"))
	.map((line) => JSON.parse(line.slice(6)));

const run = new Function(
	...Object.keys(sandbox),
	`${script}\nreturn { onEvent };`,
);
const { onEvent } = run(...Object.values(sandbox));
await new Promise((resolve) => setTimeout(resolve, 0)); // let the page's boot IIFE settle

for (const event of events) onEvent(event);
await new Promise((resolve) => setTimeout(resolve, 0));
const rendered = ids.log.textContent;

const assert = (what, condition) => {
	if (!condition) {
		console.error(`FAIL: ${what}\n--- rendered ---\n${rendered}`);
		process.exit(1);
	}
	console.log(`ok: ${what}`);
};

assert("user inputs render", rendered.includes("list files") && rendered.includes("second task"));
assert("tool cards render with args", rendered.includes("$ bash") && rendered.includes('"command":"pwd && ls"'));
assert("committed tool output renders", rendered.includes("ranger.mjs") && rendered.includes("bash output"));
assert("assistant answers render", (rendered.match(/Listed the directory/g) ?? []).length === 2);
assert("no leftover in-flight tail", !rendered.includes("working…"));
assert("status shows the model", ids.meta.textContent.includes("faux"));
// The conversation's own model wins: the server default is only the starting point for new conversations.
assert("status shows the conversation model, not the server default", ids.meta.textContent.includes("faux/faux-1") && !ids.meta.textContent.includes("anthropic"));

assert("model field mirrors the conversation model", ids.model.value === "faux/faux-1");
assert("known models offered for typing", ids.modelids.children.length === 2 && ids.modelids.children[0].value === "faux/faux-1");
assert("the picker shows the context window the endpoint declared", ids.modelids.children[1].textContent.includes("1M"));
ids.model.value = "trask/general";
await ids.setmodel.onclick();
assert("set posts the conversation id and provider/id", posted.some((p) => p.url.includes("/api/model") && p.body.id === 1 && p.body.model === "trask/general"));

// The riskiest branch is not in the recorded stream: partials that never got committed.
onEvent({ type: "run_start", inputs: [99] });
onEvent({ type: "message_update", usage: {}, changes: [{ type: "text_delta", contentIndex: 0, delta: "streaming answer" }] });
onEvent({ type: "tool_execution_start", toolCallId: "x1", toolName: "read", args: { path: "a.txt" } });
onEvent({ type: "tool_execution_update", toolCallId: "x1", toolName: "read", output: { set: "a chunk" } });
const tail = ids.log.textContent;
assert("uncommitted text shows in the in-flight tail", tail.includes("streaming answer") && tail.includes("working…"));
assert("running tool shows its live output", tail.includes('$ read {"path":"a.txt"}') && tail.includes("a chunk"));
