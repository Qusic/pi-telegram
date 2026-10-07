import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPiProcessHarness } from "./support/pi-process.ts";

test("tool batches are compact and keep thinking between real pi tool rounds", async (t) => {
	const readableFixture = fileURLToPath(new URL("fixtures/skills/fixture-skill/SKILL.md", import.meta.url));
	const missingFixture = `${readableFixture}.missing`;
	const harness = await createPiProcessHarness({
		responses: [
			{
				content: [
					{ type: "thinking", thinking: "checking command" },
					{ type: "text", text: "Running a command." },
					{
						type: "toolCall",
						id: "read-1",
						name: "read",
						arguments: { path: readableFixture },
					},
					{
						type: "toolCall",
						id: "read-2",
						name: "read",
						arguments: { path: missingFixture },
					},
				],
				stopReason: "toolUse",
			},
			{
				content: [
					{ type: "thinking", thinking: "checking another file" },
					{ type: "text", text: "One more check." },
					{ type: "toolCall", id: "read-3", name: "read", arguments: { path: readableFixture } },
				],
				stopReason: "toolUse",
			},
			{ content: "Tool finished." },
		],
	});
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	harness.telegram.receiveText("run a tool");
	const preamble = await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown.includes("checking command"),
	);
	const firstToolStart = await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown.startsWith("🔧 **read**"),
	);
	const firstBatch = await harness.telegram.waitForText(
		(message) =>
			message.kind === "edit" &&
			message.markdown.startsWith("✅ **read**") &&
			message.markdown.includes("  \n❌ **read**"),
	);
	const finalReply = await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "Tool finished.",
	);
	await harness.waitForIdle();
	const calls = await harness.getFauxCalls();

	assert.equal(calls.length, 3);
	assert.equal(preamble.markdown, "💭\nchecking command\n\n✏️\nRunning a command.");
	assert.equal(firstBatch.messageId, firstToolStart.messageId);
	assert.equal(finalReply.silent, false);
	const messages = harness.telegram.getMessages();
	assert.equal(messages.length, 5);
	assert.equal(messages[0]?.markdown, preamble.markdown);
	assert.equal(messages[1]?.markdown, firstBatch.markdown);
	assert.equal(messages[2]?.markdown, "💭\nchecking another file\n\n✏️\nOne more check.");
	assert.match(messages[3]?.markdown ?? "", /^✅ \*\*read\*\*/);
	assert.equal(messages[4]?.markdown, "Tool finished.");
	assert.deepEqual(
		messages.map((message) => message.silent),
		[true, true, true, true, false],
	);
	assert.equal(firstBatch.markdown.split("  \n").length, 2);
	assert.match(firstBatch.markdown, /SKILL\.md\.missing/);
	assert.doesNotMatch(firstBatch.markdown, /<details>|FIXTURE_SKILL_MARKER|ENOENT/);
	assert.equal(calls[0]?.reasoning, "high");
	const toolResults = calls[1]?.messages.filter((message) => message.role === "toolResult");
	assert.ok(
		toolResults?.[0]?.content.some((block) => block.type === "text" && block.text.includes("FIXTURE_SKILL_MARKER")),
	);
	assert.deepEqual(
		toolResults?.map((message) => ({ toolName: message.toolName, isError: message.isError })),
		[
			{ toolName: "read", isError: false },
			{ toolName: "read", isError: true },
		],
	);
});

for (const [toolName, mode] of [
	["fixture_task", "parallel"],
	["fixture_serial", "sequential"],
] as const) {
	test(`${mode} tools share one Telegram message with source-ordered status lines`, async (t) => {
		const harness = await createPiProcessHarness({
			toolFixture: true,
			responses: [
				{
					content: [
						{ type: "toolCall", id: "slow", name: toolName, arguments: { label: "slow", delay: 100 } },
						{ type: "toolCall", id: "fast", name: toolName, arguments: { label: "fast" } },
						{ type: "toolCall", id: "failed", name: toolName, arguments: { label: "failed", delay: 20, fail: true } },
					],
					stopReason: "toolUse",
				},
				{ content: "Batch complete." },
			],
		});
		t.after(async () => {
			await harness.dispose();
			assert.deepEqual(harness.extensionErrors, []);
		});

		harness.telegram.receiveText(`run ${mode} tools`);
		await harness.telegram.waitForText(
			(message) => message.kind === "message" && message.markdown === "Batch complete.",
		);
		await harness.waitForIdle();
		const messages = harness.telegram.getMessages();
		assert.equal(messages.length, 2);
		assert.equal(messages[0]?.silent, true);
		assert.equal(messages[1]?.silent, false);
		const title = toolName.replace(/_/g, "\\_");
		assert.deepEqual(messages[0]?.markdown.split("  \n"), [`✅ **${title}**`, `✅ **${title}**`, `❌ **${title}**`]);
		const calls = await harness.getFauxCalls();
		assert.equal(calls.length, 2);
		assert.deepEqual(
			calls[1]?.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
			["slow", "fast", "failed"],
		);
	});
}

test("a preflight-rejected tool and its following call remain in one batch", async (t) => {
	const harness = await createPiProcessHarness({
		toolFixture: true,
		responses: [
			{
				content: [
					{ type: "toolCall", id: "invalid", name: "fixture_task", arguments: {} },
					{ type: "toolCall", id: "valid", name: "fixture_task", arguments: { label: "after-rejection" } },
				],
				stopReason: "toolUse",
			},
			{ content: "Preflight complete." },
		],
	});
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	harness.telegram.receiveText("run preflight batch");
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "Preflight complete.",
	);
	await harness.waitForIdle();
	const messages = harness.telegram.getMessages();
	assert.equal(messages.length, 2);
	assert.equal(messages[0]?.silent, true);
	assert.equal(messages[0]?.markdown, "❌ **fixture\\_task**  \n✅ **fixture\\_task**");
	assert.equal(messages[1]?.markdown, "Preflight complete.");
	const calls = await harness.getFauxCalls();
	assert.equal(calls.length, 2);
	assert.deepEqual(
		calls[1]?.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => ({
				id: message.toolCallId,
				isError: message.isError,
			})),
		[
			{ id: "invalid", isError: true },
			{ id: "valid", isError: false },
		],
	);
});

test("nested pi tool events stay in the parent batch without extra Telegram messages", async (t) => {
	const harness = await createPiProcessHarness({
		toolFixture: true,
		responses: [
			{
				content: { type: "toolCall", id: "parent", name: "fixture_nested", arguments: {} },
				stopReason: "toolUse",
			},
			{ content: "Nested batch complete." },
		],
	});
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	harness.telegram.receiveText("run nested tools");
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "Nested batch complete.",
	);
	await harness.waitForIdle();
	const messages = harness.telegram.getMessages();
	assert.equal(messages.length, 2);
	assert.equal(messages[0]?.silent, true);
	assert.equal(messages[1]?.silent, false);
	assert.deepEqual(messages[0]?.markdown.split("  \n"), [
		"✅ **fixture\\_nested**",
		"↳ ✅ **fixture\\_task**",
		"↳ ❌ **fixture\\_task**",
	]);
	const calls = await harness.getFauxCalls();
	assert.equal(calls.length, 2);
	assert.deepEqual(
		calls[1]?.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
		["parent"],
	);
});

test("/stop closes a running tool batch and the next Telegram request recovers", async (t) => {
	const harness = await createPiProcessHarness({
		toolFixture: true,
		responses: [
			{
				content: [
					{ type: "toolCall", id: "slow", name: "fixture_task", arguments: { label: "slow", delay: 10_000 } },
					{ type: "toolCall", id: "fast", name: "fixture_task", arguments: { label: "fast" } },
				],
				stopReason: "toolUse",
			},
			{ content: "Recovered after tools." },
		],
	});
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	harness.telegram.receiveText("run a slow tool batch");
	await harness.telegram.waitForText(
		(message) =>
			message.kind === "edit" &&
			message.markdown.startsWith("🔧 **fixture\\_task**") &&
			message.markdown.includes("  \n✅ **fixture\\_task**"),
	);
	harness.telegram.receiveText("/stop");
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "Aborted current turn.",
	);
	await harness.waitForIdle();
	const batch = harness.telegram.getMessages().find((message) => message.markdown.includes("**fixture\\_task**"));
	assert.ok(batch);
	assert.match(batch.markdown, /^❌ \*\*fixture\\_task\*\*.* {2}\n✅ \*\*fixture\\_task\*\*/);
	assert.doesNotMatch(batch.markdown, /🔧|HIDDEN_TOOL/);
	assert.equal((await harness.getFauxCalls()).length, 1);

	harness.telegram.receiveText("request after tool abort");
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "Recovered after tools.",
	);
	await harness.waitForIdle();
	assert.equal((await harness.getFauxCalls()).length, 2);
	assert.equal(
		harness.telegram.getMessages().filter((message) => message.markdown.includes("**fixture\\_task**")).length,
		1,
	);
});
