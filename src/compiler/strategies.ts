/**
 * Turning one observed control into a ranked set of ways to find it again.
 *
 * The ordering is the argument, so it is worth stating explicitly:
 *
 *   role + accessible name   The way an operator perceives the control. Survives
 *                            restyling, relayout, and framework upgrades,
 *                            because it is the thing the screen is *for*. Fails
 *                            only when the label genuinely changes — which is a
 *                            change a human would notice too.
 *
 *   anchored row             The control in the row whose label cell reads X.
 *                            The only option when a control has no accessible
 *                            name, which on legacy forms is common rather than
 *                            exceptional. Slightly weaker because it depends on
 *                            table structure as well as text.
 *
 *   form field name          Part of the HTTP contract in a server-rendered
 *                            app, so it is more stable than it looks — changing
 *                            it means changing the handler. But it is invisible
 *                            to users, so nothing stops a rewrite from renaming
 *                            it silently.
 *
 *   generated DOM id         Last. Framework-generated ids like
 *                            ctl00_MainContent_txtMemberId encode the control
 *                            tree, so they churn whenever the page is
 *                            restructured and are the first thing to break
 *                            after a vendor upgrade. Recorded for debugging and
 *                            tie-breaking, not for driving.
 *
 * Confidence is not a constant per kind: a strategy that matches more than one
 * control on the screen is demoted, because an ambiguous locator is how replay
 * silently operates the wrong field.
 */

import type { ObservedElement } from "../perception/types.js";
import type { RankedStrategy, Target } from "../schema/capability.js";

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/** How many controls in the same frame a strategy would match. */
function countMatches(
  all: readonly ObservedElement[],
  el: ObservedElement,
  predicate: (candidate: ObservedElement) => boolean,
): number {
  return all.filter((c) => samePath(c.framePath, el.framePath) && predicate(c)).length;
}

export function deriveStrategies(
  el: ObservedElement,
  all: readonly ObservedElement[],
): RankedStrategy[] {
  const ranked: RankedStrategy[] = [];

  if (el.name !== "") {
    const matches = countMatches(all, el, (c) => c.role === el.role && c.name === el.name);
    const unique = matches === 1;
    ranked.push({
      strategy: { kind: "role_name", role: el.role, name: el.name },
      confidence: unique ? 0.95 : 0.5,
      rationale: unique
        ? `Unique ${el.role} named "${el.name}" in this frame. This is how an operator identifies ` +
          `the control, so it survives restyling and relayout; it breaks only if the label itself changes.`
        : `${matches} controls in this frame share role ${el.role} and name "${el.name}", so this ` +
          `cannot discriminate between them on its own and is demoted below anchored targeting.`,
    });
  }

  if (el.anchorText !== null && el.anchorText !== "") {
    const matches = countMatches(all, el, (c) => c.role === el.role && c.anchorText === el.anchorText);
    const unique = matches === 1;
    ranked.push({
      strategy: { kind: "anchored_row", role: el.role, anchorText: el.anchorText },
      confidence: unique ? 0.85 : 0.45,
      rationale: unique
        ? `The only ${el.role} in the row labelled "${el.anchorText}". ` +
          (el.name === ""
            ? `This control has no accessible name, so this is the primary strategy rather than a fallback — ` +
              `it is the same cue a human uses to find an unlabelled field.`
            : `Independent of the accessible name, so it still resolves if the label is reworded.`)
        : `${matches} controls share the anchor "${el.anchorText}", so this is ambiguous on its own.`,
    });
  }

  if (el.hints.fieldName !== null && el.hints.fieldName !== "") {
    const matches = countMatches(all, el, (c) => c.hints.fieldName === el.hints.fieldName);
    ranked.push({
      strategy: { kind: "field_name", fieldName: el.hints.fieldName },
      confidence: matches === 1 ? 0.7 : 0.35,
      rationale:
        `Form field name "${el.hints.fieldName}". In a server-rendered application this is part of ` +
        `the HTTP contract, so changing it means changing the request handler — more durable than it ` +
        `appears. Ranked below semantic strategies because it is invisible to users, so a rewrite can ` +
        `rename it without anyone noticing.` +
        (matches === 1 ? "" : ` Matches ${matches} controls here, so it is demoted further.`),
    });
  }

  if (el.hints.domId !== null && el.hints.domId !== "") {
    ranked.push({
      strategy: { kind: "dom_id", domId: el.hints.domId },
      confidence: 0.35,
      rationale:
        `Generated control id "${el.hints.domId}". Ids of this shape encode the server control tree, ` +
        `so they change whenever the page is restructured and are usually the first locator to break ` +
        `after a vendor upgrade. Kept for debugging and tie-breaking, not for driving.`,
    });
  }

  return ranked.sort((a, b) => b.confidence - a.confidence);
}

/** Human-readable identification, used in reviews and failure messages. */
export function describeTarget(el: ObservedElement): string {
  if (!el.actionable) {
    return el.anchorText !== null
      ? `the value labelled "${el.anchorText}"`
      : `the value "${el.value ?? ""}"`;
  }
  if (el.name !== "") return `the ${el.role} "${el.name}"`;
  if (el.anchorText !== null) return `the ${el.role} in the row labelled "${el.anchorText}"`;
  return `an unlabelled ${el.role}`;
}

export class NoStrategyError extends Error {
  constructor(el: ObservedElement) {
    super(
      `No durable way to identify ${describeTarget(el)} (role=${el.role}, name="${el.name}", ` +
        `anchor=${JSON.stringify(el.anchorText)}). Recording a step whose target cannot be found ` +
        `again would produce a capability that fails on first replay.`,
    );
    this.name = "NoStrategyError";
  }
}

export function deriveTarget(el: ObservedElement, all: readonly ObservedElement[]): Target {
  const strategies = deriveStrategies(el, all);
  // Refusing to emit a target we cannot resolve is better than emitting one
  // that will fail later with no explanation of why it was ever trusted.
  if (strategies.length === 0) throw new NoStrategyError(el);

  return {
    description: describeTarget(el),
    framePath: [...el.framePath],
    actionable: el.actionable,
    strategies,
  };
}
