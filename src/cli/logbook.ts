#!/usr/bin/env bun
/**
 * Logbook without the app window: backfill, follow, and inspect.
 *
 *   bun run ingest     read everything new since the last run
 *   bun run watch      ingest, then follow new agent activity
 *   bun run stats      what is in the database
 *
 * Flags: --root <dir> (transcripts), --db <file>, --limit <n> (stats rows).
 */
import { parseArgs } from "node:util";
import { Store } from "../core/db.ts";
import { type IngestTotals, scanAll, watchTranscripts } from "../core/ingest.ts";
import { dbPath, transcriptsRoot } from "../core/paths.ts";
import { overview, recentSessions } from "../core/stats.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    root: { type: "string" },
    db: { type: "string" },
    watch: { type: "boolean", default: false },
    limit: { type: "string", default: "15" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

const command = values.help ? "help" : (positionals[0] ?? "help");
const root = values.root ?? transcriptsRoot();
const database = values.db ?? dbPath();

switch (command) {
  case "ingest":
    ingest();
    break;
  case "stats":
    stats();
    break;
  default:
    console.log(
      "usage: logbook <ingest [--watch] | stats> [--root <transcripts dir>] [--db <file>] [--limit <n>]\n" +
        `  transcripts: ${root}\n  database:    ${database}`,
    );
}

function ingest(): void {
  const store = new Store(database);
  console.log(`reading ${root}`);
  let lastPrint = 0;
  const totals = scanAll(store, root, (done, total, running) => {
    const now = performance.now();
    if (process.stdout.isTTY && (now - lastPrint > 200 || done === total)) {
      lastPrint = now;
      process.stdout.write(`\r  ${done}/${total} files, ${mb(running.bytes)} new, ${running.events} events`);
    }
  });
  if (process.stdout.isTTY) process.stdout.write("\n");
  report(totals);

  if (!values.watch) {
    store.close();
    return;
  }
  console.log("watching for new agent activity (ctrl-c to stop)");
  const watcher = watchTranscripts(store, root, {
    onChange: (changes) =>
      console.log(`${new Date().toLocaleTimeString()}  +${changes.events} events from ${changes.changedFiles} file(s)`),
  });
  process.on("SIGINT", () => {
    watcher.close();
    store.close();
    process.exit(0);
  });
}

function stats(): void {
  const store = new Store(database);
  const o = overview(store);
  console.log(`${o.sessions} sessions from ${o.files} transcript files, ${o.firstTs?.slice(0, 10) ?? "?"} to ${o.lastTs?.slice(0, 10) ?? "?"}`);
  console.log(
    "events: " +
      Object.entries(o.events)
        .map(([kind, n]) => `${kind} ${n}`)
        .join(", "),
  );
  if (o.unknownTypes.length > 0) {
    console.log(`unrecognized entry types (format drift?): ${o.unknownTypes.map((u) => `${u.type} x${u.count}`).join(", ")}`);
  }
  console.log("");

  const rows = recentSessions(store, Number(values.limit) || 15);
  const table = rows.map((s) => [
    ago(s.lastTs),
    s.name,
    s.gitBranch ?? "",
    `${s.prompts}p ${s.toolCalls}t${s.errors ? ` ${s.errors}e` : ""}`,
    s.costUsd === null ? "" : `$${s.costUsd.toFixed(2)}`,
    s.title ?? "(untitled)",
  ]);
  const widths = [0, 1, 2, 3, 4].map((col) => Math.max(...table.map((r) => (r[col] ?? "").length), 0));
  for (const row of table) {
    console.log(row.map((cell, col) => (col < 5 ? cell.padEnd(widths[col] ?? 0) : cell)).join("  "));
  }
  store.close();
}

function report(t: IngestTotals): void {
  console.log(
    `done in ${(t.ms / 1000).toFixed(1)}s: ${t.changedFiles}/${t.files} files changed, ${t.lines} lines, ` +
      `${t.events} new events, ${t.skipped} skipped, ${t.unknown} unknown, ${t.invalid} invalid` +
      (t.oversized ? `, ${t.oversized} oversized lines skipped` : "") +
      (t.conflicts ? `, ${t.conflicts} chunks already taken by another writer` : ""),
  );
  if (t.failed) console.error(`${t.failed} file(s) could not be read; last error: ${t.lastError}`);
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ago(ts: string | null): string {
  if (!ts) return "?";
  const minutes = Math.round((Date.now() - Date.parse(ts)) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 60 / 24)}d ago`;
}
