import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_MESSAGE_LENGTH } from "../src/api.ts";
import { createToolMessages } from "../src/toolcall.ts";

function call(id: string, name: string, args: unknown = {}) {
	return { toolCallId: id, toolName: name, args };
}

function recordingApi() {
	const messages: Array<{ id: number; chatId: number; markdown: string; silent: boolean }> = [];
	const edits: Array<{ id: number; markdown: string }> = [];
	const snapshots: string[] = [];
	const api = {
		async sendText(chatId: number, markdown: string, options?: { silent?: boolean }) {
			const id = messages.length + 1;
			messages.push({ id, chatId, markdown, silent: options?.silent === true });
			snapshots.push(markdown);
			return { message_id: id };
		},
		async editText(chatId: number, id: number, markdown: string) {
			const message = messages.find((message) => message.id === id && message.chatId === chatId);
			assert.ok(message);
			message.markdown = markdown;
			edits.push({ id, markdown });
			snapshots.push(markdown);
		},
	};
	return { api, messages, edits, snapshots };
}

function blockedSendApi() {
	const recorded = recordingApi();
	const { promise: sendStarted, resolve: sent } = Promise.withResolvers<void>();
	const { promise: sendGate, resolve: releaseSend } = Promise.withResolvers<void>();
	const api: typeof recorded.api = {
		...recorded.api,
		async sendText(chatId, markdown, options) {
			const result = await recorded.api.sendText(chatId, markdown, options);
			sent();
			await sendGate;
			return result;
		},
	};
	return { ...recorded, api, sendStarted, releaseSend };
}

test("out-of-order completions keep compact source-ordered lines without input/output details", async () => {
	const { api, messages, edits, snapshots } = recordingApi();
	const tools = createToolMessages(api);
	await tools.start(100, call("read", "read", { path: "src/index.ts", offset: 12 }));
	await tools.start(100, call("bash", "bash", { command: "echo `hello`\n  && pnpm test" }));
	await tools.start(100, call("write", "write", { path: "result.txt", content: "HIDDEN_FILE_CONTENT" }));
	await tools.start(100, call("edit", "edit", { path: "src/config.ts", edits: ["HIDDEN_EDIT_CONTENT"] }));
	await tools.start(100, call("grep", "grep", { pattern: "^TODO.*fix$", path: "src" }));
	await tools.start(100, call("custom", "lookup", { query: "small", content: "HIDDEN_CUSTOM_INPUT" }));
	tools.end("custom", false);
	tools.end("grep", false);
	tools.end("edit", false);
	tools.end("write", false);
	tools.end("bash", true);
	tools.end("read", false);
	await tools.finalize();

	assert.equal(messages.length, 1);
	assert.equal(messages[0]?.silent, true);
	assert.equal(
		messages[0]?.markdown,
		"✅ **read** · `src/index.ts`  \n" +
			"❌ **bash** · `echo ʼhelloʼ && pnpm te…`  \n" +
			"✅ **write** · `result.txt`  \n" +
			"✅ **edit** · `src/config.ts`  \n" +
			"✅ **grep** · `^TODO.*fix$`  \n" +
			"✅ **lookup**",
	);
	assert.equal(edits.length, 1);
	assert.equal(snapshots.length, 2);
	assert.ok(
		snapshots.every(
			(text) => !/<details>|HIDDEN_FILE_CONTENT|HIDDEN_EDIT_CONTENT|HIDDEN_CUSTOM_INPUT|"query"|offset/.test(text),
		),
	);
});

test("telegram_attach reports file counts without showing their paths", async () => {
	const { api, messages } = recordingApi();
	const tools = createToolMessages(api);
	await tools.start(100, call("one", "telegram_attach", { paths: ["/private/secret.txt"] }));
	tools.end("one", false);
	await tools.finalize();
	await tools.start(100, call("two", "telegram_attach", { paths: ["/private/secret.txt", "/private/notes.pdf"] }));
	tools.end("two", false);
	await tools.finalize();

	assert.deepEqual(
		messages.map((message) => message.markdown),
		["✅ **telegram\\_attach** · `1 file`", "✅ **telegram\\_attach** · `2 files`"],
	);
	assert.ok(messages.every((message) => message.silent));
});

test("unknown tool names remain safe Markdown without exposing arguments", async () => {
	const { api, messages } = recordingApi();
	const tools = createToolMessages(api);
	await tools.start(100, call("custom", "custom_<probe>*`", { content: "HIDDEN_CUSTOM_CONTENT" }));
	tools.end("custom", false);
	await tools.finalize();

	assert.equal(messages[0]?.markdown, "✅ **custom\\_\\<probe\\>\\*ʼ**");
});

test("long paths keep their tail while commands and tool names keep their start", async () => {
	const { api, messages } = recordingApi();
	const tools = createToolMessages(api);
	await tools.start(100, call("read", "read", { path: `start/${"long/path/".repeat(80)}end.ts` }));
	tools.end("read", false);
	await tools.finalize();

	const text = messages[0]?.markdown;
	assert.ok(text);
	const pathSummary = text.slice("✅ **read** · `".length, -1);
	assert.match(pathSummary, /^…\/.*\/end\.ts$/);
	assert.match(pathSummary, /\/long\/path\/end\.ts$/);
	assert.ok(pathSummary.length <= 24);
	assert.equal(text.split("\n").length, 1);

	await tools.start(100, call("emoji", "read", { path: `${"😀".repeat(90)}file.ts` }));
	tools.end("emoji", false);
	await tools.finalize();
	const unicode = messages[1]?.markdown;
	assert.ok(unicode);
	assert.match(unicode, /….*file\.ts`$/);
	assert.equal(Buffer.from(unicode).toString("utf8"), unicode);

	await tools.start(100, call("windows", "write", { path: `C:\\${"directory\\".repeat(30)}src\\index.ts` }));
	tools.end("windows", false);
	await tools.finalize();
	const windowsPath = messages[2]?.markdown;
	assert.ok(windowsPath);
	assert.match(windowsPath, /^✅ \*\*write\*\* · `…\/.*directory\/src\/index\.ts`$/);
	assert.ok(windowsPath.slice("✅ **write** · `".length, -1).length <= 24);

	await tools.start(100, call("command", "bash", { command: `echo ${"x".repeat(180)} TAIL` }));
	tools.end("command", false);
	await tools.finalize();
	const command = messages[3]?.markdown;
	assert.ok(command);
	assert.match(command, /^✅ \*\*bash\*\* · `echo x+…`$/);
	assert.doesNotMatch(command, /TAIL/);

	const longName = `tool${"x".repeat(60)}`;
	await tools.start(100, call("long-name", longName));
	tools.end("long-name", false);
	await tools.finalize();
	assert.equal(messages[4]?.markdown, `✅ **${longName.slice(0, 23)}…**`);
});

test("an in-flight send cannot duplicate the group or overwrite concurrent completions", {
	timeout: 5_000,
}, async (t) => {
	const { api, messages, edits, sendStarted, releaseSend } = blockedSendApi();
	t.after(() => releaseSend());
	const tools = createToolMessages(api);
	const first = tools.start(100, call("first", "read", { path: "first.ts" }));
	await sendStarted;
	const second = tools.start(100, call("second", "read", { path: "second.ts" }));
	tools.end("second", true);
	tools.end("first", false);
	const finalized = tools.finalize();
	releaseSend();
	await Promise.all([first, second, finalized]);

	assert.equal(messages.length, 1);
	assert.equal(edits.length, 1);
	assert.equal(messages[0]?.markdown, "✅ **read** · `first.ts`  \n❌ **read** · `second.ts`");
});

test("a completion during an in-flight edit is flushed later without overlapping edits", {
	timeout: 5_000,
}, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { api, messages, edits } = recordingApi();
	const { promise: editStarted, resolve: edited } = Promise.withResolvers<void>();
	const { promise: editGate, resolve: release } = Promise.withResolvers<void>();
	t.after(() => release());
	let inFlight = 0;
	let maximumInFlight = 0;
	const tools = createToolMessages({
		...api,
		async editText(chatId, id, markdown) {
			inFlight++;
			maximumInFlight = Math.max(maximumInFlight, inFlight);
			await api.editText(chatId, id, markdown);
			edited();
			await editGate;
			inFlight--;
		},
	});
	await tools.start(100, call("first", "read", { path: "first.ts" }));
	await tools.start(100, call("second", "read", { path: "second.ts" }));
	tools.end("first", false);
	t.mock.timers.runAll();
	await editStarted;
	tools.end("second", true);
	const finalized = tools.finalize();
	assert.equal(edits.length, 1);
	release();
	await finalized;

	assert.equal(maximumInFlight, 1);
	assert.equal(edits.length, 2);
	assert.equal(messages.length, 1);
	assert.equal(messages[0]?.markdown, "✅ **read** · `first.ts`  \n❌ **read** · `second.ts`");
});

test("finalization closes unfinished lines and discards late events", async () => {
	const { api, messages, edits } = recordingApi();
	const tools = createToolMessages(api);
	await tools.start(100, call("unfinished", "bash", { command: "sleep 10" }));
	await tools.finalize();
	tools.end("unfinished", false);
	await tools.start(100, {
		...call("unfinished/1", "read", { path: "late.ts" }),
		parentToolCallId: "unfinished",
	});
	await tools.finalize();

	assert.equal(messages.length, 1);
	assert.equal(edits.length, 1);
	assert.equal(messages[0]?.markdown, "🚫 **bash** · `sleep 10`");
});

test("repeated finalization waits for the same pending message writes", { timeout: 5_000 }, async (t) => {
	const { api, messages, sendStarted, releaseSend } = blockedSendApi();
	t.after(() => releaseSend());
	const tools = createToolMessages(api);
	const started = tools.start(100, call("unfinished", "read", { path: "file.ts" }));
	await sendStarted;
	const first = tools.finalize();
	let closed = false;
	const second = tools.finalize().then(() => {
		closed = true;
	});
	// A full event-loop turn lets an incorrectly resolved second finalize settle.
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(closed, false);
	releaseSend();
	await Promise.all([started, first, second]);

	assert.equal(closed, true);
	assert.equal(messages[0]?.markdown, "🚫 **read** · `file.ts`");
});

test("concurrent chat changes preserve batch ownership and send order", { timeout: 5_000 }, async (t) => {
	const { api, messages, sendStarted, releaseSend } = blockedSendApi();
	t.after(() => releaseSend());
	const tools = createToolMessages(api);
	const first = tools.start(100, call("first", "read", { path: "first.ts" }));
	await sendStarted;
	const second = tools.start(200, call("second", "read", { path: "second.ts" }));
	const third = tools.start(300, call("third", "read", { path: "third.ts" }));
	tools.end("third", false);
	const finalized = tools.finalize();
	releaseSend();
	await Promise.all([first, second, third, finalized]);
	await tools.finalize();

	assert.deepEqual(
		messages.map((message) => message.chatId),
		[100, 200, 300],
	);
	assert.deepEqual(
		messages.map((message) => message.markdown),
		["🚫 **read** · `first.ts`", "🚫 **read** · `second.ts`", "✅ **read** · `third.ts`"],
	);
});

test("a failed initial send retries on the next flush", async () => {
	const { api, messages } = recordingApi();
	let attempts = 0;
	const tools = createToolMessages({
		...api,
		async sendText(chatId, markdown, options) {
			attempts++;
			if (attempts === 1) throw new Error("first send failed");
			return api.sendText(chatId, markdown, options);
		},
	});
	await tools.start(100, call("first", "read", { path: "first.ts" }));
	assert.equal(messages.length, 0);
	tools.end("first", false);
	await tools.finalize();

	assert.equal(attempts, 2);
	assert.equal(messages.length, 1);
	assert.equal(messages[0]?.silent, true);
	assert.equal(messages[0]?.markdown, "✅ **read** · `first.ts`");
});

test("one failed page edit does not starve later pages or the next batch", async () => {
	const { api, messages } = recordingApi();
	let failEdit = false;
	let rejectedEdits = 0;
	const tools = createToolMessages({
		...api,
		async editText(chatId, id, markdown) {
			if (failEdit && id === 1) {
				rejectedEdits++;
				throw new Error("page edit failed");
			}
			await api.editText(chatId, id, markdown);
		},
	});
	const count = 1_200;
	for (let i = 0; i < count; i++) {
		await tools.start(100, call(`read-${i}`, "read", { path: `${"directory/".repeat(12)}file-${i}.ts` }));
	}
	for (let i = 0; i < count; i++) tools.end(`read-${i}`, false);
	failEdit = true;
	await tools.finalize();

	assert.equal(rejectedEdits, 1);
	assert.ok(messages.length > 1);
	assert.match(messages[0]?.markdown ?? "", /🔧/);
	assert.ok(messages.slice(1).every((message) => !message.markdown.includes("🔧")));
	assert.ok(messages.at(-1)?.markdown.endsWith(`file-${count - 1}.ts\``));
	await tools.start(100, call("next", "read", { path: "next.ts" }));
	tools.end("next", false);
	await tools.finalize();
	assert.equal(messages.at(-1)?.markdown, "✅ **read** · `next.ts`");
});

test("oversized batches split on whole lines and status edits keep page membership stable", async () => {
	const { api, messages } = recordingApi();
	const tools = createToolMessages(api);
	const count = 1_200;
	for (let i = 0; i < count; i++) {
		await tools.start(100, call(`read-${i}`, "read", { path: `${"directory/".repeat(12)}file-${i}.ts` }));
	}
	for (let i = count - 1; i >= 0; i--) tools.end(`read-${i}`, i % 3 === 0);
	await tools.finalize();

	assert.ok(messages.length > 1);
	assert.ok(messages.every((message) => message.silent && message.markdown.length <= MAX_MESSAGE_LENGTH));
	const lines = messages.flatMap((message) => message.markdown.split("  \n"));
	assert.equal(lines.length, count);
	for (let i = 0; i < count; i++) {
		assert.ok(lines[i]?.startsWith(i % 3 === 0 ? "❌" : "✅"));
		assert.ok(lines[i]?.endsWith(`file-${i}.ts\``));
	}
});
