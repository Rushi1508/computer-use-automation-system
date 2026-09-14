# Computer-Use Automation System

A record-once, replay-many integration layer for legacy back-office applications that have no API.

An LLM works out how to accomplish a goal on a live UI **once**. That run is compiled into a typed, versioned **capability**. Production invokes the capability through **deterministic replay** with no model in the loop. When a run cannot safely continue, a person takes over **the same live browser session** and hands it back.

Design write-up: [`REPORT.md`](REPORT.md).

- **Discovery**: an observe → decide → act loop (Claude, tool calling) over the page's accessibility tree. The model points at controls by node id and never writes selectors; every action passes a policy engine first.
- **Capability artifact**: typed inputs and outputs, ordered steps, ranked locator strategies with written rationale, checkpoints, a business-outcome vocabulary, provenance and version. No transcript, and no literal values.
- **Deterministic replay**: the production path. It imports no model code, and returns `succeeded` with outputs, a `business_outcome` (a legitimate answer such as `MEMBER_NOT_FOUND`), or `failed` with what step failed, what was expected, what was observed, and a screenshot.
- **Human handoff**: a session lease decides who controls the live session. An operator console (HTTP API plus a minimal page) lets a person claim it, act on it, and hand it back.
- **Safety**: an origin, route and action allowlist; irreversible actions held for a decision; redaction at every write boundary.
- **Evidence**: event logs, results, screenshots and accessibility-tree snapshots from real runs, in [`evidence/`](evidence/).

The target is a deliberately hostile local stand-in for a core-banking servicing screen (`apps/legacy-demo`, "MERIDIAN CORE"). It has framesets, table layouts, ASP.NET-style generated ids and no test ids.

## Architecture

```
goal + URL ─► Discovery loop ─► Policy ─► Surface ─► live app          (Claude chooses each action)
                   │ trace
                   ▼
               Compiler ─► capabilities/<id>.vN.json                    (typed contract, versioned)
                                   │
inputs ──────► Replay engine ─► Policy ─► Surface ─► live app          (no model)
                   │
                   ├─► succeeded + outputs │ business_outcome │ failed + screenshot
                   └─► stuck or irreversible ─► Handoff desk ─► operator console
                                                (same live session, under a lease)

Every component writes through the evidence bus, redacted ─► .runs/<run>/ ─► curated into evidence/
```

| Component | Where | Role |
|---|---|---|
| Surface | `src/perception/` | Observes and acts on a live UI through the accessibility tree, across frames. `desktop.ts` is a documented stub of the same interface. |
| Policy engine | `src/policy/` | Allowlist, irreversible-action classification, redaction. Checked before every action. |
| Discovery loop | `src/agent/` | The only component that calls a model. Emits the trace the compiler reads. |
| Compiler | `src/compiler/` | Trace → capability; reviewed revisions (`cua revise`). |
| Capability schema and loader | `src/schema/` | The artifact contract, app profiles (outcome vocabulary per vendor product), approval records. |
| Replay engine | `src/replay/` | Deterministic execution with the three-way result contract. |
| Handoff | `src/escalation/`, `src/session/` | Intervention requests, operator console, session lease. |
| Catalog | `src/catalog/` | Lists capabilities and exposes them as tool definitions for an agent. |
| Evidence bus | `src/evidence/` | Structured event log, results, screenshots, redacted on write. |

## Prerequisites

- **Node.js 20 or newer** and npm. Developed on Node 24.
- **Chromium for Playwright**, installed once with `npx playwright install chromium`.
- **An Anthropic API key, only to run discovery.** Replay, the catalog, the evidence scenarios and the test suite make no model calls and need no key.

Nothing else: the target application runs locally.

## Setup

```bash
git clone <repository-url>
cd <repository-directory>
npm install
npx playwright install chromium
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
```

To run discovery, set `ANTHROPIC_API_KEY` in `.env`. The CLI loads `.env` itself.

Recent npm versions may warn during install that esbuild's install script was not run (`allow-scripts`). This is safe to ignore: its platform binary is installed as a dependency, and every command below has been verified from a fresh install that showed this warning.

## Configuration

| Variable | Used by | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | discovery only | — |
| `ANTHROPIC_MODEL` | discovery | `claude-opus-5` |
| `ANTHROPIC_EFFORT` | discovery | `high` |
| `MERIDIAN_PASSWORD` | the demo app's synthetic sign-on password, handed to commands by name | `demo` |
| `DEMO_APP_PORT` | `npm run demo` | `4173` |
| `OPERATOR_PORT` | the operator console for `--escalate` | `4174` |

| Needs the LLM | Does not |
|---|---|
| `discover` | `replay`, `revise`, `capabilities list · describe · tools · invoke · approve`, `npm run scenarios`, `npm run handoff`, `npm test` |

Credentials are never typed into commands. They are named by environment variable (`--secret-env`, `--input-env`), which registers them for redaction and keeps them out of shell history. The committed capabilities record `http://127.0.0.1:4173/` as their entrypoint; if you change the port, pass `--entrypoint`.

## Demo

Start the demo application and leave it running:

```bash
npm run demo
# MERIDIAN CORE demo listening on http://127.0.0.1:4173
```

Run the rest in a second terminal.

### 1. Discovery: the model accomplishes a goal on the live UI

```bash
npm run cua -- discover --goal "Sign on with operator ID 'op-demo' and password '{{MERIDIAN_PASSWORD}}', then look up member 12345 and read their current savings balance." --secret-env MERIDIAN_PASSWORD --url http://127.0.0.1:4173/ --capability my_balance_lookup --max-cost 0.50
```

`{{MERIDIAN_PASSWORD}}` is replaced with the value of that variable in the goal the model receives. Because it is declared with `--secret-env`, it is registered for redaction before the run writes anything. The run stops at the step budget, the time budget, the spend ceiling, or when the agent is stuck. It reports success only if the success condition is actually on screen when the model says it is done.

Output of the recorded run whose evidence is committed (about 20 seconds and $0.09):

```
Status:   succeeded
Steps:    6
Model:    7 turns, ~$0.0864 (prompt cache active)
Outputs:
  savingsBalance = $14,820.37

Trace:
   0. fill      ok  Enter the operator ID to sign on
   1. fill      ok  Enter the password to sign on
   2. click     ok  Submit credentials to sign on
   3. fill      ok  Enter member ID to look up
   4. click     ok  Run the member search
   5. read      ok  Capture the savings account balance requested by the goal
Artifact: capabilities/lookup_member_savings_balance.v1.json
  inputs:  operatorId:string(pii), password:string(secret), memberId:string(pii)
  outputs: savingsBalance:string
```

Versions are immutable. Re-running with an id that already has a v1 is refused before any money is spent, so choose a new `--capability` id each time.

### 2. The artifact

Your run writes `capabilities/my_balance_lookup.v1.json`. To read it as a reviewer would, with steps, locator strategies, outcomes, provenance, the invocation schema and its digest:

```bash
npm run cua -- capabilities describe my_balance_lookup
```

The committed example is `capabilities/lookup_member_savings_balance.v1.json`, as recorded by the run in `evidence/discovery-member-balance/`, and `v2.json` after a reviewed revision (`capabilities/reviews/`).

### 3. Deterministic replay, no model

```bash
npm run cua -- capabilities invoke my_balance_lookup --input operatorId=op-demo --input-env password=MERIDIAN_PASSWORD --input memberId=12345
```

No API key? Replay the committed capability instead. Nothing on this path calls a model:

```bash
npm run cua -- capabilities invoke lookup_member_savings_balance --input operatorId=op-demo --input-env password=MERIDIAN_PASSWORD --input memberId=12345
```

```
Status:     succeeded
Capability: lookup_member_savings_balance v2
Outputs:
  savingsBalance = $14,820.37

Steps:
   0. fill     via role_name
   1. fill     via role_name
   2. click    via role_name
   3. fill     via role_name
   4. click    via role_name
   5. read     via grid_cell
```

`capabilities invoke <id>` runs the newest version; add `--version N` to pin one. `replay --capability <file>` runs a specific file. Both exit **0** on success, **2** on a business outcome and **1** on a failure.

### 4. A business outcome is an answer, not a crash

```bash
npm run cua -- capabilities invoke lookup_member_savings_balance --input operatorId=op-demo --input-env password=MERIDIAN_PASSWORD --input memberId=99999
```

```
Status:     business_outcome
Outcome:    MEMBER_NOT_FOUND (at step 5)
            No member exists with the supplied ID. A legitimate answer, not a failure.
  basis:    text "No member found for ID" is on screen
```

This exits with code 2. The demo data provides others: member `55555` gives `PERMISSION_DENIED`, `abc` gives `MEMBER_ID_INVALID`, `23456` gives `NO_SAVINGS_ACCOUNT`, `67890` gives `NO_OPEN_ACCOUNTS`, and a wrong password gives `SIGN_ON_FAILED`.

### 5. Recoverable conditions and hard failures

```bash
npm run scenarios
```

This replays the committed capability 13 times against a fresh instance of the demo app. It injects faults through the app's control plane (a maintenance interstitial, session expiry, a 3-second delay, the app's error page) and seeds awkward data. It writes `evidence/replay/` and exits non-zero if any scenario ends differently than expected. The results are in [`evidence/replay/SUMMARY.md`](evidence/replay/SUMMARY.md): 1 success, 6 business outcomes, 3 recoveries, and 3 hard failures with screenshots.

A malformed invocation is refused before a browser starts:

```bash
npm run cua -- capabilities invoke lookup_member_savings_balance --input operatorId=op-demo
# Cannot invoke lookup_member_savings_balance v2:
#   - missing required input 'password'
#   - missing required input 'memberId'
```

### 6. Human handoff on the live session

Scripted, with a simulated operator working through the console's real HTTP API. It writes `evidence/handoff/`:

```bash
npm run handoff
```

By hand: open a sub-account, a flow with an irreversible step, with the operator console enabled:

```bash
npm run cua -- capabilities invoke open_sub_account --input operatorId=op-demo --input-env password=MERIDIAN_PASSWORD --input memberId=12345 --input accountType="Money Market" --input initialDeposit=250.00 --escalate
```

The run signs on, fills the form, and pauses before **Open Account** (step 8), printing:

```
>>> int-001 needs a person: risky-irreversible at step 8.
    Open http://127.0.0.1:4174 to take control of the live session. The run is paused until it is handed back.
```

Open the console, claim the intervention, look at the live screen, then approve or reject. The run resumes on the same browser session and records who decided. Without `--escalate`, the irreversible step is refused. An approved run opens a real account in the demo app; restart `npm run demo` to reset its data.

### Other commands

```bash
npm run cua -- capabilities list                 # every capability, its contract, versions and problems
npm run cua -- capabilities tools                # the JSON tool definitions an agent is given
npm run cua -- capabilities approve <id> --reviewer <name>   # approval bound to a digest of the artifact
npm run cua -- revise --capability <file> --review <file>    # apply a reviewed revision as a new version
npm run cua -- --help
```

## Evidence

| Path | What it shows |
|---|---|
| [`evidence/discovery-member-balance/`](evidence/discovery-member-balance/) | The real LLM discovery run: `events.jsonl` has every observation, model turn, policy decision, action and extraction, plus the verified success condition. `result.json` has the trace the compiler read. The artifact's `provenance.discoveryRunId` names this run. |
| [`capabilities/lookup_member_savings_balance.v1.json`](capabilities/lookup_member_savings_balance.v1.json) | The artifact that run produced. [`v2.json`](capabilities/lookup_member_savings_balance.v2.json) is the same artifact after a reviewed revision. |
| [`evidence/replay/`](evidence/replay/) | 13 deterministic replays of v2, one directory each with `events.jsonl` and `result.json`. Failures also have `screenshots/` and an accessibility-tree snapshot. |
| [`evidence/handoff/`](evidence/handoff/) | 3 handoffs on the live session: the operator repairs an application error and resumes, approves an irreversible step, or rejects one. Each has intervention records with lease transitions and handed-over and handed-back screenshots. |

Every file under `evidence/` comes from a real run of the code in this repository. `npm run scenarios` and `npm run handoff` regenerate their parts. Raw run output goes to `.runs/`, which is not committed.

The demo's data is synthetic, but committed evidence still should not read like a customer record. Before it is committed, member names, branches and account numbers are replaced with markers in text and blacked out in screenshots (`scripts/evidence-redaction.ts`). Balances and member numbers are kept, because they are the outputs and inputs the evidence demonstrates.

## Tests

```bash
npm test             # vitest: unit tests plus live tests against the demo app in a headless browser
npm run typecheck    # tsc --noEmit
```

No API key is needed. The discovery loop is tested with a scripted model, and live tests start their own demo-app instance on a free port. A full run takes about a minute.

## Design decisions and limitations

Explained in [`REPORT.md`](REPORT.md). In short:

- **The accessibility tree over screenshots or selectors**: role, name and label survive framesets and generated ids, and map onto desktop accessibility APIs.
- **Business outcomes come from the application profile**, not the recording, because a happy-path run cannot learn "no such member".
- **Irreversible actions need a decision.** A person, or an explicit supervised approval, must decide. An artifact can raise a step's risk but never lower it, and approval is a detached record bound to the artifact's digest, so editing an artifact cannot make an irreversible step run unattended.
- **Intentionally minimal**: the desktop surface is a stub; the operator console has no authentication and binds to 127.0.0.1; tenant overrides are in the schema but not yet applied; synthetic member data stays readable in evidence.
