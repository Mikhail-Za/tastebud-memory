# Migrating to Tastebud 2

Back up source files and state before deployment. Use a separate checkout and preserve existing uncommitted data changes.

| Surface | Earlier behavior | Version 2 |
|---|---|---|
| Runtime | Node18+ | Node22.16+, Node24 recommended |
| Query output | Human text, approximate decoding | Structured exact JSON; `--approx` retains vector experiments |
| Aliases | Literal query behavior, incomplete uniqueness checks | Alias-aware exact queries; global uniqueness; explicit redirects |
| Ingestion | Normalized invalid input, unsafe concurrent writes | Raw schema validation, fresh locked writes, immutable source/proposal revisions |
| Missing dates | Often indistinguishable from no work | Explicit source coverage states |
| Candidate grammar | `evidence:` in the portable engine; some adapters used `evidence_days:` | `evidence:` with complete normalized source lines and two distinct dates |
| Promotion checks | Mutable document compared indefinitely to its initial SHA | Separate immutable promotion artifact; normal project edits allowed |
| Lifecycle | Composition and triage ledger only | SQLite events, receipts, identities, sources, claims, corrections, tasks, feedback |
| Notifications | Optional shell template | Persistent argv-only transport queue |
| Triage history | Latest status replaced the previous record | Previous decisions retained; WATCH has a review date/new-evidence trigger; `unalias` reverses aliases |

The additive SQLite schema starts at version1. Existing JSON version1 datasets remain readable when valid. Known invalid legacy rows require explicit SHA256 exceptions; these are not permission to normalize new invalid data silently.

Legacy successful promotions without an immutable artifact still use the old SHA check. Copy their verified original candidate bytes into `promotion-artifacts/<promote_sha>.md` before evolving their project document. Never manufacture an artifact from an already edited document. Keep the original candidate grammar/evidence when migrating; draft a separate revised proposal if its evidence no longer meets the shared gate.

`mint --undo` refuses to delete a project document changed since promotion. Preserve it and review a deliberate revert or correction instead. Back up native recall state separately when reconciling a host's machine-specific workspace identity. Copy verified scopes with a reversible manifest; retain originals, counters, and unresolved source references. A path alias alone may not change what the host reader selects.

After deployment, run the regression suite, perform a cold restore, and reconnect agent clients to refresh their tool lists. Verify both producer capture and consumer resumption. An example configuration or a protocol test is not proof that an already-running client has reloaded.
