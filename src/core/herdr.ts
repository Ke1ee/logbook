/**
 * herdr adapter. herdr (a terminal workspace manager for AI coding agents)
 * already knows every agent pane and whether it is working, blocked, done or
 * idle. Logbook reads that instead of guessing, joins it to transcript data,
 * and asks herdr to focus a pane when you want to jump to an agent.
 *
 * herdr is optional: without it the board falls back to transcript recency.
 * This is the only file that knows herdr's JSON shape. Programs run through
 * proc.ts (argument arrays, bounded, never throwing), and pane ids are
 * validated before they reach a command line.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LIMITS, safe } from "./parse.ts";
import { runCommand } from "./proc.ts";

export type AgentState = "working" | "blocked" | "done" | "idle" | "unknown";

export interface HerdrAgent {
  paneId: string;
  /** "claude", "codex", ... */
  agent: string;
  state: AgentState;
  /** Redacted the same way as stored session data, so the two compare equal. */
  cwd: string | null;
  /** Terminal title, spinner glyphs removed, redacted. */
  title: string;
}

export interface Herdr {
  /** Current agents, or null when herdr is unreachable or answers with something unexpected. */
  list(): Promise<HerdrAgent[] | null>;
  focus(paneId: string): Promise<boolean>;
}

const STATES: ReadonlySet<string> = new Set(["working", "blocked", "done", "idle"]);
/** Starts with a letter or digit, so an id can never be read as a command-line flag. */
const PANE_ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;

/** Parse `herdr agent list` output. Null when it is not the shape we know. */
export function parseAgentList(json: string): HerdrAgent[] | null {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return null;
  }
  const agents = record(record(doc)?.result)?.agents;
  if (!Array.isArray(agents)) return null;
  const seen = new Set<string>();
  return agents.flatMap((raw): HerdrAgent[] => {
    const a = record(raw);
    const paneId = typeof a?.pane_id === "string" ? a.pane_id : null;
    if (!a || !paneId || !PANE_ID.test(paneId) || seen.has(paneId)) return [];
    seen.add(paneId);
    const status = typeof a.agent_status === "string" ? a.agent_status : "";
    const cwd = text(a.cwd) ?? text(a.foreground_cwd);
    // Terminal titles are agent-written text like any transcript field: redact before use.
    const title = cleanTitle(text(a.terminal_title_stripped) ?? text(a.terminal_title) ?? "");
    return [
      {
        paneId,
        agent: text(a.agent) ?? "agent",
        state: STATES.has(status) ? (status as AgentState) : "unknown",
        cwd: cwd ? safe(cwd, 1_000) : null,
        title: title ? safe(title, LIMITS.title) : "",
      },
    ];
  });
}

/** Agents prefix their terminal title with spinners and marks (◐ ✳ ⠋); drop them. */
export function cleanTitle(title: string): string {
  return title.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

/** Where herdr lives. GUI apps get a minimal PATH, so look in the usual install spots too. */
export function findHerdr(env: Record<string, string | undefined> = process.env): string | null {
  const candidates = [
    env.LOGBOOK_HERDR_BIN,
    Bun.which("herdr"),
    join(homedir(), ".local", "bin", "herdr"),
    "/opt/homebrew/bin/herdr",
    "/usr/local/bin/herdr",
  ];
  return candidates.find((path): path is string => Boolean(path && existsSync(path))) ?? null;
}

export function herdrClient(bin: string | null = findHerdr()): Herdr | null {
  if (!bin) return null;
  return {
    async list() {
      const out = await runCommand([bin, "agent", "list"]);
      return out === null ? null : parseAgentList(out);
    },
    async focus(paneId) {
      if (!PANE_ID.test(paneId)) return false;
      return (await runCommand([bin, "agent", "focus", paneId])) !== null;
    },
  };
}

/**
 * The .app hosting herdr's client (Ghostty, iTerm, ...): walk up the process
 * tree from each herdr process until an app bundle appears. herdr's server is
 * a child of launchd and finds nothing; its client finds the terminal.
 */
export async function findTerminalApp(): Promise<string | null> {
  const pids = (await runCommand(["/usr/bin/pgrep", "-x", "herdr"], 2_000))?.split("\n").filter((p) => /^\d+$/.test(p)) ?? [];
  for (const start of pids) {
    let pid = start;
    for (let depth = 0; depth < 16 && pid !== "0" && pid !== "1"; depth++) {
      const line = (await runCommand(["/bin/ps", "-o", "ppid=,comm=", "-p", pid], 2_000))?.trim();
      const match = line?.match(/^(\d+)\s+(.+)$/);
      if (!match) break;
      const app = match[2]?.match(/^(.+?\.app)\/Contents\/MacOS\//)?.[1];
      if (app) return app;
      pid = match[1] as string;
    }
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
