/**
 * The live board: every running agent, what it is doing in plain English, and
 * which ones are waiting on you.
 *
 * With herdr, the list of agents and their states come from herdr (it watches
 * the terminals), and each agent is joined to its Logbook session by title and
 * working directory to add what the transcript knows: the current action, your
 * last prompt, recent errors, the PR. Without herdr, the board shows sessions
 * with recent transcript activity and infers working/idle from recency.
 *
 * No model calls here: "plain English" comes from the tool calls themselves
 * (Claude's Bash calls carry a one-line description). Model summaries are chunk 3.
 */
import { basename, dirname } from "node:path";
import type { Store } from "./db.ts";
import { type AgentState, cleanTitle, type HerdrAgent } from "./herdr.ts";
import { projectName } from "./stats.ts";

export interface BoardItem {
  /** Pane id when herdr knows the agent, else the session id. */
  key: string;
  /** Present when herdr can focus this agent's pane. */
  paneId: string | null;
  sessionId: string | null;
  agent: string;
  status: AgentState;
  title: string;
  project: string;
  branch: string | null;
  /** What it is doing (working) or did last (otherwise), in plain English. */
  action: string | null;
  /** The action is the agent's last reply rather than a tool call. */
  actionIsReply: boolean;
  actionAt: string | null;
  /** The latest tool call has no result yet: running, or waiting for your approval. */
  pending: boolean;
  /** Your last prompt to this agent, first line. */
  lastPrompt: string | null;
  /** Tool errors in the last 30 minutes. */
  recentErrors: number;
  prUrl: string | null;
}

export interface Board {
  source: "herdr" | "transcripts";
  items: BoardItem[];
}

/** Agents that need you: blocked on a question or permission, or done and unseen. */
export function waitingOn(board: Board): BoardItem[] {
  return board.items.filter((item) => item.status === "blocked" || item.status === "done");
}

const RANK: Record<AgentState, number> = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 };
const WORKING_WINDOW_MS = 2 * 60_000;
const FALLBACK_WINDOW_MS = 30 * 60_000;
const ERROR_WINDOW_MS = 30 * 60_000;

interface SessionRow {
  id: string;
  project: string;
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
  lastTs: string | null;
  prUrl: string | null;
}

export function buildBoard(store: Store, agents: HerdrAgent[] | null, now = Date.now()): Board {
  if (agents) {
    // One card per pane, even if herdr ever reports a pane twice.
    agents = agents.filter((agent, index, all) => all.findIndex((other) => other.paneId === agent.paneId) === index);
    const sessions = sessionsSince(store, new Date(now - 7 * 24 * 3_600_000).toISOString());
    const matched = matchAgents(agents, sessions);
    const items = agents.map((agent) => {
      const session = matched.get(agent.paneId) ?? null;
      return item(store, session, now, {
        key: agent.paneId,
        paneId: agent.paneId,
        agent: agent.agent,
        status: agent.state,
        title: agent.title || session?.title || "Untitled agent",
        // The pane's directory is the project the agent was started in; the
        // transcript's last cwd may be a worktree it moved into.
        project: agent.cwd ? projectName(agent.cwd, agent.cwd) : session ? projectName(session.cwd, session.project) : agent.agent,
      });
    });
    return { source: "herdr", items: sorted(items) };
  }

  const sessions = sessionsSince(store, new Date(now - FALLBACK_WINDOW_MS).toISOString());
  const items = sessions.map((session) =>
    item(store, session, now, {
      key: session.id,
      paneId: null,
      agent: "claude",
      status: session.lastTs && now - Date.parse(session.lastTs) < WORKING_WINDOW_MS ? "working" : "idle",
      title: session.title || "Untitled session",
      project: projectName(session.cwd, session.project),
    }),
  );
  return { source: "transcripts", items: sorted(items) };
}

/**
 * Join herdr agents to sessions. Claude Code puts the session's title in the
 * terminal title, so the title identifies the session, and the working
 * directory breaks ties. Matching runs in passes across all agents, strongest
 * evidence first (same directory, then a worktree under the agent's directory,
 * then title alone, most recent first), so one agent cannot take the session
 * that clearly belongs to another. Each session is used once. Only Claude
 * agents have transcripts here; others are shown without one.
 */
export function matchAgents(agents: HerdrAgent[], sessions: SessionRow[]): Map<string, SessionRow> {
  const byTitle = new Map<string, SessionRow[]>();
  for (const session of sessions) {
    const key = normalize(session.title);
    if (!key) continue;
    byTitle.set(key, [...(byTitle.get(key) ?? []), session]);
  }
  const passes: Array<(agent: HerdrAgent, session: SessionRow) => boolean> = [
    (agent, session) => agent.cwd !== null && session.cwd === agent.cwd,
    (agent, session) => agent.cwd !== null && session.cwd !== null && session.cwd.startsWith(`${agent.cwd}/`),
    () => true,
  ];
  const used = new Set<string>();
  const matched = new Map<string, SessionRow>();
  for (const pass of passes) {
    for (const agent of agents) {
      if (agent.agent !== "claude" || matched.has(agent.paneId)) continue;
      const best = (byTitle.get(normalize(agent.title)) ?? [])
        .filter((session) => !used.has(session.id) && pass(agent, session))
        .sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? ""))[0];
      if (best) {
        used.add(best.id);
        matched.set(agent.paneId, best);
      }
    }
  }
  return matched;
}

interface LatestEvent {
  kind: string;
  name: string | null;
  text: string;
  filePath: string | null;
  sidechain: number;
  toolUseId: string | null;
  ts: string | null;
}

/** One line saying what an event was, for a person glancing at the board. */
export function describeAction(event: Pick<LatestEvent, "kind" | "name" | "text" | "filePath" | "sidechain">): string {
  const prefix = event.sidechain ? "Subagent: " : "";
  const lines = event.text.split("\n");
  const first = lines[0] ?? "";
  if (event.kind === "assistant_text") return `${prefix}${short(firstSentence(event.text), 140)}`;
  if (event.kind !== "tool_use") return `${prefix}${short(first, 140)}`;

  const name = event.name ?? "a tool";
  const file = () => fileLabel(event.filePath ?? first.replace(/ \(.*$/, ""));
  switch (name) {
    case "Bash": {
      // Stored as "# description\n$ command". Rows from before that format put
      // the description last; a "# " line anywhere else is part of the command.
      const last = lines[lines.length - 1] ?? "";
      const description = first.startsWith("# ")
        ? first.slice(2)
        : first.startsWith("$ ") && lines.length > 1 && last.startsWith("# ")
          ? last.slice(2)
          : null;
      const command = (first.startsWith("# ") ? (lines[1] ?? "") : first).replace(/^\$ /, "");
      return prefix + (description?.trim() ? capitalize(description.trim()) : `Running \`${short(command, 60)}\``);
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `${prefix}Editing ${file()}`;
    case "Write":
      return `${prefix}Writing ${file()}`;
    case "Read":
      return `${prefix}Reading ${file()}`;
    case "Grep":
      return `${prefix}Searching the code for ${short(first.match(/^grep (".*?")/)?.[1] ?? first, 50)}`;
    case "Glob":
      return `${prefix}Looking for files matching ${short(first.replace(/^glob /, ""), 50)}`;
    case "Agent":
    case "Task":
      return `${prefix}Handing off to a subagent: ${short(first.replace(/^[^:]*:\s*/, ""), 80)}`;
    case "WebFetch":
      return `${prefix}Reading ${host(first)}`;
    case "WebSearch":
      return `${prefix}Searching the web for "${short(first, 60)}"`;
    case "Skill":
      return `${prefix}Running ${short(first, 60)}`;
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return `${prefix}Updating its task list`;
    case "AskUserQuestion":
      return `${prefix}Asking you a question`;
    case "ExitPlanMode":
      return `${prefix}Waiting for you to approve its plan`;
    default: {
      if (name.startsWith("mcp__")) {
        const [, server = "", tool = ""] = name.split("__");
        return `${prefix}${capitalize(server.replace(/[-_]/g, " "))}: ${tool.replace(/_/g, " ")}`;
      }
      return `${prefix}Using ${name}`;
    }
  }
}

function item(
  store: Store,
  session: SessionRow | null,
  now: number,
  fields: Pick<BoardItem, "key" | "paneId" | "agent" | "status" | "title" | "project">,
): BoardItem {
  if (!session) {
    return {
      ...fields,
      sessionId: null,
      branch: null,
      action: null,
      actionIsReply: false,
      actionAt: null,
      pending: false,
      lastPrompt: null,
      recentErrors: 0,
      prUrl: null,
    };
  }
  const db = store.db;
  const prompt = db
    .query("SELECT text, ts FROM events WHERE session_id = ? AND kind = 'prompt' ORDER BY ts DESC, id DESC LIMIT 1")
    .get(session.id) as { text: string; ts: string | null } | null;
  // The current turn starts at your last prompt (bounded to a day for sessions without one).
  const turnStart = prompt?.ts ?? new Date(now - 24 * 3_600_000).toISOString();
  // What is running, or waiting for approval: the EARLIEST tool call of this
  // turn with no result yet, since tools run in order. A subagent hand-off is
  // used only when nothing more specific is outstanding: the subagent's own
  // call says more than "handing off".
  const unresolved = db
    .query(
      `SELECT kind, name, text, file_path AS filePath, sidechain, tool_use_id AS toolUseId, ts
         FROM events e
        WHERE e.session_id = ? AND e.kind = 'tool_use' AND e.tool_use_id IS NOT NULL AND e.ts >= ?
          AND NOT EXISTS (SELECT 1 FROM events r WHERE r.tool_use_id = e.tool_use_id AND r.kind = 'tool_result')
        ORDER BY (e.name IN ('Agent', 'Task')) ASC, e.ts ASC, e.id ASC
        LIMIT 1`,
    )
    .get(session.id, turnStart) as LatestEvent | null;
  const latest =
    unresolved ??
    (db
      .query(
        `SELECT kind, name, text, file_path AS filePath, sidechain, tool_use_id AS toolUseId, ts
           FROM events
          WHERE session_id = ? AND kind IN ('tool_use', 'assistant_text')
          ORDER BY ts DESC, id DESC LIMIT 1`,
      )
      .get(session.id) as LatestEvent | null);
  const pending = unresolved !== null;
  const errors = db
    .query(
      "SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND kind = 'tool_result' AND is_error = 1 AND ts >= ?",
    )
    .get(session.id, new Date(now - ERROR_WINDOW_MS).toISOString()) as { n: number };

  return {
    ...fields,
    sessionId: session.id,
    branch: session.gitBranch,
    action: latest ? describeAction(latest) : null,
    actionIsReply: latest?.kind === "assistant_text",
    actionAt: latest?.ts ?? null,
    pending,
    lastPrompt: prompt ? short(firstLine(prompt.text), 160) : null,
    recentErrors: errors.n,
    prUrl: session.prUrl,
  };
}

function sessionsSince(store: Store, since: string): SessionRow[] {
  return store.db
    .query(
      `SELECT id, project, cwd, git_branch AS gitBranch, COALESCE(title, summary) AS title,
              last_ts AS lastTs, pr_url AS prUrl
         FROM sessions WHERE last_ts >= ? ORDER BY last_ts DESC LIMIT 200`,
    )
    .all(since) as SessionRow[];
}

function sorted(items: BoardItem[]): BoardItem[] {
  return items.sort(
    (a, b) => RANK[a.status] - RANK[b.status] || (b.actionAt ?? "").localeCompare(a.actionAt ?? ""),
  );
}

function normalize(title: string | null): string {
  return cleanTitle(title ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function fileLabel(path: string): string {
  if (!path) return "a file";
  const parent = basename(dirname(path));
  return parent && parent !== "." && parent !== "/" ? `${parent}/${basename(path)}` : basename(path);
}

function host(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return short(url, 60);
  }
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function firstSentence(text: string): string {
  const line = firstLine(text.replace(/^[#>*\s-]+/, ""));
  const end = line.search(/[.!?](\s|$)/);
  return end > 0 ? line.slice(0, end + 1) : line;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function short(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
