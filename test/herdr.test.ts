import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTitle, herdrClient, parseAgentList } from "../src/core/herdr.ts";
import { fake } from "./helpers.ts";

const SAMPLE = JSON.stringify({
  id: "cli:agent:list",
  result: {
    type: "agent_list",
    agents: [
      {
        agent: "claude",
        agent_status: "working",
        cwd: "/Users/me/app",
        focused: true,
        pane_id: "w1:p1",
        terminal_title: "◐ Fix webhook retries",
        terminal_title_stripped: "◐ Fix webhook retries",
      },
      {
        agent: "claude",
        agent_status: "done",
        cwd: "/Users/me/app",
        focused: false,
        pane_id: "w1:p2",
        terminal_title: "✳ Add billing page",
        terminal_title_stripped: "Add billing page",
      },
      { agent: "codex", agent_status: "some-new-state", cwd: null, pane_id: "w2:p1", terminal_title: "" },
      { agent: "claude", agent_status: "idle", pane_id: "w3:p1; rm -rf ~", terminal_title: "x" },
    ],
  },
});

describe("parseAgentList", () => {
  test("reads agents, cleans titles, maps unknown states, drops unsafe pane ids", () => {
    expect(parseAgentList(SAMPLE)).toEqual([
      { paneId: "w1:p1", agent: "claude", state: "working", cwd: "/Users/me/app", title: "Fix webhook retries" },
      { paneId: "w1:p2", agent: "claude", state: "done", cwd: "/Users/me/app", title: "Add billing page" },
      { paneId: "w2:p1", agent: "codex", state: "unknown", cwd: null, title: "" },
    ]);
  });

  test("titles are redacted, duplicate panes dropped, flag-shaped ids refused", () => {
    const agents = parseAgentList(
      JSON.stringify({
        result: {
          agents: [
            { agent: "claude", agent_status: "working", pane_id: "w1:p1", terminal_title: `✳ debug ${fake.anthropicKey()}` },
            { agent: "claude", agent_status: "done", pane_id: "w1:p1", terminal_title: "duplicate" },
            { agent: "claude", agent_status: "idle", pane_id: "--help", terminal_title: "flag" },
          ],
        },
      }),
    );
    expect(agents?.map((a) => a.paneId)).toEqual(["w1:p1"]);
    expect(agents?.[0]?.title).toBe("debug [REDACTED:anthropic-key]");
  });

  test("anything else is null, not an exception", () => {
    expect(parseAgentList("not json")).toBeNull();
    expect(parseAgentList(JSON.stringify({ result: { agents: "nope" } }))).toBeNull();
  });

  test("cleanTitle strips leading spinners and marks only", () => {
    expect(cleanTitle("◐ Fix webhook")).toBe("Fix webhook");
    expect(cleanTitle("✳ 2FA rollout")).toBe("2FA rollout");
    expect(cleanTitle("⠋⠙  Deploy · prod")).toBe("Deploy · prod");
  });
});

describe("herdrClient", () => {
  const dir = mkdtempSync(join(tmpdir(), "logbook-herdr-"));
  const log = join(dir, "calls.log");
  const bin = join(dir, "herdr");
  writeFileSync(join(dir, "agents.json"), SAMPLE);
  writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
if [ "$1" = agent ] && [ "$2" = list ]; then cat "${join(dir, "agents.json")}"; exit 0; fi
if [ "$1" = agent ] && [ "$2" = focus ]; then exit 0; fi
exit 1
`,
  );
  chmodSync(bin, 0o755);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("lists agents through the binary", async () => {
    const herdr = herdrClient(bin);
    const agents = await herdr?.list();
    expect(agents?.map((a) => a.paneId)).toEqual(["w1:p1", "w1:p2", "w2:p1"]);
  });

  test("focuses a pane, passing the id as one argument", async () => {
    expect(await herdrClient(bin)?.focus("w1:p2")).toBe(true);
    expect(readFileSync(log, "utf8")).toContain("agent focus w1:p2\n");
  });

  test("refuses anything that is not a pane id, without running herdr", async () => {
    const before = readFileSync(log, "utf8");
    expect(await herdrClient(bin)?.focus("w1:p2; open -a Calculator")).toBe(false);
    expect(await herdrClient(bin)?.focus("--help")).toBe(false);
    expect(readFileSync(log, "utf8")).toBe(before);
  });

  test("no binary means no herdr", () => {
    expect(herdrClient(null)).toBeNull();
  });
});
