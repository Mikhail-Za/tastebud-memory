# 👅 tastebud-memory

**Compositional project fingerprints for AI agent memory.** Give every project a deterministic
high-dimensional identity vector. Every day's work becomes a weighted blend of those vectors.
One "taste" — a dot product — decomposes any day back into its exact ingredients, enumerates
every day a project ever touched, and detects ingredients **nobody has named yet**.

Zero dependencies. Two JSON files. ~600 lines of Node.

## The idea (and where it came from)

This started as a question about hexadecimal colors: *what if every project had a unique color,
and a day's work blended them into a new color you could un-mix?* The problem is that color
can't do that — 3 channels can't carry the membership of 50 projects, which is why mixed paint
can't be un-mixed.

The metaphor that actually works is a **chef's palate**. A trained chef tastes an unfamiliar
dish and names every ingredient in it, estimates the proportions, and — the key move — notices
when there's *something in the dish he doesn't recognize*. That's what this does, with
~30-year-old math: [hyperdimensional computing](https://link.springer.com/article/10.1007/s12559-009-9009-8)
(Kanerva) / vector symbolic architectures.

- Each project slug deterministically seeds a **4,096-dimension ±1 vector**. Random
  high-dimensional vectors are nearly orthogonal, so they don't interfere.
- A day's fingerprint = the **weighted sum** of its projects' vectors.
- **Decoding** = dot product against the codebook: projects in the blend score ≈ their weight;
  absent projects score ≈ 0. Mixing is reversible — the thing color couldn't do.
- **The residual** — mass the codebook can't explain — is the unknown ingredient detector. When
  your agent starts working on something that has no name yet, this notices *before you do*.

## Why bother? (what semantic search can't do)

We baselined an agent's real memory (92 days, ~400 files) with embedding search before building
this. Semantic search was good at date lookups and well-named topics — and structurally
incapable of:

- **Enumeration**: "list ALL days that touched project X" (search returns representatives, never
  the complete set)
- **Origin under aliasing**: "when did X start, including under its old name?" (recency and
  volume bury the origin — this was a total miss in our baseline)
- **Temporal set-difference**: "active in March, dead by June"
- **Absence**: "which workstreams never got documentation?" (you can't embed a negation)

Fingerprints answer all four exactly, in milliseconds, because composition is *recorded*, not
inferred. Tastebud **complements** semantic search (meaning), it doesn't replace it (membership).

## Quickstart (60 seconds)

```bash
git clone https://github.com/YOUR_USER/tastebud-memory && cd tastebud-memory
node tastebud.mjs check                      # validate the sample data
node tastebud.mjs decode 2026-01-12          # un-mix one day from its vector alone
node tastebud.mjs where aquarium-controller  # every day that project ever touched
node tastebud.mjs gaps                       # workstreams with no documentation
node tastebud.mjs tasteslike sourdough-lab   # an UNKNOWN ingredient: what is it close to?
node tastebud.mjs backtest aquarium-controller  # would the detector have caught this project emerging?
node tastebud.mjs color 2026-01-12           # the original metaphor, as garnish
```

The sample data is a fictional fortnight that includes an emerging project and an unknown
ingredient, so every command above demonstrates something real.

## Using it on your own memory

1. **Codebook** — list your projects in `codebook.json` (slug + aliases + `has_file`). Slugs are
   permanent (they seed the vectors); add aliases instead of renaming.
2. **Backfill** — have a strong LLM read each daily log and emit `{major:[{slug,w}], minor:[], new:[]}`
   per day (rules in `examples/nightly-prompt.md`). Verify a sample before trusting it — see
   `docs/methodology.md` for the gate/backtest protocol we used.
3. **Nightly** — schedule your platform's LLM to tag yesterday into `inbox/<date>.json`
   (prompt template provided), and run `node tagger.mjs nightly --write` an hour later as the
   deterministic sweeper. If the primary fails, a local model takes over and you get an alert
   with the reason (`notifyCommand` in config → Telegram/Slack/ntfy/whatever).
4. **Agent integration** — register `mcp-server/server.mjs` (standard MCP, stdio) so your agent
   can *taste before reading*: decode a day in milliseconds, then fetch only the logs that matter.

## What this is not

- **Not a summarizer.** A fingerprint is an index, not the content — the chef recovers the
  ingredient list, not the recipe steps. Taste → identify → fetch.
- **Not magic capacity.** A bundle reliably holds a few dozen constituents at D=4096 — plenty
  for a day, wrong for a year. Aggregate windows instead.
- **Not a replacement for the codebook.** Decoding requires reference vectors, like a palate
  requires training. Unknown ingredients are detected as *unexplained mass*, then triaged.

## Honest engineering notes

The full methodology — including the kill-gates this project had to pass before going live —
is in [`docs/methodology.md`](docs/methodology.md). Highlights: an adversarial verification pass
re-derived 31 of 92 days blind and found 2 real tagging errors (93.5% faithful); backtests
flagged emerging projects on day 0–2; and our honest finding that **the composition table does
most of the query work** — the vector layer earns its keep on decode, drift, similarity, and
fixed-size encoding, not on basic lookups. Production wiring (primary LLM cron + deterministic
sweeper + alerted local fallback) is in [`docs/production-pattern.md`](docs/production-pattern.md).

## License

MIT. Built by Mikhail Zaidi with Claude (Anthropic), June 2026.
