/**
 * The evidence bus.
 *
 * Every run — discovery or replay — writes a structured, append-only event log
 * plus richer artefacts on failure. Two rules shape the design:
 *
 * 1. Everything passes through the redactor on the way out. Redacting at the
 *    write boundary rather than at each call site means a new caller cannot
 *    forget; the only way to write an unredacted byte is to bypass this class.
 *
 * 2. Raw output goes to .runs/ (gitignored), never straight to /evidence/.
 *    A discovery run captures DOM snapshots, screenshots and model reasoning
 *    from a live system. Promoting a curated bundle into the committed
 *    /evidence/ directory is a deliberate second step, so "what gets published"
 *    is a decision rather than a default.
 */

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { redactor } from "../policy/redactor.js";

export type EventKind =
  | "run.start"
  | "run.end"
  | "observation"
  | "model.decision"
  | "policy.decision"
  | "action.start"
  | "action.result"
  | "checkpoint"
  | "extraction"
  | "escalation"
  | "recovery"
  | "outcome"
  | "drift"
  | "error";

export interface EvidenceEvent {
  readonly seq: number;
  readonly at: string;
  readonly kind: EventKind;
  readonly message: string;
  readonly data?: unknown;
}

export class EvidenceBus {
  readonly runId: string;
  readonly dir: string;
  #seq = 0;
  readonly #events: EvidenceEvent[] = [];

  constructor(runId: string, rootDir = ".runs") {
    this.runId = runId;
    this.dir = join(rootDir, runId);
    mkdirSync(join(this.dir, "screenshots"), { recursive: true });
  }

  get events(): readonly EvidenceEvent[] {
    return this.#events;
  }

  emit(kind: EventKind, message: string, data?: unknown): EvidenceEvent {
    const event: EvidenceEvent = {
      seq: this.#seq++,
      at: new Date().toISOString(),
      kind,
      message: redactor.redactText(message),
      ...(data === undefined ? {} : { data: redactor.redactDeep(data) }),
    };
    this.#events.push(event);
    appendFileSync(join(this.dir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  /** The richer signal the brief asks for on failure. */
  saveScreenshot(name: string, png: Buffer): string {
    const file = join(this.dir, "screenshots", `${name}.png`);
    writeFileSync(file, png);
    this.emit("error", `Screenshot captured: ${name}`, { file });
    return file;
  }

  /** DOM or accessibility-tree snapshot. Text, so it goes through redaction. */
  saveSnapshot(name: string, content: string): string {
    const file = join(this.dir, `${name}.txt`);
    writeFileSync(file, redactor.redactText(content), "utf8");
    return file;
  }

  /** Structured evidence other than the run result, such as intervention records. Redacted on write. */
  writeJson(relativePath: string, data: unknown): string {
    const file = join(this.dir, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(redactor.redactDeep(data), null, 2), "utf8");
    return file;
  }

  writeResult(result: unknown): string {
    const file = join(this.dir, "result.json");
    writeFileSync(file, JSON.stringify(redactor.redactDeep(result), null, 2), "utf8");
    return file;
  }

  /**
   * Re-applies redaction to the event log with every secret known now.
   *
   * Events are redacted as they are written, against the secrets registered at
   * that moment. A credential registered later, typed into a password field
   * after the goal that contained it was logged, would otherwise stay in the
   * earlier lines. Redaction is idempotent, so this is safe to call again.
   */
  rescrub(): void {
    const scrubbed = this.#events.map((event) => ({
      ...event,
      message: redactor.redactText(event.message),
      ...(event.data === undefined ? {} : { data: redactor.redactDeep(event.data) }),
    }));
    this.#events.splice(0, this.#events.length, ...scrubbed);
    writeFileSync(join(this.dir, "events.jsonl"), scrubbed.map((event) => `${JSON.stringify(event)}\n`).join(""), "utf8");
  }
}

export function newRunId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${prefix}-${stamp}`;
}
