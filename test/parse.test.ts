import { describe, expect, test } from "bun:test";
import { isKnownType, LIMITS, type ParsedEvent, type ParsedLine, parseLine, safe } from "../src/core/parse.ts";
import { assistantLine, entry, fake, noise, SESSION_ID, userLine } from "./helpers.ts";

describe("truncation never keeps half a secret", () => {
  test("a Write whose content puts a password across the stored limit", () => {
    const content = `${"x".repeat(LIMITS.toolInput - 30)}${fake.dbUrl()}\nmore`;
    const ev = only(
      ok(
        parseLine(
          assistantLine([{ type: "tool_use", id: "t-w", name: "Write", input: { file_path: "/app/.env", content } }]),
          "file-session-id",
        ),
      ).events,
    );
    expect(ev.text).not.toContain(fake.dbPassword().slice(0, 5));
  });

  test("text far longer than the scan window, shrunk by redaction, with a URL across the window edge", () => {
    // Eight long JWTs shrink to short markers, which would pull the window's
    // cut-off tail (half a connection string) under the display limit.
    const jwts = Array.from({ length: 8 }, () => `eyJ${noise(600)}.eyJ${noise(600)}.${noise(40)}`).join(" ");
    const password = `Pw${noise(30)}`;
    const url = `postgres${"://"}app:${password}@db.example.com/app`;
    const windowEnd = LIMITS.toolResult + 8_192;
    const pad = "y".repeat(windowEnd - jwts.length - 25);
    const text = `${jwts}${pad}${url}${"z".repeat(5_000)}`;
    expect(text.indexOf(url)).toBeLessThan(windowEnd);
    expect(text.indexOf(url) + url.length).toBeGreaterThan(windowEnd);
    const out = safe(text, LIMITS.toolResult);
    expect(out).not.toContain(password.slice(0, 6));
    expect(out).toContain("truncated from");
  });
});

describe("metadata fields are cleaned too", () => {
  test("file paths are redacted", () => {
    const filePath = "https://bucket.s3.amazonaws.com/a.png?X-Amz-Signature=abcdef0123456789abcdef";
    const ev = only(
      ok(
        parseLine(
          assistantLine([{ type: "tool_use", id: "t-m", name: "mcp__s3__get", input: { file_path: filePath } }]),
          "file-session-id",
        ),
      ).events,
    );
    expect(ev.filePath).not.toContain("abcdef0123456789");
  });

  test("PR links with embedded credentials are dropped", () => {
    const withCreds = `https${"://"}user:${noise(12)}@github.com/o/r/pull/1`;
    expect(ok(parseLine(entry({ type: "pr-link", prUrl: withCreds }), "f")).session.prUrl).toBeNull();
    expect(ok(parseLine(entry({ type: "pr-link", prUrl: "https://github.com/o/r/pull/1" }), "f")).session.prUrl).toBe(
      "https://github.com/o/r/pull/1",
    );
  });

  test("unknown type names are short and printable", () => {
    const huge = parseLine(entry({ type: "x".repeat(100_000) }), "f");
    expect(huge.status === "unknown" && huge.type.length).toBe(64);
    expect(parseLine(entry({ type: "<img src=x onerror=alert(1)>" }), "f")).toEqual({
      status: "unknown",
      type: "?img?src?x?onerror?alert?1??",
    });
  });

  test("isKnownType covers handled and skipped types", () => {
    expect(isKnownType("assistant")).toBe(true);
    expect(isKnownType("agent-name")).toBe(true);
    expect(isKnownType("brand-new-thing")).toBe(false);
  });
});

const FILE_SESSION = "file-session-id";

function ok(line: ParsedLine) {
  if (line.status !== "ok") throw new Error(`expected ok, got ${line.status}`);
  return line;
}

function only(events: ParsedEvent[]): ParsedEvent {
  expect(events).toHaveLength(1);
  return events[0] as ParsedEvent;
}

describe("user entries", () => {
  test("a typed prompt carries its session context", () => {
    const parsed = ok(parseLine(userLine("Why does the webhook retry?"), FILE_SESSION));
    const ev = only(parsed.events);
    expect(ev.kind).toBe("prompt");
    expect(ev.text).toBe("Why does the webhook retry?");
    expect(parsed.session).toMatchObject({ sessionId: SESSION_ID, cwd: "/Users/me/app", gitBranch: "main" });
  });

  test("slash commands and interrupts are labeled; harness text and isMeta text are dropped", () => {
    expect(only(ok(parseLine(userLine("<command-name>/review</command-name>"), FILE_SESSION)).events).kind).toBe("command");
    expect(only(ok(parseLine(userLine("[Request interrupted by user]"), FILE_SESSION)).events).kind).toBe("interrupt");
    expect(ok(parseLine(userLine("<system-reminder>be brief</system-reminder>"), FILE_SESSION)).events).toHaveLength(0);
    expect(ok(parseLine(userLine("Skill body injected by the harness", { isMeta: true }), FILE_SESSION)).events).toHaveLength(0);
  });

  test("compaction summaries and relayed session messages are not prompts", () => {
    const summary = only(
      ok(
        parseLine(
          userLine("This session is being continued from a previous conversation that ran out of context.", {
            isCompactSummary: true,
          }),
          FILE_SESSION,
        ),
      ).events,
    );
    expect(summary).toMatchObject({ kind: "system", name: "compact_summary" });
    for (const marker of ["<agent-message from=\"x\">", "<teammate-message teammate_id=\"y\">"]) {
      const peer = only(ok(parseLine(userLine(`Another Claude session sent a message:\n${marker}hi`), FILE_SESSION)).events);
      expect(peer).toMatchObject({ kind: "system", name: "peer_message" });
    }
  });

  test("prompts that merely resemble injected text stay prompts", () => {
    for (const text of [
      "this session is being continued from a previous conversation? why did it lose my context",
      "ANOTHER CLAUDE SESSION SENT A MESSAGE to the wrong pane, can you check",
      "Another Claude session sent a message: can you tell me what it said?",
    ]) {
      expect(only(ok(parseLine(userLine(text), FILE_SESSION)).events).kind).toBe("prompt");
    }
  });

  test("text inside a subagent transcript is the parent's task, not a person", () => {
    const ev = only(ok(parseLine(userLine("Audit the auth middleware", { isSidechain: true }), FILE_SESSION)).events);
    expect(ev.kind).toBe("subagent_prompt");
    expect(ev.sidechain).toBe(true);
  });

  test("tool results are truncated and keep the error flag", () => {
    const big = "x".repeat(10_000);
    const ev = only(
      ok(parseLine(userLine([{ type: "tool_result", tool_use_id: "t-1", content: big, is_error: true }]), FILE_SESSION))
        .events,
    );
    expect(ev.kind).toBe("tool_result");
    expect(ev.isError).toBe(true);
    expect(ev.toolUseId).toBe("t-1");
    expect(ev.size).toBe(10_000);
    expect(ev.text.length).toBeLessThan(LIMITS.toolResult + 40);
    expect(ev.text).toContain("more chars]");
  });

  test("array-shaped tool results are flattened", () => {
    const content = [{ type: "text", text: "line one" }, { type: "image" }, { type: "text", text: "line two" }];
    const ev = only(ok(parseLine(userLine([{ type: "tool_result", tool_use_id: "t-2", content }]), FILE_SESSION)).events);
    expect(ev.text).toBe("line one\n[image]\nline two");
  });
});

describe("assistant entries", () => {
  test("prose and tool calls become events; empty thinking is ignored", () => {
    const parsed = ok(
      parseLine(
        assistantLine([
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: "Running the tests." },
          { type: "tool_use", id: "t-9", name: "Bash", input: { command: "bun test", description: "Run tests" } },
        ]),
        FILE_SESSION,
      ),
    );
    expect(parsed.session.model).toBe("claude-opus-5-5");
    expect(parsed.events.map((e) => [e.kind, e.block])).toEqual([
      ["assistant_text", 1],
      ["tool_use", 2],
    ]);
    const call = parsed.events[1] as ParsedEvent;
    expect(call.name).toBe("Bash");
    expect(call.toolUseId).toBe("t-9");
    expect(call.text).toBe("# Run tests\n$ bun test");
  });

  test("an Edit shows the file and the change", () => {
    const ev = only(
      ok(
        parseLine(
          assistantLine([
            { type: "tool_use", id: "t-3", name: "Edit", input: { file_path: "/app/a.ts", old_string: "a", new_string: "b" } },
          ]),
          FILE_SESSION,
        ),
      ).events,
    );
    expect(ev.filePath).toBe("/app/a.ts");
    expect(ev.text).toBe("/app/a.ts\n--- before\na\n+++ after\nb");
  });

  test("secrets in tool input are redacted", () => {
    const ev = only(
      ok(
        parseLine(
          assistantLine([
            { type: "tool_use", id: "t-4", name: "Bash", input: { command: `psql ${fake.dbUrl()} -c 'select 1'` } },
          ]),
          FILE_SESSION,
        ),
      ).events,
    );
    expect(ev.text).not.toContain(fake.dbPassword());
    expect(ev.text).toContain("[REDACTED:password]");
  });

  test("redaction runs before truncation, so a secret across the cut is not half-kept", () => {
    const key = fake.anthropicKey();
    const content = `${"x".repeat(LIMITS.toolResult - 12)}${key} tail`;
    const ev = only(ok(parseLine(userLine([{ type: "tool_result", tool_use_id: "t-5", content }]), FILE_SESSION)).events);
    expect(ev.text).not.toContain("sk-ant");
    expect(ev.text).not.toContain(key.slice(0, 12));
  });

  test("the <synthetic> placeholder model is ignored", () => {
    const parsed = ok(
      parseLine(
        entry({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "x" }] } }),
        FILE_SESSION,
      ),
    );
    expect(parsed.session.model).toBeNull();
  });
});

describe("session metadata entries", () => {
  test("ai-title, pr-link and cost-state patch the session", () => {
    expect(ok(parseLine(entry({ type: "ai-title", aiTitle: "Fix webhook retries" }), FILE_SESSION)).session.title).toBe(
      "Fix webhook retries",
    );
    expect(
      ok(parseLine(entry({ type: "pr-link", prUrl: "https://github.com/o/r/pull/7", prNumber: 7 }), FILE_SESSION)).session
        .prUrl,
    ).toBe("https://github.com/o/r/pull/7");
    const cost = ok(
      parseLine(entry({ type: "cost-state", totalCostUSD: 1.25, totalLinesAdded: 40, totalLinesRemoved: 9.0 }), FILE_SESSION),
    ).session;
    expect([cost.costUsd, cost.linesAdded, cost.linesRemoved]).toEqual([1.25, 40, 9]);
  });

  test("a missing sessionId falls back to the file's session", () => {
    const line = JSON.stringify({ type: "ai-title", aiTitle: "t" });
    expect(ok(parseLine(line, FILE_SESSION)).session.sessionId).toBe(FILE_SESSION);
  });

  test("only meaningful system subtypes are kept", () => {
    const away = ok(parseLine(entry({ type: "system", subtype: "away_summary", content: "While you were away..." }), FILE_SESSION));
    expect(only(away.events)).toMatchObject({ kind: "system", name: "away_summary", text: "While you were away..." });
    expect(ok(parseLine(entry({ type: "system", subtype: "turn_duration", durationMs: 5 }), FILE_SESSION)).events).toHaveLength(0);
  });
});

describe("tolerance", () => {
  test("bulky known types are skipped without parsing their JSON", () => {
    expect(parseLine('{"type":"api-request","body": THIS IS NOT JSON', FILE_SESSION)).toEqual({
      status: "skipped",
      type: "api-request",
    });
  });

  test("unknown entry types are reported, not dropped silently", () => {
    expect(parseLine(entry({ type: "brand-new-thing" }), FILE_SESSION)).toEqual({ status: "unknown", type: "brand-new-thing" });
  });

  test("garbage is invalid", () => {
    expect(parseLine("not json", FILE_SESSION).status).toBe("invalid");
    expect(parseLine("[1,2,3]", FILE_SESSION).status).toBe("invalid");
  });
});
