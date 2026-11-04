import { homedir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

/** Where Claude Code writes session transcripts. Respects CLAUDE_CONFIG_DIR. */
export function transcriptsRoot(env: Env = process.env): string {
  if (env.LOGBOOK_TRANSCRIPTS) return env.LOGBOOK_TRANSCRIPTS;
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

/** Per-user data directory. It lives outside the repo so session data can never be committed. */
export function dataDir(env: Env = process.env): string {
  return env.LOGBOOK_DATA_DIR || join(homedir(), "Library", "Application Support", "logbook");
}

export function dbPath(env: Env = process.env): string {
  return env.LOGBOOK_DB || join(dataDir(env), "logbook.db");
}
