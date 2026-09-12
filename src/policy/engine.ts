/**
 * The action gate.
 *
 * Both the discovery agent and the replay engine route every action through
 * `check()` before it reaches a Surface. Nothing else is trusted to remember.
 */

import type { Action, ObservedElement } from "../perception/types.js";
import { redactor } from "./redactor.js";
import type { PolicyConfig, PolicyContext, PolicyDecision, RiskClass } from "./types.js";

function allow(rule: string, reason: string): PolicyDecision {
  return { verdict: "allow", rule, reason };
}
function deny(rule: string, reason: string): PolicyDecision {
  return { verdict: "deny", rule, reason };
}
function confirm(rule: string, reason: string): PolicyDecision {
  return { verdict: "confirm", rule, reason };
}

/** Password-ish fields whose typed value must never reach a log or artifact. */
function isSecretField(target: ObservedElement): boolean {
  if (target.hints.inputType === "password") return true;
  return /pass(word|wd)?|secret|token|pin\b/i.test(`${target.name} ${target.anchorText ?? ""}`);
}

export class PolicyEngine {
  constructor(private readonly config: PolicyConfig) {}

  /**
   * Decides whether an action may proceed.
   *
   * `target` is the element the action addresses, when there is one. It is what
   * makes risk classification possible at all: the action verb alone cannot
   * distinguish clicking "Back to Search" from clicking "Open Account".
   */
  check(action: Action, context: PolicyContext, target?: ObservedElement): PolicyDecision {
    if (!this.config.allowedActions.includes(action.kind)) {
      return deny("action-allowlist", `Action '${action.kind}' is not in the permitted action set.`);
    }

    if (action.kind === "navigate") {
      const urlDecision = this.checkLocation(action.url);
      if (urlDecision.verdict !== "allow") return urlDecision;
    }

    // Registering the secret is a side effect of the check rather than
    // something callers must remember to do. A guardrail that depends on every
    // call site being disciplined is not a guardrail.
    if (action.kind === "fill" && target !== undefined && isSecretField(target)) {
      redactor.registerSecret(action.value);
    }

    const risk = this.riskOf(action, context, target);
    if (risk === "safe_reversible") {
      return allow("risk-classification", "Action is reversible and read-only in effect.");
    }

    const label = target?.name !== undefined && target.name !== "" ? target.name : (target?.anchorText ?? action.kind);

    if (context.mode === "replay" && context.capabilityApproved === true) {
      return allow(
        "approved-capability",
        `Irreversible step '${label}' was reviewed and approved when this capability was published.`,
      );
    }

    return confirm(
      "risky-irreversible",
      `'${label}' looks irreversible. A person should decide before it runs.`,
    );
  }

  /**
   * Checks a URL against the allowlist. Called before navigating, and again
   * after any action that might have navigated — a click can land somewhere the
   * allowlist forbids, and only checking intent would miss it.
   */
  checkLocation(rawUrl: string): PolicyDecision {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return deny("url-parse", `'${rawUrl}' is not a valid absolute URL.`);
    }

    if (!this.config.allowedOrigins.includes(url.origin)) {
      return deny("origin-allowlist", `Origin ${url.origin} is not permitted.`);
    }

    for (const denied of this.config.deniedPathPrefixes) {
      if (url.pathname.startsWith(denied)) {
        return deny("path-denylist", `Path ${url.pathname} is explicitly denied.`);
      }
    }

    const permitted = this.config.allowedPathPrefixes.some((p) => url.pathname.startsWith(p));
    if (!permitted) {
      return deny("path-allowlist", `Path ${url.pathname} is not within a permitted prefix.`);
    }

    return allow("url-allowlist", `${url.origin}${url.pathname} is permitted.`);
  }

  /**
   * Classifies an action's reversibility.
   *
   * On replay the artifact's declared class wins, because a human reviewed it.
   * Inference is good enough to decide whether to interrupt an exploring agent;
   * it is not good enough to decide whether an unattended production run may
   * move money.
   */
  riskOf(action: Action, context: PolicyContext, target?: ObservedElement): RiskClass {
    if (context.mode === "replay" && context.declaredRisk !== undefined) {
      return context.declaredRisk;
    }
    return this.inferRisk(action, target);
  }

  /**
   * Heuristic risk inference for discovery.
   *
   * Only committing actions are treated as irreversible. Typing into a field
   * changes nothing durable; it is the control that submits the form which
   * does. Matching is on the accessible name and anchor text because that is
   * what a human operator reads before deciding the same thing.
   *
   * Known limitation: a control whose label does not contain a recognised verb
   * is classified safe. That is a false negative by construction, which is why
   * the artifact carries a reviewable per-step risk class rather than relying
   * on this at replay time.
   */
  inferRisk(action: Action, target?: ObservedElement): RiskClass {
    if (action.kind !== "click") return "safe_reversible";
    if (target === undefined) return "safe_reversible";

    const haystack = `${target.name} ${target.anchorText ?? ""}`.toLowerCase();
    for (const pattern of this.config.riskyControlPatterns) {
      if (haystack.includes(pattern.toLowerCase())) return "risky_irreversible";
    }
    return "safe_reversible";
  }
}
