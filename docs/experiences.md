# Cross-project experiences

Tastebud experience protocol `tastebud-experience/1` records a cited lesson, suggests structurally similar lessons in the same configured workspace, and records what happened when another project adapted one. It does not execute an intervention, infer meaning, establish truth, grant permission, or change user preferences. Current user instructions remain authoritative.

An experience is an immutable `memory_record` event. Corrections cite the exact older event in `supersedes`; applications keep the exact experience revision they inspected, so a later correction makes them visibly stale instead of rebinding them. Detail reports `event_retired` for the exact requested revision and retains `retired` as the current-lineage retirement state. `scope: "project"` stays in the origin project. `scope: "workspace"` is routable to all registered projects in this database trust domain. Scope is not operating-system isolation and never copies records between separate databases.

## Feature vocabulary and retrieval

Agents supply normalized lowercase slugs in three roles:

- `operations`: what is being done, such as `publish-file`, `recover-queue`, or `update-record`.
- `mechanisms`: the causal or technical structure, such as `atomic-rename`, `bounded-retry`, or `optimistic-concurrency`.
- `environments`: relevant surroundings, such as `sqlite`, `container`, or `greenhouse`.

Use a small shared vocabulary and inspect full text before reuse. Conditions and limits deliberately remain text. A matching environment alone never qualifies a structural match.

`memory_experiences` accepts `{project, query?, features?, mode?, as_of?, limit?}`. Modes are `lexical`, exact sparse `features`, `fingerprint`, and `hybrid`. With features, the default is the simpler exact feature mode; with text alone, the default is lexical. The optional fingerprint is version 1, 512 dimensions, deterministic FNV-1a/Mulberry32 role-qualified bundles and cosine scoring. Hybrid weights lexical 0.55 and fingerprint 0.45. Fingerprint and hybrid feature signals require a shared operation or mechanism. Candidate counts and reported success/failure never affect rank or activate preferences.

Development corpus results at recall@3/MRR were lexical `.833/.833`, exact features `1/1`, fingerprint `1/1`, and hybrid `1/1`. HDC showed no incremental development benefit over exact features, so it remains explicit and optional. The corpus is synthetic and small; these results make no claim of semantic reasoning or general superiority. Run `node evaluation/run.mjs [external-queries.json]` to reproduce or supply untouched cases in `tastebud-experience-eval/1` format.

## Capture and apply

Capture the supporting Markdown with `memory_source`, then record an event like this:

```json
{"event":{"id":"experience-v1","session":"session-a","project":"queue-lab","type":"experience","payload":{"title":"Bound retries for an idempotent queue","problem":"A worker repeats a stalled operation.","mechanism":"Unbounded retry hides terminal failure.","intervention":"Cap attempts and inspect the terminal result.","conditions":["The operation is idempotent."],"limits":["Stop at the equipment heat threshold."],"features":{"operations":["recover-queue"],"mechanisms":["bounded-retry"],"environments":["container"]},"scope":"workspace","outcome":"succeeded","evidence":[{"source_id":"SOURCE_ID","hash":"SOURCE_HASH","quote":"EXACT QUOTE FROM CAPTURED SOURCE"}]}}}
```

`succeeded` and `failed` experiences need matching captured evidence. Corrections and retirements also need evidence. An `unknown` original may have an empty evidence array and remains visibly reported as unknown. Quote matching proves only that the report appeared in captured bytes.

Retrieve candidates, then fetch the exact card ID with `memory_experience`. Check every condition and limit, current/corrected/retired state, source drift diagnostics, environment differences, failed and declined applications, and any withheld cross-project application content. Present-day `captured_source_changed`, `filesystem_status`, and `archived` diagnostics are labeled current even on an event `as_of` view.

Record the planned adaptation before executing it:

```json
{"event":{"id":"application-plan","session":"session-b","project":"greenhouse-lab","type":"experience_application","payload":{"application_id":"greenhouse-retry","experience_id":"experience-v1","previous_event_id":null,"context":"A greenhouse queue is stalled.","features":{"operations":["recover-queue"],"mechanisms":["bounded-retry"],"environments":["greenhouse"]},"adaptation":"Use one retry and a lower heat threshold.","assessments":[{"condition":"The operation is idempotent.","status":"met","reason":"The request has a stable key."}],"checks":[],"status":"planned","outcome":"unknown","evidence":[],"share":"project"}}}
```

Assess every source condition exactly once as `met`, `unmet`, or `unknown`, with a reason. Unmet or unknown conditions remain visible and mean the application is not fully validated. An `application_id` is workspace-global; prefix it with the target project, as in `greenhouse-retry`, to avoid collisions. Updates retain `application_id` and `experience_id` and cite the latest exact application event in `previous_event_id`. An evaluated `succeeded` or `failed` outcome needs named checks and matching captured evidence. A succeeded outcome cannot contain a failed or unknown check; a failed outcome needs a failed check. A decline uses `status: "declined"` and `outcome: "not-applied"`.

Application summaries and target project slugs for workspace experiences are visible across the workspace, so another project can see adverse outcomes. Candidate cards and experience detail withhold full context, adaptation, assessments, checks, and evidence outside the target project unless `share: "workspace"` was explicit. This is interface-level minimization: `memory_history` exposes complete immutable event payloads for any project within the configured trusted workspace. Project-scoped sources cannot create workspace-shared applications. Bounded details report omissions and link `memory_history` for the listed origin and target projects. If target projects are omitted, their count is explicit; full history remains available per registered project.

## Portability and adapters

Run `node examples/experience-transfer-demo.mjs` for a fictional capture, cross-environment retrieval, detail inspection, planned adaptation, cited outcome, correction, bundle backup/restore, and cold-process reopen with stable IDs and evidence hashes. It also verifies a pending explicit preference proposal survives without treating it as approved. The demo is protocol verification, not autonomous agent learning.

Existing semantic or graph indexes can store `workspace_id`, exact event `id`, `payload_hash`, origin/target project slug, and evidence `source_id` plus revision `hash`. Treat those indexes as complementary candidate generators and resolve the stable event ID through `memory_experience` before use. Tastebud remains the event/evidence authority; do not copy index scores back as outcomes or preferences.

MCP clients discover `memory_experiences`, `memory_experience`, updated schemas, and SessionStart guidance when a new server process starts. Long-lived clients may need to reconnect. CLI reads JSON from a named file or stdin with `memory-cli.mjs experiences REQUEST.json|-` and `memory-cli.mjs experience REQUEST.json|-`; writes continue through `memory-cli.mjs record` or `memory_record` only.

Storage uses bounded full event scans at current scale and schema version remains 1. Add an index or projection only after measured event volume makes scans too slow. Whole-store backup remains the portability boundary; there is no live-store merge or implicit sharing.
