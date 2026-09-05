# Explicit agent preferences

The preference register keeps **owner decisions separate from agent observations**. Agents can propose rules and report applications. A separate owner interface approves exact wording. Useful outcomes, repeated retrieval, producer names and quoted assertions never activate or strengthen a preference.

Preferences are guidance, never permission to act. Current user instructions take priority. Agents must check scope and exceptions, disclose consequential applications, and ask when overlapping rules leave intent unclear. The store exposes these facts; it cannot force a model to follow them or notice an unreported application.

## Review and correct

From an interactive owner terminal, with the normal workspace configuration selected:

```sh
TASTEBUD_CONFIG=/path/to/tastebud.config.json node scripts/review-preferences.mjs
```

Open the printed local URL. Ctrl+C stops the page's server. The launcher refuses piped/non-TTY invocation. Its capability is in a URL fragment, then browser memory and an API header; refreshing requires reopening the original launch URL. No account, dependency, or background service is added.

The page shows pending changes, current/proposed wording, scope, exceptions, expected effect, evidence and history. Approve or reject a change, then confirm its server-fetched preview within 60 seconds. A changed request or stale revision fails. Correct, retire and restore create new pending drafts; each requires its own approval. Existing history stays intact.

Reported applications show the exact revision and agent-reported execution outcome. Mark an application aligned, contradicted or uncertain independently. This assessment never changes the preference. Old applications remain visible when the preference changes or is retired.

Trusted host adapters can embed the same page and transaction functions. Their authentication belongs to the host; receipts disclose their actual source. The reference private dashboard adapter uses its existing query-string token handoff, sessionStorage and header authentication, with Origin/Fetch-Site checks on preference endpoints. A chat adapter must validate native inbound owner identity and exact confirmation outside the LLM. Plain agent chat can always discuss and draft changes; an agent saying “the user approved” has no activation authority.

## Agent workflow

1. Read `memory_brief` with project and optional `domain`: `planning`, `coding`, `operations`, or `communication`.
2. Inspect `preferences.state`, `active_count`, `pending_count` and `incomplete`. If incomplete, read `memory_preferences` before relying on the rules. With no domain, check every returned scope yourself.
3. Propose changes through `memory_record`. Never invoke an owner server, its approval API or owner chat commands on the user's behalf. Configured producer labels are unverified.
4. Report consequential application with a `preference_use` event and tell the user which rule affected the work. Report the execution outcome separately from intent alignment.

```json
{
  "id": "small-changes-draft-1",
  "session": "session-123",
  "project": "garden",
  "type": "preference_proposal",
  "payload": {
    "preference_id": "small-changes",
    "base_revision": null,
    "operation": "set",
    "kind": "default",
    "body": "Prefer small, independently reviewable changes.",
    "scope": {"kind": "project", "domains": ["coding"]},
    "exceptions": ["Use one larger change when the user requests it."],
    "rationale": "Keep review manageable.",
    "effect": "Split independent implementation work into smaller changes."
  }
}
```

Every proposal has an originating project, including workspace-wide rules (`scope.kind: workspace`). Domains are an explicit nonempty list or `['all']` alone. `base_revision` is null for a new preference; updates reference the current approval receipt. `operation` is `set` or `retire`; `kind` is `default` or `constraint`. Both kinds remain subordinate to current user instructions and existing permission boundaries. Optional evidence uses captured `source_id`, `hash`, `quote`; quote verification is not approval or independent corroboration. Duplicate citations are deduplicated, and source drift remains visible in the full lookup.

```json
{
  "id": "small-changes-use-1",
  "session": "session-123",
  "project": "garden",
  "type": "preference_use",
  "payload": {
    "revision": "APPROVAL_RECEIPT_ID",
    "reason": "Split two independent fixes for review.",
    "task": "Repair the watering timer.",
    "domain": "coding",
    "outcome": "succeeded"
  }
}
```

Outcomes: `succeeded`, `failed`, `unknown`. Only an approved `set` revision in the matching project/domain can be referenced. A historical revision can be reported later; the lookup marks `stale_application` when it is no longer current. Owner alignment starts `unknown`.

CLI lookup: `node memory-cli.mjs preferences PROJECT [DOMAIN]`. MCP: `memory_preferences({project, domain?, as_of?})`. `as_of` uses recorded knowledge, including owner approval time. Briefs include rules **before priority claims**, ordered by scope specificity and approval sequence. No retrieval count, use count or outcome enters that order. At very small budgets the bodies may be omitted; counts and `incomplete` remain. Legacy `claim.kind=preference` is explicitly `nonbinding-unreviewed` in briefs.

## Storage and limits

The additive tables share the existing SQLite transactions and full-database backups. Back up before deployment: the first writable open initializes them, even for an ordinary agent event. Older stores opened read-only report `uninitialized` in briefs, health and preference lookup. They are not silently treated as an empty register. Cold bundle restore preserves proposals, exact approval receipts, history and assessments.

This protects the application's normal interfaces. An unrestricted process running as the same OS user can read capabilities, allocate a terminal, call library functions or edit the database. Neither a launch receipt nor a chat receipt is a cryptographic human signature. Stronger separation requires a distinct trusted service/account. No implicit learning, hidden ranking, automatic semantic conflict resolution or automatic authorization expansion is implemented.
