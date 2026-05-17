// Markdown → Telegram HTML renderer for the parse_mode="HTML" whitelist:
//   <b> <i> <u> <s> <code> <pre> <pre><code class="language-x"> <a> <blockquote> <tg-spoiler>
//
// 1. autoCloseMarkdown appends closers for unclosed ``` ` ** * __ _ ~~ ||
//    so mid-stream snapshots still render.
// 2. mdToTelegramHtml stashes code in placeholders, escapes the rest,
//    applies block then inline transforms, restores code.
//
// Lists/tables are passed through as plain text (Telegram doesn't render them).
// Headings degrade to <b>line</b>. Pure functions, safe on partial input.
const NUL = "\u0000";
const PLACEHOLDER_RE = /\u0000PH(\d+)\u0000/g;

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Returns true iff `pat` matches an odd number of times in `s`. */
function oddCount(s: string, pat: RegExp): boolean {
	return ((s.match(pat) || []).length) % 2 === 1;
}

/** Strip already-balanced code regions so we can count remaining markers
 *  without false positives from code content. */
function stripBalancedCode(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, "")
		.replace(/`[^`\n]*`/g, "");
}

/** Append closers for unclosed markers in (possibly mid-stream) markdown.
 *  Unbalanced `[` is left as a literal bracket.
 *
 *  Order matters: if `**` was opened before an unclosed fence, its closer
 *  must go BEFORE the fence — otherwise bold ends up wrapping the rendered
 *  <pre>, which Telegram rejects. So we split at the last unclosed ``` and
 *  only count inline markers in the prefix. */
export function autoCloseMarkdown(md: string): string {
	const fences = (md.match(/```/g) || []).length;
	const fenceUnclosed = fences % 2 === 1;

	// head: where unclosed inline markers live; tail: the open code block.
	let head = md;
	let tail = "";
	if (fenceUnclosed) {
		const lastFence = md.lastIndexOf("```");
		head = md.slice(0, lastFence);
		tail = md.slice(lastFence);
	}

	const bare = stripBalancedCode(head);
	let closers = "";
	if (oddCount(bare, /`/g)) closers += "`";
	if (oddCount(bare, /\*\*/g)) closers += "**";
	if (oddCount(bare.replace(/\*\*/g, ""), /\*/g)) closers += "*";
	if (oddCount(bare, /__/g)) closers += "__";
	if (oddCount(bare.replace(/__/g, ""), /_/g)) closers += "_";
	if (oddCount(bare, /~~/g)) closers += "~~";
	if (oddCount(bare, /\|\|/g)) closers += "||";

	let out = head + closers + tail;
	if (fenceUnclosed) out += "\n```";
	return out;
}

/** Render a markdown subset to Telegram HTML. Not idempotent — pass raw
 *  markdown only once. */
export function mdToTelegramHtml(md: string): string {
	const text = autoCloseMarkdown(md);
	const placeholders: string[] = [];
	const stash = (html: string): string => {
		const idx = placeholders.length;
		placeholders.push(html);
		return `${NUL}PH${idx}${NUL}`;
	};

	// Fenced code → <pre>[<code class="language-x">]…</code></pre>
	let work = text.replace(
		/```([a-zA-Z0-9_+\-]*)\n?([\s\S]*?)```/g,
		(_m, lang: string, code: string) => {
			const body = escapeHtml(code.replace(/\n$/, ""));
			const html = lang
				? `<pre><code class="language-${lang}">${body}</code></pre>`
				: `<pre>${body}</pre>`;
			return stash(html);
		},
	);

	// Inline code
	work = work.replace(/`([^`\n]+)`/g, (_m, code: string) => stash(`<code>${escapeHtml(code)}</code>`));

	// Escape the rest; placeholder NUL sentinels are preserved.
	work = escapeHtml(work);

	// Headings → <b>…</b> (Telegram tolerates nested <b>).
	work = work.replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, "<b>$1</b>");

	// Consecutive `> ` lines → one <blockquote>. `>` is already escaped to `&gt;`.
	work = work.replace(
		/(?:^&gt;[ \t]?.*(?:\n&gt;[ \t]?.*)*)/gm,
		(block: string) => {
			const inner = block.replace(/^&gt;[ \t]?/gm, "");
			return `<blockquote>${inner}</blockquote>`;
		},
	);

	// Inline. Links first so URLs aren't mangled. Bold's `(?!\*)` on close
	// leaves the trailing `*` for italic, so `***x***` resolves correctly.
	work = work.replace(
		/\[([^\]\n]+)\]\(([^)\s]+)\)/g,
		(_m, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`,
	);
	work = work.replace(/\*\*([^\n]+?)\*\*(?!\*)/g, "<b>$1</b>");
	work = work.replace(/__([^\n]+?)__(?!_)/g, "<b>$1</b>");
	work = work.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
	work = work.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, "$1<i>$2</i>");
	work = work.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
	work = work.replace(/\|\|([\s\S]+?)\|\|/g, "<tg-spoiler>$1</tg-spoiler>");

	// Restore code placeholders.
	work = work.replace(PLACEHOLDER_RE, (_m, i: string) => placeholders[Number(i)]);

	return work;
}
