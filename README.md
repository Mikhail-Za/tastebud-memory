# Tastebud Memory

Tastebud helps agents resume projects with cited decisions, corrections, open actions, and recoverable history. It combines exact project/date queries with a local SQLite continuity store. Fingerprint similarity remains available as an experiment.

Requires Node **22.16+** (Node 24 recommended). No npm runtime dependencies. SQLite is provided by Node; some Node releases print an experimental-feature warning.

## Start with the example workspace

```sh
node tastebud.mjs check
node memory-cli.mjs sync
node tastebud.mjs first recipe-site
node memory-cli.mjs brief recipe-site "Resume the search feature"
npm test
```

The example data is fictional. Put real data outside this repository and point `TASTEBUD_CONFIG` at its configuration file. See [configuration](docs/configuration.md) and the [operating guide](docs/operating-guide.md).

## The memory loop

1. Capture source revisions and register stable project identities with `memory-cli.mjs sync`.
2. An agent reads `memory_brief(project, task)` before resuming work.
3. The agent records a decision, correction, task change, outcome, or retrieval feedback with a stable event ID.
4. SQLite commits the event and its receipt together. Retrying the same event is safe; conflicting reuse of an ID fails.
5. A correction explicitly supersedes the prior claim. Completing a task requires an outcome and the current revision ID.
6. Briefs expose the current view, while evidence revisions and event history remain recoverable.

A supported claim means its quotation matches a captured source. It does **not** establish truth, user approval, or permission to act. Agent turn summaries remain unreviewed checkpoints. Source changes, expired claims, negative feedback, and omitted context are visible.

## Exact history and experimental fingerprints

`decode`, `where`, `first`, `cooccur`, `window`, `diff`, `gaps`, and `coverage` return structured JSON from the composition table. Aliases and explicit project redirects share a logical identity. Small weights are retained; exact membership never depends on vector thresholds.

```sh
node tastebud.mjs decode 2026-01-19
node tastebud.mjs window 2026-01-05 2026-01-20
node tastebud.mjs coverage
node tastebud.mjs decode 2026-01-19 --approx
node tastebud.mjs similar 2026-01-19
```

The weighted composition itself is an agent-produced interpretation of a daily log. Exact table queries prove what was stored, not whether the original tagging was semantically correct. Fingerprints can suggest similar activity patterns; they are not semantic embeddings or proof of project identity.

## Agent interface

Register `mcp-server/server.mjs` with an MCP client:

```json
{
  "command": "node",
  "args": ["/path/to/tastebud-memory/mcp-server/server.mjs"],
  "env": {
    "TASTEBUD_CONFIG": "/path/to/private/tastebud.config.json",
    "TASTEBUD_PRODUCER": "agent-a",
    "TASTEBUD_WRITES": "1"
  }
}
```

Read tools include exact queries, `memory_brief`, `memory_search`, `memory_evidence`, `memory_history`, and `memory_health`. `memory_source` and `memory_record` require write mode. Producer attribution comes from client configuration; it is a local process label, not cryptographic proof of a model or human identity. The server validates arguments, returns structured results, and marks failures with `isError: true`.

`scripts/capture.mjs` adapts session-start and turn-completion hooks. It loads a bounded brief at session start and stores substantive turn summaries as checkpoints. Configure it using the host client's supported hooks or notification mechanism; registration and reload requirements differ between clients. It does not automatically infer approved decisions from a transcript.

## Ingestion and candidates

The primary tagger writes a dated JSON proposal. The sweeper validates its raw weights, date, aliases, and duplicates; writes under a shared lock; retains the proposal and source bytes; and flags changed sources for explicit revision. Dry runs do not call fallback models, send notifications, or consume inputs.

New project candidates still use the [nine-gate candidate workflow](CANDIDATES.md). Successful promotion retains immutable candidate evidence separately from the evolving project document. Alias suggestions use bounded co-occurrence rather than corpus-size-dependent rarity scores. Similarity alone never approves an alias.

## Retention and verification

```sh
node scripts/backup.mjs create /safe/location/continuity.bundle.json
node scripts/backup.mjs restore /safe/location/continuity.bundle.json /new/workspace
```

Bundles contain the SQLite snapshot, source revisions, identities, JSON stores, candidates, and configured pending queues. Restore checks hashes and database integrity, reconstructs sources, and relocates configuration into a fresh directory. Store another copy on an independent device or backup service: an on-disk restore drill does not establish off-machine backup coverage.

CI runs behavioral tests on Node 22 and 24: validation, concurrency, crash recovery, corrections, task revisions, MCP handoffs, ingestion, source relocation, archive/restore, and the existing candidate fault-injection suite. The private release scanner additionally requires a local denylist; a missing denylist is an incomplete scan and fails.

The practical success criteria are successful handoffs, fewer repeated explanations and mistakes, and fewer abandoned actions. Retrieval benchmarks help assess those goals; document counts and vector counts are not substitutes.

MIT.

Public repository: https://github.com/Mikhail-Za/tastebud-memory
