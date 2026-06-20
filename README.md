# pi-telegram

A Telegram DM bridge for [pi](https://pi.dev) — chat with your pi coding agent from anywhere through a Telegram bot. Based on [badlogic/pi-telegram](https://github.com/badlogic/pi-telegram), rewritten with AI (Claude `opus-4.7`) to better fit my personal preferences and needs.

## Features

- **Two-way Telegram ↔ pi bridge** over long-polling `getUpdates`
- **Streamed replies** with live previews, including extended thinking (separated from the answer by 💭 / ✏️ markers); long answers grow incrementally instead of only appearing at the end
- **Markdown rendering** to native Telegram formatting (bold, italics, links, inline code, fenced code blocks, blockquotes), robust to partial mid-stream snippets
- **Attachments in**: photos, albums, documents, video, audio, voice, animations and stickers; images are inlined as image inputs, everything else is referenced by local path
- **Attachments out**: a `telegram_attach` tool lets the agent send generated files with its reply
- **Tool call breadcrumbs**: each tool call posts a `🔧 …` message, edited in place with ✅ / ❌ and a result preview
- **Mid-turn steering**: messages sent while the agent is busy are injected into the running turn
- **Typing indicator** while the agent is working
- **Single-user authorization** by Telegram user id

### Telegram-side commands

Auto-published as the bot menu at boot. Anything else is forwarded to pi as a user turn.

| Command    | Description                                  |
| ---------- | -------------------------------------------- |
| `/new`     | Start a new pi session                       |
| `/resume`  | List recent sessions; `/resumeN` to switch   |
| `/stop`    | Abort the current turn                       |
| `/status`  | Model, token usage, cost and context window  |
| `/compact` | Compact the conversation                     |
| `/skills`  | List skills available to the agent           |

Resuming a session echoes that session's last reply back to the chat, so it reflects where you left off (the TUI already shows the full history).

## Differences vs. upstream `badlogic/pi-telegram`

| Area                  | Upstream                                                                        | This fork                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Setup & lifecycle     | `/telegram-setup` / `/telegram-connect` / `/telegram-disconnect` commands; explicit per-session connect | No pi-side commands; you write `~/.pi/agent/telegram.json` yourself, polling auto-starts per session       |
| Authorization         | First DM user is auto-paired                                                    | First DM user id is reported via `notify`; you add it to the config and restart                            |
| Commands & bot menu   | Telegram-side commands limited to `/status`, `/compact`, `stop`, `/help`, `/start`; no menu published | Adds `/new`, `/resume`, `/skills` and publishes the menu via `setMyCommands`; session switching from Telegram |
| Concurrency           | Extra messages while busy are queued and dispatched after the current turn ends | Extra messages are steered into the running turn                                                           |
| Aborted-turn replay   | After `stop`, queued messages are re-injected as a synthetic history block      | No replay — `stop` just aborts                                                                             |
| Prompt prefix         | Each message prefixed with `[telegram]`, plus a system-prompt suffix            | Forwarded as-is                                                                                            |
| Rendering             | Plain text only; URL preview cards enabled                                      | Markdown → Telegram HTML, plain-text retry on 400; URL preview cards disabled                              |
| Streaming             | Probes `sendMessageDraft`, falls back to `sendMessage` + `editMessageText`; previews truncated at 4096 chars, full answer only appears at `agent_end` | `sendMessageDraft` only; oversized previews are promoted into real messages mid-stream so long answers grow live |
| Tool call breadcrumbs | None                                                                            | `🔧 …` per tool call, edited with the result                                                               |
| Thinking blocks       | Stripped                                                                        | Streamed, separated by 💭 / ✏️ markers                                                                     |
| Status bar            | Rich colored status                                                             | Only transient polling errors                                                                              |

Media-group debouncing, the `telegram_attach` tool surface and the 4096-char chunking match upstream. Internally the fork is split into small manager closures instead of a single file.

## Install

Only one pi session should poll a given bot token at a time, so load this per-session instead of installing globally:

```bash
pi -e git:github.com/Qusic/pi-telegram
```

## Configure

1. Talk to [@BotFather](https://t.me/BotFather), run `/newbot`, copy the bot token.
2. Create `~/.pi/agent/telegram.json`:

   ```json
   { "botToken": "123456:ABC-your-token-here" }
   ```

3. Start pi — polling starts automatically.
4. DM your bot once. pi will notify you with your Telegram user id; add `"allowedUserId": <id>` to the config and restart.

## Usage

Just chat with your bot. Text becomes the next pi turn; photos/files are downloaded and referenced in the prompt (images also inlined); ask pi for an artifact and it can call `telegram_attach` to send files back; `/stop` aborts.

## License

MIT. See [LICENSE](./LICENSE).
