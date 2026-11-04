/**
 * Running other programs (herdr, ps, open, sketchybar).
 *
 * Always an argument array, never a shell string, so no data can turn into a
 * command. Always bounded: on timeout the whole process group is killed, so a
 * program that ignores SIGTERM, or leaves a child holding its output open,
 * cannot hang a caller. And never throwing: Bun.spawn throws synchronously
 * when a program is missing, and in the app an exception escaping a timer
 * force-quits the process.
 */

/** stdout when the program exits 0, null on failure, a missing program, or timeout. */
export async function runCommand(cmd: readonly string[], timeoutMs = 3_000): Promise<string | null> {
  let proc: ReturnType<typeof spawnPiped>;
  try {
    proc = spawnPiped(cmd);
  } catch {
    return null;
  }

  const finished = (async () => {
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out : null;
  })().catch(() => null);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const result = await Promise.race([finished, timedOut]);
  clearTimeout(timer);

  if (result === "timeout") {
    try {
      process.kill(-proc.pid, "SIGKILL"); // the whole group: the program and anything it spawned
    } catch {}
    return null;
  }
  return result;
}

/** Start a program and do not wait for it. Returns false instead of throwing. */
export function launch(cmd: readonly string[]): boolean {
  try {
    Bun.spawn([...cmd], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function spawnPiped(cmd: readonly string[]) {
  // detached: its own process group, so a timeout can kill everything it started
  return Bun.spawn([...cmd], { stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true });
}
