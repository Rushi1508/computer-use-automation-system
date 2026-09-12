# Human-in-the-loop handoff scenarios

Each run pauses on the live session and raises an intervention. A scripted operator claims it
through the operator console's HTTP API — the same API a person's console page uses — acts on
the same browser session, and hands it back. The human is simulated; the control transfer is not.

Regenerate with `npm run handoff`. Each scenario directory holds the replay's events and result,
the full intervention record (context, lease transitions, operator actions, state before and after),
and screenshots of the session as it was handed over and handed back.

`open_sub_account` is a hand-authored capability, labelled as such in its provenance, used so there is
a genuinely irreversible step to decide on without spending model budget on a second recording.

| Scenario | Condition | Why it paused | What the operator did | Resolution | Run ended | As expected |
|---|---|---|---|---|---|---|
| [01-operator-repairs-application-error](./01-operator-repairs-application-error/interventions/int-001.json) | Application error on search; replay cannot recover by itself | application_error at step 5 | claimed int-001, navigated back, re-ran the search (3 actions), resumed | resume | succeeded: savingsBalance=$14,820.37 | yes |
| [02-operator-approves-irreversible-step](./02-operator-approves-irreversible-step/interventions/int-001.json) | Draft capability reaches its irreversible step | risky-irreversible at step 8 | claimed int-001, inspected the filled form, approved | approve | succeeded: newAccountNumber=0009-4000 | yes |
| [03-operator-rejects-irreversible-step](./03-operator-rejects-irreversible-step/interventions/int-001.json) | Draft capability reaches its irreversible step; the person declines | risky-irreversible at step 8 | claimed int-001, rejected with a reason | reject | failed: confirmation_refused | yes |
