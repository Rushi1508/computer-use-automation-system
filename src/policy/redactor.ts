/**
 * Redaction for everything that leaves the process: evidence logs, model
 * transcripts, intervention requests, and artifacts.
 *
 * The hard part of redaction is not catching secrets, it is not destroying the
 * evidence in the process. A naive "mask every long digit run" rule would
 * scrub the account numbers and balances that a capability's checkpoints
 * assert on, turning a debuggable failure into an unreadable one. So the rule
 * here is classification, not blanket pattern matching:
 *
 *   - Always redacted: credentials. Anything registered as a secret literal at
 *     runtime, and any object value under a credential-shaped key.
 *   - Pattern redacted: identifiers that are never legitimate business output —
 *     SSNs, payment card numbers that pass a Luhn check, bearer tokens, API
 *     keys.
 *   - Deliberately NOT redacted here: account numbers and balances. They are
 *     the declared outputs of the capability, and masking them would defeat
 *     the point of capturing evidence at all.
 *
 * The honest limitation: in a real deployment, member names and account
 * numbers ARE regulated data, and evidence would be redacted per-field using
 * the classification declared on the artifact's output schema rather than left
 * visible. This demo keeps them readable because the data is synthetic and the
 * checkpoints need to be inspectable. The mechanism to do it properly is the
 * `sensitivity` field on artifact parameters — registering a value as secret is
 * the same code path either way.
 */

const CREDENTIAL_KEY = /pass(word|wd)?|secret|token|api[-_]?key|authorization|auth|cookie|credential|ssn|tax[-_]?id|pin\b/i;

const PLACEHOLDER = "[REDACTED]";

interface Pattern {
  readonly name: string;
  readonly regex: RegExp;
  /** Optional extra test; used to avoid masking numbers that merely look long. */
  readonly confirm?: (match: string) => boolean;
}

/** Luhn check, so ordinary long identifiers are not mistaken for card numbers. */
function passesLuhn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const char = digits[i];
    if (char === undefined) return false;
    let d = char.charCodeAt(0) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const PATTERNS: readonly Pattern[] = [
  { name: "anthropic-key", regex: /sk-ant-[A-Za-z0-9_-]{8,}/g },
  { name: "bearer-token", regex: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi },
  { name: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    name: "payment-card",
    regex: /\b(?:\d[ -]?){13,19}\b/g,
    confirm: passesLuhn,
  },
];

export interface RedactionReport {
  readonly text: string;
  /** Rule name -> number of substitutions. Written into evidence for auditability. */
  readonly counts: Readonly<Record<string, number>>;
}

export class Redactor {
  /** Literal values observed at runtime that must never be written anywhere. */
  #secrets = new Set<string>();

  /**
   * Registers a literal secret. Called when the agent fills a field classified
   * sensitive, so the value is scrubbed from every later log line, transcript,
   * and intervention payload — not just the one that introduced it.
   */
  registerSecret(value: string): void {
    const trimmed = value.trim();
    // Very short values would match everywhere and destroy the log.
    if (trimmed.length >= 3) this.#secrets.add(trimmed);
  }

  get secretCount(): number {
    return this.#secrets.size;
  }

  redactText(input: string): string {
    return this.redactTextWithReport(input).text;
  }

  redactTextWithReport(input: string): RedactionReport {
    const counts: Record<string, number> = {};
    let text = input;

    // Registered literals first: they are known-certain, and doing them before
    // the patterns avoids a pattern half-masking a secret and leaving a
    // recognisable remainder.
    for (const secret of this.#secrets) {
      if (secret === "") continue;
      const parts = text.split(secret);
      if (parts.length > 1) {
        counts["registered-secret"] = (counts["registered-secret"] ?? 0) + parts.length - 1;
        text = parts.join(PLACEHOLDER);
      }
    }

    for (const pattern of PATTERNS) {
      text = text.replace(pattern.regex, (match) => {
        if (pattern.confirm !== undefined && !pattern.confirm(match)) return match;
        counts[pattern.name] = (counts[pattern.name] ?? 0) + 1;
        return PLACEHOLDER;
      });
    }

    return { text, counts };
  }

  /**
   * Deep-redacts a structure. Values under credential-shaped keys are replaced
   * wholesale rather than pattern-matched, because a password that happens to
   * look like ordinary text is still a password.
   */
  redactDeep<T>(value: T): T {
    return this.#walk(value) as T;
  }

  #walk(value: unknown, keyHint?: string): unknown {
    if (typeof value === "string") {
      if (keyHint !== undefined && CREDENTIAL_KEY.test(keyHint)) return PLACEHOLDER;
      return this.redactText(value);
    }
    if (Array.isArray(value)) return value.map((v) => this.#walk(v));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = CREDENTIAL_KEY.test(k) && typeof v !== "object" ? PLACEHOLDER : this.#walk(v, k);
      }
      return out;
    }
    return value;
  }
}

/** Shared instance. Secrets registered anywhere are scrubbed everywhere. */
export const redactor = new Redactor();
