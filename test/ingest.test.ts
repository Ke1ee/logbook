import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/db.ts";
import { identifyFile, ingestFile, scanAll } from "../src/core/ingest.ts";
import { overview, recentSessions } from "../src/core/stats.ts";
import { assistantLine, entry, fake, SESSION_ID, userLine } from "./helpers.ts";

const PROJECT = "-Users-me-app";
let dir: string;
let root: string;
let dbFile: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "logbook-test-"));
  root = join(dir, "projects");
  mkdirSync(join(root, PROJECT), { recursive: true });
  dbFile = join(dir, "logbook.db");
  store = new Store(dbFile);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const mainFile = () => join(root, PROJECT, `${SESSION_ID}.jsonl`);
const prompt = (n: number, text = `prompt ${n}`) =>
  `${userLine(text, { uuid: `u-${n}`, timestamp: `2026-11-04T10:00:${String(n).padStart(2, "0")}.000Z` })}\n`;

function texts(kind = "prompt"): string[] {
  return (store.db.query("SELECT text FROM events WHERE kind = ? ORDER BY line_offset").all(kind) as Array<{ text: string }>).map(
    (row) => row.text,
  );
}

describe("incremental reads", () => {
  test("new lines are read once, never twice", () => {
    writeFileSync(mainFile(), prompt(1) + prompt(2));
    scanAll(store, root);
    expect(texts()).toEqual(["prompt 1", "prompt 2"]);

    appendFileSync(mainFile(), prompt(3));
    scanAll(store, root);
    scanAll(store, root);
    expect(texts()).toEqual(["prompt 1", "prompt 2", "prompt 3"]);
  });

  test("an unfinished last line waits for the next pass", () => {
    const second = prompt(2, "the full second prompt");
    writeFileSync(mainFile(), prompt(1) + second.slice(0, 25));
    ingestFile(store, root, mainFile());
    expect(texts()).toEqual(["prompt 1"]);

    appendFileSync(mainFile(), second.slice(25));
    ingestFile(store, root, mainFile());
    expect(texts()).toEqual(["prompt 1", "the full second prompt"]);
  });

  test("byte offsets stay correct across multi-byte characters", () => {
    writeFileSync(mainFile(), prompt(1, "日本語のテスト 🚀"));
    ingestFile(store, root, mainFile());
    appendFileSync(mainFile(), prompt(2, "émoji 🧪 again"));
    ingestFile(store, root, mainFile());
    expect(texts()).toEqual(["日本語のテスト 🚀", "émoji 🧪 again"]);
  });

  test("a truncated file is re-read from the start", () => {
    writeFileSync(mainFile(), prompt(1) + prompt(2) + prompt(3));
    ingestFile(store, root, mainFile());
    writeFileSync(mainFile(), prompt(9, "rewritten"));
    ingestFile(store, root, mainFile());
    expect(texts()).toEqual(["rewritten"]);
  });

  test("a file replaced by rename is re-read from the start", () => {
    writeFileSync(mainFile(), prompt(1));
    ingestFile(store, root, mainFile());
    const replacement = join(dir, "replacement.jsonl");
    writeFileSync(replacement, prompt(1, "replaced one") + prompt(2, "replaced two"));
    renameSync(replacement, mainFile());
    ingestFile(store, root, mainFile());
    expect(texts()).toEqual(["replaced one", "replaced two"]);
  });
});

describe("sessions", () => {
  test("subagent transcripts join their parent session without overriding its metadata", () => {
    writeFileSync(
      mainFile(),
      `${entry({ type: "ai-title", aiTitle: "Main title" })}\n${prompt(1)}${assistantLine([
        { type: "tool_use", id: "t-1", name: "Bash", input: { command: "ls" } },
      ])}\n`,
    );
    const subagentDir = join(root, PROJECT, SESSION_ID, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "agent-abc.jsonl"),
      `${userLine("Audit the auth middleware", { isSidechain: true, gitBranch: "other", timestamp: "2026-11-04T11:00:00.000Z" })}\n` +
        `${entry({ type: "ai-title", aiTitle: "Subagent title" })}\n`,
    );

    scanAll(store, root);
    const [session] = recentSessions(store);
    expect(session).toMatchObject({
      id: SESSION_ID,
      name: "app",
      title: "Main title",
      gitBranch: "main",
      prompts: 1,
      toolCalls: 1,
      lastTs: "2026-11-04T11:00:00.000Z",
    });
    expect(texts("subagent_prompt")).toEqual(["Audit the auth middleware"]);
  });

  test("unknown entry types are tallied so format drift is visible", () => {
    writeFileSync(mainFile(), `${entry({ type: "brand-new-thing" })}\n${entry({ type: "brand-new-thing" })}\n`);
    scanAll(store, root);
    expect(overview(store).unknownTypes).toMatchObject([{ type: "brand-new-thing", count: 2 }]);
  });
});

describe("privacy", () => {
  test("secrets never reach the database file", () => {
    writeFileSync(
      mainFile(),
      prompt(1, `connect with ${fake.dbUrl()} using ${fake.anthropicKey()}`) +
        `${assistantLine([{ type: "tool_use", id: "t-1", name: "Bash", input: { command: `export STRIPE=${fake.stripeKey()}` } }])}\n`,
    );
    scanAll(store, root);
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const bytes = readFileSync(dbFile).toString("latin1");
    for (const secret of [fake.dbPassword(), fake.anthropicKey(), fake.stripeKey()]) {
      expect(bytes).not.toContain(secret);
    }
    expect(texts()[0]).toContain("app_user:[REDACTED:password]@db.example.com");
  });
});

describe("failures stay contained", () => {
  test("an unreadable transcript is reported and every other file is still read", () => {
    const files = ["a", "b", "c"].map((name) => join(root, PROJECT, `${name}.jsonl`));
    files.forEach((file, i) => writeFileSync(file, prompt(i + 1, `from ${i}`)));
    chmodSync(files[1] as string, 0o000);
    try {
      const totals = scanAll(store, root);
      expect(totals.failed).toBe(1);
      expect(totals.lastError).toContain("b.jsonl");
      expect(texts().sort()).toEqual(["from 0", "from 2"]);
    } finally {
      chmodSync(files[1] as string, 0o644);
    }
  });

  test("a database error is counted, not thrown", () => {
    writeFileSync(mainFile(), prompt(1));
    store.close();
    const totals = ingestFile(store, root, mainFile());
    expect(totals.failed).toBe(1);
    store = new Store(dbFile); // for afterEach
  });
});

describe("two writers", () => {
  test("a stale chunk from a second process is refused, not counted twice", () => {
    writeFileSync(mainFile(), prompt(1) + `${entry({ type: "brand-new-thing" })}\n`);
    const other = new Store(dbFile);
    try {
      ingestFile(store, root, mainFile());
      // The second process read the same bytes from offset 0 before the first committed.
      const stale = other.applyChunk(
        {
          file: mainFile(),
          project: PROJECT,
          fileSessionId: SESSION_ID,
          isSubagent: false,
          startOffset: 0,
          readOffset: 999,
          size: 999,
          ino: 1,
        },
        [{ offset: 0, parsed: { status: "unknown", type: "brand-new-thing" } }],
      );
      expect(stale.conflict).toBe(true);
      expect(overview(store).unknownTypes).toMatchObject([{ type: "brand-new-thing", count: 1 }]);
      expect(store.getFile(mainFile())?.readOffset).toBe(statSync(mainFile()).size);
    } finally {
      other.close();
    }
  });

  test("types this version already knows are not reported as drift", () => {
    store.db.exec(
      "INSERT INTO unknown_types VALUES ('agent-name', 5, 'x', 'x', NULL), ('brand-new-thing', 2, 'x', 'x', NULL)",
    );
    expect(overview(store).unknownTypes.map((u) => u.type)).toEqual(["brand-new-thing"]);
  });
});

describe("rule changes reach stored history", () => {
  test("text stored under older rules is re-redacted when the rules change", () => {
    writeFileSync(mainFile(), prompt(1, "plain prompt with a secret-ish word: KEEPME123456"));
    scanAll(store, root);
    // Pretend a later rule version now considers KEEPME123456 a secret.
    const changed = store.reRedact("next-rules", (text) => text.replaceAll("KEEPME123456", "[REDACTED:test]"));
    expect(changed).toBe(1);
    expect(texts()).toEqual(["plain prompt with a secret-ish word: [REDACTED:test]"]);
    expect(store.reRedact("next-rules", () => "should not run")).toBe(0);
  });
});

describe("identifyFile", () => {
  test("maps paths to sessions", () => {
    expect(identifyFile(root, join(root, PROJECT, `${SESSION_ID}.jsonl`))).toEqual({
      project: PROJECT,
      sessionId: SESSION_ID,
      isSubagent: false,
    });
    expect(identifyFile(root, join(root, PROJECT, SESSION_ID, "subagents", "agent-x.jsonl"))).toEqual({
      project: PROJECT,
      sessionId: SESSION_ID,
      isSubagent: true,
    });
    expect(identifyFile(root, join(root, PROJECT, "notes.md"))).toBeNull();
    expect(identifyFile(root, join(dir, "elsewhere.jsonl"))).toBeNull();
  });
});
