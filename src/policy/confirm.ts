/**
 * What happens when policy returns `confirm`.
 *
 * This is the seam human-in-the-loop escalation plugs into. It lives with the
 * policy engine rather than with the discovery agent because replay needs it
 * too, and the production execution path must not depend on the component that
 * talks to a model.
 *
 * The default refuses. For an unattended run that is the only safe answer: an
 * irreversible step with nobody to approve it should not happen.
 */

import type { Action, ObservedElement } from "../perception/types.js";
import type { PolicyDecision } from "./types.js";

export type ConfirmHandler = (
  decision: PolicyDecision,
  action: Action,
  target: ObservedElement | undefined,
) => Promise<boolean>;

export const denyByDefault: ConfirmHandler = async () => false;

/** For a supervised recording session only, where a person is watching the run. */
export const autoApprove: ConfirmHandler = async () => true;
