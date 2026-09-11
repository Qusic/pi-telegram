import { appendFileSync, readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FauxScript } from "../support/faux-script.ts";

const scriptPath = process.env.PI_TELEGRAM_FAUX_SCRIPT;
if (!scriptPath) throw new Error("PI_TELEGRAM_FAUX_SCRIPT is required");
const tracePath = process.env.PI_TELEGRAM_FAUX_TRACE;
const script = JSON.parse(readFileSync(scriptPath, "utf8")) as FauxScript;
// A session swap may reload this module; the trace is also the durable response cursor.
const consumedResponses = tracePath ? readFileSync(tracePath, "utf8").split("\n").filter(Boolean).length : 0;

const faux = fauxProvider({
	provider: "pi-telegram-test",
	api: "pi-telegram-test",
	models: [{ id: "faux-1", name: "Faux Model", reasoning: true, ...script.model }],
	tokenSize: { min: 1, max: 1 },
	...(script.tokensPerSecond === undefined ? {} : { tokensPerSecond: script.tokensPerSecond }),
});

faux.setResponses(
	script.responses.slice(consumedResponses).map((response) => (context, options, _state, model) => {
		if (tracePath) {
			appendFileSync(
				tracePath,
				`${JSON.stringify({
					model: { provider: model.provider, id: model.id },
					systemPrompt: context.systemPrompt,
					messages: context.messages,
					tools: context.tools?.map((tool) => tool.name) ?? [],
					reasoning: options?.reasoning,
				})}\n`,
			);
		}
		return fauxAssistantMessage(response.content, {
			...(response.stopReason === undefined ? {} : { stopReason: response.stopReason }),
			...(response.errorMessage === undefined ? {} : { errorMessage: response.errorMessage }),
		});
	}),
);

export default function (pi: ExtensionAPI) {
	pi.registerProvider(faux.provider);
}
