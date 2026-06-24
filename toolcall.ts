// Render tool-call breadcrumbs as Telegram Rich Messages.
//
// One message per call, edited in place from "running" to done/error. Layout:
//   <icon> **toolName** · `head`     ← summary; head inlined when short
//   <details>head</details>          ← head as a code block instead, when long
//   <details>body</details>          ← bulk field (content/edits), if any
//   <details>arguments</details>     ← leftover options as JSON, if any
//   <details>output</details>        ← result, auto-expanded when short/error
//
// Per-tool layout is declarative (see SPECS); unknown tools fall through to the
// generic arguments block rather than us guessing field meanings. Rich Messages
// parse markdown inside <details>.
// See https://core.telegram.org/bots/api#rich-messages.

interface ToolSpec {
	/** Field shown as the summary: inlined when short, a code block when long. */
	head: string;
	/** Bulky field always shown as its own code block (file content, edits…). */
	body?: string;
	/** Code-block language for head/body when rendered as a block. */
	lang?: string;
}

// Field names are pi's built-in tool schemas; nothing here is guessed.
const SPECS: Record<string, ToolSpec> = {
	bash: { head: "command", lang: "sh" },
	read: { head: "path" },
	ls: { head: "path" },
	grep: { head: "pattern" },
	find: { head: "pattern" },
	write: { head: "path", body: "content" },
	edit: { head: "path", body: "edits", lang: "json" },
};

// Sizing knobs (UX, not technical caps — Telegram's hard limit is 32768 chars).
const INLINE_MAX = 40; // head longer than this renders as a code block, not inline
const FIELD_MAX = 2000; // head/body/arguments block budget
const RESULT_MAX = 3000; // output block budget
const AUTO_OPEN_CHARS = 280; // expand a section only if both this short…
const AUTO_OPEN_LINES = 12; // …and this few lines

export type ToolArgs = Record<string, unknown> | undefined;
export interface ResultBlock {
	type: string;
	text?: string;
}

// ---------- helpers ----------

/** Wrap `body` in a fenced code block whose fence outruns any backtick run
 *  inside it, so content containing ``` can't break out of the block. */
function fence(body: string, lang: string): string {
	let longest = 0;
	for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const ticks = "`".repeat(Math.max(3, longest + 1));
	return `${ticks}${lang}\n${body}\n${ticks}`;
}

/** Truncate to `max` chars, flagging how much was dropped. */
function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max).trimEnd()}\n… (+${text.length - max} chars)`;
}

/** Collapse to one line and strip backticks for safe use in an inline-code span. */
function inlineHint(text: string): string {
	return text.replace(/\s+/g, " ").replace(/`/g, "ʼ").trim();
}

/** Short enough to render expanded rather than collapsed. */
function isShort(text: string): boolean {
	return text.length <= AUTO_OPEN_CHARS && text.split("\n").length <= AUTO_OPEN_LINES;
}

/** A tappable <summary> over a fenced code block; short bodies auto-expand. */
function block(label: string, body: string, opts: { lang?: string; max?: number; open?: boolean } = {}): string {
	const clipped = clip(body, opts.max ?? FIELD_MAX);
	const open = opts.open || isShort(clipped) ? " open" : "";
	return `<details${open}><summary>${label}</summary>\n\n${fence(clipped, opts.lang ?? "")}\n\n</details>`;
}

/** A field value as code-block text: strings verbatim, everything else as JSON. */
function asCode(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/** Flatten result content blocks, noting non-text blocks by type (e.g. `[image]`). */
function resultText(blocks: ResultBlock[]): string {
	return blocks
		.map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : `[${b.type}]`))
		.join("\n")
		.trim();
}

// ---------- renderer ----------

/** Summary line + head/body/arguments sections, shared by start and end. */
function header(icon: string, toolName: string, args: Record<string, unknown>): string[] {
	const spec = SPECS[toolName];
	const used = new Set<string>();
	const sections: string[] = [];

	let hint = "";
	if (spec) {
		const head = args[spec.head];
		if (typeof head === "string" && head.length > 0) {
			used.add(spec.head);
			if (!head.includes("\n") && head.length <= INLINE_MAX) hint = inlineHint(head);
			else sections.push(block(spec.head, head, { lang: spec.lang }));
		}
		if (spec.body && args[spec.body] != null) {
			used.add(spec.body);
			sections.push(block(spec.body, asCode(args[spec.body]), { lang: spec.lang }));
		}
	}
	sections.unshift(`${icon} **${toolName}**${hint ? ` · \`${hint}\`` : ""}`);

	// everything else: one generic JSON block (the whole arg set for unknown tools).
	const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !used.has(k)));
	if (Object.keys(rest).length > 0) sections.push(block("arguments", asCode(rest), { lang: "json" }));

	return sections;
}

/** Breadcrumb for a tool that just started running. */
export function renderToolStart(toolName: string, args: ToolArgs): string {
	return header("🔧", toolName, args ?? {}).join("\n\n");
}

/** Breadcrumb for a finished tool: same header (now ✅/❌) plus the output.
 *  Args come from the start event since the end event omits them. */
export function renderToolEnd(toolName: string, args: ToolArgs, blocks: ResultBlock[], isError: boolean): string {
	const sections = header(isError ? "❌" : "✅", toolName, args ?? {});
	const result = resultText(blocks);
	if (result) sections.push(block("output", result, { max: RESULT_MAX, open: isError }));
	return sections.join("\n\n");
}
