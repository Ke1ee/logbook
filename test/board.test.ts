import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBoard, describeAction, waitingOn } from "../src/core/board.ts";
import { Store } from "../src/core/db.ts";
import type { HerdrAgent } from "../src/core/herdr.ts";
import { scanAll } from "../src/core/ingest.ts";
import { assistantLine, entry, userLine } from "./helpers.ts";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

describe("describeAction", () => {
  const tool = (name: string, text: string, filePath: string | null = null, sidechain = 0) =>
    describeAction({ kind: "tool_use", name, text, filePath, sidechain });

  test("Bash uses the agent's own description, else the command", () => {
    expect(tool("Bash", "# run the test suite\n$ bun test")).toBe("Run the test suite");
    expect(tool("Bash", "$ bun test\n# run the test suite")).toBe("Run the test suite"); // rows stored before the format change
    expect(tool("Bash", "$ npm run build")).toBe("Running `npm run build`");
  });

  test("a comment inside a command is not mistaken for the description", () => {
    expect(tool("Bash", "# install deps\n$ cat > x.sh <<EOF\n# reading the README\nEOF")).toBe("Install deps");
    expect(tool("Bash", "$ cat > x.sh <<EOF\n# reading the README\nEOF")).toBe("Running `cat > x.sh <<EOF`");
  });

  test("file tools name the file with its folder", () => {
    expect(tool("Edit", "/Users/me/app/src/core/db.ts\n--- before", "/Users/me/app/src/core/db.ts")).toBe("Editing core/db.ts");
    expect(tool("Read", "/Users/me/app/README.md", "/Users/me/app/README.md")).toBe("Reading app/README.md");
  });

  test("search, subagents, web, MCP and questions", () => {
    expect(tool("Grep", 'grep "webhook" in src')).toBe('Searching the code for "webhook"');
    expect(tool("Agent", "general-purpose: Audit the auth middleware\nlong prompt")).toBe(
      "Handing off to a subagent: Audit the auth middleware",
    );
    expect(tool("WebFetch", "https://docs.stripe.com/webhooks\nsummarize")).toBe("Reading docs.stripe.com");
    expect(tool("mcp__github__create_pull_request", "{}")).toBe("Github: create pull request");
    expect(tool("AskUserQuestion", "{}")).toBe("Asking you a question");
    expect(tool("Bash", "$ ls", null, 1)).toBe("Subagent: Running `ls`");
  });

  test("agent prose becomes its first sentence", () => {
    expect(describeAction({ kind: "assistant_text", name: null, text: "All 12 tests pass. Next I will…", filePath: null, sidechain: 0 })).toBe(
      "All 12 tests pass.",
    );
  });
});

describe("buildBoard", () => {
  let dir: string;
  let root: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "logbook-board-"));
    root = join(dir, "projects");
    mkdirSync(join(root, "-Users-me-app"), { recursive: true });
    mkdirSync(join(root, "-Users-me-other"), { recursive: true });
    store = new Store(join(dir, "logbook.db"));

    const session = (project: string, id: string, title: string, cwd: string, lines: string[]) =>
      writeFileSync(
        join(root, project, `${id}.jsonl`),
        `${[entry({ type: "ai-title", aiTitle: title, sessionId: id }), ...lines].join("\n")}\n`,
      );
    const common = (id: string, cwd: string) => ({ sessionId: id, cwd });

    // A: working, a test run still in flight.
    session("-Users-me-app", "a", "Fix webhook retries", "/Users/me/app", [
      userLine("Make webhook retries idempotent", { ...common("a", "/Users/me/app"), uuid: "a1", timestamp: at(3) }),
      assistantLine([{ type: "tool_use", id: "ta", name: "Bash", input: { command: "bun test", description: "run the test suite" } }], {
        ...common("a", "/Users/me/app"),
        uuid: "a2",
        timestamp: at(1),
      }),
    ]);
    // B: finished, after a failed edit.
    session("-Users-me-app", "b", "Add billing page", "/Users/me/app", [
      userLine("Add a billing page", { ...common("b", "/Users/me/app"), uuid: "b1", timestamp: at(20) }),
      assistantLine([{ type: "tool_use", id: "tb", name: "Edit", input: { file_path: "/Users/me/app/billing.tsx" } }], {
        ...common("b", "/Users/me/app"),
        uuid: "b2",
        timestamp: at(15),
      }),
      userLine([{ type: "tool_result", tool_use_id: "tb", content: "String not found", is_error: true }], {
        ...common("b", "/Users/me/app"),
        uuid: "b3",
        timestamp: at(14),
      }),
      assistantLine([{ type: "text", text: "Done. The billing page is live behind a flag." }], {
        ...common("b", "/Users/me/app"),
        uuid: "b4",
        timestamp: at(10),
      }),
    ]);
    // C: three days old.
    session("-Users-me-other", "c", "Old refactor", "/Users/me/other", [
      userLine("Refactor", { ...common("c", "/Users/me/other"), uuid: "c1", timestamp: at(3 * 24 * 60) }),
    ]);
    scanAll(store, root);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const agent = (paneId: string, title: string, state: HerdrAgent["state"], cwd: string, kind = "claude"): HerdrAgent => ({
    paneId,
    agent: kind,
    state,
    cwd,
    title,
  });

  test("a blocked agent shows the first unfinished call of its turn, not the last", () => {
    writeFileSync(
      join(root, "-Users-me-app", "d.jsonl"),
      `${[
        entry({ type: "ai-title", aiTitle: "Ship it", sessionId: "d" }),
        userLine("ship it", { sessionId: "d", uuid: "d1", timestamp: at(4) }),
        assistantLine([{ type: "tool_use", id: "td1", name: "Bash", input: { command: "./deploy.sh prod", description: "deploy to production" } }], {
          sessionId: "d",
          uuid: "d2",
          timestamp: at(3),
        }),
        assistantLine([{ type: "tool_use", id: "td2", name: "Read", input: { file_path: "/Users/me/app/README.md" } }], {
          sessionId: "d",
          uuid: "d3",
          timestamp: at(3),
        }),
      ].join("\n")}\n`,
    );
    scanAll(store, root);
    const [blocked] = buildBoard(store, [agent("w9:p1", "Ship it", "blocked", "/Users/me/app")], NOW).items;
    expect(blocked).toMatchObject({ action: "Deploy to production", pending: true });
  });

  test("matching uses the strongest evidence across all agents, regardless of order", () => {
    writeFileSync(
      join(root, "-Users-me-app", "w.jsonl"),
      `${[
        entry({ type: "ai-title", aiTitle: "Same title", sessionId: "wt", cwd: "/Users/me/app/.claude/worktrees/agent-1" }),
        userLine("x", { sessionId: "wt", cwd: "/Users/me/app/.claude/worktrees/agent-1", uuid: "w1", timestamp: at(30) }),
      ].join("\n")}\n`,
    );
    writeFileSync(
      join(root, "-Users-me-other", "o.jsonl"),
      `${[
        entry({ type: "ai-title", aiTitle: "Same title", sessionId: "so", cwd: "/Users/me/other" }),
        userLine("y", { sessionId: "so", cwd: "/Users/me/other", uuid: "o1", timestamp: at(5) }),
      ].join("\n")}\n`,
    );
    scanAll(store, root);
    for (const order of [
      ["w5:p1", "w5:p2"],
      ["w5:p2", "w5:p1"],
    ]) {
      const agents = order.map((pane) =>
        pane === "w5:p1" ? agent("w5:p1", "Same title", "idle", "/Users/me/app") : agent("w5:p2", "Same title", "idle", "/Users/me/other"),
      );
      const bySession = Object.fromEntries(buildBoard(store, agents, NOW).items.map((i) => [i.paneId, i.sessionId]));
      expect(bySession).toEqual({ "w5:p1": "wt", "w5:p2": "so" });
    }
  });

  test("non-Claude agents are listed but never matched to a Claude transcript", () => {
    const [codex] = buildBoard(store, [agent("w7:p1", "Fix webhook retries", "working", "/Users/me/app", "codex")], NOW).items;
    expect(codex?.sessionId).toBeNull();
  });

  test("with herdr: agents joined to sessions, sorted by who needs you", () => {
    const board = buildBoard(
      store,
      [
        agent("w1:p1", "Fix webhook retries", "working", "/Users/me/app"),
        agent("w1:p2", "Add billing page", "done", "/Users/me/app"),
        agent("w2:p1", "Brand new agent", "idle", "/Users/me/x"),
        agent("w1:p3", "Fix webhook retries", "blocked", "/Users/me/elsewhere"),
      ],
      NOW,
    );
    expect(board.source).toBe("herdr");
    expect(board.items.map((i) => [i.paneId, i.status, i.sessionId])).toEqual([
      ["w1:p3", "blocked", null], // same title, but its session is already claimed by w1:p1 in the same cwd
      ["w1:p2", "done", "b"],
      ["w1:p1", "working", "a"],
      ["w2:p1", "idle", null],
    ]);

    const working = board.items.find((i) => i.paneId === "w1:p1");
    expect(working).toMatchObject({
      action: "Run the test suite",
      pending: true,
      lastPrompt: "Make webhook retries idempotent",
      project: "app",
    });
    const done = board.items.find((i) => i.paneId === "w1:p2");
    expect(done).toMatchObject({ action: "Done.", pending: false, recentErrors: 1 });
    expect(waitingOn(board).map((i) => i.paneId)).toEqual(["w1:p3", "w1:p2"]);
  });

  test("without herdr: recent sessions only, working inferred from recency", () => {
    const board = buildBoard(store, null, NOW);
    expect(board.source).toBe("transcripts");
    expect(board.items.map((i) => [i.sessionId, i.status])).toEqual([
      ["a", "working"],
      ["b", "idle"],
    ]);
  });
});
