/**
 * Turns one line of a Claude Code transcript into rows Logbook stores.
 *
 * The transcript format is internal to Claude Code and changes between
 * versions, so this parser is deliberately tolerant: it pulls out the fields it
 * understands, ignores the rest, and reports entry types it has never seen as
 * "unknown" so format drift shows up in the app instead of silently dropping
 * data.
 *
 * Every string it returns has already been redacted and truncated.
 */
import { redact } from "./redact.ts";
import { clip, head } from "./text.ts";

export type EventKind =
  | "prompt" // something a person typed
  | "command" // a slash command or `!` shell command a person ran
  | "interrupt" // a person stopped the agent mid-turn
  | "subagent_prompt" // the task a parent agent handed to a subagent
  | "assistant_text" // prose the agent showed
  | "tool_use" // a tool call: Bash, Edit, Read, an MCP tool, ...
  | "tool_result" // what the tool returned, truncated
  | "system"; // compaction boundaries, away summaries, notices

export interface ParsedEvent {
  kind: EventKind;
  /** Index of the content block within its transcript entry. */
  block: number;
  uuid: string | null;
  ts: string | null;
  sidechain: boolean;
  /** Tool name for tool_use, subtype for system events. */
  name: string | null;
  toolUseId: string | null;
  /** File the tool touched, when its input names one. */
  filePath: string | null;
  isError: boolean;
  /** Length of the original content, before redaction and truncation. */
  size: number;
  /** Redacted and truncated: safe to store and display. */
  text: string;
}

export interface SessionPatch {
  sessionId: string;
  ts: string | null;
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  entrypoint: string | null;
  model: string | null;
  title: string | null;
  summary: string | null;
  prUrl: string | null;
  costUsd: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
}

export type ParsedLine =
  | { status: "ok"; type: string; session: SessionPatch; events: ParsedEvent[] }
  | { status: "skipped"; type: string }
  | { status: "unknown"; type: string }
  | { status: "invalid" };

/** Stored-text limits, applied after redaction. */
export const LIMITS = {
  prose: 50_000,
  toolInput: 4_000,
  toolResult: 2_000,
  system: 2_000,
  title: 200,
} as const;

/**
 * Entry types with no learning signal: request logs, UI state, file-backup
 * bookkeeping. Most start with {"type":"...", so they are dropped before
 * JSON.parse. That matters: api-request entries are the bulk of every
 * transcript by bytes.
 */
export const SKIPPED_TYPES: ReadonlySet<string> = new Set([
  // agent-name may be worth reading once the live board labels subagents.
  "agent-color",
  "agent-name",
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "artifact-autoreact-ledger",
  "artifact-comment-monitor",
  "atis-latch",
  "attachment",
  "bridge-session",
  "file-history-delta",
  "file-history-snapshot",
  "frame-link",
  "last-prompt",
  "mode",
  "permission-mode",
  "queue-operation",
  "session-owner",
  "tools-used",
]);

const KEPT_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set(["away_summary", "compact_boundary", "informational"]);

const TYPE_PREFIX = '{"type":"';

/** User-role text the harness injected rather than a person typed. */
const HARNESS_TEXT =
  /^\s*<(?:system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr|task-notification|user-prompt-submit-hook)\b/;
const COMMAND_TEXT = /^\s*<(?:command-name|command-message|command-args|bash-input)\b/;
const INTERRUPT_TEXT = /^\s*\[Request interrupted/;

type Json = Record<string, unknown>;

export function parseLine(line: string, fallbackSessionId: string): ParsedLine {
  if (line.startsWith(TYPE_PREFIX)) {
    const end = line.indexOf('"', TYPE_PREFIX.length);
    const type = end > 0 ? line.slice(TYPE_PREFIX.length, end) : "";
    if (SKIPPED_TYPES.has(type)) return { status: "skipped", type };
  }

  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return { status: "invalid" };
  }
  if (!isRecord(entry)) return { status: "invalid" };

  const type = typeof entry.type === "string" ? entry.type : "";
  if (SKIPPED_TYPES.has(type)) return { status: "skipped", type };

  const session = basePatch(entry, fallbackSessionId);
  const ok = (events: ParsedEvent[] = []): ParsedLine => ({ status: "ok", type, session, events });

  switch (type) {
    case "user":
      return ok(userEvents(entry, session.ts));
    case "assistant": {
      const model = field(asRecord(entry.message)?.model, 200);
      if (model && model !== "<synthetic>") session.model = model;
      return ok(assistantEvents(entry, session.ts));
    }
    case "system":
      return ok(systemEvents(entry, session.ts));
    case "ai-title":
      session.title = title(entry.aiTitle);
      return ok();
    case "summary":
      session.summary = title(entry.summary);
      return ok();
    case "pr-link":
      session.prUrl = prUrl(entry.prUrl);
      return ok();
    case "cost-state":
      session.costUsd = num(entry.totalCostUSD);
      session.linesAdded = int(entry.totalLinesAdded);
      session.linesRemoved = int(entry.totalLinesRemoved);
      return ok();
    default:
      return { status: "unknown", type: typeLabel(type) };
  }
}

const HANDLED_TYPES: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "system",
  "ai-title",
  "summary",
  "pr-link",
  "cost-state",
]);

/** True for entry types this version of the parser reads or deliberately skips. */
export function isKnownType(type: string): boolean {
  return HANDLED_TYPES.has(type) || SKIPPED_TYPES.has(type);
}

function basePatch(entry: Json, fallbackSessionId: string): SessionPatch {
  return {
    sessionId: id(entry.sessionId) ?? id(entry.session_id) ?? fallbackSessionId,
    ts: id(entry.timestamp),
    cwd: field(entry.cwd, 1_000),
    gitBranch: field(entry.gitBranch),
    version: field(entry.version, 100),
    entrypoint: field(entry.entrypoint, 100),
    model: null,
    title: null,
    summary: null,
    prUrl: null,
    costUsd: null,
    linesAdded: null,
    linesRemoved: null,
  };
}

function userEvents(entry: Json, ts: string | null): ParsedEvent[] {
  const sidechain = entry.isSidechain === true;
  const meta = entry.isMeta === true;
  const uuid = id(entry.uuid);
  const events: ParsedEvent[] = [];

  blocksOf(asRecord(entry.message)?.content).forEach((block, index) => {
    if (block.type === "text" && typeof block.text === "string") {
      const text = block.text;
      if (meta || HARNESS_TEXT.test(text)) return;
      const kind: EventKind = sidechain
        ? "subagent_prompt"
        : COMMAND_TEXT.test(text)
          ? "command"
          : INTERRUPT_TEXT.test(text)
            ? "interrupt"
            : "prompt";
      events.push(event(kind, index, uuid, ts, sidechain, { text: safe(text, LIMITS.prose), size: text.length }));
    } else if (block.type === "tool_result") {
      const raw = resultText(block.content);
      events.push(
        event("tool_result", index, uuid, ts, sidechain, {
          toolUseId: id(block.tool_use_id),
          isError: block.is_error === true,
          text: safe(raw, LIMITS.toolResult),
          size: raw.length,
        }),
      );
    }
  });
  return events;
}

function assistantEvents(entry: Json, ts: string | null): ParsedEvent[] {
  const sidechain = entry.isSidechain === true;
  const uuid = id(entry.uuid);
  const events: ParsedEvent[] = [];

  blocksOf(asRecord(entry.message)?.content).forEach((block, index) => {
    if (block.type === "text" && typeof block.text === "string") {
      if (!block.text.trim()) return;
      events.push(
        event("assistant_text", index, uuid, ts, sidechain, {
          text: safe(block.text, LIMITS.prose),
          size: block.text.length,
        }),
      );
    } else if (block.type === "tool_use" || block.type === "server_tool_use") {
      const name = str(block.name) ?? "unknown";
      const input = asRecord(block.input) ?? {};
      events.push(
        event("tool_use", index, uuid, ts, sidechain, {
          name: field(name, 200),
          toolUseId: id(block.id),
          filePath: field(input.file_path, 1_000) ?? field(input.notebook_path, 1_000),
          text: safe(describeToolInput(name, input), LIMITS.toolInput),
          size: jsonLength(input),
        }),
      );
    }
    // thinking / redacted_thinking blocks carry no visible text: nothing to keep.
  });
  return events;
}

function systemEvents(entry: Json, ts: string | null): ParsedEvent[] {
  const subtype = str(entry.subtype);
  if (!subtype || !KEPT_SYSTEM_SUBTYPES.has(subtype)) return [];
  const content = typeof entry.content === "string" ? entry.content : "";
  return [
    event("system", 0, id(entry.uuid), ts, entry.isSidechain === true, {
      name: subtype,
      text: safe(content, LIMITS.system),
      size: content.length,
    }),
  ];
}

/** A short, readable rendering of a tool call's input. Redacted later by the caller. */
export function describeToolInput(name: string, input: Json): string {
  const s = (value: unknown): string =>
    typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value);

  switch (name) {
    case "Bash":
      return `$ ${s(input.command)}${input.description ? `\n# ${s(input.description)}` : ""}`;
    case "Edit":
      return `${s(input.file_path)}${input.replace_all ? " (replace all)" : ""}\n--- before\n${s(input.old_string)}\n+++ after\n${s(input.new_string)}`;
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits.filter(isRecord) : [];
      const first = edits[0];
      return `${s(input.file_path)} (${edits.length} edits)${first ? `\n--- before\n${s(first.old_string)}\n+++ after\n${s(first.new_string)}` : ""}`;
    }
    case "Write": {
      // No cutting here: safe() truncates after redacting, and only safe() may cut.
      const content = s(input.content);
      return `${s(input.file_path)} (${content.length} chars)\n${content}`;
    }
    case "Read":
      return `${s(input.file_path)}${input.offset ? ` from line ${s(input.offset)}` : ""}${input.limit ? ` (${s(input.limit)} lines)` : ""}`;
    case "NotebookEdit":
      return `${s(input.notebook_path)} ${s(input.edit_mode)}\n${s(input.new_source)}`;
    case "Grep":
      return `grep ${JSON.stringify(s(input.pattern))}${input.path ? ` in ${s(input.path)}` : ""}${input.glob ? ` (${s(input.glob)})` : ""}`;
    case "Glob":
      return `glob ${s(input.pattern)}${input.path ? ` in ${s(input.path)}` : ""}`;
    case "Agent":
    case "Task":
      return `${s(input.subagent_type) || "agent"}: ${s(input.description)}\n${s(input.prompt)}`;
    case "WebFetch":
      return `${s(input.url)}\n${s(input.prompt)}`;
    case "WebSearch":
      return s(input.query);
    case "Skill":
      return `/${s(input.skill)}${input.args ? ` ${s(input.args)}` : ""}`;
    default:
      return JSON.stringify(input);
  }
}

/** Longer than any single credential (an RSA-4096 PEM block is about 3.3K characters). */
const MARGIN = 8_192;

/**
 * Redact first, then truncate (see redact.ts for why the order matters).
 * Text too long to scan whole is scanned in a window. head() can cut a secret
 * in half at the end of that window, and half a secret matches no rule. What is
 * left of it is always within the window's last MARGIN characters, even after
 * redaction has shortened or lengthened the text before it, so those
 * characters are dropped rather than shown.
 */
export function safe(text: string, limit: number): string {
  if (text.length <= limit + MARGIN) return clip(redact(text), limit);
  const redacted = redact(head(text, limit + MARGIN));
  const kept = head(redacted, Math.max(0, Math.min(limit, redacted.length - MARGIN)));
  return `${kept}\n… [truncated from ${text.length} chars]`;
}

function title(value: unknown): string | null {
  const text = str(value)?.trim();
  return text ? safe(text, LIMITS.title) : null;
}

/** Short metadata strings (cwd, branch, tool names, paths) get the same treatment as content. */
function field(value: unknown, max = 300): string | null {
  const text = str(value);
  return text ? safe(text, max) : null;
}

/** Identifiers need no redaction, only a length bound. */
function id(value: unknown): string | null {
  return str(value)?.slice(0, 200) ?? null;
}

/** Shown in the drift banner: keep it short and printable. */
function typeLabel(type: string): string {
  return (type || "(missing)").slice(0, 64).replace(/[^\w.:-]/g, "?");
}

/** A PR link is shown as a button and opened in the browser: https only, no embedded credentials. */
function prUrl(value: unknown): string | null {
  const url = str(value);
  return url && /^https:\/\/[^\s@"'<>`]{1,2000}$/.test(url) ? url : null;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!isRecord(part)) return "";
        if (part.type === "text" && typeof part.text === "string") return part.text;
        if (part.type === "image") return "[image]";
        return JSON.stringify(part);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

function event(
  kind: EventKind,
  block: number,
  uuid: string | null,
  ts: string | null,
  sidechain: boolean,
  fields: Partial<Pick<ParsedEvent, "name" | "toolUseId" | "filePath" | "isError">> & { text: string; size: number },
): ParsedEvent {
  return {
    kind,
    block,
    uuid,
    ts,
    sidechain,
    name: fields.name ?? null,
    toolUseId: fields.toolUseId ?? null,
    filePath: fields.filePath ?? null,
    isError: fields.isError ?? false,
    size: fields.size,
    text: fields.text,
  };
}

function blocksOf(content: unknown): Json[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content.filter(isRecord);
  return [];
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Json | null {
  return isRecord(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function int(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.trunc(n);
}
