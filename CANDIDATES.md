# Candidate-gated minting

A slug is permanent: its exact string seeds the project's hypervector, so a mint can never be
renamed, only reversed. Because of that, the recommended (and only automated) way a new slug enters
the codebook is the **candidate flow**: you draft a small candidate file, and `promote` runs it
through nine deterministic gates inside one atomic, crash-recoverable transaction. Nothing is minted
on a hunch, and nothing is minted just because a file exists on disk.

This replaces the old file-existence `autofile` step, which is now deprecated and out of the nightly
sweep (see the note at the end).

## Where candidates live

Two directories, configured in `tastebud.config.json` (see
[`docs/configuration.md`](docs/configuration.md)):

- `candidatesDir` (default `<dataDir>/project-candidates`): your drafts, one `<slug>.md` per
  proposed project.
- `projectsDir`: where a promoted candidate's file is written (`<slug>.md`), and what `has_file`
  detection and the destination-free gate look at.

Both are validated (exist and are directories) only when a candidate command actually runs
(`promote`, `sweep-candidates`, `autopromote`). The legacy commands never require them.

## The candidate file grammar (closed and anchored)

A candidate is `---` frontmatter, a `---` fence, then a free-form body (ignored). It is **not YAML**
and does no type coercion: it is a small, deliberately rigid grammar so a malformed or hostile draft
is rejected, not half-parsed. A leading BOM is stripped and CRLF is normalized to LF first.

```
---
slug: weather-station
class: product
status: candidate
drafted_by: field-notes
drafted_on: 2026-01-21
evidence:
  - date: 2026-01-19
    quote: "- Assembled the outdoor sensor enclosure and wired the anemometer to the microcontroller."
  - date: 2026-01-20
    quote: "- Wrote the firmware loop that logs temperature humidity and wind speed every minute."
---
Free-form notes. Promote this file to mint `weather-station`, or delete it to reject.
```

Rules:

- **Scalar lines** match `^([a-z_]+): (.*)$` for the closed key set
  `{slug, class, parent, status, drafted_by, drafted_on}`. `parent` is optional; the rest are
  required.
- **The evidence block** is a bare `evidence:` line followed by **two or more** entries, each exactly
  two lines: `  - date: YYYY-MM-DD` then `    quote: "<text>"`. The quote is the text between the
  first and last `"` on the line; trailing text after the closing quote is rejected.
- Any unknown key, duplicate key, a key named `__proto__` / `constructor` / `prototype`, any other
  indentation, a flow array / anchor / block scalar, or a missing closing fence rejects the whole
  file.

## The nine gates

`promote` and `sweep-candidates` evaluate the same nine gates against fresh on-disk state. `g1` runs
first; if it fails, only `g1` is reported (the later gates need its parsed result). Otherwise all of
`g2`..`g9` run and every failure is collected.

| Gate | Name | Passes when |
|------|------|-------------|
| g1 | schema | Parses; frontmatter `slug` equals the filename stem and is kebab-case; `class` is one of `product, business, ops, research, content, personal, meta`; `status` is `candidate`; `drafted_by` is non-empty; `drafted_on` is a real date; there are >=2 evidence entries, each a real date with a non-empty quote. |
| g2 | path safety | The candidate path is a regular file whose real parent is the real `candidatesDir` (no symlink, reparse point, or traversal). |
| g3 | not-known | The slug is not already a codebook key and not any existing alias. |
| g4 | ledger-open | The slug's ledger status is absent or `open` (a `dismissed` / `watching` / `aliased` / `minted` / `undone` entry blocks it). |
| g5 | ripe-mint | On fresh state the slug is a current unknown that is ripe and whose recommendation is `mint`. |
| g6 | companion guard | No known codebook slug is a companion of this one at or above `TASTEBUD_CANDIDATE_COMPANION_MAX` (default 0.30). A slug that rides almost entirely with one known project reads as an alias, not a new project. |
| g7 | evidence | Every evidence quote, whitespace-normalized, equals a full line of that date's log (resolved over `logDirs`), is at least 12 non-space characters, and there are >=2 distinct dates. |
| g8 | destination-absent | `projectsDir/<slug>.md` does not already exist. |
| g9 | class/parent | `class` is valid and `parent`, if present, is an existing codebook key. |

Unattended promotion (autopromote, below) additionally requires `class` to be `product` with no
parent. A human `promote` allows any valid class or parent, but every gate still runs.

## Commands

```bash
node tastebud.mjs sweep-candidates            # dry-run: validate every candidate, print PASS/FAIL, ZERO writes
node tastebud.mjs sweep-candidates --write    # the whole enumeration under one lock: log events, autopromote if enabled
node tastebud.mjs promote <slug>              # human promote: any valid class/parent, all nine gates, atomic
node tastebud.mjs mint <slug> --undo          # reverse a promotion (or a legacy mint)
node tastebud.mjs autopromote on|off|status   # opt in/out of unattended self-minting (persisted)
node tastebud.mjs migrate-ledger [--dry]      # normalize the decision ledger to the current schema
node tastebud.mjs digest --json               # {date, decide:[...], candidates:[{slug,pass,gate?}]} for automation
```

`sweep-candidates` (no `--write`) writes nothing. With `--write` it runs the whole candidate
enumeration under one lock: it records a `created` event per candidate and a `rejected` event for
failing ones (both deduplicated), and, only if `autopromote` is enabled and the candidate is
unattended-safe and all gates pass, it promotes. Ordinary gate failures are data and exit 0; a
non-zero exit means an engine exception, which the nightly sweeper treats as a real alert.

### autopromote

Off by default. `autopromote on` persists `autopromote.json` (`{version:1, enabled:true}`); a
missing or malformed file is treated as disabled. With it on, the nightly sweep self-mints only the
product-class, no-parent candidates that pass all nine gates. Everything else "shadows": it is
reported as ready but waits for a human `promote`.

## The promote transaction (and how it recovers)

Under a lock, on fresh reads, `promote` commits in a fixed order so any crash is recoverable:

1. Snapshot the candidate bytes + sha256 and run the gates.
2. Capture the pre-transaction bytes (or absence) of `codebook.json` and `unknowns-ledger.json`.
3. Re-read the candidate; abort if its sha changed.
4. Commit: (a) write the ledger `minted` entry with `via:promote` and the `promote_sha` (the durable
   in-progress marker), (b) write the codebook entry with `has_file:true`, (c) exclusively create the
   project file and fsync it, (d) at the commit point re-verify the candidate's identity and bytes,
   then delete it. After (d) the promotion is committed.
5. On any caught failure before commit, roll back in order: remove the project file, restore the
   codebook, and only if both of those succeed, restore the ledger (clearing the marker last). If a
   prerequisite restore fails, the `via:promote` marker is deliberately kept so `check` can flag it.

`mint <slug> --undo` for a candidate-promoted slug runs the mirror-image reverse transaction:
reconstruct the candidate from the project bytes, remove the project file, drop the codebook entry,
and last set the ledger to `undone` (which then blocks a re-promote via gate g4). A legacy direct
mint undoes in place with no file touched.

## check reconciliation and repair

`node tastebud.mjs check` reconciles every `via:promote` ledger entry (and nothing else, so
founding or hand-added codebook keys are never treated as corruption). A promotion is complete when
the codebook key is present, `projectsDir/<slug>.md` exists with sha256 equal to `promote_sha`, and
the candidate is gone. Any deviation prints:

```
INCOMPLETE-PROMOTION <slug>: <the exact missing/extra artifact>
  repair: ...
```

To repair: to keep the promotion, restore the missing artifact (the project file's bytes are the
candidate's bytes) and remove any lingering candidate; to abandon it, run `mint <slug> --undo`.

## candidate-events.jsonl

Each candidate action appends one advisory JSON line to `<dataDir>/candidate-events.jsonl`:
`{ts, slug, event, candidateSha?, gates?, detail?}` with `event` in
`created, rejected, promoted, promote-failed, undone`. It carries no log text, quotes, absolute
paths, or exception messages. It is deduplicated on the payload (excluding `ts`), the reader
tolerates a truncated final line, and no command's correctness depends on it: it feeds the digest's
recent-activity line and an audit trail only.

## Deprecated: autofile

`autofile` treated the existence of a `<slug>.md` as human judgment and auto-minted. It is retained
(it still prints its `AUTOFILED:` line and honors its exit codes) but prints a deprecation notice to
stderr and is no longer part of the nightly sweep. Prefer the candidate flow, which re-checks the
evidence instead of trusting a bare file.
