/**
 * The guardrail contract.
 *
 * Every action taken against a surface — by the discovery agent or by the
 * deterministic replay engine — passes through this gate. It is built before
 * the agent loop on purpose: a policy engine bolted on afterwards is one that
 * some code path has already learned to bypass.
 *
 * Three verdicts rather than two. "Block" alone would make the system useless
 * for exactly the operations a bank wants automated — opening a sub-account,
 * posting a transaction — since those are irreversible by nature. "Flag" alone
 * is not a guardrail, because the action still happens. Requiring a human
 * decision on the risky class is the only option that keeps the capability
 * useful and still keeps a person accountable for the irreversible step, and it
 * routes into the escalation path that has to exist anyway.
 */

import type { ActionKind } from "../perception/types.js";

export type Verdict = "allow" | "confirm" | "deny";

export interface PolicyDecision {
  readonly verdict: Verdict;
  /** Which rule decided this, for the evidence log. */
  readonly rule: string;
  /** Human-readable justification, surfaced in intervention requests. */
  readonly reason: string;
}

/**
 * How reversible an action is.
 *
 * During discovery this is inferred. During replay it is read from the
 * artifact, where a human reviewed it — inference is a reasonable way to decide
 * whether to interrupt an exploring agent, but a poor basis for deciding
 * whether an unattended production run may move money.
 */
export type RiskClass = "safe_reversible" | "risky_irreversible";

export type PolicyMode = "discovery" | "replay";

export interface PolicyContext {
  readonly mode: PolicyMode;
  /**
   * Replay only. An approved capability has had its risky steps reviewed, so
   * they do not re-prompt on every invocation; a draft still does.
   */
  readonly capabilityApproved?: boolean;
  /** Replay only. The risk class the artifact declares for this step. */
  readonly declaredRisk?: RiskClass;
}

/** What the agent is permitted to do. Everything not permitted is denied. */
export interface PolicyConfig {
  /**
   * Origins the agent may operate against, as `scheme://host:port`. Deny by
   * default: an empty list permits nothing, which is the safe failure mode for
   * a misread config.
   */
  readonly allowedOrigins: readonly string[];
  /** Path prefixes within those origins. ["/"] permits the whole origin. */
  readonly allowedPathPrefixes: readonly string[];
  /** Action verbs the agent may use at all. */
  readonly allowedActions: readonly ActionKind[];
  /**
   * Accessible-name and anchor substrings that mark a control as irreversible.
   * Configurable because the vocabulary is institution- and vendor-specific:
   * one core calls it "Post", another "Commit", another "Release Funds".
   */
  readonly riskyControlPatterns: readonly string[];
  /**
   * Paths that are never navigable regardless of the allowlist. Escape hatch
   * for known-destructive routes inside an otherwise permitted app.
   */
  readonly deniedPathPrefixes: readonly string[];
}

/**
 * Defaults for the demo target.
 *
 * Scoped to one origin and one app rather than left open, because the point of
 * an allowlist is that widening it is a deliberate act.
 */
export function defaultPolicyConfig(origin: string): PolicyConfig {
  return {
    allowedOrigins: [origin],
    allowedPathPrefixes: ["/"],
    allowedActions: ["click", "fill", "select", "navigate", "wait", "read"],
    riskyControlPatterns: [
      "open account",
      "open sub-account",
      "submit",
      "confirm",
      "post",
      "transfer",
      "delete",
      "remove",
      "close account",
      "authorize",
      "approve",
      "disburse",
      "sign off",
    ],
    // The fault control plane is test scaffolding. The agent must never reach
    // it: an agent that can arm faults against its own target can manufacture
    // the conditions it is being evaluated on.
    deniedPathPrefixes: ["/_control"],
  };
}
