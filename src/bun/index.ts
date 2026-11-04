/**
 * Logbook's main process. It owns the database and the transcript watcher and
 * answers the window over Electrobun's RPC. That RPC runs over a loopback
 * WebSocket that Electrobun encrypts with a random per-window AES-GCM key:
 * other local processes can reach the port but cannot read or forge the
 * traffic. Do not add an HTTP server next to it.
 */
import { BrowserView, BrowserWindow, Utils } from "electrobun/main";
import { Store } from "../core/db.ts";
import { type IngestTotals, scanAllAsync, watchTranscripts } from "../core/ingest.ts";
import { dbPath, transcriptsRoot } from "../core/paths.ts";
import { overview, recentSessions } from "../core/stats.ts";
import type { LogbookRPC, Snapshot } from "../shared/rpc.ts";

const store = new Store(dbPath());
const root = transcriptsRoot();
let ingesting: Snapshot["ingesting"] = null;
let problem: string | null = null;

const rpc = BrowserView.defineRPC<LogbookRPC>({
  maxRequestTime: 15_000,
  handlers: {
    requests: {
      snapshot: (): Snapshot => ({
        overview: overview(store),
        sessions: recentSessions(store, 40),
        transcriptsRoot: root,
        ingesting,
        problem,
      }),
      openExternal: ({ url }) => isPlainHttpsLink(url) && Utils.openExternal(url),
    },
  },
});

export const mainWindow = new BrowserWindow({
  title: "Logbook",
  url: "views://main/index.html",
  frame: { width: 480, height: 900 },
  titleBarStyle: "hiddenInset",
  rpc,
});

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

async function start(): Promise<void> {
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
  } finally {
    ingesting = null;
    notifyChanged();
    // Follow live activity even if the backfill failed: new files may still be readable.
    watchTranscripts(store, root, {
      onChange: (changes, pass) => {
        const before = problem;
        noteProblems(changes, pass);
        if (changes.changedFiles > 0) console.log(`[logbook] +${changes.events} events from ${changes.changedFiles} file(s)`);
        if (changes.changedFiles > 0 || problem !== before) notifyChanged();
      },
    });
  }
}

void start();
