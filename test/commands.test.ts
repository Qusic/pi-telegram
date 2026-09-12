import assert from "node:assert/strict";
import { test } from "node:test";
import { createPiProcessHarness } from "./support/pi-process.ts";

test("unauthorized Telegram users cannot invoke the model", async (t) => {
	const harness = await createPiProcessHarness({ responses: [] });
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	harness.telegram.receiveText("intruder request", { userId: 999 });
	const denial = await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "This bot is not authorized for your account.",
	);
	assert.equal(denial.silent, false);
	assert.deepEqual(await harness.getFauxCalls(), []);
});

test("/status reports real session usage without invoking the model", async (t) => {
	const harness = await createPiProcessHarness({ responses: [{ content: "status seed reply" }] });
	t.after(async () => {
		await harness.dispose();
		assert.deepEqual(harness.extensionErrors, []);
	});

	harness.telegram.receiveText("seed status data");
	await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown === "status seed reply",
	);
	await harness.waitForIdle();
	harness.telegram.receiveText("/status");
	const status = await harness.telegram.waitForText(
		(message) => message.kind === "message" && message.markdown.startsWith("**Status**"),
	);
	await harness.waitForIdle();

	assert.equal(status.silent, false);
	assert.match(status.markdown, /\*\*Model\*\* — `pi-telegram-test\/faux-1`/);
	assert.match(status.markdown, /\*\*Tokens\*\* — ↑\S+ ↓\S+/);
	assert.match(status.markdown, /\*\*Context\*\* — \d+\.\d+% \/ 128k/);
	assert.equal((await harness.getFauxCalls()).length, 1);
});
