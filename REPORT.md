*Assignment A: computer-use automation for legacy back-office applications. Setup, commands and evidence are in [README.md](README.md).*

# Architecture

One TypeScript process in which every component has a narrow contract:

| Component | Contract |
|---|---|
| **Surface** (`src/perception`) | `observe`, `act`, `screenshot`; the only browser-aware code |
| **Policy engine** (`src/policy`) | `allow · confirm · deny` before every action (agent, replay or operator) and on each landing URL |
| **Discovery loop** (`src/agent`) | goal → trace; the only component that calls a model |
| **Compiler → replay** (`src/compiler`, `src/replay`) | trace → capability → result; replay imports no model SDK |
| **Handoff desk + lease** (`src/escalation`, `src/session`) | intervention requests; enforced control of the session |

An evidence bus sits beneath all of them and redacts everything it writes.

**Perception is the accessibility tree.** The tree is flattened across frames into numbered elements, each with a role, name, value, label cell and grid position. The model acts by node id; the compiler derives locators afterwards, so the model never writes a selector. The target is hostile on purpose: framesets, table layout, no test ids, and generated ids. Role, name and label survive all of that, and UI Automation and AX expose the same concepts on desktop. Screenshot coordinates were rejected because they do not replay across resolutions and cost vision tokens every step. The price is custom-drawn controls, which have no accessibility node.

**Discovery and replay share only the artifact.** The loop is hand-written so that its trace can feed the compiler and policy refusals reach the model as tool results. It is bounded by steps, time, spend and stuck detection; the recorded run took 7 turns and ~$0.09. One process and a local demo app keep things simple, and each future service boundary is already an interface.

# Artifact schema

A capability (`src/schema/capability.ts`) is a contract first:

```
id, version, name, description, approvalState
surface    { kind: web | legacy_web | desktop, entrypoint, appProfileId }
lineage    { baseCapabilityId?, tenantId?, overrides[{ stepIndex, target }] }
inputs[]   { name, type, required, sensitivity: none | pii | secret }
outputs[]  { name, type, sensitivity, fromStep }
steps[]    { index, intent, action, target?, value: {param}|{literal}, risk, checkpoint? }
successCheckpoint, knownOutcomes[], authentication, provenance { discoveryRunId, revisions[] }
```

- **Parameters, never literals.** Typed values become typed inputs and free text is templated, so recorded IDs and passwords never enter the file. Tests assert this.
- **Targets are ranked strategies, each with a confidence and a rationale:** `role_name`, `anchored_row` (the label cell beside an unnamed control), `grid_cell`, `field_name` and `dom_id`. Confidence comes from how many elements each strategy matched on the recorded screen. Generated ids rank last.
- **Detectors describe what a person sees** (`text_present`, `grid_column`, …), not DOM internals.
- **Outcomes belong to the application.** A happy-path run cannot learn "no such member", so that vocabulary comes from an app profile. Outcomes specific to one step are added in review.
- **Versioned and reviewable.** Versions are immutable. `cua revise` applies a review document to produce a new draft version, and the tests regenerate every committed revision.
- **Agent-invocable and transcript-free.** The JSON Schema an agent receives is generated from the same typed inputs replay validates against. The artifact holds intents and locators, never model messages.

# Determinism & error handling

Replay runs the recorded steps in order with no model. It tries each target's strategies in rank order for up to 10 s per step, and never guesses between several elements that match the same strategy. It asserts checkpoints, the success checkpoint, and non-empty outputs. Three identical invocations produced identical results, apart from timestamps.

| Result | Meaning | Examples (`evidence/replay/`) |
|---|---|---|
| **`business_outcome`** (exit 2) | A legitimate answer, with its basis | `MEMBER_NOT_FOUND`, `PERMISSION_DENIED`, `SIGN_ON_FAILED`, `NO_SAVINGS_ACCOUNT` |
| **recovered** (the run continues) | A known transient condition with a bounded remedy | interstitial dismissed; session expiry handled by re-running only authentication; slow render absorbed by the bounded wait |
| **`failed`** (exit 1) | Stop, reporting step, intent, expected, observed, screenshot and tree snapshot | `application_error`, `target_not_found`, `target_ambiguous`, `checkpoint_failed`, `policy_denied`, `confirmation_refused` |

- **Detectors are pinned both ways.** Outcomes are checked before recoverables. A contract test requires each detector to match only its own screens, and every application-message screen to be claimed by some detector. The second rule was added after a failed sign-on surfaced as `target_not_found`.
- **Absence needs proof.** "No savings account" requires evidence that the grid rendered, and the same absence across two observations.
- **Irreversible actions are never repeated**, by retry or by re-authentication.
- **Drift is recorded.** A step carried by a fallback strategy produces a `DriftRecord`.
- **Discovery verifies success too.** The model's `done` is accepted only if the artifact's success condition holds on screen.

# Heterogeneity & multi-tenant

**The seam is the `Surface` interface.** Observations, actions and stored strategies all speak in role, name, value, anchor, grid position and `framePath`, so nothing above the Surface knows how it is implemented.

- **Legacy web** is implemented.
- **Desktop** is a typed stub (`src/perception/desktop.ts`) that records the mapping. UI Automation or AX supplies the same fields, `framePath` becomes a window and pane path, `navigate` becomes focusing a window or following a menu path, and `anchored_row` becomes the primary strategy.
- **Custom-drawn controls** would need a Surface built on image anchors, with lower strategy confidence.

**Reuse is layered, most shared first:**

1. **An app profile per vendor product and version**, holding outcomes, recoverables and fatal conditions, shared by every tenant on that product.
2. **A base capability per flow**, recorded once; `--entrypoint` binds it to any tenant's instance.
3. **Tenant overrides.** `lineage` names the base and replaces only the step targets that differ. Semantic strategies rank first because branding changes styling and ids far more often than accessible names.

**Drift.** Every replay records which strategy resolved each step. Aggregated per tenant and `productVersion`, a rising count of `DriftRecord`s signals that an override or a re-recording is due before primary strategies fail. The catalog also flags versions that would break existing callers.

**Status:** profiles, entrypoint binding, drift records and contract-change detection are built. Overrides are in the schema but not yet applied at load time.

# Escalation & handoff

**Detecting "stuck".**
- *Discovery* hands off when the model escalates, after three consecutive failed or refused actions, or at an irreversible action.
- *Replay* hands off at irreversible steps, and on failures a person could fix: a missing or ambiguous target, a failed checkpoint, the app's error page.
- *Replay does not hand off* after a policy denial or a person's own decision, and hands off at most three times per run.

**The intervention request** carries:
- the run, and the capability or goal;
- the step and its intent;
- the reason and the expected state;
- the redacted screen, plus a live screenshot;
- the resolutions that fit: `approve` or `reject` at an irreversible step, `resume` or `completed_manually` otherwise, and `abort` always.

**The same live session, under a lease.** The console acts on the same Surface instance, and so the same browser page, that automation drives, while automation holds a lease-checked view of it. The lease cycles through `automation → pending_human → human → resuming → automation`:
- nobody holds a paused session;
- every observe and act is checked;
- other operators are refused;
- automation acting out of turn raises `LeaseViolation`.

**Handback is recorded and verified.** Operator actions pass through the same policy engine and are recorded, and steps finished by hand are marked `completedBy: operator`. Replay re-locates its target on resume, and `completed_manually` must still pass the success checkpoint. `evidence/handoff/` shows repair-and-resume, approve and reject, with lease transitions and screenshots.

**Scope.** The console page is plain and the operator in the evidence is scripted, but both drive the same HTTP API. There is **no operator authentication**: the console is localhost-only and the operator's identity is a request field. Production would use SSO.

# Safety

**Allowlist.** `PolicyConfig` sets origins (deny by default), path prefixes, denied paths and action verbs. It is checked before each action and on each landing URL. Crafted artifacts that navigate off-origin, or to the demo's `/_control` plane, fail with `policy_denied` before the browser moves. The defaults live in code.

**Irreversible actions need a decision.** Blocking would forbid what banks want automated, and flagging would let the action happen anyway. So an action matching the configurable irreversible vocabulary waits for a person or an explicit supervised approval (`--approve-risky`), and is refused otherwise.

**An artifact can add caution, never remove it.** On replay, a step's effective risk is the more cautious of the artifact's declaration and the policy's reading of the live control. An edit marking "Open Account" reversible therefore still stops for a person. Approval, which lets irreversible steps run unattended, is a detached record (`capabilities approve` writes it to `capabilities/approvals/`). It holds the artifact's SHA-256 digest and is honoured only while that still matches. An artifact cannot approve itself, and any edit voids its approval. Tests against the live app confirm no account is opened in either case.

**Secrets.**
- Declared credentials (`--secret-env`, secret inputs) are registered before the first event is written.
- Passwords typed into password fields are registered at the policy check.
- Keys, tokens, SSNs and card numbers are redacted by pattern.
- Evidence and operator API responses are redacted, and discovery re-redacts its log at the end of the run.
- Errors expose no stack traces or paths, and artifacts hold no values.

**Limits.**
- The runtime does not redact on-screen customer data. Committed evidence has names, branches and account numbers removed by a publication step over the synthetic dataset, but raw `.runs/` output keeps them.
- The model sees the credential it types during discovery.
- An undeclared credential in a goal is on disk until the run ends (the CLI warns).
- A committing control with no recognised verb is inferred reversible during discovery.
- Approval is integrity, not authentication: anyone who can write `capabilities/approvals/` can approve.

# Cuts

| Left out | Why | Next |
|---|---|---|
| Desktop surface (stub) | Time went to the schema, replay and handoff | `Surface` over UI Automation |
| Applying tenant overrides | The schema's shape mattered first | Apply `lineage.overrides` in the loader; demonstrate a relabelled variant |
| Operator authentication; co-browsing | Out of scope; the lease is the mechanism | SSO identity, a live view, an intervention queue |
| Per-field evidence redaction; credential placeholders | The data is synthetic | Redact by `sensitivity`; substitute credentials inside the Surface |
| Policy files; learning from handoffs | One demo app; the learning loop is only designed | Per-tenant policy; draft `cua revise` documents from resolutions |
| Scaling infrastructure; other stretch goals | Abstractions before infrastructure; depth before breadth | A registry keyed by product and version; a bounded single-step LLM fallback |
