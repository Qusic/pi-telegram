import type { AssistantMessage, FauxContentBlock, FauxModelDefinition, Message } from "@earendil-works/pi-ai";

interface ScriptedFauxResponse {
	content: string | FauxContentBlock | FauxContentBlock[];
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}

export interface FauxScript {
	responses: ScriptedFauxResponse[];
	model?: Omit<FauxModelDefinition, "id">;
	tokensPerSecond?: number;
}

export interface FauxTraceEntry {
	model: { provider: string; id: string };
	systemPrompt: string;
	messages: Message[];
	tools: string[];
	reasoning?: string;
}
