/**
 * The Logbook window. Everything shown comes from the main process over
 * Electrobun RPC. Transcript text is untrusted input (agents fetch web pages,
 * print files, echo command output), so it only ever reaches the DOM through
 * text nodes, never innerHTML.
 */
import { Electroview } from "electrobun/view";
import type { SessionSummary } from "../../core/stats.ts";
import type { LogbookRPC, Snapshot } from "../../shared/rpc.ts";

const ACTIVE_MS = 5 * 60_000;

const rpc = Electroview.defineRPC<LogbookRPC>({
  maxRequestTime: 15_000,
  handlers: {
    messages: {
      changed: () => void refresh(),
      progress: ({ done, total }) => setStatus(done < total ? `catching up · ${done}/${total} transcripts` : null),
    },
  },
});
new Electroview({ rpc });

let latest: Snapshot | null = null;
let inFlight = false;
let queued = false;

async function refresh(): Promise<void> {
  if (inFlight) {
    queued = true;
    return;
  }
  inFlight = true;
  try {
    latest = await rpc.request.snapshot();
    render(latest);
  } catch (error) {
    setStatus(`could not load data: ${String(error)}`);
  } finally {
    inFlight = false;
    if (queued) {
      queued = false;
      void refresh();
    }
  }
}

function render(snapshot: Snapshot): void {
  const { overview, sessions } = snapshot;
  const events = Object.values(overview.events).reduce((sum, n) => sum + n, 0);
  text("#summary", `${fmt(overview.sessions)} sessions · ${fmt(events)} events · since ${day(overview.firstTs)}`);
  setStatus(snapshot.ingesting ? `catching up · ${snapshot.ingesting.done}/${snapshot.ingesting.total} transcripts` : null);

  const problem = must<HTMLElement>("#problem");
  problem.hidden = snapshot.problem === null;
  problem.textContent = snapshot.problem ?? "";

  const drift = must<HTMLElement>("#drift");
  drift.hidden = overview.unknownTypes.length === 0;
  drift.textContent = drift.hidden
    ? ""
    : `Claude Code wrote ${overview.unknownTypes.length} entry type(s) Logbook doesn't recognize yet (${overview.unknownTypes
        .map((u) => u.type)
        .join(", ")}). Nothing breaks; those lines just aren't shown.`;

  const list = must<HTMLElement>("#sessions");
  list.replaceChildren(
    ...(sessions.length ? sessions.map(card) : [h("p", { class: "empty" }, "No agent sessions yet. Start one in a terminal.")]),
  );
}

function card(s: SessionSummary): HTMLElement {
  const active = s.lastTs !== null && Date.now() - Date.parse(s.lastTs) < ACTIVE_MS;
  const changed =
    s.linesAdded || s.linesRemoved ? ` · +${fmt(s.linesAdded ?? 0)} −${fmt(s.linesRemoved ?? 0)}` : "";
  return h(
    "article",
    { class: active ? "session active" : "session" },
    h("div", { class: "title" }, active ? h("span", { class: "dot", title: "active in the last 5 minutes" }) : null, s.title ?? "Untitled session"),
    h("div", { class: "where" }, [s.name, s.gitBranch, ago(s.lastTs)].filter(Boolean).join(" · ")),
    h(
      "div",
      { class: "numbers" },
      `${plural(s.prompts, "prompt")} · ${plural(s.toolCalls, "tool call")}`,
      s.errors ? h("span", { class: "errors" }, ` · ${plural(s.errors, "error")}`) : null,
      s.costUsd === null ? "" : ` · $${s.costUsd.toFixed(2)}`,
      changed,
    ),
    s.prUrl ? prButton(s.prUrl) : null,
  );
}

function prButton(url: string): HTMLElement {
  // Anchored, so https://evil.example/github.com/o/r/pull/1 cannot pass as a GitHub PR.
  const label = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#]|$)/);
  const button = h("button", { class: "pr", type: "button" }, label ? `${label[1]} #${label[2]}` : "pull request");
  button.addEventListener("click", () => void rpc.request.openExternal({ url }));
  return button;
}

function setStatus(message: string | null): void {
  const status = must<HTMLElement>("#status");
  status.textContent = message ?? "watching for agent activity";
  status.classList.toggle("live", message === null);
}

/** Build an element; string children become text nodes, so markup in data stays inert. */
function h(tag: string, attrs: Record<string, string>, ...children: Array<Node | string | null>): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  for (const child of children) {
    if (child !== null) element.append(child);
  }
  return element;
}

function text(selector: string, value: string): void {
  must<HTMLElement>(selector).textContent = value;
}

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}

const fmt = (n: number): string => n.toLocaleString("en-US");
const plural = (n: number, noun: string): string => `${fmt(n)} ${noun}${n === 1 ? "" : "s"}`;

function day(ts: string | null): string {
  return ts ? new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "?";
}

function ago(ts: string | null): string {
  if (!ts) return "";
  const minutes = Math.round((Date.now() - Date.parse(ts)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 60 / 24)}d ago`;
}

// Relative times and "active" dots age even when no new events arrive.
setInterval(() => latest && render(latest), 30_000);
void refresh();
