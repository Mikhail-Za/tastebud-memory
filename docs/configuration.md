# Configuration reference

Everything lives in `tastebud.config.json` (looked for in the current directory first, then next
to the scripts). All relative paths in it resolve against the config file's own directory, so the
tools work no matter where you launch them from. Runtime behavior is tuned further with a handful
of `TASTEBUD_*` environment variables.

The shipped config is enough to run the quickstart as-is; every key below has a sane default.

## Config keys (`tastebud.config.json`)

| Key | Type | Default | What it does |
|-----|------|---------|--------------|
| `dataDir` | string | `"./examples"` | Directory holding `codebook.json`, `compositions.json`, `unknowns-ledger.json`, `inbox/`, `alerts.log`, and the candidate runtime artifacts `candidate-events.jsonl` and `autopromote.json`. The advisory lock `.tastebud.lock` is created beside this directory. |
| `logDirs` | string[] | `[]` | Directories the sweeper (and the candidate evidence gate) search for `<date>.md` daily logs, first-match by order. Each listed entry must be an existing directory; paths are canonicalized and deduped. |
| `dimensions` | integer (>= 64) | `4096` | Hypervector width. Fixed for a corpus: the slug string plus this number seed each vector, so changing it re-seeds everything. |
| `candidatesDir` | string | `<dataDir>/project-candidates` | Directory of `<slug>.md` candidate drafts read by `promote` / `sweep-candidates`. Validated (exists and is a directory) only when a candidate command runs. |
| `projectsDir` | string | (unset) | Directory of `<slug>.md` project files. The `promote` destination, and what `has_file` detection and the destination-free gate look at. Required for candidate commands; when unset the legacy `has_file`/`gaps` paths are simply inert. Validated lazily, like `candidatesDir`. |
| `localModel` | object or `null` | `null` | The OpenAI-compatible fallback tagger. `null` disables the fallback lane entirely (see below). |
| `notifyArgs` | string[] or `null` | `null` | **Recommended** alert/digest transport. An argv array spawned WITHOUT a shell; the `"{message}"` element is replaced with the text. |
| `notifyCommand` | string or `null` | `null` | **Legacy / deprecated** alert transport. A shell template containing `{message}`. See the security note below. |

### `dataDir`
```json
"dataDir": "./examples"
```

### `logDirs`
```json
"logDirs": ["./examples/logs", "/home/me/agent/memory/daily"]
```

### `dimensions`
```json
"dimensions": 4096
```

### `projectsDir`
```json
"projectsDir": "./examples/projects"
```

### `candidatesDir`
```json
"candidatesDir": "./examples/project-candidates"
```
Where you draft candidate files (`<slug>.md`) for the `promote` flow. Defaults to
`<dataDir>/project-candidates`. See [`../CANDIDATES.md`](../CANDIDATES.md) for the grammar and gates.

### Candidate runtime files (under `dataDir`)
- `autopromote.json` (`{version:1, enabled:boolean}`): whether the nightly `sweep-candidates --write`
  self-mints unattended-safe candidates. Written by `autopromote on|off`; a missing or malformed file
  is treated as disabled (fail-closed). Git-ignored.
- `candidate-events.jsonl`: an advisory, deduplicated audit line per candidate action
  (`created`/`rejected`/`promoted`/`promote-failed`/`undone`). Carries no log text or paths. Nothing
  depends on it for correctness. Git-ignored.
- `.tastebud.lock` (beside `dataDir`): the advisory single-writer lock every mutating command holds.
  Reaped automatically if its recorded process is gone. Git-ignored.

### `localModel`
Off by default (`null`). When enabled it must point at an **OpenAI-compatible chat-completions
endpoint** (LM Studio, llama.cpp `--api`, Ollama's `/v1`, vLLM, etc.). The sweeper only calls it
when the primary tagger left no valid inbox file. It retries up to **3 attempts** per day with a
**120-second** timeout each, so the worst case before it gives up on a day is about **6 minutes**
(3 x 120s, minus early failures). `key` is optional (sent as `Authorization: Bearer <key>`).
```json
"localModel": {
  "url": "http://localhost:1234/v1/chat/completions",
  "model": "your-local-model-id",
  "key": "optional-bearer-token"
}
```

### `notifyArgs` (recommended)
Spawned without a shell, so the multi-line digest arrives intact and no log-derived text is ever
interpreted as shell syntax.
```json
"notifyArgs": ["ntfy", "publish", "my-topic", "{message}"]
```

### `notifyCommand` (legacy, deprecated)
A shell command line with `{message}`. Two hazards, both named in `tagger.mjs`: on Windows a shell
command line silently truncates a multi-line message at the first newline (so the digest's decide
table never arrives, exit 0, no error), and because the digest text derives from your logs, any
shell metacharacters in it run through a shell. Prefer `notifyArgs`. Only `"`, `` ` ``, and `$` are
sanitized and newlines are flattened to `" | "`; that is not a substitute for the shell-less form.
```json
"notifyCommand": "curl -s -d {message} https://ntfy.sh/my-topic"
```

## Environment variables

All are optional and override the defaults below at runtime.

### Triage tuning (read by `tastebud.mjs`)

| Var | Type | Default | Meaning | Example |
|-----|------|---------|---------|---------|
| `TASTEBUD_RIPE_DAYS` | int | `2` | Distinct-days threshold at which an unknown is ripe to decide. | `TASTEBUD_RIPE_DAYS=3` |
| `TASTEBUD_RIPE_MASS` | float | `0.5` | Accumulated major-weight threshold for ripeness. | `TASTEBUD_RIPE_MASS=0.75` |
| `TASTEBUD_RIPE_AGE_DAYS` | int | `7` | Age (days since first seen) that alone makes an unknown ripe. | `TASTEBUD_RIPE_AGE_DAYS=10` |
| `TASTEBUD_OVERDUE_AGE_DAYS` | int | `14` | Age at which a ripe, still-open unknown is marked `OVERDUE`. | `TASTEBUD_OVERDUE_AGE_DAYS=21` |
| `TASTEBUD_REVIVE_DELTA_DAYS` | int | `1` | Extra days beyond the dismissal baseline that revive a dismissed unknown. | `TASTEBUD_REVIVE_DELTA_DAYS=2` |
| `TASTEBUD_UNKNOWN_AGE_DAYS` | int | `14` | Age used with the min-days gate to sort escalated unknowns first. | `TASTEBUD_UNKNOWN_AGE_DAYS=10` |
| `TASTEBUD_UNKNOWN_MIN_DAYS` | int | `3` | Min distinct days for that escalation sort. | `TASTEBUD_UNKNOWN_MIN_DAYS=2` |
| `TASTEBUD_UNKNOWN_ALIAS_HINT` | float | `0.40` | Neighbor co-occurrence score above which `alias` is the recommendation. | `TASTEBUD_UNKNOWN_ALIAS_HINT=0.5` |
| `TASTEBUD_UNKNOWN_ALIAS_MIN_DAYS` | int | `2` | Min days seen before an `alias` recommendation is offered. | `TASTEBUD_UNKNOWN_ALIAS_MIN_DAYS=3` |
| `TASTEBUD_CANDIDATE_COMPANION_MAX` | float in [0,1] | `0.30` | Candidate gate g6 ceiling: a candidate is refused if any known codebook slug is a companion at or above this share. Must parse to a finite number in [0,1]; a bad value is a fail-closed error (it never silently disables the guard). | `TASTEBUD_CANDIDATE_COMPANION_MAX=0.25` |

### Sweeper behavior (read by `tagger.mjs`)

| Var | Type | Default | Meaning | Example |
|-----|------|---------|---------|---------|
| `TASTEBUD_LOOKBACK_DAYS` | int | `10` | How many days back a dateless `nightly` sweep scans, so a late-written log is still picked up. | `TASTEBUD_LOOKBACK_DAYS=14` |
| `TASTEBUD_STALE_DAYS` | int | `2` | Age at which a still-missing daily log is reported as a no-log note (younger days stay silent). | `TASTEBUD_STALE_DAYS=3` |
| `TASTEBUD_CHECKPOINT` | `1` | (unset) | Force the weekly git data checkpoint on a write run regardless of weekday. | `TASTEBUD_CHECKPOINT=1` |
| `TASTEBUD_NO_DIGEST` | any value | (unset) | Suppress the nightly digest send (use for manual/backfill runs so a batch does not push a digest per invocation). | `TASTEBUD_NO_DIGEST=1` |
