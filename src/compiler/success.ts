/**
 * The condition that proves a recorded flow reached its goal.
 *
 * Shared by the two places that must agree on it. The compiler writes it into
 * the artifact as the success checkpoint that replay asserts. The discovery loop
 * asserts it on the live screen before accepting the model's claim that it is
 * done — so a run is only recorded as succeeded if the evidence replay will
 * later look for was actually showing when the model said so.
 */

import type { DiscoveryResult } from "../agent/loop.js";
import type { Detector } from "../schema/capability.js";

export interface DerivedCheckpoint {
  readonly description: string;
  readonly detector: Detector;
  /** True when the detector is a guess a reviewer should tighten before approving. */
  readonly weak: boolean;
}

/**
 * Derives the condition that proves the goal was reached.
 *
 * Prefers structural text that is the same for every invocation: the column
 * header of the grid a value was read from, then a label verified on screen at
 * record time. A title or anchor is a last resort and flagged as weak — a
 * detector on "Member 12345" would pass for one input and fail for all others.
 */
export function deriveSuccessCheckpoint(run: Pick<DiscoveryResult, "trace" | "checkpoints">): DerivedCheckpoint {
  for (let i = run.trace.length - 1; i >= 0; i--) {
    const step = run.trace[i];
    const grid = step?.target?.grid;
    if (step?.action.kind === "read" && grid !== undefined) {
      return {
        description: `The screen shows a grid with a "${grid.columnHeader}" column, where the returned value is read from.`,
        detector: { kind: "text_present", text: grid.columnHeader },
        weak: false,
      };
    }
  }

  for (let i = run.checkpoints.length - 1; i >= 0; i--) {
    const text = run.checkpoints[i]?.verifiedText ?? null;
    if (text !== null) {
      return {
        description: `The screen shows "${text}", as verified when the flow was recorded.`,
        detector: { kind: "text_present", text },
        weak: false,
      };
    }
  }

  const title = run.trace.at(-1)?.titleBefore ?? "";
  if (title !== "" && !/\d{3,}/.test(title)) {
    return {
      description: `The final screen is titled "${title}".`,
      detector: { kind: "title_equals", value: title },
      weak: true,
    };
  }

  for (let i = run.trace.length - 1; i >= 0; i--) {
    const anchor = run.trace[i]?.target?.anchorText ?? null;
    if (anchor !== null && anchor !== "" && !/\d{3,}/.test(anchor)) {
      return {
        description: `The screen showing "${anchor}" was reached.`,
        detector: { kind: "text_present", text: anchor },
        weak: true,
      };
    }
  }

  return {
    description: "The flow completed without the application's error page.",
    detector: { kind: "text_absent", text: "Unexpected error" },
    weak: true,
  };
}
