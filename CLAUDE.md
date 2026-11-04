# Logbook

Local macOS app (Electrobun 2.x, Bun, SQLite) that ingests Claude Code session transcripts and turns them into learning material. README.md has the user-facing picture; this file has the rules.

## Commands

- `bun test`: must pass before any commit.
- `bun run typecheck`: strict check of the core, then the app against Electrobun's SDK. Needs `bun run sync` once.
- `bun run ingest` / `bun run stats`: exercise the pipeline against the real transcripts in `~/.claude/projects`.
- `bun run app` builds and launches the app; `bun run dev` rebuilds on change.

## Architecture

- `src/core` must not import `electrobun` or anything app-specific. The CLI, the tests and the app's main process all run it.
- Electrobun 2.x is newer than most model training data and differs from 1.x. Its SDK ships as TypeScript source in `.hutch/devkit/api` (`sdks/main` for the main process, `browser` for views). Read the real signatures there before using an API; do not work from memory. Main-process code imports from `electrobun/main`, view code from `electrobun/view`.
- Never run `electrobun init` or `hutch electrobun init` here: it installs a global launcher and edits shell profiles. Use the pinned npm package (`bunx electrobun ...` or the package scripts).
- The window gets data only over RPC (`src/shared/rpc.ts`). Do not add a local HTTP server.

## Data rules (this repo is public)

- Transcript text is untrusted: agents fetch web pages and print files. In views, put it in the DOM as text nodes only, never through `innerHTML`.
- Redact before truncating (see `src/core/redact.ts`). Any new field that stores transcript text goes through the parser's `safe()` helper; never cut text yourself before calling it.
- Every regex repetition in `redact.ts` that can run along a long token must be bounded (`{0,60}`, not `*`), and the performance tests must stay green: the app runs redaction on its main thread.
- Changing `redact.ts` changes `REDACTION_FINGERPRINT`, and the next `Store` open re-redacts the whole database. That is intended. Add a regression test (with a runtime-built fake secret) for every new shape.
- Never commit transcripts, databases, or real credentials. Tests assemble fake secrets at runtime (`test/helpers.ts`) so no secret-shaped literal lands in the repo.
- Offsets into transcript files are byte offsets. Never derive them from string lengths.
- Ingestion stays idempotent: events are keyed by `(file, line_offset, block)` and inserted `OR IGNORE`, and anything derived (prompt counts, tool calls, errors) is computed from events rather than stored.
- The transcript format is internal to Claude Code. Unknown entry types are tallied in `unknown_types`, not treated as errors. When one appears, decide whether to parse it or add it to `SKIPPED_TYPES` in `src/core/parse.ts`.
