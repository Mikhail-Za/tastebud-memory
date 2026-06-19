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
       └─ unknown that already has a project file → AUTO-FILE into the codebook (logged, not pinged)
       └─ snapshots compositions.json → .bak BEFORE every append (refuses to append if that fails)

Sun  WEEKLY DIGEST - plain cron, runs tastebud.mjs unknowns --write
       └─ surfaces ONLY ripe unknowns, each with a recommendation (mint/alias/dismiss/watch)
       └─ writes <dataDir>/unknowns-report.md and pushes it via notifyCommand (the one weekly ping)
       └─ Maturing items stay logged-only; you are not asked about them
```

## Why this split (each rule bought with a scar)

- **The LLM never edits the composition store.** It writes one tiny new file; deterministic code
  does the merge. An LLM doing nightly JSON surgery on your history will eventually mangle it.
- **Primary on your subscription/OAuth LLM, fallback strictly local.** If your platform reaches
  your main model via OAuth, don't extract the token for a standalone script. Route the call
  through the platform's own scheduler (that's what the inbox handoff enables) and let it own
  token refresh.
- **Silence means success, and routine detection is silent.** The only pushes (config
  `notifyCommand`; point it at Slack, ntfy, a webhook, anything) are *failures* and the *weekly
  digest*: primary failed (with the reason, so you can investigate), fallback used, all lanes
  dead, or the once-a-week ripe-unknown review. Finding a new unknown ingredient is **not** a
  push anymore: the sweeper logs it to the triage queue to ripen, and only the weekly digest
  asks you about the ones that matured. Have a periodic job re-send alerts whose push failed.
- **Auto-file the unambiguous unknowns.** If an unknown slug already has a project file on disk
  (config `projectsDir`) and has shown up as major work, a human already decided it is a real
  project; asking again is busywork. The nightly pass files it into the codebook automatically
  (`autofile`, snapshot first), logs it, and does not ping. This keeps the weekly digest focused
  on genuinely undecided items.
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

## The weekly decision loop (ripe-only, reversible)

The nightly pass detects and ripens; the weekly pass decides. Keep them separate so day-to-day
noise never reaches you and the one weekly touchpoint is high-signal.

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
  ground truth. `dismiss` is "not now" and *revives* an item if it later grows; `mint` is an
  undoable codebook write (`mint --undo`); `watch` defers; `alias` folds a name onto an existing
  project and resolves it. Every mutating command snapshots to `.bak` first. The principle: no
  triage action is a one-way door, so a wrong call at 0.74 confidence costs one line to undo.
