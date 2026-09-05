# Current version

For version 2, use the [operating guide](operating-guide.md) and [migration matrix](migration-v2.md). The scheduling pattern below remains useful; configuration and recovery contracts in those guides take precedence.

# Production pattern: primary LLM cron + deterministic sweeper + alerted fallback

This is the wiring that runs nightly in the original deployment (a scheduled agent platform on
Windows; everything here translates to cron/systemd/launchd + any agent platform).

## The shape

```
02:40  PRIMARY - your agent platform's scheduled job, on your main LLM
       └─ reads codebook.json + yesterday's log (prompt: examples/nightly-prompt.md)
       └─ writes ONE small file: <dataDir>/inbox/<date>.json     ← tiny LLM write surface

03:30  SWEEPER - plain cron/Task Scheduler, runs tagger.mjs nightly --write
       └─ inbox present+valid → ingest deterministically (provenance: primary-cron), clean inbox
       └─ inbox missing/invalid → ALERT with reason → LOCAL fallback model tags → second ALERT
       └─ new unknown major slugs → LOG silently to the triage queue (no ping; they ripen first)
       └─ snapshots compositions.json → .bak BEFORE every append (refuses to append if that fails)
       Then, in this fixed order (each step best-effort, none can corrupt the tag above):
       └─ sweep-candidates --write → validate every candidate under one lock; autopromote the
          unattended-safe passers if you opted in; a NON-ZERO exit is an engine ALERT and
          suppresses the "all good" digest (ordinary gate failures are console-only data)
       └─ regenerate <dataDir>/unknowns-report.md
       └─ weekly data checkpoint (Sundays / TASTEBUD_CHECKPOINT=1): git-commit codebook +
          compositions + unknowns-ledger only
       └─ compose + send the DAILY DIGEST (ripe decide queue + candidate lines, or a one-line pulse;
          recent decisions; no-log days folded in) via notify; on a confirmed ack it calls
          `digest --json` and `mark-sent` for the ripe slugs. One consolidated push per run.

Sun  WEEKLY ROLLUP - optional, plain cron. A light strategic summary only: week-over-week shift,
       any item left undecided all week, workstreams still unfiled. The DAILY digest above owns
       per-item decisions, so this does not re-propose them.
```

## Why this split (each rule bought with a scar)

- **The LLM never edits the composition store.** It writes one tiny new file; deterministic code
  does the merge. An LLM doing nightly JSON surgery on your history will eventually mangle it.
- **Primary on your subscription/OAuth LLM, fallback strictly local.** If your platform reaches
  your main model via OAuth, don't extract the token for a standalone script. Route the call
  through the platform's own scheduler (that's what the inbox handoff enables) and let it own
  token refresh.
- **One consolidated daily push; routine events fold into it.** The pushes (config
  `notifyCommand`; point it at Slack, ntfy, a webhook, anything) are *failures* (immediate, with
  the reason: primary failed, fallback used, all lanes dead) and the *daily digest*. Finding a new
  unknown ingredient is not its own ping: the sweeper logs it to the triage queue to ripen, and it
  only appears in the digest once it has matured. Routine no-log days fold into the digest as one
  line instead of re-firing nightly. The digest is a short pulse when nothing needs you and expands
  to the ripe decide queue when it does. Have a periodic job re-send alerts whose push failed.
- **Mint through the candidate gate, not on file existence.** A slug is permanent, so it enters the
  codebook only through a drafted candidate that `promote` re-validates against nine gates (schema,
  path safety, not-already-known, evidence quoting real log lines, companion independence,
  destination free, class/parent). Unattended self-minting is opt-in (`autopromote on`) and even then
  only for the product-class, no-parent, all-gates-pass drafts; everything else waits for a human
  `promote`. The earlier "auto-file any unknown that already has a `<slug>.md`" shortcut trusted a
  stray file too much and has been retired from the nightly sweep. See
  [`../CANDIDATES.md`](../CANDIDATES.md).
- **Test the fallback before you need it.** Point the primary at a dead URL once and watch the
  whole chain fire: alert, local tag, second alert. Five minutes now, certainty forever.
- **Validate the local lane against your primary's tags** (`tagger.mjs test <dates>`) before
  trusting it. Ours scored 0.74 average major-set agreement against a bar of 0.80, which is why
  it's the fallback and not the primary. Resist tuning the prompt against the same test days
  until it passes; that's overfitting your gate.
- **Duplicate-refusal makes everything idempotent.** Re-running the sweeper is always safe; a
  stale inbox file for an already-tagged day is cleaned, not double-ingested.

## Agent-side integration

- Register `mcp-server/server.mjs` (stdio MCP) with your agent so it can taste before reading.
- Tell the agent WHEN to use it (one paragraph in its tools/bootstrap notes): *"before reading
  multiple daily logs to answer 'when did X start / which days touched Y / what was that day
  about', call tastebud_decode / tastebud_where / tastebud_first, then fetch only the days
  that matter."* A registered tool the agent doesn't know to reach for is dead weight.
- If your scheduled jobs run with least-privilege tool allowlists (they should), note that
  weekly triage doesn't need the MCP tools. compositions.json and codebook.json are just files;
  `read` is enough.

## The decision loop (ripe-only, reversible)

The nightly pass detects, ripens, and sends the daily digest; you decide from the digest. Keeping
detection silent and surfacing only ripe items means day-to-day noise never reaches you and the
digest stays high-signal.

- **Surface only what is ripe.** `tastebud.mjs unknowns --write` writes `unknowns-report.md` with
  three sections: **Decide** (ripe, with a recommendation and the reasoning), **Watching** (parked
  by you), and **Maturing** (still ripening, FYI only). Push the Decide section as PROPOSALS in
  whatever review your agent already sends you, alongside `gaps` and a week-over-week `diff`. A
  human approves every codebook change.
- **Each proposal carries a recommendation, not a decision.** The report suggests **mint**,
  **alias**, **dismiss**, or **watch** per item with its rationale (for example, an unknown that
  co-occurs almost entirely with one project reads as an alias of it). Treat it as a starting
  point: a human who knows the work can always overrule it.
- **Every decision is reversible, on a persistent ledger.** Verdicts live in
  `<dataDir>/unknowns-ledger.json`, separate from the composition store, so triage never risks
  ground truth. `dismiss` is "not now" and *revives* an item if it later grows; `watch` defers;
  `alias` folds a name onto an existing project and resolves it; a candidate `promote` is an
  undoable codebook write (`mint --undo` runs the reverse transaction). Every mutating command holds
  the advisory lock and writes atomically. The principle: no triage action is a one-way door.

## Drafting candidates (bring your own)

The engine never invents the candidate file for you; drafting is your side of the contract, exactly
like tagging. When an unknown ripens ("would mint" in the digest), produce
`candidatesDir/<slug>.md` in the grammar from [`../CANDIDATES.md`](../CANDIDATES.md): the class, a
`status: candidate` line, and at least two `date` + `quote` evidence entries where each quote is an
**exact full line** copied from that day's log. Your agent can draft this the same way it tags: read
the ripe slug's days, pull two representative log lines, emit the file. Keeping the drafting surface
this small (a file with quoted evidence) is what lets `promote` re-verify it deterministically. A bad
or fabricated quote simply fails gate g7 and never mints.

## Reconciliation after a crash

`promote` is one atomic transaction with a durable `via:promote` ledger marker, so an interrupted
run is always recoverable. `node tastebud.mjs check` reconciles every `via:promote` entry against
the codebook, the project file plus its immutable promotion artifact (by sha), and the candidate directory, and prints an
`INCOMPLETE-PROMOTION` line with the exact artifact and a one-line repair for any deviation. Wire
`check` into the same nightly cron (or a monitor) so a rare interrupted promotion surfaces the next
morning instead of silently. Founding or hand-added codebook keys have no ledger entry and are never
flagged.
