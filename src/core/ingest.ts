/**
 * Incremental transcript ingestion.
 *
 * Claude Code appends one JSON object per line to each transcript. Logbook
 * remembers, per file, the byte offset it has read up to, and on every pass
 * reads only the complete lines after it; an unfinished last line is left for
 * the next pass. Offsets are bytes, not string lengths: transcripts are UTF-8
 * and full of multi-byte characters.
 *
 * Nothing here throws on a bad file. One unreadable transcript is counted and
 * reported, and every other file is still read: in the app, an exception that
 * escaped a timer would take the whole process down.
 */
import { closeSync, fstatSync, type FSWatcher, openSync, readdirSync, readSync, statSync, watch } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { ChunkLine, ChunkResult, Store } from "./db.ts";
import { parseLine } from "./parse.ts";

const CHUNK_BYTES = 8 * 1024 * 1024;
/** A single line longer than this is skipped instead of buffered. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const NEWLINE = 0x0a;

const decoder = new TextDecoder("utf-8");

export interface FileIdentity {
  project: string;
  sessionId: string;
  isSubagent: boolean;
}

/**
 * A transcript's path says which session it belongs to:
 *   <project>/<session-id>.jsonl                         the main conversation
 *   <project>/<session-id>/subagents/agent-<id>.jsonl    a subagent it spawned
 */
export function identifyFile(root: string, path: string): FileIdentity | null {
  if (!path.endsWith(".jsonl")) return null;
  const parts = relative(root, path).split(sep);
  if (parts.length < 2 || parts[0] === ".." || parts.some((part) => part === "")) return null;
  const project = parts[0] as string;
  const second = parts[1] as string;
  if (parts.length === 2) return { project, sessionId: second.slice(0, -".jsonl".length), isSubagent: false };
  return { project, sessionId: second, isSubagent: true };
}

export interface IngestTotals {
  files: number;
  changedFiles: number;
  lines: number;
  events: number;
  skipped: number;
  unknown: number;
  invalid: number;
  oversized: number;
  /** Files that could not be read this pass (permissions, I/O, a locked database). */
  failed: number;
  /** Chunks another process had already committed. Harmless; that process owns those bytes. */
  conflicts: number;
  lastError: string | null;
  bytes: number;
  ms: number;
}

export function emptyTotals(): IngestTotals {
  return {
    files: 0,
    changedFiles: 0,
    lines: 0,
    events: 0,
    skipped: 0,
    unknown: 0,
    invalid: 0,
    oversized: 0,
    failed: 0,
    conflicts: 0,
    lastError: null,
    bytes: 0,
    ms: 0,
  };
}

/** Read whatever is new in one transcript. Safe to call any number of times; never throws. */
export function ingestFile(store: Store, root: string, path: string, totals: IngestTotals = emptyTotals()): IngestTotals {
  const id = identifyFile(root, path);
  if (!id) return totals;

  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(totals, path, error); // ENOENT: deleted since listing
    return totals;
  }

  try {
    // fstat the open descriptor, not the path: if the file is replaced while
    // we read, we keep reading the file whose size and inode we checked.
    const stat = fstatSync(fd);
    totals.files++;

    const previous = store.getFile(path);
    let offset = previous?.readOffset ?? 0;
    if (previous && (previous.ino !== stat.ino || stat.size < previous.readOffset)) {
      // Truncated or replaced: what we stored no longer matches the bytes on disk.
      store.forgetFile(path);
      offset = 0;
    }
    if (stat.size <= offset) return totals;
    totals.changedFiles++;

    const commit = (lines: ChunkLine[], startOffset: number, readOffset: number): ChunkResult => {
      const result = store.applyChunk(
        {
          file: path,
          project: id.project,
          fileSessionId: id.sessionId,
          isSubagent: id.isSubagent,
          startOffset,
          readOffset,
          size: stat.size,
          ino: stat.ino,
        },
        lines,
      );
      if (result.conflict) totals.conflicts++;
      totals.lines += result.lines;
      totals.events += result.events;
      totals.skipped += result.skipped;
      totals.unknown += result.unknown;
      totals.invalid += result.invalid;
      return result;
    };

    let window = CHUNK_BYTES;
    while (offset < stat.size) {
      const want = Math.min(window, stat.size - offset);
      const buffer = Buffer.allocUnsafe(want);
      const got = readSync(fd, buffer, 0, want, offset);
      if (got <= 0) break;
      const view = buffer.subarray(0, got);

      const lastNewline = view.lastIndexOf(NEWLINE);
      if (lastNewline === -1) {
        // No complete line in the window.
        if (offset + got >= stat.size) break; // an unfinished last line: the writer is mid-append
        if (window < MAX_LINE_BYTES) {
          window *= 2; // one long line: widen and retry
          continue;
        }
        const next = findNewline(fd, offset + got, stat.size);
        if (next === -1) break;
        totals.oversized++;
        if (commit([], offset, next + 1).conflict) break;
        offset = next + 1;
        window = CHUNK_BYTES;
        continue;
      }

      const consumed = lastNewline + 1;
      const result = commit(splitLines(view.subarray(0, consumed), offset, id.sessionId), offset, offset + consumed);
      if (result.conflict) break; // another writer is ahead in this file; the next pass resumes from its offset
      totals.bytes += consumed;
      offset += consumed;
      window = CHUNK_BYTES;
    }
  } catch (error) {
    // The chunk in flight rolled back with its offset, so the next pass retries it.
    fail(totals, path, error);
  } finally {
    closeSync(fd);
  }
  return totals;
}

/** Every transcript under the root, oldest first so later metadata wins. */
export function listTranscripts(root: string): string[] {
  const found: Array<{ path: string; mtime: number }> = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4) walk(path, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        let mtime = 0;
        try {
          mtime = statSync(path).mtimeMs;
        } catch {
          continue;
        }
        found.push({ path, mtime });
      }
    }
  };
  walk(root, 0);
  return found.sort((a, b) => a.mtime - b.mtime).map((f) => f.path);
}

export function scanAll(
  store: Store,
  root: string,
  onProgress?: (done: number, total: number, totals: IngestTotals) => void,
): IngestTotals {
  const started = performance.now();
  const totals = emptyTotals();
  const files = listTranscripts(root);
  files.forEach((path, index) => {
    ingestFile(store, root, path, totals);
    onProgress?.(index + 1, files.length, totals);
  });
  return finish(store, totals, started);
}

/**
 * scanAll for a process that also serves a UI: yields to the event loop every
 * few milliseconds, so a long first backfill does not freeze the window.
 */
export async function scanAllAsync(
  store: Store,
  root: string,
  onProgress?: (done: number, total: number, totals: IngestTotals) => void,
): Promise<IngestTotals> {
  const started = performance.now();
  const totals = emptyTotals();
  const files = listTranscripts(root);
  let lastYield = performance.now();
  for (const [index, path] of files.entries()) {
    ingestFile(store, root, path, totals);
    if (performance.now() - lastYield > 16) {
      onProgress?.(index + 1, files.length, totals);
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
  onProgress?.(files.length, files.length, totals);
  return finish(store, totals, started);
}

export interface Watcher {
  close(): void;
}

/**
 * Follow new transcript activity. fs.watch gives near-instant updates; a slow
 * periodic rescan catches anything it drops (sleep, event overflow, files
 * replaced by rename). onChange also fires when a pass hit failures, so the
 * caller can show them.
 */
export function watchTranscripts(
  store: Store,
  root: string,
  options: {
    /** "watch" passes cover only files that just changed; "rescan" passes cover every file. */
    onChange?: (totals: IngestTotals, pass: "watch" | "rescan") => void;
    debounceMs?: number;
    rescanMs?: number;
  } = {},
): Watcher {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rescanning = false;

  const report = (totals: IngestTotals, pass: "watch" | "rescan") => {
    // A rescan always reports, so the caller can clear a problem a full pass no longer sees.
    if (pass === "watch" && totals.changedFiles === 0 && totals.failed === 0) return;
    try {
      options.onChange?.(totals, pass);
    } catch (error) {
      console.error("[logbook] onChange handler failed", error);
    }
  };

  const flush = () => {
    timer = null;
    const totals = emptyTotals();
    const paths = [...pending];
    pending.clear();
    for (const path of paths) ingestFile(store, root, path, totals);
    report(totals, "watch");
  };

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const name = filename.toString();
      if (!name.endsWith(".jsonl")) return;
      pending.add(join(root, name));
      timer ??= setTimeout(flush, options.debounceMs ?? 250);
    });
    watcher.on("error", () => {}); // e.g. the root was deleted; the rescan keeps going
  } catch {
    // No transcripts directory yet: the periodic rescan still picks it up once it exists.
  }

  const rescan = setInterval(() => {
    if (rescanning) return;
    rescanning = true;
    scanAllAsync(store, root)
      .then((totals) => report(totals, "rescan"))
      .catch((error) => console.error("[logbook] rescan failed", error))
      .finally(() => {
        rescanning = false;
      });
  }, options.rescanMs ?? 60_000);

  return {
    close() {
      watcher?.close();
      clearInterval(rescan);
      if (timer) clearTimeout(timer);
    },
  };
}

function finish(store: Store, totals: IngestTotals, started: number): IngestTotals {
  totals.ms = performance.now() - started;
  try {
    store.setMeta("last_scan_at", new Date().toISOString());
  } catch (error) {
    fail(totals, "(database)", error);
  }
  return totals;
}

function fail(totals: IngestTotals, path: string, error: unknown): void {
  totals.failed++;
  const reason = (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error));
  totals.lastError = `${basename(path)}: ${reason}`;
}

function splitLines(bytes: Uint8Array, baseOffset: number, fallbackSessionId: string): ChunkLine[] {
  const lines: ChunkLine[] = [];
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(NEWLINE, start);
    const end = newline === -1 ? bytes.length : newline;
    if (end > start) {
      const text = decoder.decode(bytes.subarray(start, end));
      if (text.trim()) lines.push({ offset: baseOffset + start, parsed: parseLine(text, fallbackSessionId) });
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  return lines;
}

/** Absolute position of the next newline at or after `from`, or -1. */
function findNewline(fd: number, from: number, size: number): number {
  const step = 1024 * 1024;
  const buffer = Buffer.allocUnsafe(step);
  for (let position = from; position < size; position += step) {
    const got = readSync(fd, buffer, 0, Math.min(step, size - position), position);
    if (got <= 0) return -1;
    const index = buffer.subarray(0, got).indexOf(NEWLINE);
    if (index !== -1) return position + index;
  }
  return -1;
}
