# Methodology: how to prove this works on YOUR memory before trusting it

Tastebud was not shipped on vibes. It had to pass a sequence of kill-gates against a real
agent's memory corpus, and the same protocol applies to your data. The whole point: **your
existing history is a free backtest set**. You can validate the entire system offline before
it touches anything live.

## Phase 0: freeze the ground truth

Before writing system code:

1. **Corpus facts**: how many logged days, where they live, and the duplicates/format drift that
   will trap a tagger. Ours had compat-copies to dedupe, headless files needing date-from-filename,
   service status-line noise, and a name collision between two things sharing one nickname.
2. **Emergent-project targets**: projects that appeared in your logs BEFORE they got any
   documentation. These are the residual detector's backtest targets. In our corpus, a
   relocation workstream ran 13+ days undocumented, a client-site rebuild ran ~21 days, and
   several workstreams never got files at all.
3. **Test questions + baseline**: ~10 real questions spanning enumeration, aliasing/origin,
   co-occurrence, set-difference, absence. Run them through your existing retrieval and grade
   honestly (ours: 2 HIT / 5 PARTIAL / 1 MISS / 2 STRUCTURAL-MISS). This is the bar to beat.

Freeze this document. If the numbers change later, re-run Phase 0 rather than editing them in
place.

## Phase 1: tagging backfill, with a human/adversarial gate

Tag every historical day with a strong LLM (composition rules in `examples/nightly-prompt.md`).
**Gate**: re-derive a stratified ~30% sample blind. Read the log FIRST, write down your own
composition, THEN compare to the stored tag; anchoring-proof ordering matters. Grade MATCH /
MINOR-DIFF / MAJOR-DIFF and require ≥90% MATCH+MINOR. Fix MAJOR-DIFFs in the data, don't
footnote them.

Ours: 29/31 faithful. The two real errors found (an unsupported major and a missed co-major)
were corrected and flagged `verified-corrected`.

If tagging fails this gate, STOP. Every layer above is built on it, and the honest conclusion
is that the tagger, not the encoding, is your bottleneck.

## Phase 2: the vector layer, evaluated honestly

Build the hypervector layer and run two tests:

1. **The Phase-0 questions.** Require the structural misses to become answerable and no
   regression on what already worked.
2. **Emergent-project backtest.** Remove each Phase-0 target from the codebook, replay
   history, and require the unexplained-mass detector to flag it within ≤5 days of first major
   activity. Ours: day 0 for two targets, day 2 for one. Threshold 0.20 recommended; 0.25
   missed a small-footprint workstream.

**Pre-commit to the kill-rule**: if the plain composition table answers everything and the
vectors add nothing measurable, keep the table and drop the vectors. Our honest finding: the
table IS the workhorse for lookups. The vectors earn their keep on lossless decode, day
similarity, drift/entanglement (one project's identity measurably absorbing another's), and
fixed-size encoding for fast whole-corpus matching.

## Phase 3: going live, with provenance

- Nightly tagging via the **primary cron + deterministic sweeper** split
  (`docs/production-pattern.md`). Never let the LLM edit your composition store directly.
- Every entry carries provenance flags (`primary-cron` vs `local-fallback` vs `verified-corrected`).
- A weekly triage closes the loop on unknown ingredients: each gets a proposal (create a
  project file, add an alias, or dismiss), with a human approving codebook changes. Slug choices
  are permanent; they seed the vectors. The mature-before-asking protocol below governs *which*
  unknowns reach that weekly review.
- Schedule a retro ~2 weeks in: did the detector catch anything real? Does your agent actually
  call the tools? Are alerts signal or noise? Kill or keep on evidence.

## Triage methodology: mature before asking, decide reversibly

Detection without discipline is just a new source of noise. A residual detector that pinged you
the first time any unnamed slug appeared would train you to ignore it inside a week. Two rules
keep the unknown-ingredient loop trustworthy.

**Mature before asking.** An unknown is not worth a decision the moment it appears. Most one-offs
are exactly that: a slug the tagger minted for a single afternoon that never recurs. So an unknown
ripens *silently* until it has earned a question, by one of three independent triggers: it recurs
across enough days, it carries enough major weight, or it ages past about a week. Everything below
that bar sits in a **Maturing** bucket that is logged but never surfaced for a decision. The
thresholds (`TASTEBUD_RIPE_DAYS`, `TASTEBUD_RIPE_MASS`, `TASTEBUD_RIPE_AGE_DAYS`) are env-tunable,
but the principle is fixed: let the corpus decide what is real before you spend attention on it.
The weekly review (`unknowns --write`) acts only on ripe items; the Maturing list is FYI.

**Decide reversibly, on a persistent ledger.** Every verdict is recorded in
`<dataDir>/unknowns-ledger.json` and every one is reversible, because triage under uncertainty
will be wrong sometimes and the cost of a wrong call should be a one-line undo, not a corrupted
codebook:

- **dismiss** is "not now," not "never." It records a baseline so a dismissed one-off *revives*
  if it later grows past where you dismissed it, returning as something to watch.
- **mint** is an undoable codebook write (`mint --undo`). The codebook itself stays append-only
  (slugs seed vectors and are never renamed), but a *mistaken* add can be cleanly removed.
- **watch** defers the call and keeps the item in view without nagging.
- **alias** folds a name onto an existing project and resolves it; aliases are treated as known,
  so the unknown leaves the list.

Because the decision store is separate from the composition store, triage never risks your
ground-truth history. Snapshots (`.bak`) are written before every codebook or ledger mutation, so
even the irreversible-looking operations have a way back.

## Capacity and limits (be honest with yourself)

- A D=4096 bundle reliably holds a few dozen constituents. Days are fine, years are not;
  aggregate windows instead.
- Decode quality degrades gracefully, but the codebook is the palate: garbage slugs in, garbage
  taste out.
- Day-level granularity proved sufficient for us. Resist per-conversation fingerprinting until
  day-level demonstrably fails you.
- `tasteslike` is co-occurrence-based; for a 1-day-old unknown it reflects that single day's
  company. More days, better taste.
