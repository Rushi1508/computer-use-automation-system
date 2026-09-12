/**
 * The perception/action vocabulary, and the seam the whole design rests on.
 *
 * Everything above this layer — the agent loop, the compiler, the replay
 * engine — speaks only in these types. Nothing above it knows what Playwright
 * is, what a CSS selector looks like, or that frames exist. That is what makes
 * "extend to a legacy web app or a desktop app" a matter of writing another
 * Surface rather than reworking the system.
 *
 * The load-bearing decision here is that the model never authors a locator.
 * It sees an Observation containing elements addressed by an opaque, per
 * observation `nodeId`, and it acts by saying `click(node 7)`. Selectors are
 * derived afterwards, by the compiler, from properties the Surface observed
 * about that element. A model that invents `div.panel > input:nth-child(3)`
 * produces a capability that breaks the first time anything shifts; a model
 * that points at a node lets us record *why* that node was identifiable, and
 * record several independent ways to find it again.
 */

/** Where an element lives in the frame hierarchy. Empty means the top document. */
export type FramePath = readonly string[];

/**
 * A control the operator could interact with, as observed at one instant.
 *
 * `nodeId` is stable only within a single Observation. It is a handle for the
 * model to point at, never something to persist into an artifact.
 */
export interface ObservedElement {
  readonly nodeId: number;
  /**
   * Whether this node can be operated, or only read.
   *
   * Legacy screens present most of their information as static table text, so
   * an observation limited to actionable controls cannot address the very
   * values a capability exists to return. Readable nodes close that gap: they
   * are valid targets for `read` and nothing else.
   */
  readonly actionable: boolean;
  readonly role: string;
  /**
   * The accessible name, as a screen reader would announce it. Empty string is
   * a real and common answer on legacy surfaces — an input whose only identity
   * is the text in the neighbouring table cell has no accessible name at all.
   * Callers must treat "" as "this control cannot be found by name".
   */
  readonly name: string;
  readonly value: string | null;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly framePath: FramePath;
  /**
   * Text of the nearest enclosing row or labelling cell. This is what makes an
   * unnamed control addressable at all, so it is captured at observation time
   * rather than reconstructed later from a screenshot or a DOM dump.
   */
  readonly anchorText: string | null;
  /**
   * Last-resort identification hints, recorded but deliberately ranked below
   * everything semantic. Generated control IDs churn between releases of the
   * vendor product, so these exist to break ties and to debug, not to drive.
   */
  readonly hints: {
    readonly tag: string;
    readonly inputType: string | null;
    readonly domId: string | null;
    readonly fieldName: string | null;
  };
}

/** A complete perception of the surface at one instant. */
export interface Observation {
  readonly url: string;
  readonly title: string;
  readonly framePaths: readonly FramePath[];
  readonly elements: readonly ObservedElement[];
  /**
   * The accessibility tree rendered for a reader, one entry per frame. This is
   * what the model actually reads; `elements` is what it points at.
   */
  readonly tree: string;
  readonly capturedAt: string;
  /**
   * Frames that could not be read, and why.
   *
   * An observation that silently drops a frame is indistinguishable from a
   * blank screen, which leads an agent to conclude the application is broken
   * and escalate — or worse, to act on a partial view believing it is complete.
   * Failures are surfaced rather than swallowed.
   */
  readonly warnings: readonly string[];
}

/** Action verbs. Shared with the artifact schema so recorded steps use one vocabulary. */
export const ACTION_KINDS = ["click", "fill", "select", "navigate", "wait", "read"] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * An action expressed against a live Observation.
 *
 * Distinct from a recorded artifact step, which targets a durable descriptor
 * instead of a nodeId. Keeping them separate is what stops a per-observation
 * handle from leaking into a persisted capability.
 */
export type Action =
  | { readonly kind: "click"; readonly nodeId: number }
  | { readonly kind: "fill"; readonly nodeId: number; readonly value: string }
  | { readonly kind: "select"; readonly nodeId: number; readonly value: string }
  | { readonly kind: "navigate"; readonly url: string }
  | { readonly kind: "wait"; readonly ms: number }
  | { readonly kind: "read"; readonly nodeId: number };

export interface ActResult {
  readonly ok: boolean;
  /** Populated by `read`; the visible text of the targeted element. */
  readonly text?: string;
  readonly error?: string;
}

/**
 * The only contract the rest of the system depends on.
 *
 * A legacy web app is the same implementation with a different target. A
 * desktop app is a different implementation — UI Automation on Windows, AX on
 * macOS — exposing the same roles, names, and anchors, because those concepts
 * are native to both platforms' accessibility layers. That is the reason the
 * accessibility tree was chosen as the perception channel over the DOM: the
 * DOM has no desktop equivalent, and a screenshot has no stable identity.
 */
export interface Surface {
  /** Perceive current state. Must not mutate the surface. */
  observe(): Promise<Observation>;
  /** Perform one action against the most recent Observation. */
  act(action: Action): Promise<ActResult>;
  /** PNG bytes, for evidence on failure. */
  screenshot(): Promise<Buffer>;
  /** Release underlying resources. */
  close(): Promise<void>;
}

export class SurfaceError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "SurfaceError";
  }
}
