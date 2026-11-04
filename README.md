# Logbook

A local macOS app that sits next to your terminal and turns what your coding agents did into an understanding of your own systems.

When most of your code is written by several agent sessions at once, the code moves faster than your understanding of it. The agents already keep a detailed record of every prompt, edit, command and result. Logbook reads that record, keeps it on your machine, and builds toward three things: a live board of what every agent is doing, a daily digest of what changed in your systems and why, and a reviewer that asks you questions about your own diffs until you can answer them.

## Status

Chunks 1 and 2 of 6 are done: ingestion, and a live board of running agents. See the [roadmap](#roadmap).

## The live board

The window opens on every running agent, the ones waiting on you first: which need you (blocked on a question or a permission), which are done and unread, and what each working one is doing right now, in plain English ("Run the test suite", "Editing core/db.ts", "Subagent: Reading docs.stripe.com"), with your last prompt and any recent tool errors.

- With [herdr](https://herdr.dev), the list of agents and their states come from herdr, which watches the terminals. Each agent is matched to its transcript by title and directory, and "jump to agent" focuses its pane. Without herdr, the board shows sessions active in the last 30 minutes and infers working or idle from recency.
- A menu bar item shows how many agents are waiting on you, with one click to each. If you replace the menu bar (SketchyBar and friends), Logbook also writes `status.json` to its data folder and fires a SketchyBar `logbook_update` event with `WAITING=<n>` whenever the count changes.
- "Plain English" comes from the tool calls themselves (Claude's shell commands carry a one-line description). No model is called yet.

## How it works

- Claude Code writes every session to `~/.claude/projects/<project>/<session>.jsonl`, with subagents under `<session>/subagents/`. Logbook remembers, per file, the byte offset it has read up to and reads only complete new lines, so it is cheap to run continuously and safe to run twice.
- The transcript format is internal to Claude Code and changes between versions. The parser keeps the fields it understands and counts entry types it has never seen, and the window shows those counts, so format drift shows up on screen instead of as silently missing data.
- Every string is checked for credentials and redacted before it is stored, then truncated.
- Everything lands in SQLite at `~/Library/Application Support/logbook/logbook.db`, readable by your user only.
- The app is [Electrobun](https://electrobun.dev) 2.x: a Bun main process and the system WebKit view. The window talks to the main process over Electrobun's RPC, a loopback WebSocket that Electrobun encrypts with a random key per window. There is no web server for a browser or another process to read from.
- The CLI and the app can run at the same time: each chunk commits only if no other writer has already taken those bytes, so nothing is counted twice.

On a machine with about 2 GB of transcripts from 40 days of heavy use, the first backfill takes under 10 seconds and later passes take milliseconds.

## Privacy

- Chunk 1 is fully local. Nothing leaves your Mac.
- Later chunks will send redacted session excerpts to the Anthropic API, with your own API key, to write digests and questions.
- Redaction covers passwords in URLs; provider tokens (Anthropic, OpenAI, OpenRouter, Stripe, GitHub, GitLab, Slack, AWS, Google, Hugging Face, npm, SendGrid, Shopify, Discord, eBay); JWTs; private keys; `Authorization`, `Cookie` and bearer headers; signed-URL parameters; webhook URLs; credentials on command lines (`curl -u`, `mysql -p`, `--password`); and any `key = value` whose key name says secret, in `.env`, YAML, INI, JSON or code. A value that only refers to a secret (`process.env.API_KEY`, `${TOKEN}`, `req.body.password`) is kept, so diffs of auth code stay readable.
- When the rules change, everything already stored is re-redacted on the next launch (a few seconds, once), so a rule added today also cleans last month's history.
- It is pattern-based, so it can still miss things. If you find a miss, open an issue describing the shape of the secret, never the secret itself.
- Claude Code deletes its own transcripts after `cleanupPeriodDays` (default 30). Logbook keeps its own copy of what it reads; raise that setting if you also want Claude Code's history to last longer.

## Setup

Requires macOS on Apple Silicon, [Bun](https://bun.sh) 1.3 or later, and Claude Code.

```sh
bun install
bun run sync    # one time: fetches Electrobun's toolchain into ~/.hutch and its SDK into .hutch/devkit
bun run app     # build and open the app
```

Without the app:

```sh
bun run ingest  # read everything new
bun run watch   # ingest, then follow new agent activity
bun run stats   # what is in the database
```

Development: `bun test`, `bun run typecheck`, `bun run dev` (rebuilds the app on change).

Electrobun 2.x's `init` command installs a global `hutch` launcher and appends a PATH line to your shell profile. This repo does not need it: every command above goes through the pinned `electrobun` npm package.

## Layout

| Path | What lives there |
| --- | --- |
| `src/core` | Ingestion, parsing, redaction, storage. No app-framework imports; shared by the CLI, the tests and the app. |
| `src/cli` | The command-line entry point. |
| `src/bun` | The app's main process. |
| `src/views/main` | The app window. |
| `src/shared` | The RPC contract between the two. |
| `test` | Tests. Fake credentials are assembled at runtime so none sit in the repo. |

## Roadmap

1. **Ingestion and status window.** Done.
2. **Live board.** Done: what every running agent is doing in plain English, which ones are waiting on you, a menu bar count, and a jump to the agent.
3. **Session cards and a daily digest.** Claude Haiku summarizes each session as it runs; Claude Opus writes the digest through the Batch API.
4. **The reviewer.** Questions about each pull request's diff, graded against the code, with spaced repetition and a list of what you shipped but never explained.
5. **Production context.** Deploys, runtime errors and schema changes linked back to the sessions that caused them.
6. **Notes and calendar**, if they still seem worth building.

No license has been chosen yet.
