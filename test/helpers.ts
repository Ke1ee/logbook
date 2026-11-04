/**
 * Fake credentials, assembled at runtime so no secret-shaped literal ever sits
 * in this public repo (and secret scanners have nothing to flag).
 */
const filler = (n: number) => "Zq9Xw".repeat(n);

export const fake = {
  anthropicKey: () => ["sk", "ant", "api03", filler(8)].join("-"),
  stripeKey: () => ["sk", "live", filler(5)].join("_"),
  githubToken: () => `gh${"p"}_${filler(8)}`,
  awsAccessKey: () => `AKI${"A"}${"ZQ9XW".repeat(3)}Q`,
  jwt: () => [`eyJ${"hbGciOiJIUzI1NiJ9"}`, `eyJ${"zdWIiOiIxMjM0NTY3ODkwIn0"}`, filler(6)].join("."),
  dbPassword: () => `hunter2${filler(1)}`,
  dbUrl: () => `postgres${"://"}app_user:${fake.dbPassword()}@db.example.com:5432/app`,
  privateKey: () =>
    `-----BEGIN ${"RSA PRIVATE"} KEY-----\n${filler(16)}\n${filler(16)}\n-----END ${"RSA PRIVATE"} KEY-----`,
};

/** A deterministic pseudo-random string over an alphabet, for secret-shaped test values. */
export function noise(length: number, alphabet = "aB3dE5fG7hJ9kLmNpQrStUvWxYz"): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[(i * 7 + 3) % alphabet.length];
  return out;
}

export const SESSION_ID = "11111111-2222-4333-8444-555555555555";

/** One transcript line shaped like Claude Code's, with overrides. */
export function entry(fields: Record<string, unknown>): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    userType: "external",
    cwd: "/Users/me/app",
    sessionId: SESSION_ID,
    version: "2.1.317",
    gitBranch: "main",
    ...fields,
  });
}

export function userLine(content: unknown, fields: Record<string, unknown> = {}): string {
  return entry({
    type: "user",
    message: { role: "user", content },
    uuid: "u-1",
    timestamp: "2026-11-04T10:00:00.000Z",
    ...fields,
  });
}

export function assistantLine(content: unknown, fields: Record<string, unknown> = {}): string {
  return entry({
    type: "assistant",
    message: { role: "assistant", model: "claude-opus-5-5", content },
    uuid: "a-1",
    timestamp: "2026-11-04T10:00:05.000Z",
    ...fields,
  });
}
