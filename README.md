# 👅 tastebud-memory

**Compositional project fingerprints for AI agent memory.** Give every project a deterministic
high-dimensional identity vector. Every day's work becomes a weighted blend of those vectors.
One "taste" (a dot product) decomposes any day back into its exact ingredients, enumerates
every day a project ever touched, and detects ingredients **nobody has named yet**.

Zero runtime dependencies, stdlib-only Node: the query engine (`tastebud.mjs`) and the
deterministic sweeper (`tagger.mjs`) read two JSON files and nothing else. The nightly production
pattern *around* them (a scheduler, an LLM tagging lane, and a notify hook) is bring-your-own,
wired in [`docs/production-pattern.md`](docs/production-pattern.md).

_Current as of 2026-07-12._

## What it looks like

Sample outputs below are pinned to a reference date of **2026-07-12** running against the shipped
example data. The `open Nd` age in the triage output advances with the calendar, so it is left out
of the samples here; everything else is stable.

```console
$ node tastebud.mjs decode 2026-01-12        # un-mix one day from its 4096-dim vector alone
2026-01-12 - Dosing pump driver; recipe-site deploy; soil sensors moved to bed 2
recovered from vector alone (vs actual):
  aquarium-controller          est=0.502  actual=0.500
  recipe-site                  est=0.296  actual=0.300
  garden-sensors               est=0.191  actual=0.200
  minors (table): home-lab

$ node tastebud.mjs gaps                     # what's been worked on but never documented?
workstreams in logs with NO project file:
  aquarium-controller            4 day(s)  mass=2.150  first=2026-01-10
  home-lab                       3 day(s)  mass=1.550  first=2026-01-05
  sourdough-lab                  2 day(s)  mass=0.900  first=2026-01-15  [NOT EVEN IN CODEBOOK]
  garden-sensors                 1 day(s)  mass=0.200  first=2026-01-12

$ node tastebud.mjs tasteslike sourdough-lab # the unknown ingredient: what is it close to?
sourdough-lab  [UNKNOWN INGREDIENT - not in codebook]
keeps company with (rarity-weighted co-occurrence):
  recipe-site                  0.463
  aquarium-controller          0.201
  novel-draft                  0.173
tastes like (similar taste-profiles among known ingredients):
  budget-tracker               cos=0.903
  garden-sensors               cos=0.804
  aquarium-controller          cos=0.356
  job-search                   cos=0.337
  home-lab                     cos=0.139

$ node tastebud.mjs unknowns                 # triage: which unknowns are RIPE to decide on?
unknowns: 1 total  (decide 1, maturing 0)
  sourdough-lab                2 day(s)  mass=0.900  [OVERDUE  ]  -> alias->recipe-site
```

Those last two are the headline feature. `sourdough-lab` doesn't exist anywhere as a project:
the nightly tagger *invented* the slug because nothing in the codebook fit, and the system
flagged it and placed it next to its nearest relative. Your agent notices new workstreams
forming **before you've named them** and then helps you decide what to do about each one. The
`-> alias->recipe-site` is a *recommendation*, not a decision: `sourdough-lab` keeps company
almost entirely with `recipe-site`, so the system reads it as the same work and suggests folding
it in. You stay in charge: you could mint it as its own project instead, dismiss it, or wait.

## The pipeline

```
daily log (markdown)
     │  nightly LLM tagger (rules + your codebook; invents slugs when nothing fits)
     ▼
composition row   {"date":"2026-01-12","major":[{"slug":"aquarium-controller","w":0.5},...]}
     │  deterministic: slug string → seeded ±1 hypervector, day = weighted sum
     ▼
fingerprint (4096-dim)
     │
     ├─ decode / where / first / cooccur / window / diff / gaps   (exact membership queries)
     ├─ similar / drift / tasteslike / backtest                   (vector-layer extras)
     ├─ unknowns / mint / alias / dismiss / watch / autofile      (ripen-then-decide triage loop)
     └─ MCP server → your agent tastes before it reads
```

## The idea (and where it came from)

This started as a question about hexadecimal colors: *what if every project had a unique color,
and a day's work blended them into a new color you could un-mix?* The problem is that color
can't do that. Three channels can't carry the membership of 50 projects, which is why mixed
paint can't be un-mixed.

The metaphor that actually works is a **chef's palate**. A trained chef tastes an unfamiliar
dish and names every ingredient in it, estimates the proportions, and (the key move) notices
when there's *something in the dish he doesn't recognize*. That's what this does, with
~30-year-old math: [hyperdimensional computing](https://link.springer.com/article/10.1007/s12559-009-9009-8)
(Kanerva) / vector symbolic architectures.

- Each project slug deterministically seeds a **4,096-dimension ±1 vector**. Random
  high-dimensional vectors are nearly orthogonal, so they don't interfere.
- A day's fingerprint is the **weighted sum** of its projects' vectors.
- **Decoding** is a dot product against the codebook: projects in the blend score close to
  their weight, and absent projects score close to zero. Mixing is reversible, the thing color
  couldn't do.
- **The residual**, the mass the codebook can't explain, is the unknown ingredient detector.
  When your agent starts working on something that has no name yet, this notices *before you do*.

## Why bother? (what semantic search can't do)

We baselined an agent's real memory (92 days, ~400 files) with embedding search before building
this. Semantic search was good at date lookups and well-named topics, and structurally
incapable of:

- **Enumeration**: "list ALL days that touched project X" (search returns representatives, never
  the complete set)
- **Origin under aliasing**: "when did X start, including under its old name?" (recency and
  volume bury the origin; this was a total miss in our baseline)
- **Temporal set-difference**: "active in March, dead by June"
- **Absence**: "which workstreams never got documentation?" (you can't embed a negation)

One concrete failure from that baseline, because it's instructive. A business project had been
renamed early in its life, and we asked search *"when did this start, including under its
earlier name?"* with three increasingly charitable query phrasings. Every one returned the
later, high-volume era of the project; the actual origin date and rename event never surfaced,
because similarity ranking structurally favors where the *bulk* of the writing is, and origins
are by definition thin. `tastebud.mjs first <slug>` answers it exactly, because the codebook
records the alias and the composition table records the date. Absence queries fail even worse:
asked "which workstreams never got a project file," embedding search matched the literal phrase
"project file" to documentation *about the memory system itself*. It cannot reason about what
isn't there.

Fingerprints answer all four exactly, in milliseconds, because composition is *recorded*, not
inferred. Tastebud **complements** semantic search (meaning); it doesn't replace it (membership).

## The unknown-ingredient loop (detect, ripen, decide, reverse)

Detecting an unnamed workstream is only half the job. The other half is deciding what it *is*,
without being nagged about every fleeting one-off and without making a single irreversible
mistake. Tastebud closes that loop with a full triage + reversible-decision system. The chef
keeps tasting; you only get asked once a dish is worth a verdict.

**Detection is continuous but silent.** Every night the sweeper notices new unknown slugs and
logs them. No pings. A brand-new slug seen once is not a reason to interrupt you.

**Mature before asking.** An unknown is *not* surfaced for a decision until it ripens: it has to
recur across days, accumulate real major weight, or age past about a week. Thin one-offs sit
quietly in a **Maturing** bucket and never nag. A workstream that shows up for one afternoon and
vanishes was noise; a workstream that keeps coming back has earned a question. All the thresholds
are env-tunable (`TASTEBUD_RIPE_DAYS`, `TASTEBUD_RIPE_MASS`, `TASTEBUD_RIPE_AGE_DAYS`, and more).

**Auto-file the obvious.** If an unknown already has a project file on disk (config `projectsDir`),
the nightly sweeper files it into the codebook automatically. A file means a human already judged
it a real project, so there is nothing to ask. Logged, not pinged.

> Trust boundary, stated plainly: this reference implementation treats *file existence* as the
> proxy for human judgment, so a stray or machine-created `<slug>.md` will auto-mint. That is fine
> for a single-user setup where you control the project directory. If files can appear without a
> human decision, prefer a review-gated flow: keep proposals in a separate candidates directory and
> require an explicit `promote` step (re-validating the evidence) before anything enters the
> permanent codebook. Slugs are permanent, so an accidental mint is only reversible via `--undo`.

**Weekly digest decides only ripe items.** Once a week a review surfaces *only* the ripe unknowns,
each with a recommendation (**mint** / **alias** / **dismiss** / **watch**) plus the context behind
it, pushed through your config notify hook. Everything still maturing stays out of your way.

**Every decision is walkable-back.** Triage state lives in a persistent ledger
(`<dataDir>/unknowns-ledger.json`), separate from your composition history, so a wrong call never
corrupts ground truth:

- **dismiss** means "not now," not "never." A dismissed one-off *revives* if it starts growing
  again, and comes back recommended as something to watch.
- **mint** writes the slug into the codebook, and is undoable with `mint --undo` (undo only removes
  a slug this tool minted, so it can never delete a founding or hand-added project).
- **watch** parks it on a watchlist: out of the decide queue, still in view. A watched item can
  later be minted, aliased, or dismissed.
- **alias** folds a name into an existing project and resolves it. The engine treats codebook
  aliases as known, so the unknown leaves the list until you remove the alias. Undoing an alias is
  a manual codebook edit today, not a one-command reverse.

```console
$ node tastebud.mjs unknowns                 # what is ripe to decide on right now?
unknowns: 1 total  (decide 1, maturing 0)
  sourdough-lab                2 day(s)  mass=0.900  [OVERDUE  ]  -> alias->recipe-site

$ node tastebud.mjs alias sourdough-lab recipe-site   # fold it in; it now resolves
$ node tastebud.mjs watch sourdough-lab "keep an eye on it"   # or defer the call
$ node tastebud.mjs mint sourdough-lab --class product        # or make it its own project
$ node tastebud.mjs mint sourdough-lab --undo                 # changed your mind: undo it
```

The recommendation is a hint, never a decision. Here `sourdough-lab` co-occurs almost entirely
with `recipe-site`, so the system suggests aliasing it; a human who knows it is a distinct effort
can mint it instead. The point of the loop is that you make the call, late enough to be sure, and
can always take it back.

## Quickstart (60 seconds)

**Prerequisites:** Node 18+ (uses ESM and global fetch); Git - or download the ZIP. Nothing else
to install. Every config key and environment variable is documented in
[`docs/configuration.md`](docs/configuration.md); the shipped config runs this quickstart as-is.

With Git:

```bash
git clone https://github.com/Mikhail-Za/tastebud-memory && cd tastebud-memory
node tastebud.mjs check                      # validate the sample data
node tastebud.mjs decode 2026-01-12          # un-mix one day from its vector alone
node tastebud.mjs where aquarium-controller  # every day that project ever touched
node tastebud.mjs gaps                       # workstreams with no documentation
node tastebud.mjs tasteslike sourdough-lab   # an UNKNOWN ingredient: what is it close to?
node tastebud.mjs backtest aquarium-controller  # would the detector have caught this project emerging?
node tastebud.mjs unknowns                   # the triage queue: which unknowns are ripe to decide?
node tastebud.mjs color 2026-01-12           # the original metaphor, as garnish
```

No Git? Download and extract the ZIP, then run the same commands:

```bash
# any OS with curl + unzip:
curl -L -o tastebud-memory.zip https://github.com/Mikhail-Za/tastebud-memory/archive/refs/heads/main.zip
unzip tastebud-memory.zip && cd tastebud-memory-main
node tastebud.mjs check                      # then the rest of the commands above, verbatim
```

On Windows without curl/unzip, download
<https://github.com/Mikhail-Za/tastebud-memory/archive/refs/heads/main.zip> in a browser,
right-click - Extract All, then `cd` into `tastebud-memory-main` and run the same commands.

The unknown-ingredient loop adds its own small command set (all reversible, all snapshot before
they write):

```bash
node tastebud.mjs unknowns --write           # write unknowns-report.md (Decide / Watching / Maturing)
node tastebud.mjs alias sourdough-lab recipe-site   # fold a name into a project; it now resolves
node tastebud.mjs mint sourdough-lab --class product  # promote an unknown to its own codebook slug
node tastebud.mjs mint sourdough-lab --undo  # reverse a mint
node tastebud.mjs dismiss sourdough-lab "one-off"   # "not now"; revives if it grows again
node tastebud.mjs watch sourdough-lab        # park on the watchlist, out of the decide queue
node tastebud.mjs decisions                  # the persistent decision ledger, grouped by status
node tastebud.mjs digest                     # the daily report: ripe decide queue + recent decisions (push via your notify hook)
node tastebud.mjs autofile                   # dry-run filing unknowns that already have a project file
```

The sample data is a fictional fortnight that includes an emerging project and an unknown
ingredient, so every command above demonstrates something real.

## Using it on your own memory

1. **Codebook**: list your projects in `codebook.json` (slug + aliases + `has_file`). Slugs are
   permanent (they seed the vectors); add aliases instead of renaming.
2. **Backfill**: have a strong LLM read each daily log and emit `{major:[{slug,w}], minor:[], new:[]}`
   per day (rules in `examples/nightly-prompt.md`). Verify a sample before trusting it. See
   `docs/methodology.md` for the gate/backtest protocol we used.
3. **Nightly**: schedule your platform's LLM to tag yesterday into `inbox/<date>.json`
   (prompt template provided), and run `node tagger.mjs nightly --write` an hour later as the
   deterministic sweeper. The local-model fallback is **off by default** (`localModel: null`): if
   the primary fails and no local model is configured, the day is left untagged with a one-line
   note. Set `localModel` (see [`docs/configuration.md`](docs/configuration.md)) to an
   OpenAI-compatible endpoint to enable the fallback lane, and you get an alert with the reason
   whenever it fires. For alerts and digests, prefer `notifyArgs` in config (an argv array with a
   `{message}` element, spawned without a shell) over the legacy `notifyCommand` shell template.
   Both can point at Slack, ntfy, a webhook, anything.
   The same nightly pass logs new unknown slugs silently and auto-files any that already have a
   project file (config `projectsDir`); it does not interrupt you for either.
4. **Weekly decision loop**: once a week run `node tastebud.mjs unknowns --write` and review only
   the ripe unknowns, each with a recommendation. Decide with `mint` / `alias` / `dismiss` /
   `watch`; every call is reversible and snapshots before it writes. See
   [`docs/production-pattern.md`](docs/production-pattern.md) for the wiring.
5. **Agent integration**: register `mcp-server/server.mjs` (standard MCP, stdio) so your agent
   can *taste before reading*: decode a day in milliseconds, then fetch only the logs that matter.

## A note on the notify hook (it runs a command you configure)

The alert/digest transport executes a command *you* put in the config, and the text it carries
(the digest, alert lines) is **derived from your own logs**. So be deliberate about which form you
use:

- **`notifyArgs` (recommended).** An argv array spawned WITHOUT a shell; the `"{message}"` element
  is replaced with the message as a single argument. No shell means no metacharacter interpretation
  and the multi-line digest arrives intact. This is the only recommended form.
- **`notifyCommand` (legacy, deprecated).** A shell command line with `{message}`. It has two named
  hazards: on Windows a shell command line silently truncates a multi-line message at the first
  newline (exit 0, no error, so the digest's decide table just vanishes), and because the message
  is log-derived text spliced into a shell command line, shell metacharacters in it run through a
  shell. Only `"`, `` ` ``, and `$` are stripped and newlines flattened to `" | "` - a mitigation,
  not a guarantee. Kept only for existing setups; use `notifyArgs` instead.

Nothing runs unless you set one of these (both default to `null`). Full details and examples are in
[`docs/configuration.md`](docs/configuration.md).

## What this is not

- **Not a summarizer.** A fingerprint is an index, not the content. The chef recovers the
  ingredient list, not the recipe steps. Taste, identify, then fetch.
- **Not magic capacity.** A bundle reliably holds a few dozen constituents at D=4096. Plenty
  for a day, wrong for a year; aggregate windows instead.
- **Not a replacement for the codebook.** Decoding requires reference vectors, like a palate
  requires training. Unknown ingredients are detected as *unexplained mass*, then triaged.

## Honest engineering notes

The full methodology, including the kill-gates this project had to pass before going live,
is in [`docs/methodology.md`](docs/methodology.md). Highlights: an adversarial verification pass
re-derived 31 of 92 days blind and found 2 real tagging errors (93.5% faithful); backtests
flagged emerging projects within 0-2 days; and our honest finding that **the composition table
does most of the query work**. The vector layer earns its keep on decode, drift, similarity, and
fixed-size encoding, not on basic lookups. Production wiring (primary LLM cron + deterministic
sweeper + alerted local fallback) is in [`docs/production-pattern.md`](docs/production-pattern.md).

## License

MIT. Built by Mikhail Zaidi with Claude (Anthropic), June 2026.
