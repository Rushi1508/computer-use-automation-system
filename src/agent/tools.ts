/**
 * The agent's action vocabulary, and how a surface is described to it.
 *
 * Two things here are load-bearing for the artifact, not just the loop:
 *
 * - Every acting tool requires a `why`. That string becomes the recorded step's
 *   intent, which is what makes a capability reviewable by a human later. A
 *   step list without intent is a macro; a step list with intent is something a
 *   reviewer can audit and a maintainer can repair.
 *
 * - `read` requires an `outputName`. Extraction is not a side effect of
 *   browsing — it is the model declaring "this value is part of what the
 *   capability returns", which is what lets the compiler emit a typed output
 *   contract instead of guessing from the transcript.
 *
 * Tool input schemas are generated from Zod, the same definitions that validate
 * artifacts. One source of truth for a shape that both a model and a runtime
 * validator have to agree on.
 */

import { z } from "zod";

import type { Observation, ObservedElement } from "../perception/types.js";

const NodeId = z.number().int().nonnegative().describe("The [n] id of a control from CONTROLS");
const Why = z.string().min(1).describe("Why this action advances the goal. Recorded as the step's intent.");

export const TOOL_SCHEMAS = {
  click: z.object({ nodeId: NodeId, why: Why }),
  fill: z.object({
    nodeId: NodeId,
    value: z.string().describe("Text to type. Use the literal value; parameterisation happens later."),
    why: Why,
  }),
  select: z.object({
    nodeId: NodeId,
    value: z.string().describe("The option value or visible label to choose"),
    why: Why,
  }),
  navigate: z.object({ url: z.string().describe("Absolute URL"), why: Why }),
  read: z.object({
    nodeId: NodeId,
    outputName: z
      .string()
      .min(1)
      .describe("camelCase name for this value in the capability's output contract, e.g. savingsBalance"),
    why: Why,
  }),
  checkpoint: z.object({
    description: z
      .string()
      .min(1)
      .describe("An observable condition proving the expected state was reached"),
  }),
  done: z.object({
    summary: z.string().min(1).describe("What was accomplished"),
  }),
  escalate: z.object({
    reason: z.string().min(1).describe("Why you cannot safely proceed"),
  }),
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

const DESCRIPTIONS: Record<ToolName, string> = {
  click:
    "Click a control. Use for buttons and links. The result is a fresh observation of the surface after the click.",
  fill: "Type text into a textbox, replacing whatever is there.",
  select: "Choose an option in a dropdown (combobox).",
  navigate: "Go to an absolute URL. Prefer clicking the UI over guessing URLs.",
  read:
    "Read a control's text or value AND declare it as a named output of this capability. " +
    "Call this for every value the goal asks you to retrieve.",
  checkpoint:
    "Record that an expected state was reached, described by something observable on screen. " +
    "Call this after a step whose success is not obvious from the next action.",
  done: "The goal is achieved. Call this last.",
  escalate:
    "You cannot safely proceed — blocked, ambiguous, or the surface is not what you expected. " +
    "A human operator will be asked to take over. Prefer this over guessing.",
};

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** Shaped to the Messages API's tool contract; `type` is always "object". */
  readonly input_schema: {
    readonly type: "object";
    readonly properties?: Record<string, unknown>;
    readonly required?: string[];
    readonly [key: string]: unknown;
  };
}

export function toolDefinitions(): ToolDefinition[] {
  return (Object.keys(TOOL_SCHEMAS) as ToolName[]).map((name) => {
    const schema = z.toJSONSchema(TOOL_SCHEMAS[name]) as Record<string, unknown>;
    return {
      name,
      description: DESCRIPTIONS[name],
      input_schema: { ...schema, type: "object" as const },
    };
  });
}

const MAX_TREE_CHARS = 3500;

/**
 * Renders an Observation for the model.
 *
 * Controls are listed with their node id, role and accessible name. A control
 * with no accessible name is shown as `(unnamed)` together with its anchor
 * text, because the model still has to be able to point at it — that is the
 * whole reason anchors are captured at observation time.
 */
export function renderObservation(obs: Observation): string {
  const lines: string[] = [`URL: ${obs.url}`, `TITLE: ${obs.title}`, "", "CONTROLS (act by node id):"];

  if (obs.elements.length === 0) {
    lines.push("  (no interactive controls found)");
  }

  for (const el of obs.elements) {
    lines.push(`  ${describeElement(el)}`);
  }

  const tree =
    obs.tree.length > MAX_TREE_CHARS
      ? `${obs.tree.slice(0, MAX_TREE_CHARS)}\n... (truncated)`
      : obs.tree;

  lines.push("", "SCREEN (accessibility tree):", tree);
  return lines.join("\n");
}

export function describeElement(el: ObservedElement): string {
  const frame = el.framePath.length === 0 ? "top" : el.framePath.join("/");
  const name = el.name !== "" ? `"${el.name}"` : "(unnamed)";
  const anchor = el.name === "" && el.anchorText !== null ? ` anchor="${el.anchorText}"` : "";
  const value = el.value !== null && el.value !== "" ? ` value="${el.value}"` : "";
  const disabled = el.enabled ? "" : " [disabled]";
  return `[${el.nodeId}] ${el.role} ${name}${anchor}${value}${disabled} (frame: ${frame})`;
}

export const SYSTEM_PROMPT = `You are operating a legacy back-office banking application on behalf of a human operator, through an accessibility-tree interface.

You will be shown the current screen as a list of CONTROLS plus an accessibility tree. Act by referring to a control's node id. Node ids are reassigned after every action, so always use ids from the most recent observation.

Some controls have no accessible name. They are shown as (unnamed) with an anchor, which is the text of the neighbouring cell that identifies them to a human. Point at them by node id like any other control.

Working rules:
- State why each action advances the goal. That reasoning is recorded as the step's intent and reviewed by a human later.
- Call read for every value the goal asks you to retrieve, and give it a clear output name.
- Call checkpoint after a step whose success would not otherwise be obvious.
- Some actions are irreversible and will be held for human confirmation. That is expected — do not try to work around a held or denied action, and never look for an alternative route to an action the policy refused.
- If you are blocked, or the screen is not what you expected, call escalate rather than guessing.
- Call done once the goal is achieved.`;
