import { describe, expect, test } from "bun:test";
import { redact } from "../src/core/redact.ts";
import { fake, noise } from "./helpers.ts";

describe("shapes found in review", () => {
  const v = (n: number) => noise(n);
  const hex = (n: number) => noise(n, "0123456789abcdef");
  const b64 = (n: number) => noise(n, "AbCdEfGh0123456789+/");
  // [label, text containing the secret, the secret]
  const cases: Array<[string, string, string]> = [
    ["aws credentials ini", `[default]\naws_secret_access_key = wJalr${b64(35)}`, `wJalr${b64(35)}`],
    ["authorization basic", `curl -H 'Authorization: Basic ${btoa(`admin:${v(14)}`)}' https://api.x.io`, btoa(`admin:${v(14)}`)],
    ["curl -u", `curl -u admin:${v(16)} https://api.x.io/v1`, v(16)],
    ["cookie header", `cookie: sessionid=${v(32)}; csrftoken=abc`, v(32)],
    ["set-cookie", `set-cookie: __Secure-next-auth.session-token=${v(60)}; Path=/`, v(60)],
    ["yaml lowercase", `production:\n  adapter: postgresql\n  password: ${v(20)}\n`, v(20)],
    ["rails secret_key_base", `secret_key_base: ${hex(64)}`, hex(64)],
    ["js object", `const cfg = { password: "${v(18)}", user: "x" }`, v(18)],
    ["python", `api_key = "${v(24)}"`, v(24)],
    ["x-api-key header", `-H "X-API-KEY: ${v(32)}"`, v(32)],
    ["azure connection string", `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${b64(86)}==;EndpointSuffix=x`, b64(86)],
    ["url password containing /", `postgres${"://"}app:ab/${v(14)}@db.internal:5432/app`, `ab/${v(14)}`],
    ["url password containing @", `postgres${"://"}app:p@${v(14)}@db.internal:5432/app`, v(14)],
    ["env value starting with $", `DB_PASSWORD=$${v(15)}`, v(15)],
    ["slack webhook", `https://hooks.slack.com/services/T0${v(8)}/B0${v(8)}/${v(24)}`, v(24)],
    ["discord webhook", `https://discord.com/api/webhooks/123456789012345678/${v(68)}`, v(68)],
    ["openrouter", `sk-${"or"}-v1-${hex(64)}`, hex(64)],
    ["google oauth", `ya${"29"}.${v(120)}`, v(120)],
    ["gitlab", `gl${"pat"}-${v(20)}`, v(20)],
    ["huggingface", `h${"f"}_${v(34)}`, v(34)],
    ["mysql -p", `mysql -uroot -p${v(14)} app`, v(14)],
    ["npmrc", `//registry.npmjs.org/:_authToken=6f1b2c3d-4e5f-4a7b-8c9d-${hex(12)}`, `6f1b2c3d-4e5f-4a7b-8c9d-${hex(12)}`],
    ["aws json", `{"Credentials": {"SecretAccessKey": "${b64(40)}", "SessionToken": "${b64(300)}"}}`, b64(40)],
    ["k8s secret", `data:\n  password: ${btoa(v(20))}\n`, btoa(v(20))],
    ["discord bot token", `client.login("M${v(25)}.${v(6)}.${v(38)}")`, `M${v(25)}.${v(6)}.${v(38)}`],
    ["ebay token", `EBAY_TOKEN v${"^"}1.1#i^1#r^1#${v(60)}`, v(60)],
  ];
  for (const [label, text, secret] of cases) {
    test(label, () => {
      const out = redact(text);
      expect(out).not.toContain(secret);
      expect(out).toContain("[REDACTED:");
    });
  }

  test("a connection string glued to preceding text", () => {
    expect(redact(`xxxx${fake.dbUrl()}`)).not.toContain(fake.dbPassword());
  });

  test("overlapping rules leave one clean marker", () => {
    expect(redact(`aws_access_key_id = ${fake.awsAccessKey()}`)).toBe("aws_access_key_id = [REDACTED:aws-access-key]");
  });
});

describe("code that only refers to secrets stays readable", () => {
  const unchanged = [
    "const password = req.body.password;",
    "if (token === undefined) return;",
    "const apiKey = process.env.ANTHROPIC_API_KEY;",
    "apiKey: z.string().min(1),",
    "password?: string;",
    "token: string;",
    "headers: { Authorization: `Bearer ${token}` }",
    "const session = await getToken();",
    'password = os.environ["DB_PASSWORD"]',
    '"max_tokens": 1024, "cache_read_input_tokens": 1234567',
    "PWD=/Users/me/app",
    "export DB_PASSWORD=$DB_PASSWORD_PROD",
    "password: ${{ secrets.DB_PASSWORD }}",
    "fetch('https://api.example.com:8080/users?email=a@b.com')",
    "token.value = refreshed;",
    "const userPassword = hash(password);",
  ];
  for (const line of unchanged) {
    test(line, () => {
      expect(redact(line)).toBe(line);
    });
  }
});

describe("performance on hostile input", () => {
  const runs = [
    "a.".repeat(30_000),
    "a-".repeat(30_000),
    "eyJ".repeat(20_000),
    "SECRET".repeat(10_000),
    '"token'.repeat(10_000),
    "password=".repeat(6_000),
    `postgres${"://"}u:${"@".repeat(50_000)}`,
  ];
  for (const text of runs) {
    test(`${JSON.stringify(text.slice(0, 12))}… (${text.length} chars)`, () => {
      const started = performance.now();
      redact(text);
      expect(performance.now() - started).toBeLessThan(250);
    });
  }
});

describe("redact", () => {
  test("provider tokens are hidden and the surrounding text kept", () => {
    for (const secret of [fake.anthropicKey(), fake.stripeKey(), fake.githubToken(), fake.awsAccessKey(), fake.jwt()]) {
      const out = redact(`token is ${secret} ok`);
      expect(out).not.toContain(secret);
      expect(out).toMatch(/^token is \[REDACTED:[a-z-]+\] ok$/);
    }
  });

  test("tokens glued to other text are still caught", () => {
    for (const secret of [fake.anthropicKey(), fake.stripeKey(), fake.githubToken(), fake.jwt()]) {
      expect(redact(`KEY_${secret}`)).not.toContain(secret);
      expect(redact(`xxxx${secret}`)).not.toContain(secret);
    }
  });

  test("OpenAI-style keys match, kebab-case words do not", () => {
    const projectKey = `sk-${"proj"}-${"Zq9Xw".repeat(6)}`;
    const legacyKey = `sk-${"Zq9Xw0".repeat(6)}`;
    expect(redact(projectKey)).toBe("[REDACTED:openai-key]");
    expect(redact(legacyKey)).toBe("[REDACTED:openai-key]");
    const words = "flask-sqlalchemy-integration-helpers risk-assessment-framework-version-two";
    expect(redact(words)).toBe(words);
  });

  test("a connection string keeps user and host but loses the password", () => {
    const out = redact(`DATABASE_URL=${fake.dbUrl()}`);
    expect(out).not.toContain(fake.dbPassword());
    expect(out).toContain("app_user:[REDACTED:password]@db.example.com:5432/app");
  });

  test("a URL password with an empty user", () => {
    const out = redact(`redis${"://"}:${fake.dbPassword()}@cache.internal:6379`);
    expect(out).not.toContain(fake.dbPassword());
  });

  test(".env and shell assignments", () => {
    const out = redact(`STRIPE_WEBHOOK_SECRET=abc123def456\nexport API_TOKEN="q1w2e3r4t5"\nDB_PASSWORD: s3cr3tpass`);
    expect(out).not.toContain("abc123def456");
    expect(out).not.toContain("q1w2e3r4t5");
    expect(out).not.toContain("s3cr3tpass");
    expect(out).toContain("STRIPE_WEBHOOK_SECRET=[REDACTED:value]");
  });

  test("references to secrets and small numbers survive", () => {
    const text = "API_KEY=process.env.API_KEY\nMAX_TOKENS=4096\nSECRET_NAME=${SECRET}\nAUTH_TOKEN=<your token>";
    expect(redact(text)).toBe(text);
  });

  test("quoted JSON keys", () => {
    const out = redact(`{"apiKey": "q1w2e3r4t5y6", "max_tokens": 1024, "token_type": "pat"}`);
    expect(out).toContain(`"apiKey": "[REDACTED:value]"`);
    expect(out).toContain(`"max_tokens": 1024`);
    expect(out).toContain(`"token_type": "pat"`);
  });

  test("private key blocks, including ones cut off before their END line", () => {
    const key = fake.privateKey();
    expect(redact(`before\n${key}\nafter`)).toBe("before\n[REDACTED:private-key]\nafter");
    const truncated = key.slice(0, 60);
    expect(redact(`before\n${truncated}`)).toBe("before\n[REDACTED:private-key]");
  });

  test("bearer tokens and signed URL parameters", () => {
    const token = `${"Zq9Xw".repeat(4)}abcdef`;
    expect(redact(`Authorization: Bearer ${token}`)).toBe("Authorization: Bearer [REDACTED:credential]");
    expect(redact(`-H "Bearer ${token}"`)).toBe('-H "Bearer [REDACTED:token]"');
    const url = redact("https://r2.example.com/img.png?X-Amz-Signature=abcdef0123456789&width=300");
    expect(url).toBe("https://r2.example.com/img.png?X-Amz-Signature=[REDACTED:value]&width=300");
  });

  test("is idempotent", () => {
    const once = redact(`${fake.dbUrl()} ${fake.stripeKey()} SESSION_SECRET=abcdefgh`);
    expect(redact(once)).toBe(once);
  });

  test("leaves ordinary prose and code alone", () => {
    const text =
      "Make the webhook handler idempotent: key on event.id. See https://example.com/docs and ops@example.com.\n" +
      "const retries = 3;\nfunction tokenize(input: string) { return input.split(' '); }";
    expect(redact(text)).toBe(text);
  });
});
