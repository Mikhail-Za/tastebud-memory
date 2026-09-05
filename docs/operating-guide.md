# Operating Tastebud 2

## Before resuming a project

Request `memory_brief` with the project name, current task, and a context budget (default 1600 estimated tokens). Briefs enforce a UTF-8 byte ceiling of three bytes per budget unit; the token count is an estimate, not a tokenizer guarantee. Inspect `omitted`, expired/disputed claims, source-change flags, and `coverage`. Empty actions can mean no structured task history has been captured; they do not prove a project has no remaining work. Use `memory_evidence` for the cited revision and `memory_history` for earlier claims or task outcomes.

Check the brief's `preferences` state and completeness. Approved rules precede claims; `incomplete: true` requires the full `memory_preferences` lookup. Read the [preference workflow](preferences.md) for scope, exceptions, agent proposals, owner confirmation, corrections and separate intent-alignment feedback. Agents must not launch owner review servers, call their approval APIs or impersonate owner chat commands.

Use exact queries for membership, dates, and activity windows. Use `memory_search` for local full-text evidence retrieval. An existing semantic-search service can remain a complementary retrieval path; the default store works offline.

## Capture a decision or correction

First capture the relevant Markdown source with `memory_source(path)`. Then send:

```json
{
  "event": {
    "id": "garden-decision-1",
    "session": "session-123",
    "project": "garden",
    "type": "claim",
    "payload": {
      "kind": "decision",
      "body": "Water weekly.",
      "evidence": [{"source_id": "SOURCE_ID", "hash": "REVISION_HASH", "quote": "Water weekly."}]
    }
  }
}
```

Claim kinds: `fact`, `decision`, `constraint`, `preference`, `failure`, `lesson`, `outcome`, `summary`. Without evidence, a claim is `proposed`. With a verified quotation, it is `supported`; that label is not human approval. A correction supplies `supersedes` with the previous claim ID and new evidence. A second correction against an already superseded revision fails rather than silently racing another writer. Optional `valid_until` records expiration.

`as_of` means knowledge recorded and events observed by that timestamp. Imported historical documents do not retroactively become knowledge the store possessed before import.

## Close an action

A task event needs `id`, `title`, and `status` (`open`, `blocked`, `done`, `cancelled`). Add `owner`, `dependencies`, `next_action`, and `due_at` where useful. Dependency IDs must already exist. Updates must supply `previous_event_id` from the brief's `revision_event_id`; stale updates fail. A `done` task requires an outcome and completed dependencies.

Feedback events accept `claim_id` (optional), `outcome`, and `note`. Outcomes are `useful`, `stale`, `incorrect`, `missed`, `handoff-success`, and `handoff-failed`. Negative claim feedback marks the current brief as disputed; a correction still requires evidence. Review feedback and stranded tasks periodically.

Turn hooks capture unreviewed checkpoints, shown in briefs for 30 days. They do not substitute for explicit decisions and task updates. Event history is retained beyond the brief's checkpoint window.

## Source changes and retention

`coverage` separates untagged, current, changed, unverified, ambiguous, and missing-source days. Existing rows without hashes are unverified; do not invent their original revision hashes. The `legacyRows` compatibility map permits only individually identified, byte-hashed historical exceptions and reports them during `check`.

To correct a composition:

```sh
node memory-cli.mjs ingest YYYY-MM-DD proposal.json /path/to/log.md --write --revise
```

The prior composition, proposal, and source bytes remain available. A supplied proposal `source_hash` must match the log at commit time.

Before pruning, capture sources with `sync` and take a backup. `archive SOURCE_ID` marks retained evidence as archived without deleting a file. After an explicit file move, `relocate SOURCE_ID NEW_PATH` preserves the source ID and verifies that its bytes match the current revision. Neither operation rewrites history.

## Recovery and delivery

SQLite uses WAL, full synchronization, and transactional event receipts. A receipt is returned only after commit. IDs must be stable across retries, with identical payloads and the same configured producer.

Candidate promotion has its own fault-tested file transaction and immutable `promotion-artifacts/<sha>.md`. `check` verifies the artifact; normal edits to a committed project document are allowed. Undo refuses to discard an edited project document. Treat that refusal as a request for an explicit revision/revert plan.

The optional argv notification adapter retains unacknowledged deliveries in SQLite. Configure `notifyAckPattern` if exit code zero is insufficient evidence of delivery. A lost acknowledgment can result in a duplicate retry; pass `{id}` to a transport that supports deduplication.

The legacy JSONL memory-write applier uses an append-only producer journal plus SQLite receipts. It never merges over or removes the producer append target. It verifies every body entry before acknowledging, and retains failures and dead letters. Do not truncate the live journal; coordinate a producer cutover for archival. New integrations should use `memory_record`.

## Boundaries

Backups and source exports can contain private data. Keep them outside the public source tree. Shared code does not imply shared memory between different users or tenants. Configure separate databases and workspace IDs for separate trust domains.

The store is agent infrastructure, not a change to model weights. Reliability of event capture, evidence quality, retrieval, and agent behavior determines its usefulness. Test a real project handoff after a long gap before treating long-term usefulness as established.
