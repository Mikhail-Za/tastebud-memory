# Production pattern: primary LLM cron + deterministic sweeper + alerted fallback

This is the wiring that runs nightly in the original deployment (an OpenClaw agent platform on
Windows; everything here translates to cron/systemd/launchd + any agent platform).

## The shape

```
02:40  PRIMARY - your agent platform's scheduled job, on your main LLM
       └─ reads codebook.json + yesterday's log (prompt: examples/nightly-prompt.md)
       └─ writes ONE small file: <dataDir>/inbox/<date>.json     ← tiny LLM write surface

03:30  SWEEPER - plain cron/Task Scheduler, runs tagger.mjs nightly --write
       └─ inbox present+valid → ingest deterministically (provenance: primary-cron), clean inbox
       └─ inbox missing/invalid → ALERT with reason → LOCAL fallback model tags → second ALERT
       └─ unknown major slugs → ALERT ("unknown ingredient - consider adding to codebook")
       └─ snapshots compositions.json → .bak BEFORE every append (refuses to append if that fails)
```

## Why this split (each rule bought with a scar)

- **The LLM never edits the composition store.** It writes one tiny new file; deterministic code
  does the merge. An LLM doing nightly JSON surgery on your history will eventually mangle it.
- **Primary on your subscription/OAuth LLM, fallback strictly local.** If your platform reaches
  your main model via OAuth, don't extract the token for a standalone script. Route the call
  through the platform's own scheduler (that's what the inbox handoff enables) and let it own
  token refresh.
- **Silence means success.** The only pushes (config `notifyCommand`; point it at Telegram,
  Slack, ntfy, anything) are: primary failed (with the reason, so you can investigate), fallback
  used, unknown ingredient found, or all lanes dead. Have a periodic job re-send alerts whose
  push failed. Our agent's heartbeat does this as backstop.
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
- Weekly: surface `gaps` + unknown ingredients + week-over-week `diff` as PROPOSALS in whatever
  review your agent already sends you. A human approves codebook changes.
