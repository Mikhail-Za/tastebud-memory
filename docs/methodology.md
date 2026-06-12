# Methodology — how to prove this works on YOUR memory before trusting it

Tastebud was not shipped on vibes. It had to pass a sequence of kill-gates against a real
agent's memory corpus, and the same protocol applies to your data. The whole point: **your
existing history is a free backtest set** — you can validate the entire system offline before
it touches anything live.

## Phase 0 — Freeze the ground truth

Before writing system code:

1. **Corpus facts**: how many logged days, where they live, duplicates/format drift that will
   trap a tagger (ours had compat-copies to dedupe, headless files needing date-from-filename,
   service status-line noise, and a name collision between two things sharing one nickname).
2. **Emergent-project targets**: projects that appeared in your logs BEFORE they got any
   documentation. These are the residual detector's backtest targets. (In our corpus: a
   relocation workstream ran 13+ days undocumented; a client-site rebuild ran ~21 days; several
   workstreams never got files at all.)
3. **Test questions + baseline**: ~10 real questions spanning enumeration, aliasing/origin,
   co-occurrence, set-difference, absence. Run them through your existing retrieval and grade
   honestly (ours: 2 HIT / 5 PARTIAL / 1 MISS / 2 STRUCTURAL-MISS). This is the bar to beat.

Freeze this document. If the numbers change later, re-run Phase 0 — don't edit them in place.

## Phase 1 — Tagging backfill, with a human/adversarial gate

Tag every historical day with a strong LLM (composition rules in `examples/nightly-prompt.md`).
**Gate**: re-derive a stratified ~30% sample blind — read the log FIRST, write down your own
composition, THEN compare to the stored tag (anchoring-proof ordering matters). Grade MATCH /
MINOR-DIFF / MAJOR-DIFF; require ≥90% MATCH+MINOR. Fix MAJOR-DIFFs in the data, don't footnote
them.

Ours: 29/31 faithful; the two real errors found (an unsupported major; a missed co-major) were
corrected and flagged `verified-corrected`.

If tagging fails this gate, STOP — every layer above is built on it, and the honest conclusion
is that the tagger, not the encoding, is your bottleneck.

## Phase 2 — The vector layer, evaluated honestly

Build the hypervector layer and run two tests:

1. **The Phase-0 questions** — require the structural misses to become answerable and no
   regression on what already worked.
2. **Emergent-project backtest** — remove each Phase-0 target from the codebook, replay
   history, require the unexplained-mass detector to flag it within ≤5 days of first major
   activity. (Ours: day 0 for two targets, day 2 for one; threshold 0.20 recommended — 0.25
   missed a small-footprint workstream.)

**Pre-commit to the kill-rule**: if the plain composition table answers everything and the
vectors add nothing measurable, keep the table and drop the vectors. Our honest finding: the
table IS the workhorse for lookups; the vectors earn their keep on lossless decode, day
similarity, drift/entanglement (one project's identity measurably absorbing another's), and
fixed-size encoding for fast whole-corpus matching.

## Phase 3 — Going live, with provenance

- Nightly tagging via the **primary cron + deterministic sweeper** split
  (`docs/production-pattern.md`) — never let the LLM edit your composition store directly.
- Every entry carries provenance flags (`gpt-x-cron` vs `local-fallback` vs `verified-corrected`).
- A weekly triage closes the loop on unknown ingredients: each gets a proposal — create a
  project file, add an alias, or dismiss — with a human approving codebook changes (slug choices
  are permanent; they seed the vectors).
- Schedule a retro ~2 weeks in: did the detector catch anything real? Does your agent actually
  call the tools? Are alerts signal or noise? Kill or keep on evidence.

## Capacity and limits (be honest with yourself)

- A D=4096 bundle reliably holds a few dozen constituents; days are fine, years are not —
  aggregate windows instead.
- Decode quality degrades gracefully but the codebook is the palate: garbage slugs in, garbage
  taste out.
- Day-level granularity proved sufficient for us; resist per-conversation fingerprinting until
  day-level demonstrably fails you.
- `tasteslike` is co-occurrence-based; for a 1-day-old unknown it reflects that single day's
  company. More days, better taste.
