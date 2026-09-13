# Replay scenarios

Capability: `lookup_member_savings_balance` v3, replayed with no model in the loop.
Regenerate with `npm run scenarios`.

| Scenario | Condition | Status | Result | Recoveries | Elapsed | As expected |
|---|---|---|---|---|---|---|
| [01-success](./01-success/result.json) | Healthy application, known member | succeeded | savingsBalance=$14,820.37 | — | 2.0s | yes |
| [02-outcome-member-not-found](./02-outcome-member-not-found/result.json) | Member ID that does not exist | business_outcome | MEMBER_NOT_FOUND | — | 1.5s | yes |
| [03-outcome-permission-denied](./03-outcome-permission-denied/result.json) | Restricted member the operator may not view | business_outcome | PERMISSION_DENIED | — | 1.5s | yes |
| [04-outcome-malformed-member-id](./04-outcome-malformed-member-id/result.json) | Non-numeric member ID, rejected by the application | business_outcome | MEMBER_ID_INVALID | — | 1.5s | yes |
| [05-recovered-maintenance-interstitial](./05-recovered-maintenance-interstitial/result.json) | Unexpected maintenance notice before the search screen | succeeded | savingsBalance=$14,820.37 | maintenance_interstitial (click) | 2.1s | yes |
| [06-recovered-session-expired](./06-recovered-session-expired/result.json) | Session times out when the search is submitted | succeeded | savingsBalance=$14,820.37 | session_expired (reauthenticate) | 3.3s | yes |
| [07-recovered-slow-load](./07-recovered-slow-load/result.json) | Search response delayed by 3 seconds | succeeded | savingsBalance=$14,820.37 | transient_slow_render (bounded_wait) | 4.5s | yes |
| [08-failed-application-error](./08-failed-application-error/result.json) | Application returns its error page on search | failed | application_error | — | 1.6s | yes |
| [09-failed-invalid-invocation](./09-failed-invalid-invocation/result.json) | Caller omits a required input | failed | invalid_input | — | 0.0s | yes |
| [10-outcome-no-savings-account](./10-outcome-no-savings-account/result.json) | Member whose only account is checking | business_outcome | NO_SAVINGS_ACCOUNT | — | 1.8s | yes |
| [11-outcome-no-open-accounts](./11-outcome-no-open-accounts/result.json) | Closed member with no accounts at all | business_outcome | NO_OPEN_ACCOUNTS | — | 1.5s | yes |
| [12-failed-ambiguous-savings-accounts](./12-failed-ambiguous-savings-accounts/result.json) | Member with two savings accounts; the capability cannot tell which balance is meant | failed | target_ambiguous | — | 2.0s | yes |
| [13-outcome-sign-on-failed](./13-outcome-sign-on-failed/result.json) | Credential the application rejects | business_outcome | SIGN_ON_FAILED | — | 0.9s | yes |
