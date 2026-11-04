/**
 * Logbook's SQLite store.
 *
 * Ingestion is idempotent by construction: every event is keyed by
 * (file, byte offset of its line, block index) and inserted with OR IGNORE,
 * session time ranges only ever widen, and each chunk of lines commits in the
 * same transaction as the file's new read offset. A crash mid-chunk rolls back
 * to the previous offset, and re-reading those bytes yields the same keys, so
 * nothing is counted twice.
 *
 * Counts (prompts, tool calls, errors) are never stored; they are computed
 * from events, so they cannot drift.
 */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ParsedLine, SessionPatch } from "./parse.ts";
import { REDACTION_FINGERPRINT, redact } from "./redact.ts";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per transcript file: how far into it Logbook has read.
CREATE TABLE IF NOT EXISTS files (
  path        TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  is_subagent INTEGER NOT NULL DEFAULT 0,
  read_offset INTEGER NOT NULL DEFAULT 0,
  size        INTEGER NOT NULL DEFAULT 0,
  ino         INTEGER,
  lines       INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  project       TEXT NOT NULL,
  cwd           TEXT,
  git_branch    TEXT,
  title         TEXT,
  summary       TEXT,
  version       TEXT,
  entrypoint    TEXT,
  model         TEXT,
  first_ts      TEXT,
  last_ts       TEXT,
  cost_usd      REAL,
  lines_added   INTEGER,
  lines_removed INTEGER,
  pr_url        TEXT
);
CREATE INDEX IF NOT EXISTS sessions_last_ts ON sessions (last_ts);

CREATE TABLE IF NOT EXISTS session_prs (
  session_id TEXT NOT NULL,
  pr_url     TEXT NOT NULL,
  first_seen TEXT,
  PRIMARY KEY (session_id, pr_url)
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  file        TEXT NOT NULL,
  line_offset INTEGER NOT NULL,
  block       INTEGER NOT NULL,
  session_id  TEXT NOT NULL,
  uuid        TEXT,
  ts          TEXT,
  kind        TEXT NOT NULL,
  sidechain   INTEGER NOT NULL DEFAULT 0,
  name        TEXT,
  tool_use_id TEXT,
  file_path   TEXT,
  is_error    INTEGER NOT NULL DEFAULT 0,
  size        INTEGER NOT NULL DEFAULT 0,
  text        TEXT NOT NULL,
  UNIQUE (file, line_offset, block)
);
CREATE INDEX IF NOT EXISTS events_session_kind ON events (session_id, kind);
CREATE INDEX IF NOT EXISTS events_session_ts ON events (session_id, ts);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);

-- Entry types the parser has never seen: the early warning for format drift.
CREATE TABLE IF NOT EXISTS unknown_types (
  type        TEXT PRIMARY KEY,
  count       INTEGER NOT NULL,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  sample_file TEXT
);
`;

export interface FileState {
  path: string;
  readOffset: number;
  size: number;
  ino: number | null;
  lines: number;
}

export interface ChunkLine {
  /** Byte offset of the line within its file. */
  offset: number;
  parsed: ParsedLine;
}

export interface ChunkMeta {
  file: string;
  project: string;
  /** Session the file belongs to by its path; entries may name their own. */
  fileSessionId: string;
  isSubagent: boolean;
  /** Byte offset this chunk was read from: must still be the stored offset when it commits. */
  startOffset: number;
  /** Byte offset just past the last complete line in this chunk. */
  readOffset: number;
  size: number;
  ino: number;
}

export interface ChunkResult {
  lines: number;
  events: number;
  skipped: number;
  unknown: number;
  invalid: number;
  /** Another writer already committed these bytes; nothing was written. */
  conflict: boolean;
}

interface SessionAccumulator {
  id: string;
  project: string;
  firstTs: string | null;
  lastTs: string | null;
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
  summary: string | null;
  version: string | null;
  entrypoint: string | null;
  model: string | null;
  costUsd: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  prUrl: string | null;
}

const METADATA_FIELDS = [
  "cwd",
  "gitBranch",
  "title",
  "summary",
  "version",
  "entrypoint",
  "model",
  "costUsd",
  "linesAdded",
  "linesRemoved",
  "prUrl",
] as const;

export class Store {
  readonly db: Database;

  constructor(path: string) {
    const inMemory = path === ":memory:";
    if (!inMemory) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

    // The database is a (redacted) record of your work: keep the file and its
    // WAL/SHM siblings readable by this user only.
    const previousMask = process.umask(0o077);
    let db: Database;
    try {
      db = new Database(path, { create: true, strict: true });
      // busy_timeout must come first: switching to WAL takes a lock that a
      // second process opening the same file at the same moment would
      // otherwise fail on immediately.
      db.exec("PRAGMA busy_timeout = 5000");
      retryBusy(() => db.exec("PRAGMA journal_mode = WAL"));
      db.exec("PRAGMA synchronous = NORMAL");
    } finally {
      process.umask(previousMask);
    }
    if (!inMemory) chmodSync(path, 0o600);

    retryBusy(() => db.exec(SCHEMA));
    this.db = db;
    retryBusy(() => this.setMeta("schema_version", String(SCHEMA_VERSION)));
    this.reRedact(REDACTION_FINGERPRINT, redact);
  }

  /**
   * Apply the current redaction rules to text stored under older ones. Runs
   * once per rule change (a few seconds for a large database) and is a no-op
   * otherwise. Re-redacting is safe: markers left by earlier passes survive.
   * Returns how many rows changed.
   */
  reRedact(fingerprint: string, transform: (text: string) => string): number {
    if (this.getMeta("redaction_fingerprint") === fingerprint) return 0;
    let changed = 0;
    const clean = (value: string | null) => (value === null ? null : transform(value));

    const page = this.db.query(
      "SELECT id, text, file_path AS filePath, name FROM events WHERE id > ? ORDER BY id LIMIT 2000",
    );
    const updateEvent = this.db.query("UPDATE events SET text = $text, file_path = $filePath, name = $name WHERE id = $id");
    for (let after = 0; ; ) {
      const rows = page.all(after) as Array<{ id: number; text: string; filePath: string | null; name: string | null }>;
      if (rows.length === 0) break;
      this.db
        .transaction(() => {
          for (const row of rows) {
            const next = { id: row.id, text: transform(row.text), filePath: clean(row.filePath), name: clean(row.name) };
            if (next.text !== row.text || next.filePath !== row.filePath || next.name !== row.name) {
              updateEvent.run(next);
              changed++;
            }
          }
        })
        .immediate();
      after = (rows[rows.length - 1] as { id: number }).id;
    }

    const sessions = this.db
      .query("SELECT id, cwd, git_branch AS gitBranch, title, summary FROM sessions")
      .all() as Array<{ id: string; cwd: string | null; gitBranch: string | null; title: string | null; summary: string | null }>;
    const updateSession = this.db.query(
      "UPDATE sessions SET cwd = $cwd, git_branch = $gitBranch, title = $title, summary = $summary WHERE id = $id",
    );
    this.db
      .transaction(() => {
        for (const row of sessions) {
          const next = { id: row.id, cwd: clean(row.cwd), gitBranch: clean(row.gitBranch), title: clean(row.title), summary: clean(row.summary) };
          if (next.cwd !== row.cwd || next.gitBranch !== row.gitBranch || next.title !== row.title || next.summary !== row.summary) {
            updateSession.run(next);
            changed++;
          }
        }
      })
      .immediate();

    this.setMeta("redaction_fingerprint", fingerprint);
    return changed;
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | null {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  getFile(path: string): FileState | null {
    const row = this.db
      .query("SELECT path, read_offset, size, ino, lines FROM files WHERE path = ?")
      .get(path) as { path: string; read_offset: number; size: number; ino: number | null; lines: number } | null;
    return row ? { path: row.path, readOffset: row.read_offset, size: row.size, ino: row.ino, lines: row.lines } : null;
  }

  /** Drop everything read from a file that was truncated or replaced, so it can be re-read from byte 0. */
  forgetFile(path: string): void {
    this.db
      .transaction(() => {
        this.db.query("DELETE FROM events WHERE file = ?").run(path);
        this.db.query("DELETE FROM files WHERE path = ?").run(path);
      })
      .immediate();
  }

  applyChunk(meta: ChunkMeta, lines: readonly ChunkLine[]): ChunkResult {
    const result: ChunkResult = { lines: 0, events: 0, skipped: 0, unknown: 0, invalid: 0, conflict: false };
    const storedOffset = this.db.query("SELECT read_offset FROM files WHERE path = ?");

    const insertEvent = this.db.query(`
      INSERT OR IGNORE INTO events
        (file, line_offset, block, session_id, uuid, ts, kind, sidechain, name, tool_use_id, file_path, is_error, size, text)
      VALUES
        ($file, $lineOffset, $block, $sessionId, $uuid, $ts, $kind, $sidechain, $name, $toolUseId, $filePath, $isError, $size, $text)`);
    const insertPr = this.db.query(`
      INSERT OR IGNORE INTO session_prs (session_id, pr_url, first_seen) VALUES ($sessionId, $prUrl, $ts)`);
    const noteUnknown = this.db.query(`
      INSERT INTO unknown_types (type, count, first_seen, last_seen, sample_file) VALUES ($type, 1, $now, $now, $file)
      ON CONFLICT(type) DO UPDATE SET count = unknown_types.count + 1, last_seen = excluded.last_seen`);
    const upsertSession = this.db.query(`
      INSERT INTO sessions
        (id, project, cwd, git_branch, title, summary, version, entrypoint, model, first_ts, last_ts, cost_usd, lines_added, lines_removed, pr_url)
      VALUES
        ($id, $project, $cwd, $gitBranch, $title, $summary, $version, $entrypoint, $model, $firstTs, $lastTs, $costUsd, $linesAdded, $linesRemoved, $prUrl)
      ON CONFLICT(id) DO UPDATE SET
        cwd           = COALESCE(excluded.cwd, sessions.cwd),
        git_branch    = COALESCE(excluded.git_branch, sessions.git_branch),
        title         = COALESCE(excluded.title, sessions.title),
        summary       = COALESCE(excluded.summary, sessions.summary),
        version       = COALESCE(excluded.version, sessions.version),
        entrypoint    = COALESCE(excluded.entrypoint, sessions.entrypoint),
        model         = COALESCE(excluded.model, sessions.model),
        first_ts      = CASE WHEN sessions.first_ts IS NULL OR excluded.first_ts < sessions.first_ts
                             THEN COALESCE(excluded.first_ts, sessions.first_ts) ELSE sessions.first_ts END,
        last_ts       = CASE WHEN sessions.last_ts IS NULL OR excluded.last_ts > sessions.last_ts
                             THEN COALESCE(excluded.last_ts, sessions.last_ts) ELSE sessions.last_ts END,
        cost_usd      = COALESCE(excluded.cost_usd, sessions.cost_usd),
        lines_added   = COALESCE(excluded.lines_added, sessions.lines_added),
        lines_removed = COALESCE(excluded.lines_removed, sessions.lines_removed),
        pr_url        = COALESCE(excluded.pr_url, sessions.pr_url)`);
    const upsertFile = this.db.query(`
      INSERT INTO files (path, project, session_id, is_subagent, read_offset, size, ino, lines, updated_at)
      VALUES ($path, $project, $sessionId, $isSubagent, $readOffset, $size, $ino, $lines, $now)
      ON CONFLICT(path) DO UPDATE SET
        read_offset = excluded.read_offset,
        size        = excluded.size,
        ino         = excluded.ino,
        lines       = files.lines + excluded.lines,
        updated_at  = excluded.updated_at`);

    const write = () => {
      // Compare-and-set on the read offset. The CLI and the app can both be
      // ingesting; if another writer already committed these bytes, the stored
      // offset has moved and this chunk is stale. Writing it anyway would move
      // the offset backwards and count lines and unknown types twice.
      const current = (storedOffset.get(meta.file) as { read_offset: number } | null)?.read_offset ?? 0;
      if (current !== meta.startOffset) {
        result.conflict = true;
        return;
      }
      result.lines = lines.length;
      const now = new Date().toISOString();
      const sessions = new Map<string, SessionAccumulator>();

      for (const { offset, parsed } of lines) {
        if (parsed.status === "invalid") {
          result.invalid++;
        } else if (parsed.status === "skipped") {
          result.skipped++;
        } else if (parsed.status === "unknown") {
          result.unknown++;
          noteUnknown.run({ type: parsed.type, now, file: meta.file });
        } else {
          const { session, events } = parsed;
          for (const ev of events) {
            const changed = insertEvent.run({
              file: meta.file,
              lineOffset: offset,
              block: ev.block,
              sessionId: session.sessionId,
              uuid: ev.uuid,
              ts: ev.ts,
              kind: ev.kind,
              sidechain: ev.sidechain ? 1 : 0,
              name: ev.name,
              toolUseId: ev.toolUseId,
              filePath: ev.filePath,
              isError: ev.isError ? 1 : 0,
              size: ev.size,
              text: ev.text,
            });
            result.events += changed.changes;
          }
          accumulate(sessions, session, meta);
          if (session.prUrl && !meta.isSubagent) {
            insertPr.run({ sessionId: session.sessionId, prUrl: session.prUrl, ts: session.ts });
          }
        }
      }

      for (const s of sessions.values()) upsertSession.run({ ...s });
      upsertFile.run({
        path: meta.file,
        project: meta.project,
        sessionId: meta.fileSessionId,
        isSubagent: meta.isSubagent ? 1 : 0,
        readOffset: meta.readOffset,
        size: meta.size,
        ino: meta.ino,
        lines: lines.length,
        now,
      });
    };

    // IMMEDIATE takes the write lock up front, so the offset check and the
    // writes after it are atomic with respect to any other process.
    this.db.transaction(write).immediate();
    return result;
  }
}

/**
 * Run a statement that can hit SQLITE_BUSY while another process is creating
 * or recovering the same database (busy_timeout does not cover every case).
 */
function retryBusy(run: () => unknown): void {
  for (let attempt = 0; ; attempt++) {
    try {
      run();
      return;
    } catch (error) {
      if (attempt >= 20 || !/BUSY|LOCKED/i.test(String((error as { code?: string }).code ?? error))) throw error;
      Bun.sleepSync(25 * (attempt + 1));
    }
  }
}

function accumulate(map: Map<string, SessionAccumulator>, patch: SessionPatch, meta: ChunkMeta): void {
  let acc = map.get(patch.sessionId);
  if (!acc) {
    acc = {
      id: patch.sessionId,
      project: meta.project,
      firstTs: null,
      lastTs: null,
      cwd: null,
      gitBranch: null,
      title: null,
      summary: null,
      version: null,
      entrypoint: null,
      model: null,
      costUsd: null,
      linesAdded: null,
      linesRemoved: null,
      prUrl: null,
    };
    map.set(patch.sessionId, acc);
  }
  if (patch.ts) {
    if (!acc.firstTs || patch.ts < acc.firstTs) acc.firstTs = patch.ts;
    if (!acc.lastTs || patch.ts > acc.lastTs) acc.lastTs = patch.ts;
  }
  // Subagent transcripts only widen the session's time range. Its title,
  // branch and totals come from the main conversation.
  if (meta.isSubagent) return;
  for (const field of METADATA_FIELDS) {
    const value = patch[field];
    if (value !== null) (acc as unknown as Record<string, unknown>)[field] = value;
  }
}
