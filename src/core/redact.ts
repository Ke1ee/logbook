/**
 * Credential redaction.
 *
 * Every string Logbook stores or shows passes through redact() first. The
 * transcripts it reads hold whatever the agents printed: connection strings,
 * `cat .env` output, API responses, curl commands. The rules err toward hiding,
 * because a false positive costs a few characters of context and a false
 * negative puts a live credential in the database and on screen. The one
 * deliberate exception: in code, a value that only *refers* to a secret
 * (`req.body.password`, `process.env.API_KEY`, `${TOKEN}`) is kept, so diffs of
 * auth code stay readable.
 *
 * Every repetition that can run along a long token is bounded, so a hostile
 * 60K-character line costs milliseconds rather than seconds.
 *
 * Callers must redact before truncating: cutting first can split a secret so
 * that no rule recognizes the half that remains (see safe() in parse.ts).
 */

const mark = (kind: string): string => `[REDACTED:${kind}]`;

const QUOTES = /^["'`]|["'`]$/g;

/** Placeholders and empties that are safe to show whether quoted or not. */
const PLACEHOLDER =
  /^(?:\*{3,}|x{4,}|\.{3}|…|<[^>]*>|\[REDACTED[^\]]*\]?|null|none|nil|changeme|your[-_ ].*|basic|bearer|token|digest|\$\{.*|\$\(.*)$/i;

/** $UPPER_CASE is a shell variable; $mixedCase123 is just a password that starts with "$". */
const SHELL_VARIABLE = /^\$[A-Z_][A-Z0-9_]*$/;

/** Unquoted values that are code pointing at a secret, not the secret itself. */
const CODE_REFERENCE = [
  /^(?:process\.env|import\.meta\.env|Bun\.env|Deno\.env|os\.environ|os\.getenv|getenv|ENV\[|ENV\.fetch|System\.getenv|std::env|env[.(]|secrets\.|vars\.|config\.|settings\.)/,
  /^(?:await|new|function|async|require|import|typeof|this|self)\b/,
  /^(?:true|false|undefined|null|string|number|boolean|any|unknown|never|object|bigint|symbol|str|int|bool|bytes)$/,
  // property access or a call, letters only: req.body.password, getToken(), z.string(), obj->key
  /^[A-Za-z_$][A-Za-z_$]*(?:(?:\.|::|->)[A-Za-z_$][A-Za-z_$]*)+(?:[([].*)?$/,
  /^[A-Za-z_$][\w$]*\(/,
  // Identifiers made of real words: userPassword, api_token_value, refreshed. Random
  // tokens fail these (dJQxE9rY... has digits and one-letter humps), and a plain
  // lowercase word is far more often a variable than a credential.
  /^[a-z]{2,}(?:[A-Z][a-z]{2,})+$/,
  /^[a-z]{2,}(?:_[a-z]{2,})+$/,
  /^[a-z]{1,24}$/,
];

/** True when a matched value only refers to a secret (or is a placeholder) and can be shown. */
function isReference(raw: string, key = ""): boolean {
  const quoted = /^["'`]/.test(raw);
  const value = raw.replace(QUOTES, "").trim();
  // Under six characters there is too little entropy to be a credential worth hiding.
  if (value.length < 6 || PLACEHOLDER.test(value) || SHELL_VARIABLE.test(value)) return true;
  // Token counts (max_tokens: 4096, cache_read_input_tokens: 1234567) are not secrets.
  if (/^\d+$/.test(value) && /token/i.test(key)) return true;
  if (quoted) return raw.startsWith("`") && value.includes("${"); // template literals built from variables
  return CODE_REFERENCE.some((pattern) => pattern.test(value));
}

/** Put the marker where the value was, keeping its quotes so the surrounding code still parses by eye. */
function wrap(value: string, marker: string): string {
  const quote = value[0];
  return quote === '"' || quote === "'" || quote === "`" ? `${quote}${marker}${quote}` : marker;
}

type Replacer = (match: string, ...groups: string[]) => string;

interface Rule {
  kind: string;
  pattern: RegExp;
  replace: Replacer;
  /** Cheap pre-check: skip the rule when the text cannot contain a match. */
  gate?: RegExp;
}

const fixed =
  (kind: string): Replacer =>
  () =>
    mark(kind);

const SECRET_KEY =
  "(?:secret|token|password|passwd|api[_-]?key|apikey|private[_-]?key|access[_-]?key|auth[_-]?key|client[_-]?secret|credentials?|encryption[_-]?key|signing[_-]?key|accountkey|session[_-]?key|master[_-]?key)";

const RULES: readonly Rule[] = [
  {
    kind: "private-key",
    // PEM, OpenSSH and PGP. A key cut off before its END line is hidden through the end of the text.
    pattern:
      /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z ]{0,10}-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z ]{0,10}-----|$)/g,
    replace: fixed("private-key"),
  },
  {
    kind: "url-password",
    // scheme://user:password@host. The password runs to the LAST "@" before the
    // host, so an unencoded "/" or "@" inside it cannot leak a tail.
    // No word boundary before the scheme: a URL glued to other text still matches.
    pattern: /([a-z][a-z0-9+.-]{0,20}:\/\/)([^\s:/@'"`]{0,256}):([^\s'"`]{1,1024})@([^\s@/'"`]{1,256})/gi,
    gate: /:\/\/[^\s]*@/,
    replace: (match, scheme = "", user = "", password = "", host = "") =>
      // host:port/path?email=a@b.com is not a credential
      /^\d{1,5}\//.test(password) ? match : `${scheme}${user}:${mark("password")}@${host}`,
  },
  {
    kind: "query-secret",
    pattern:
      /([?&;](?:password|passwd|pwd|secret|token|access_token|refresh_token|id_token|api[_-]?key|apikey|auth|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature)=)[^&\s"'`#]{1,4096}/gi,
    replace: (_m, prefix = "") => `${prefix}${mark("value")}`,
  },
  {
    kind: "webhook",
    // Webhook URLs whose path is the credential.
    pattern:
      /((?:hooks\.slack\.com\/(?:services|workflows|triggers)|discord(?:app)?\.com\/api\/webhooks\/\d{5,30})\/)[A-Za-z0-9/_-]{8,512}/g,
    replace: (_m, prefix = "") => `${prefix}${mark("webhook")}`,
  },

  // Provider tokens. Distinctive prefixes carry no leading word boundary on
  // purpose: a key glued to other text (KEY_sk-ant-..., a base64 blob) must
  // still match, and these prefixes rarely occur inside ordinary words.
  { kind: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{16,300}/g, replace: fixed("anthropic-key") },
  { kind: "openrouter-key", pattern: /sk-or-v1-[A-Za-z0-9]{32,128}/g, replace: fixed("openrouter-key") },
  {
    kind: "openai-key",
    // Generic "sk-" needs care: kebab-case words (flask-..., risk-...) contain it.
    pattern: /(?<![A-Za-z0-9-])sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,300}|[A-Za-z0-9]{32,200})/g,
    replace: fixed("openai-key"),
  },
  { kind: "stripe-key", pattern: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,250}/g, replace: fixed("stripe-key") },
  { kind: "webhook-secret", pattern: /whsec_[A-Za-z0-9+/=]{10,200}/g, replace: fixed("webhook-secret") },
  {
    kind: "github-token",
    pattern: /(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})/g,
    replace: fixed("github-token"),
  },
  { kind: "gitlab-token", pattern: /glpat-[A-Za-z0-9_-]{20,100}/g, replace: fixed("gitlab-token") },
  { kind: "slack-token", pattern: /(?:xox[abposr]|xapp)-[A-Za-z0-9-]{10,250}/g, replace: fixed("slack-token") },
  { kind: "aws-access-key", pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g, replace: fixed("aws-access-key") },
  { kind: "google-api-key", pattern: /AIza[0-9A-Za-z_-]{35}/g, replace: fixed("google-api-key") },
  { kind: "google-oauth", pattern: /ya29\.[A-Za-z0-9_-]{20,2048}/g, replace: fixed("google-oauth") },
  { kind: "huggingface-token", pattern: /hf_[A-Za-z0-9]{30,100}/g, replace: fixed("huggingface-token") },
  { kind: "npm-token", pattern: /npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g, replace: fixed("npm-token") },
  { kind: "sendgrid-key", pattern: /SG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{30,64}/g, replace: fixed("sendgrid-key") },
  { kind: "shopify-token", pattern: /shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}/g, replace: fixed("shopify-token") },
  {
    kind: "discord-token",
    pattern: /(?<![A-Za-z0-9_-])[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,40}(?![A-Za-z0-9_-])/g,
    replace: fixed("discord-token"),
  },
  { kind: "ebay-token", pattern: /v\^1\.1#i\^1#[^\s"'`]{20,4096}/g, replace: fixed("ebay-token") },
  {
    kind: "jwt",
    // JWS (3 parts) and JWE (5 parts, some possibly empty). Glued tokens match
    // too; the header bound keeps a long "eyJeyJeyJ..." run linear in practice.
    pattern: /eyJ[A-Za-z0-9_-]{8,2048}(?:\.[A-Za-z0-9_-]{0,8192}){2,4}/g,
    replace: fixed("jwt"),
  },

  // Headers and command-line credentials.
  {
    kind: "auth-header",
    pattern:
      /\b(authorization\s{0,10}[:=]\s{0,10}["'`]?\s{0,10}(?:(?:basic|bearer|token|digest|negotiate|apikey|api-key|key|sso-key|ntlm)\s{1,10})?)([^\s"'`,;]{6,4096})/gi,
    replace: (match, prefix = "", value = "") => (isReference(value) ? match : `${prefix}${mark("credential")}`),
  },
  {
    kind: "bearer",
    pattern: /\b(Bearer\s{1,10})([A-Za-z0-9._~+/=-]{16,4096})/gi,
    replace: (match, prefix = "", value = "") => (isReference(value) ? match : `${prefix}${mark("token")}`),
  },
  {
    kind: "cookie",
    // Cookie / Set-Cookie headers carrying name=value pairs (not `cookie: string` in code).
    pattern: /\b((?:set-)?cookie\s{0,10}:\s{0,10})([^\s=;,"'`]{1,256}=[^\n"'`]{1,8192})/gi,
    replace: (_m, prefix = "") => `${prefix}${mark("cookie")}`,
  },
  {
    kind: "cli-basic-auth",
    // curl -u user:password, httpie -a user:password
    pattern: /((?:^|\s)(?:-u|--user|-a|--auth)[\s=]{1,10})([^\s:'"`]{1,256}):([^\s'"`]{1,1024})/g,
    replace: (match, prefix = "", user = "", password = "") =>
      isReference(password) ? match : `${prefix}${user}:${mark("password")}`,
  },
  {
    kind: "cli-secret-flag",
    pattern:
      /((?:^|\s)--(?:password|passwd|token|api-key|apikey|secret|client-secret|auth-token|access-token)[\s=]{1,10})(["']?)([^\s'"`]{3,1024})\2/gi,
    replace: (match, prefix = "", quote = "", value = "") =>
      isReference(value) ? match : `${prefix}${quote}${mark("value")}${quote}`,
  },
  {
    kind: "mysql-password",
    // mysql -uroot -pSECRET (no space after -p); a bare -p prompts and is left alone.
    pattern: /(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n]{0,200}?\s-p)([^\s'"`]{1,256})/g,
    replace: (_m, prefix = "") => `${prefix}${mark("password")}`,
  },
  { kind: "sshpass", pattern: /(\bsshpass\s{1,10}-p\s{0,10})(\S{1,256})/g, replace: (_m, prefix = "") => `${prefix}${mark("password")}` },

  {
    kind: "assignment",
    // key = value wherever the key's name says it holds a secret: .env, YAML,
    // INI, JSON, JS objects, headers (X-API-Key: ...), connection strings
    // (AccountKey=...). Case-insensitive; == => :: and ?: are not assignments.
    pattern: new RegExp(
      String.raw`(?<![A-Za-z0-9_])(["']?)([A-Za-z0-9_.-]{0,60}?${SECRET_KEY}[A-Za-z0-9_.-]{0,60})\1(\s{0,10}(?:=(?![=>~])|:(?!:))\s{0,10})("(?:[^"\\\n]|\\.){0,4096}"|'(?:[^'\\\n]|\\.){0,4096}'|` +
        "`[^`\\n]{0,4096}`" +
        String.raw`|<[^>\n]{0,200}>|[^\s"'` +
        "`" +
        String.raw`,;)}\]]{1,4096})`,
      "gi",
    ),
    gate: new RegExp(SECRET_KEY, "i"),
    replace: (match, quote = "", key = "", sep = "", value = "") =>
      isReference(value, key) ? match : `${quote}${key}${quote}${sep}${wrap(value, mark("value"))}`,
  },
];

export const REDACTION_KINDS: readonly string[] = RULES.map((rule) => rule.kind);

/**
 * Changes whenever the rules change. The store keeps the fingerprint its text
 * was redacted under and re-redacts everything when it differs, so a rule
 * added today also cleans what was stored last month.
 */
export const REDACTION_FINGERPRINT: string = fnv1a(
  [
    ...RULES.map((rule) => `${rule.kind}\u0000${rule.pattern.source}\u0000${rule.pattern.flags}\u0000${rule.replace.toString()}`),
    PLACEHOLDER.source,
    SHELL_VARIABLE.source,
    ...CODE_REFERENCE.map((pattern) => pattern.source),
    isReference.toString(),
  ].join("\n"),
);

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function redact(text: string): string {
  let out = text;
  for (const rule of RULES) {
    if (rule.gate && !rule.gate.test(out)) continue;
    out = out.replace(rule.pattern, rule.replace as (substring: string, ...args: unknown[]) => string);
  }
  return out;
}
