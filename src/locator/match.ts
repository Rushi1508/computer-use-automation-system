/**
 * One matcher, shared by recording and replay.
 *
 * The compiler decides how far to trust a locator by asking "how many elements
 * on the recorded screen did this strategy match?". Replay asks "which element
 * does this strategy match now?". If those questions were answered by different
 * code, "unique when recorded" and "resolves when replayed" could quietly mean
 * different things — which is exactly how a capability was once compiled with a
 * read target rated unique that in fact matched two cells. Both sides call the
 * functions below, so the two answers cannot drift apart.
 *
 * Everything here operates on Observations, never on a browser. That is what
 * lets replay run unchanged against any Surface: a desktop driver producing the
 * same ObservedElement shape gets resolution, drift reporting and detectors
 * without a line of new locator code.
 */

import type { FramePath, Observation, ObservedElement } from "../perception/types.js";
import type { Detector, Strategy, Target } from "../schema/capability.js";

export function samePath(a: FramePath, b: FramePath): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

/** Every strategy an element can be found by, unranked. Ranking is the compiler's job. */
export function candidateStrategies(el: ObservedElement): Strategy[] {
  const out: Strategy[] = [];
  const anchor = el.anchorText ?? "";

  if (!el.actionable && el.grid !== undefined && anchor !== "") {
    out.push({ kind: "grid_cell", column: el.grid.columnHeader, rowContains: anchor });
  }
  if (el.name !== "") out.push({ kind: "role_name", role: el.role, name: el.name });
  if (anchor !== "") out.push({ kind: "anchored_row", role: el.role, anchorText: anchor });

  const fieldName = el.hints.fieldName ?? "";
  if (fieldName !== "") out.push({ kind: "field_name", fieldName });
  const domId = el.hints.domId ?? "";
  if (domId !== "") out.push({ kind: "dom_id", domId });

  return out;
}

export function strategyMatches(strategy: Strategy, el: ObservedElement): boolean {
  switch (strategy.kind) {
    case "role_name":
      return el.role === strategy.role && el.name === strategy.name;
    case "anchored_row":
      return el.role === strategy.role && el.anchorText === strategy.anchorText;
    case "grid_cell":
      return (
        el.grid !== undefined &&
        el.grid.columnHeader === strategy.column &&
        el.grid.rowTexts.includes(strategy.rowContains)
      );
    case "field_name":
      return el.hints.fieldName === strategy.fieldName;
    case "dom_id":
      return el.hints.domId === strategy.domId;
  }
}

export interface MatchScope {
  readonly framePath: FramePath;
  readonly actionable: boolean;
  /** Search every frame. For application-wide remedies such as dismissing an interstitial. */
  readonly anyFrame?: boolean;
}

export function findMatches(
  strategy: Strategy,
  scope: MatchScope,
  elements: readonly ObservedElement[],
): ObservedElement[] {
  return elements.filter(
    (el) =>
      el.actionable === scope.actionable &&
      (scope.anyFrame === true || samePath(el.framePath, scope.framePath)) &&
      strategyMatches(strategy, el),
  );
}

/** How many elements a candidate strategy matched on the screen where the step was recorded. */
export interface LocatorEvidence {
  readonly strategy: Strategy;
  readonly matches: number;
}

/**
 * Recorded alongside each trace step, against the full observation at the
 * moment of acting. Stores counts rather than the other elements themselves,
 * so the trace carries what uniqueness needs without copying every value on
 * the screen into evidence.
 */
export function locatorEvidence(
  target: ObservedElement,
  elements: readonly ObservedElement[],
): LocatorEvidence[] {
  const scope: MatchScope = { framePath: target.framePath, actionable: target.actionable };
  return candidateStrategies(target).map((strategy) => ({
    strategy,
    matches: findMatches(strategy, scope, elements).length,
  }));
}

/** Stable identity for a strategy, for joining recorded evidence to ranked strategies. */
export function strategyKey(strategy: Strategy): string {
  return JSON.stringify(strategy);
}

// --- Resolution -------------------------------------------------------------

export interface StrategyAttempt {
  readonly kind: Strategy["kind"];
  readonly rank: number;
  readonly outcome: "resolved" | "no_match" | "ambiguous";
  readonly matches: number;
}

export interface Resolution {
  readonly element: ObservedElement | null;
  readonly attempts: readonly StrategyAttempt[];
  /** Index into the target's strategies of the one that resolved. Above 0 is a drift signal. */
  readonly winnerRank: number | null;
}

/**
 * Walks a target's strategies in rank order and takes the first that matches
 * exactly one element.
 *
 * An ambiguous strategy is skipped, never tie-broken. Picking between two
 * matches is how replay operates the wrong field with no error, and a
 * lower-ranked strategy that is unambiguous is better evidence of which
 * element was meant than a higher-ranked one that is not.
 */
export function resolveTarget(
  target: Target,
  elements: readonly ObservedElement[],
  options: { readonly anyFrame?: boolean } = {},
): Resolution {
  const scope: MatchScope = {
    framePath: target.framePath,
    actionable: target.actionable,
    ...(options.anyFrame === true ? { anyFrame: true } : {}),
  };
  const attempts: StrategyAttempt[] = [];

  for (let rank = 0; rank < target.strategies.length; rank++) {
    const ranked = target.strategies[rank];
    if (ranked === undefined) continue;
    const matches = findMatches(ranked.strategy, scope, elements);
    if (matches.length === 1 && matches[0] !== undefined) {
      attempts.push({ kind: ranked.strategy.kind, rank, outcome: "resolved", matches: 1 });
      return { element: matches[0], attempts, winnerRank: rank };
    }
    attempts.push({
      kind: ranked.strategy.kind,
      rank,
      outcome: matches.length === 0 ? "no_match" : "ambiguous",
      matches: matches.length,
    });
  }

  return { element: null, attempts, winnerRank: null };
}

// --- Detectors ----------------------------------------------------------------

/**
 * Text visible on screen, optionally restricted to one frame.
 *
 * Built from the accessibility tree plus the observed elements' names and
 * values — what a person reads, not the DOM.
 */
export function screenText(obs: Observation, framePath?: FramePath): string {
  const wanted =
    framePath === undefined ? null : framePath.length === 0 ? "(top)" : framePath.join(" > ");
  const sections = obs.tree.split(/^# frame: /m).filter((section) => section.trim() !== "");
  const tree = sections
    .filter((section) => wanted === null || section.startsWith(`${wanted}\n`))
    .join("\n");
  const own = obs.elements
    .filter((el) => framePath === undefined || samePath(el.framePath, framePath))
    .map((el) => `${el.name}\n${el.value ?? ""}`);
  // The snapshot escapes quotes inside names; undo that so detectors match what is shown.
  return [tree, ...own].join("\n").replace(/\\"/g, '"');
}

export function detectorHolds(detector: Detector, obs: Observation): boolean {
  switch (detector.kind) {
    case "text_present":
      return screenText(obs, detector.framePath).includes(detector.text);
    case "text_absent":
      return !screenText(obs).includes(detector.text);
    case "text_matches":
      return new RegExp(detector.pattern).test(screenText(obs, detector.framePath));
    case "url_contains":
      // Top-level URL only. Frames navigate without changing it, which is why
      // detectors on framed applications are written against text instead.
      return obs.url.includes(detector.value);
    case "title_equals":
      return obs.title === detector.value;
    case "grid_column":
      return obs.elements.some(
        (el) =>
          el.grid?.columnHeader === detector.column &&
          (detector.framePath === undefined || samePath(el.framePath, detector.framePath)),
      );
  }
}

const STRUCTURAL_LINE = /^\s*- (heading|columnheader|rowheader|button|link|tab|dialog)\s+"((?:[^"\\]|\\.)*)"/;

/**
 * Text that labels the screen rather than reporting data on it: headings,
 * column headers, button and link names, the title.
 *
 * The distinction is what makes a checkpoint replayable. "Balance" is on every
 * member's detail screen; "Dolores Abernathy" is on exactly one.
 */
export function structuralTexts(obs: Observation): Set<string> {
  const out = new Set<string>();
  for (const line of obs.tree.split("\n")) {
    const text = STRUCTURAL_LINE.exec(line)?.[2]?.replace(/\\"/g, '"').trim();
    if (text !== undefined && text !== "") out.add(text);
  }
  for (const el of obs.elements) {
    if (el.actionable && el.name !== "") out.add(el.name);
    if (el.grid !== undefined) out.add(el.grid.columnHeader);
  }
  if (obs.title !== "") out.add(obs.title);
  return out;
}

/**
 * Chooses text from a free-text checkpoint description that replay can assert.
 *
 * Resolved at record time, while the screen the description refers to is still
 * in front of the agent. Keeps only text that is a structural label on that
 * screen, contains no value the run typed, and has no long digit run (the
 * signature of an identifier or amount). Prefers what the model quoted;
 * otherwise the longest label the description mentions. Returns null rather
 * than guess — an unasserted checkpoint is honest, an asserted guess is not.
 */
export function verifiableText(
  description: string,
  obs: Observation,
  forbidden: readonly string[],
): string | null {
  const structural = structuralTexts(obs);
  const usable = (text: string): boolean =>
    text.length >= 3 &&
    !/\d{3,}/.test(text) &&
    !forbidden.some((f) => f.length >= 2 && text.toLowerCase().includes(f.toLowerCase()));

  for (const match of description.matchAll(/"([^"]{3,80})"/g)) {
    const text = (match[1] ?? "").trim();
    if (structural.has(text) && usable(text)) return text;
  }

  const lower = description.toLowerCase();
  const mentioned = [...structural]
    .filter((text) => text.length >= 4 && usable(text) && lower.includes(text.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  return mentioned[0] ?? null;
}
