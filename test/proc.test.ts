import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, runCommand } from "../src/core/proc.ts";

const dir = mkdtempSync(join(tmpdir(), "logbook-proc-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function alive(pidFile: string): boolean {
  if (!existsSync(pidFile)) return false;
  try {
    process.kill(Number(readFileSync(pidFile, "utf8").trim()), 0);
    return true;
  } catch {
    return false;
  }
}

describe("runCommand", () => {
  test("returns stdout on success, null on failure or a missing program", async () => {
    expect(await runCommand([script("ok", "echo hello")])).toBe("hello\n");
    expect(await runCommand([script("fail", "echo nope; exit 3")])).toBeNull();
    expect(await runCommand([join(dir, "does-not-exist")])).toBeNull();
  });

  test("a program that ignores SIGTERM is killed at the timeout", async () => {
    const pidFile = join(dir, "stubborn.pid");
    const stubborn = script("stubborn", `echo $$ > "${pidFile}"\ntrap '' TERM\nsleep 30`);
    const started = performance.now();
    expect(await runCommand([stubborn], 300)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_500);
    await Bun.sleep(100);
    expect(alive(pidFile)).toBe(false);
  });

  test("a child that keeps stdout open cannot hang the caller, and is killed too", async () => {
    const pidFile = join(dir, "orphan.pid");
    const leaky = script("leaky", `sleep 30 &\necho $! > "${pidFile}"\nexit 0`);
    const started = performance.now();
    expect(await runCommand([leaky], 300)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_500);
    await Bun.sleep(100);
    expect(alive(pidFile)).toBe(false);
  });
});

describe("launch", () => {
  test("never throws, even for a missing program", () => {
    expect(launch([join(dir, "does-not-exist")])).toBe(false);
    expect(launch([script("quick", "exit 0")])).toBe(true);
  });
});
