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
	const [call] = await harness.waitForFauxCalls(1);

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

	harness.telegram.receiveText("/new");
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "✅ New session started.",
	);
	const after = await harness.getState();
	assert.notEqual(after.sessionId, before.sessionId);

	harness.telegram.receiveText("hello after replacement");
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "reply after replacement",
	);
	const trace = await harness.waitForFauxCalls(2);

	assert.equal(trace.length, 2);
	const [firstCall, secondCall] = trace;
	assert.ok(firstCall);
	assert.ok(secondCall);
	assert.equal(userText(firstCall.messages.at(-1)), "hello before replacement");
	assert.equal(userText(secondCall.messages.at(-1)), "hello after replacement");
});
