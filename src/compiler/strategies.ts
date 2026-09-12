/**
 * Ranking the ways a recorded element can be found again.
 *
 * The ordering is the argument, so it is worth stating explicitly:
 *
 *   role + accessible name   How an operator perceives the control. Survives
 *                            restyling, relayout and framework upgrades,
 *                            because it is the thing the screen is for. Fails
 *                            only when the label genuinely changes.
 *
 *   grid cell                A value in a data grid, identified by BOTH its
 *                            column header and a cell that identifies its row.
 *                            Either coordinate alone is ambiguous — every cell
 *                            in a row shares the row's neighbours.
 *
 *   anchored row             The element next to a label cell reading X. The
 *                            only option for a control with no accessible name,
 *                            which on legacy forms is normal, not exceptional.
 *
 *   form field name          Part of the HTTP contract in a server-rendered
 *                            app, so more durable than it looks; ranked lower
 *                            because nothing visible stops a rewrite renaming it.
 *
 *   generated DOM id         Last. Ids like ctl00_MainContent_txtMemberId encode
 *                            the server control tree and are the first locator
 *                            to break after a vendor upgrade.
 *
 * Confidence is computed from what was actually on screen when the step was
 * recorded. A strategy that matched more than one element there is demoted,
 * because an ambiguous locator is how replay silently operates the wrong field.
 * The counts come from the same matcher replay resolves with.
 */

import { candidateStrategies, type LocatorEvidence, strategyKey } from "../locator/match.js";
import type { ObservedElement } from "../perception/types.js";
import type { RankedStrategy, Strategy, Target } from "../schema/capability.js";

const BASE_CONFIDENCE: Readonly<Record<Strategy["kind"], number>> = {
  role_name: 0.95,
  grid_cell: 0.92,
  anchored_row: 0.85,
  field_name: 0.7,
  dom_id: 0.35,
};

const round = (n: number): number => Math.round(n * 100) / 100;

function rationaleFor(strategy: Strategy, el: ObservedElement, matches: number | null): string {
  const uniqueness =
    matches === null
      ? " Uniqueness was not recorded for this step, so confidence is reduced until it is re-recorded."
      : matches === 1
        ? ""
        : ` ${matches} elements on the recorded screen match this, so on its own it cannot tell them apart.`;

  switch (strategy.kind) {
    case "role_name":
      return (
        `The ${strategy.role} named "${strategy.name}" — how an operator identifies it, so it survives ` +
        `restyling and relayout and breaks only if the label itself changes.` +
        uniqueness
      );

    case "grid_cell":
      return (
        `The cell under the "${strategy.column}" column in the row containing "${strategy.rowContains}". ` +
        `A value in a data grid needs both coordinates: cells in one row share the same neighbours, so a ` +
        `row label alone matches several of them. Matching the column by header text rather than position ` +
        `also survives columns being reordered.` +
        uniqueness
      );

    case "anchored_row": {
      const subject = el.actionable
        ? `The ${strategy.role} whose label cell reads "${strategy.anchorText}".`
        : `The text next to "${strategy.anchorText}".`;
      const note =
        el.actionable && el.name === ""
          ? " This control has no accessible name, so this is the cue a human actually uses to find it — the primary strategy, not a fallback."
          : el.grid !== undefined
            ? " Ranked below the grid coordinate, which also pins the column."
            : " Independent of the accessible name, so it still resolves if the label is reworded.";
      return subject + note + uniqueness;
    }

    case "field_name":
      return (
        `Form field name "${strategy.fieldName}". In a server-rendered application this is part of the HTTP ` +
        `contract, so changing it means changing the request handler. Ranked below semantic strategies ` +
        `because it is invisible to users, so a rewrite can rename it without anyone noticing.` +
        uniqueness
      );

    case "dom_id":
      return (
        `Generated control id "${strategy.domId}". Ids of this shape encode the server control tree, so they ` +
        `change whenever the page is restructured and are usually the first locator to break after a vendor ` +
        `upgrade. Kept for debugging and tie-breaking, not for driving.` +
        uniqueness
      );
  }
}

export function deriveStrategies(
  el: ObservedElement,
  evidence: readonly LocatorEvidence[],
): RankedStrategy[] {
  const counts = new Map(evidence.map((e) => [strategyKey(e.strategy), e.matches] as const));

  return candidateStrategies(el)
    .map((strategy) => {
      const matches = counts.get(strategyKey(strategy)) ?? null;
      const base = BASE_CONFIDENCE[strategy.kind];
      const confidence = matches === null ? round(base * 0.8) : matches === 1 ? base : round(base * 0.5);
      return { strategy, confidence, rationale: rationaleFor(strategy, el, matches) };
    })
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * Human-readable identification, used in reviews and failure messages.
 * Never includes the element's value: that would copy this run's data into the artifact.
 */
export function describeTarget(el: ObservedElement): string {
  if (!el.actionable) {
    if (el.grid !== undefined && el.anchorText !== null) {
      return `the "${el.grid.columnHeader}" value in the row containing "${el.anchorText}"`;
    }
    return el.anchorText !== null ? `the value labelled "${el.anchorText}"` : "an unlabelled value";
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

export function deriveTarget(el: ObservedElement, evidence: readonly LocatorEvidence[]): Target {
  const strategies = deriveStrategies(el, evidence);
  // Refusing to emit a target we cannot resolve is better than emitting one
  // that fails later with no record of why it was ever trusted.
  if (strategies.length === 0) throw new NoStrategyError(el);

  return {
    description: describeTarget(el),
    framePath: [...el.framePath],
    actionable: el.actionable,
    strategies,
  };
}
