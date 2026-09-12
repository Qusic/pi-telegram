import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { createPiProcessHarness } from "./support/pi-process.ts";

function userText(message: Message | undefined): string | undefined {
	if (message?.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

test("real pi process discovers and expands skills from Telegram", async (t) => {
	const harness = await createPiProcessHarness({ responses: [{ content: "skill reply" }] });
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	harness.telegram.receiveText("/skills");
	const skills = await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown.includes("/skill:fixture-skill"),
	);
	assert.match(skills.markdown, /Deterministic skill used to verify discovery/);
	assert.deepEqual(await harness.getFauxCalls(), []);

	harness.telegram.receiveText("/skill:fixture-skill user arguments");
	const reply = await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "skill reply",
	);
	await harness.waitForIdle();
	const calls = await harness.getFauxCalls();
	const [call] = calls;

	assert.equal(calls.length, 1);
	assert.equal(reply.chatId, 100);
	assert.ok(call);
	assert.match(call.systemPrompt, /fixture-skill/);
	const expandedSkill = userText(call.messages.at(-1));
	assert.ok(expandedSkill);
	assert.match(expandedSkill, /<skill name="fixture-skill"/);
	assert.match(expandedSkill, /FIXTURE_SKILL_MARKER/);
	assert.match(expandedSkill, /user arguments$/);
	assert.ok(call.tools.includes("telegram_attach"));
});

test("real pi process rebinds Telegram after /new replaces the session", async (t) => {
	const harness = await createPiProcessHarness({
		responses: [{ content: "first reply" }, { content: "reply after replacement" }],
	});
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	const before = await harness.getState();
	harness.telegram.receiveText("hello before replacement");
	await harness.telegram.waitForText((message) => message.kind === "message" && message.markdown === "first reply");
	await harness.waitForIdle();

	harness.telegram.receiveText("/new");
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "✅ New session started.",
	);
	const after = await harness.getState();
	assert.notEqual(after.sessionId, before.sessionId);
	assert.equal(after.messageCount, 0);
	assert.equal((await harness.getFauxCalls()).length, 1);

	harness.telegram.receiveText("hello after replacement");
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "reply after replacement",
	);
	await harness.waitForIdle();
	const trace = await harness.getFauxCalls();

	assert.equal(trace.length, 2);
	const [firstCall, secondCall] = trace;
	assert.ok(firstCall);
	assert.ok(secondCall);
	assert.deepEqual(firstCall.messages.filter((message) => message.role === "user").map(userText), [
		"hello before replacement",
	]);
	assert.deepEqual(secondCall.messages.filter((message) => message.role === "user").map(userText), [
		"hello after replacement",
	]);
});

test("/resume n switches to the listed session and rebinds Telegram", async (t) => {
	const harness = await createPiProcessHarness({
		responses: [
			{ content: "reply from first session" },
			{ content: "reply from second session" },
			{ content: "reply after resume" },
		],
	});
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	const firstSession = await harness.getState();
	harness.telegram.receiveText("first session prompt");
	const firstReply = await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "reply from first session",
	);
	await harness.waitForIdle();

	harness.telegram.receiveText("/new");
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "✅ New session started.",
	);
	harness.telegram.receiveText("second session prompt");
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "reply from second session",
	);
	await harness.waitForIdle();

	harness.telegram.receiveText("/resume");
	const listing = await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown.startsWith("**Sessions**"),
	);
	const firstSessionLine = listing.markdown.split("\n").find((line) => line.includes("first session prompt"));
	const resumeIndex = firstSessionLine?.match(/\/resume(\d+)/)?.[1];
	assert.ok(resumeIndex, "first session should appear in the /resume listing");
	assert.equal((await harness.getFauxCalls()).length, 2);

	harness.telegram.receiveText(`/resume ${resumeIndex}`);
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "✅ Resumed: `first session prompt`",
	);
	await harness.telegram.waitForText(
		(message) =>
			message.kind === "message" &&
			message.messageId !== firstReply.messageId &&
			message.markdown === "reply from first session",
	);
	const resumedState = await harness.getState();
	assert.equal(resumedState.sessionId, firstSession.sessionId);
	assert.equal(resumedState.messageCount, 2);
	assert.equal((await harness.getFauxCalls()).length, 2);

	harness.telegram.receiveText("prompt after resume");
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "reply after resume",
	);
	await harness.waitForIdle();
	const trace = await harness.getFauxCalls();
	assert.equal(trace.length, 3);
	const resumedCall = trace[2];
	assert.ok(resumedCall);
	assert.deepEqual(resumedCall.messages.filter((message) => message.role === "user").map(userText), [
		"first session prompt",
		"prompt after resume",
	]);
});
