import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const parameters = Type.Object({
	label: Type.String(),
	delay: Type.Optional(Type.Integer({ minimum: 0 })),
	fail: Type.Optional(Type.Boolean()),
});

export default function (pi: ExtensionAPI) {
	for (const name of ["fixture_task", "fixture_serial"] as const) {
		pi.registerTool({
			name,
			label: name,
			description: "Deterministic tool for testing Telegram batch rendering.",
			parameters,
			...(name === "fixture_serial" ? { executionMode: "sequential" as const } : {}),
			async execute(_id, args, signal) {
				await delay(args.delay ?? 0, undefined, { signal });
				if (args.fail) throw new Error(`HIDDEN_TOOL_ERROR_${args.label}`);
				return {
					content: [{ type: "text", text: `HIDDEN_TOOL_OUTPUT_${args.label}` }],
					details: { label: args.label },
				};
			},
		});
	}

	pi.registerTool({
		name: "fixture_nested",
		label: "fixture_nested",
		description: "Runs nested tool calls through the real pi tool pipeline.",
		parameters: Type.Object({}),
		async execute(_id, _args, signal, _onUpdate, ctx) {
			const options = signal ? { signal } : {};
			await Promise.all([
				ctx.executeTool("fixture_task", { label: "nested-slow", delay: 100 }, options),
				ctx.executeTool("fixture_task", { label: "nested-fast", fail: true }, options),
			]);
			return { content: [{ type: "text", text: "HIDDEN_NESTED_OUTPUT" }], details: {} };
		},
	});
}
