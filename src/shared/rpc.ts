/** The contract between Logbook's main process and its window. */
import type { RPCSchema } from "electrobun";
import type { Board } from "../core/board.ts";
import type { Overview, SessionSummary } from "../core/stats.ts";

export interface Snapshot {
  overview: Overview;
  /** Running agents, the ones waiting on you first. */
  board: Board;
  sessions: SessionSummary[];
  transcriptsRoot: string;
  /** Set while the first backfill after launch is still running. */
  ingesting: { done: number; total: number } | null;
  /** Transcripts that could not be read, if any. Shown so a failure is never silent. */
  problem: string | null;
}

export type LogbookRPC = {
  /** Handled by the main process, called from the window. */
  bun: RPCSchema<{
    requests: {
      snapshot: { params: undefined; response: Snapshot };
      openExternal: { params: { url: string }; response: boolean };
      /** Bring an agent's pane to the front (herdr only). */
      focusAgent: { params: { paneId: string }; response: boolean };
    };
  }>;
  /** Handled by the window, sent from the main process. */
  webview: RPCSchema<{
    messages: {
      changed: void;
      progress: { done: number; total: number };
    };
  }>;
};
