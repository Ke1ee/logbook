/**
 * Logbook's main process. It owns the database, the transcript watcher, the
 * herdr poller and the menu bar item, and answers the window over Electrobun's
 * RPC. That RPC runs over a loopback WebSocket that Electrobun encrypts with a
 * random per-window AES-GCM key: other local processes can reach the port but
 * cannot read or forge the traffic. Do not add an HTTP server next to it.
 *
 * Nothing that runs from a timer or a menu click may throw: Electrobun treats
 * an uncaught exception as fatal and quits. External programs go through
 * core/proc.ts, which never throws.
 */
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserView, BrowserWindow, type MenuItemConfig, Tray, Utils } from "electrobun/main";
import { type Board, buildBoard, waitingOn } from "../core/board.ts";
import { Store } from "../core/db.ts";
import { findTerminalApp, type HerdrAgent, herdrClient } from "../core/herdr.ts";
import { type IngestTotals, scanAllAsync, watchTranscripts } from "../core/ingest.ts";
import { dataDir, dbPath, transcriptsRoot } from "../core/paths.ts";
import { launch } from "../core/proc.ts";
import { overview, recentSessions } from "../core/stats.ts";
import type { LogbookRPC, Snapshot } from "../shared/rpc.ts";

const store = new Store(dbPath());
const root = transcriptsRoot();
const herdr = herdrClient();
let ingesting: Snapshot["ingesting"] = null;
let problem: string | null = null;
let agents: HerdrAgent[] | null = null;
let board: Board = buildBoard(store, null);

const rpc = BrowserView.defineRPC<LogbookRPC>({
  maxRequestTime: 15_000,
  handlers: {
    requests: {
      snapshot: (): Snapshot => ({
        overview: overview(store),
        board,
        sessions: recentSessions(store, 40),
        transcriptsRoot: root,
        ingesting,
        problem,
      }),
      openExternal: ({ url }) => isPlainHttpsLink(url) && Utils.openExternal(url),
      focusAgent: ({ paneId }) => focusAgent(paneId),
    },
  },
});

// ── window ─────────────────────────────────────────────────────────────────
// Logbook lives in the menu bar, so closing the window hides it (the usual
// macOS menu bar app behavior) and "Show Logbook" or a Dock click brings it
// back. Electrobun's exitOnLastWindowClosed setting alone did not stop the app
// quitting when its window closed (tested on 2.0.5), so the close is vetoed.

let mainWindow: BrowserWindow | null = null;
let quitting = false;

function showWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.activate();
    return;
  }
  const window = new BrowserWindow({
    title: "Logbook",
    url: "views://main/index.html",
    frame: { width: 480, height: 900 },
    titleBarStyle: "hiddenInset",
    rpc,
  });
  window.on("will-close", (event) => {
    if (quitting) return;
    (event as { response?: { allow: boolean } }).response = { allow: false };
    window.hide();
  });
  window.on("close", () => {
    if (mainWindow === window) mainWindow = null;
  });
  mainWindow = window;
}

function quit(): void {
  quitting = true;
  Utils.quit();
}

// Clicking the Dock icon with no window open brings one back, as on any Mac app.
app.on("reopen", () => {
  try {
    showWindow();
  } catch (error) {
    console.error("[logbook] could not reopen the window", error);
  }
});

// ── menu bar ───────────────────────────────────────────────────────────────

const tray = new Tray({ title: "◦" });
let trayMenuKey = "";

tray.on("tray-clicked", (event) => {
  try {
    const action = (event as { data?: { action?: string } }).data?.action ?? "";
    if (action.startsWith("focus:")) void focusAgent(action.slice("focus:".length));
    else if (action === "show") showWindow();
    else if (action === "quit") quit();
  } catch (error) {
    console.error("[logbook] menu action failed", error);
  }
});

function updateTray(): void {
  const waiting = waitingOn(board);
  tray.setTitle(waiting.length > 0 ? `◉ ${waiting.length}` : "◦");
  const items: MenuItemConfig[] = [
    ...waiting.map(
      (item): MenuItemConfig => ({
        type: "normal",
        label: `${item.status === "blocked" ? "Needs you" : "Done"} · ${shorten(item.title, 48)}`,
        action: item.paneId ? `focus:${item.paneId}` : "show",
      }),
    ),
    ...(waiting.length > 0 ? [{ type: "separator" } as const] : []),
    { type: "normal", label: "Show Logbook", action: "show" },
    { type: "normal", label: "Quit Logbook", action: "quit" },
  ];
  const key = JSON.stringify(items);
  if (key !== trayMenuKey) {
    trayMenuKey = key;
    tray.setMenu(items);
  }
}

// ── jumping to an agent ────────────────────────────────────────────────────

let terminalApp: string | null = null;

/** herdr focuses the agent's pane, then the terminal hosting herdr comes to the front. */
async function focusAgent(paneId: string): Promise<boolean> {
  try {
    // Only panes herdr itself reported: neither the window nor a menu item can target anything else.
    if (!herdr || !board.items.some((item) => item.paneId === paneId)) return false;
    if (!(await herdr.focus(paneId))) return false;
    terminalApp ??= await findTerminalApp();
    if (terminalApp) launch(["/usr/bin/open", terminalApp]);
    return true;
  } catch (error) {
    console.error("[logbook] could not focus the agent", error);
    return false;
  }
}

// ── status file for status bars (SketchyBar and friends) ───────────────────
// Rewritten on every change and every 30 seconds (updatedAt is a heartbeat, so a
// reader can tell a stale file from a quiet one), removed on quit. SketchyBar
// gets a logbook_update event only when the waiting count changes.

const STATUS_FILE = join(dataDir(), "status.json");
const sketchybar =
  [Bun.which("sketchybar"), "/opt/homebrew/bin/sketchybar", "/usr/local/bin/sketchybar"].find(
    (path): path is string => Boolean(path && existsSync(path)),
  ) ?? null;
let statusKey = "";
let lastWaiting = -1;

function publishStatus(heartbeat: boolean): void {
  const waiting = waitingOn(board);
  const status = {
    waiting: waiting.length,
    agents: board.items.map(({ title, status, project }) => ({ title, status, project })),
  };
  const key = JSON.stringify(status);
  if (key !== statusKey || heartbeat) {
    statusKey = key;
    try {
      writeFileSync(`${STATUS_FILE}.tmp`, JSON.stringify({ ...status, pid: process.pid, updatedAt: new Date().toISOString() }));
      renameSync(`${STATUS_FILE}.tmp`, STATUS_FILE);
    } catch (error) {
      console.error("[logbook] could not write the status file", error);
    }
  }
  if (waiting.length !== lastWaiting) {
    lastWaiting = waiting.length;
    if (sketchybar) launch([sketchybar, "--trigger", "logbook_update", `WAITING=${waiting.length}`]);
  }
}

function clearStatus(): void {
  try {
    unlinkSync(STATUS_FILE);
  } catch {}
  if (sketchybar) launch([sketchybar, "--trigger", "logbook_update", "WAITING=0"]);
}

app.on("before-quit", () => {
  quitting = true; // Cmd+Q and system shutdown arrive here, not through quit()
  clearStatus();
});
process.on("exit", () => {
  try {
    unlinkSync(STATUS_FILE);
  } catch {}
});

// ── the board ──────────────────────────────────────────────────────────────

function refreshBoard(heartbeat = false): void {
  try {
    board = buildBoard(store, agents);
    updateTray();
    publishStatus(heartbeat);
    notifyChanged();
  } catch (error) {
    console.error("[logbook] could not refresh the board", error);
  }
}

let polling = false;
let herdrFailures = 0;

async function pollHerdr(): Promise<void> {
  if (!herdr || polling) return;
  polling = true;
  try {
    const next = await herdr.list();
    // Ride out a transient failure on the last good list; three in a row means herdr is gone.
    if (next === null && ++herdrFailures < 3) return;
    if (next !== null) herdrFailures = 0;
    if (JSON.stringify(next) !== JSON.stringify(agents)) {
      agents = next;
      refreshBoard();
    }
  } catch (error) {
    console.error("[logbook] herdr poll failed", error);
  } finally {
    polling = false;
  }
}

// ── plumbing ───────────────────────────────────────────────────────────────

/** Only plain https links (PR pages) leave the app: no file:// or app schemes, no embedded credentials. */
function isPlainHttpsLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

// The window may not have finished loading when the first notice goes out;
// it asks for a snapshot on load anyway, so a dropped notice loses nothing.
const send = (deliver: () => unknown) => {
  try {
    void deliver();
  } catch {}
};
const notifyChanged = () => send(() => rpc.send.changed());

/** A full pass sets or clears the problem line; a partial pass can only raise one. */
function noteProblems(totals: IngestTotals, pass: "watch" | "rescan"): void {
  if (totals.failed > 0) {
    problem = `${totals.failed} transcript${totals.failed === 1 ? "" : "s"} could not be read (${totals.lastError})`;
    console.error(`[logbook] ${problem}`);
  } else if (pass === "rescan") {
    problem = null;
  }
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

async function start(): Promise<void> {
  showWindow();
  updateTray();
  // Timers first, so nothing that fails below can leave the board frozen.
  // herdr states change without transcript writes (an agent finishing); and
  // recency-based states and "3m ago" labels age even when nothing arrives.
  setInterval(() => void pollHerdr(), 2_000);
  setInterval(() => refreshBoard(true), 30_000);

  try {
    // Catch up on whatever happened while the app was closed.
    const totals = await scanAllAsync(store, root, (done, total) => {
      ingesting = done < total ? { done, total } : null;
      send(() => rpc.send.progress({ done, total }));
    });
    noteProblems(totals, "rescan");
    console.log(
      `[logbook] caught up in ${(totals.ms / 1000).toFixed(1)}s: ${totals.events} new events from ${totals.changedFiles} files`,
    );
  } catch (error) {
    problem = `could not read transcripts: ${String(error)}`;
    console.error("[logbook] backfill failed", error);
  }
  ingesting = null;

  try {
    // Follow live activity even if the backfill failed: new files may still be readable.
    watchTranscripts(store, root, {
      onChange: (changes, pass) => {
        const before = problem;
        noteProblems(changes, pass);
        if (changes.changedFiles > 0) console.log(`[logbook] +${changes.events} events from ${changes.changedFiles} file(s)`);
        if (changes.changedFiles > 0 || problem !== before) refreshBoard();
      },
    });
  } catch (error) {
    console.error("[logbook] could not watch transcripts", error);
  }

  await pollHerdr();
  refreshBoard(true);
  console.log(`[logbook] live board: ${herdr ? `herdr, ${agents?.length ?? 0} agents` : "transcripts only (herdr not found)"}`);
}

void start();
