/** Read-side queries: what the app and CLI show about the ingested data. */
import { basename } from "node:path";
import type { Store } from "./db.ts";
import { isKnownType } from "./parse.ts";

export interface Overview {
  sessions: number;
  files: number;
  events: Record<string, number>;
  unknownTypes: Array<{ type: string; count: number; lastSeen: string }>;
  firstTs: string | null;
  lastTs: string | null;
  lastScanAt: string | null;
}

export function overview(store: Store): Overview {
  const db = store.db;
  const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
  const range = db.query("SELECT MIN(first_ts) AS firstTs, MAX(last_ts) AS lastTs FROM sessions").get() as {
    firstTs: string | null;
    lastTs: string | null;
  };
  const events: Record<string, number> = {};
  for (const row of db.query("SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY n DESC").all() as Array<{
    kind: string;
    n: number;
  }>) {
    events[row.kind] = row.n;
  }
  return {
    sessions: count("SELECT COUNT(*) AS n FROM sessions"),
    files: count("SELECT COUNT(*) AS n FROM files"),
    events,
    unknownTypes: (
      db.query("SELECT type, count, last_seen AS lastSeen FROM unknown_types ORDER BY count DESC").all() as Overview["unknownTypes"]
    )
      // Rows recorded before this version learned a type are history, not drift.
      .filter((row) => !isKnownType(row.type)),
    firstTs: range.firstTs,
    lastTs: range.lastTs,
    lastScanAt: store.getMeta("last_scan_at"),
  };
}

export interface SessionSummary {
  id: string;
  project: string;
  name: string;
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
  firstTs: string | null;
  lastTs: string | null;
  prompts: number;
  toolCalls: number;
  errors: number;
  costUsd: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  prUrl: string | null;
  model: string | null;
}

export function recentSessions(store: Store, limit = 20): SessionSummary[] {
  const rows = store.db
    .query(
      `SELECT s.id, s.project, s.cwd, s.git_branch AS gitBranch, COALESCE(s.title, s.summary) AS title,
              s.first_ts AS firstTs, s.last_ts AS lastTs, s.cost_usd AS costUsd,
              s.lines_added AS linesAdded, s.lines_removed AS linesRemoved, s.pr_url AS prUrl, s.model,
              (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.kind = 'prompt') AS prompts,
              (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.kind = 'tool_use') AS toolCalls,
              (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.kind = 'tool_result' AND e.is_error = 1) AS errors
         FROM sessions s
        ORDER BY s.last_ts DESC NULLS LAST
        LIMIT ?`,
    )
    .all(limit) as Array<Omit<SessionSummary, "name">>;
  return rows.map((row) => ({ ...row, name: projectName(row.cwd, row.project) }));
}

/**
 * A readable project name: the working directory's folder, else the encoded
 * transcript folder. Agents often work in a worktree inside the repo
 * (<repo>/.claude/worktrees/agent-x); those are named after the repo.
 */
export function projectName(cwd: string | null, project: string): string {
  if (cwd) {
    const root = cwd.replace(/\/\.(?:claude|git)\/worktrees\/[^/]+(?:\/.*)?$/, "").replace(/\/+$/, "");
    return basename(root) || root || cwd;
  }
  return project.replace(/^-+/, "") || project;
}
