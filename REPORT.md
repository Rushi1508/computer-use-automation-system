*Assignment A: computer-use automation for legacy back-office applications. How to run it, and where the evidence is: [README.md](README.md).*

# Architecture

One TypeScript process, built from components with narrow contracts:

| Component | Contract |
|---|---|
| **Surface** (`src/perception`) | `observe()`, `act(action)`, `screenshot()`. The only code that knows it is driving a browser. |
| **Policy engine** (`src/policy`) | `check(action) → allow · confirm · deny`, run before every action from the agent, from replay or from an operator. The URL an action lands on is re-checked afterwards. |
| **Discovery loop** (`src/agent`) | goal + entrypoint → trace. The only component that calls a model. |
| **Compiler → replay** (`src/compiler`, `src/replay`) | trace → capability → result. Replay's module graph contains no model SDK. |
| **Handoff desk + session lease** (`src/escalation`, `src/session`) | Intervention requests, and enforced state for who controls the session. |

An evidence bus sits under all of them and redacts at the write boundary.

**Why the accessibility tree.** An observation is the page's accessibility snapshot across frames, flattened into numbered elements: role, name, value, the label cell of an unnamed control, and grid column and row. The model acts by node id and never writes a selector; the compiler derives locators from the element it chose. The target is hostile on purpose, with framesets, table layout, no test ids, and generated ids like `ctl00_MainContent_txtMemberId`. Role, name and label survive what breaks selectors, and they are also what UI Automation and AX expose on the desktop. Screenshot coordinates were rejected because they do not replay across resolutions and cost vision tokens at every step. The price of this choice is custom-drawn controls that have no accessibility node.

**Discovery and replay share only the artifact.** The loop is hand-written because its trace feeds the compiler, and a policy refusal has to reach the model as a tool result, not an exception. Each run is bounded by a step count, a time limit, a dollar ceiling and stuck detection. With prompt caching, the recorded run took 7 turns and about $0.09. Compilation is a deterministic function of the trace. A single process and a local demo app keep the system simple, and every future service boundary is already an interface.

# Artifact schema

A capability (`src/schema/capability.ts`; for example `capabilities/lookup_member_savings_balance.v2.json`) is a contract first:

```
id, version, name, description, approvalState
surface      { kind: web | legacy_web | desktop, entrypoint, appProfileId }
lineage      { baseCapabilityId?, tenantId?, overrides[{ stepIndex, target }] }
inputs[]     { name, type, required, description, sensitivity: none | pii | secret }
outputs[]    { name, type, description, sensitivity, fromStep }
steps[]      { index, intent, action, target?, value: {param}|{literal}, outputName?, url?,
               risk: safe_reversible | risky_irreversible, waitMs, checkpoint? }
authentication { throughStep }        successCheckpoint { description, detector }
knownOutcomes[]                        provenance { discoveryRunId, goal, model, recordedAt, revisions[] }
```

- **Values are parameters, never literals.** Values the run typed become typed inputs, and free text is templated ("Search for member {memberId}"), so recorded IDs and passwords never enter the file. Tests assert this.
- **A target is a ranked set of strategies, each with a confidence and a written rationale.** The strategies are `role_name`; `anchored_row` (the label cell beside an unnamed control); `grid_cell` (a column header plus a cell in the same row); `field_name`; and `dom_id`. Confidence comes from how many elements each strategy matched on the recorded screen, so ambiguity is measured rather than assumed away. Generated ids rank last because vendor upgrades break them first.
- **Detectors describe what a person sees**: `text_present`, `text_matches`, `grid_column`, `title_equals` and `url_contains`, never DOM internals.
- **Business outcomes belong to the application.** A happy-path recording cannot learn "no such member", so that vocabulary lives in an app profile and is merged in at compile time. Outcomes specific to one step are added in review.
- **Versioned and reviewable.** Versions are immutable: `discover` refuses to overwrite one, and `cua revise` turns a reviewed revision document into the next version as a draft, recorded in `provenance`. Tests regenerate every committed revision from its base. The lookup's v1 was recorded; v2 added two outcomes after replay review.
- **Agent-invocable, and free of the transcript.** The JSON Schema an agent receives is generated from the same typed inputs replay validates an invocation against. The artifact holds intents and derived locators, never messages.

# Determinism & error handling

Replay runs the recorded steps in order, with no model. It tries each target's strategies in rank order, polling for up to 10 s per step, and a strategy that matches several elements counts as ambiguous and is never guessed. Checkpoints are asserted where they were recorded, the success checkpoint at the end, and declared outputs must be non-empty. Three invocations with the same inputs produced identical results once timestamps were removed.

The result contract separates three cases, with distinct exit codes:

| Result | Meaning | Examples (`evidence/replay/`) |
|---|---|---|
| **`business_outcome`** (exit 2) | A legitimate answer, with the basis for it | `MEMBER_NOT_FOUND`, `PERMISSION_DENIED`, `MEMBER_ID_INVALID`, `SIGN_ON_FAILED`, `NO_OPEN_ACCOUNTS`, `NO_SAVINGS_ACCOUNT` |
| **recovered** (the run continues; listed in `recoveries`) | A known transient condition with a bounded remedy | a maintenance interstitial dismissed (up to 2 attempts); session expiry, where only the authentication steps are re-run (1 attempt); a slow render absorbed by the bounded wait |
| **`failed`** (exit 1) | Stop, reporting the step, its intent, what was expected, what was observed, a screenshot and a tree snapshot | `application_error` (stops at once), `target_not_found`, `target_ambiguous`, `checkpoint_failed`, `policy_denied`, `confirmation_refused`, `invalid_input` (before the browser starts) |

- **Detectors are pinned in both directions.** Outcomes are checked before recoverables, and a contract test requires each profile detector to match exactly its own screens, and every screen carrying an application message to be claimed by some detector. The second rule came after a failed sign-on turned out to be unclaimed and was being reported as an escalatable `target_not_found`.
- **Absence is never assumed.** Concluding "no savings account" requires positive proof that the grid rendered, and the same absence seen on two consecutive observations.
- **Recovery never repeats an irreversible action.** A reversible action is re-located and retried once, an irreversible one never is, and re-authentication is refused once an irreversible step has run.
- **Drift is secondary.** A step carried by a lower-ranked strategy produces a `DriftRecord`.
- **Discovery verifies success too.** The model's `done` is accepted only if the success condition the artifact will carry holds on screen at that moment. Otherwise it is sent back, and repeated rejection ends the run as stuck.

# Heterogeneity & multi-tenant

**The seam is the `Surface` interface.** Observations and actions are expressed in role, name, value, anchor, grid position and `framePath`, and stored strategies use the same vocabulary. Nothing above the Surface knows which implementation produced an observation.

- **Legacy web** is what this repository implements.
- **Desktop** is a typed stub (`src/perception/desktop.ts`) that records the mapping. UI Automation's control type, name and Value pattern, or AX's role, title and value, fill the same fields. `framePath` becomes a window-and-pane path. `navigate` becomes focusing a window or following a menu path, which is why the entrypoint is a string interpreted per `surface.kind`. `anchored_row` becomes the primary strategy. Custom-drawn controls would need a Surface built on an image anchor plus coordinates, with lower strategy confidence, which the schema can already express.

**Reuse is layered, most shared first:**

1. **An app profile per vendor product and version** (`AppProfile`: vendor, `productVersion`, outcomes, recoverables, fatal conditions), written once and shared by every tenant on that product.
2. **A base capability per product flow**, recorded once. Its entrypoint is bound per invocation (`--entrypoint`), so it runs unchanged against another tenant's instance.
3. **Tenant specialisation by override.** `lineage { baseCapabilityId, tenantId, overrides[{ stepIndex, target }] }` replaces only the targets that differ. Semantic strategies rank first because branding and configuration change styling and ids far more often than accessible names.

**Drift is visible per run and per version.** Each run records which strategy resolved each step, and a `DriftRecord` whenever a fallback was needed. Aggregated per tenant and `productVersion`, a rising fallback rate is the signal to re-record or add an override before primary strategies fail. Across versions, the catalog flags a new version that would break existing callers.

**Status:** profiles, entrypoint binding, drift records and contract-change detection are implemented. `lineage.overrides` is in the schema but is not yet applied at load time, and no second tenant variant is demonstrated.

# Escalation & handoff

**Detecting "stuck".** Discovery hands off when the model calls `escalate`, after three consecutive failed or refused actions, or at an irreversible action. Replay hands off at irreversible steps and on failures a person could fix: a missing or ambiguous target, a failed checkpoint, the application's error page. It does not hand off after a policy denial, a malformed invocation, or a decision a person already made, and it hands off at most three times per run.

**The intervention request** carries the run, the capability or goal, the step and its intent, the reason, what was expected, the redacted screen, and the resolutions that fit: `approve`, `reject` or `abort` for an irreversible step; `resume`, `completed_manually` or `abort` otherwise. A live screenshot is available on request.

**Same live session, under a lease.** The console acts on the same Surface instance, and so the same browser page, that automation drives; automation holds only a lease-checked view. The lease runs `automation → pending_human → human → resuming → automation`, with a generation counter:

- nobody holds the session while it is pending or resuming;
- every observe and act is checked against the holder;
- another operator is refused (HTTP 403);
- automation acting while a person holds control raises `LeaseViolation`.

**Handback is recorded and verified.** Operator actions pass the same policy engine and are recorded with their targets. A step finished by hand is marked `completedBy: operator`, and in discovery those actions join the trace. On handback, replay re-locates its target, and `completed_manually` still has to pass the success checkpoint. Interventions persist with their lease transitions and handed-over and handed-back screenshots; `evidence/handoff/` shows a repair followed by resume, an approval, and a rejection.

**Scope.** The console page is deliberately plain, and the operator in the evidence is scripted. That scripted operator drives the same HTTP API the page uses, and a test drives the page itself. There is **no operator authentication**: the console binds to 127.0.0.1 and the operator id is a request field. Production would take operator identity from SSO and add a live view.

# Safety

**Allowlist.** `PolicyConfig` sets the permitted origins (deny by default), path prefixes, denied paths and action verbs. It is checked before every action, and again on each URL an action lands on. The demo policy permits one origin and six verbs, and denies the fault-injection plane (`/_control`). Crafted artifacts that navigate to another origin or to `/_control` fail with `policy_denied` before the browser moves. *Limit:* the defaults live in code, with the origin taken from the entrypoint.

**Irreversible actions need a decision.** Blocking them would forbid exactly what banks want automated, and merely flagging them lets them happen anyway. So actions in the confirm class, identified by their labels against a configurable vocabulary, wait for a person at the desk or an explicit supervised approval (`--approve-risky`). Otherwise they are refused.

**An artifact can add caution, never remove it.** On replay, a step's effective risk is the more cautious of the artifact's declaration and the policy's reading of the live control. An edit marking "Open Account" reversible still stops, and the failure says the artifact and the screen disagree.

Approval, which lets irreversible steps run unattended, is **not read from the artifact** either. It is a detached record in `capabilities/approvals/`, written by `capabilities approve`, that holds the artifact's SHA-256 digest and is honoured only while the digest matches. An artifact therefore cannot approve itself, and any edit voids its approval. Tests exercise both cases against the live app and check that no account was opened.

**Secrets.**
- Declared credentials (`--secret-env`, secret inputs) are registered with the redactor before the first event is written.
- A password typed into a password field is registered at the policy check.
- Keys, bearer tokens, SSNs and Luhn-valid card numbers are redacted by pattern, and values under credential-shaped keys are masked.
- The evidence bus and operator API redact everything they write, and discovery re-redacts its event log once every secret is known.
- Error messages expose no stack traces or file paths, and artifacts hold no values at all.

**Limits.**
- Synthetic member names, account numbers and balances remain readable in evidence and screenshots; per-field redaction by output `sensitivity` is not built.
- The model sees the credential during discovery, because it types it; a placeholder the Surface substitutes is not built.
- A committing control with no recognised verb is treated as reversible during discovery.
- Approval provides integrity, not authentication: whoever can write to `capabilities/approvals/` can approve.
- An undeclared credential in a goal stays on disk until the run ends; the CLI warns when this happens.

# Cuts

| Left out | Why | Next |
|---|---|---|
| Desktop surface (a typed stub) | Time went to the schema, replay and handoff | Implement `Surface` over UI Automation; nothing above it changes |
| Applying tenant overrides, and a second tenant variant | The schema shape was the decision to make early; applying overrides is mechanical | Apply `lineage.overrides` in the loader; demonstrate it on a relabelled copy of the app |
| Operator authentication and a live co-browsing view | Scoped out by the brief; the lease and API are the mechanism | SSO identity, a screencast view, an intervention queue across runs |
| Per-field evidence redaction, and credential placeholders | Synthetic data; `sensitivity` already classifies outputs | Redact evidence by classification; substitute credentials inside the Surface |
| External policy files | One demo app, with explicit and tested defaults | Per-app and per-tenant policy |
| Learning from handoffs | Designed, not built | Draft a `cua revise` document from an operator's resolution |
| Scaling infrastructure | The brief prefers abstractions to infrastructure | A registry keyed by product and version; workers that hold sessions |
| Other stretch goals (code generation, LLM fallback, stability scores) | Depth over breadth; the catalog and approval gating were taken instead | A bounded, policy-checked, single-step LLM fallback |
