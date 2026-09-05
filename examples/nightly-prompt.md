# Nightly tagging prompt - template for your PRIMARY scheduled LLM

Give this (adapted to your paths) to whatever your agent platform runs on a schedule. The job
writes ONE small file; the deterministic sweeper (tagger.mjs) ingests it later. Keeping the LLM's
write surface tiny is what makes this reliable night after night.

---

Your ONLY task: produce a project-composition tag for YESTERDAY's daily log and write it to one file.

1. Determine yesterday's date in <your timezone> as `YYYY-MM-DD`.
2. If `<dataDir>/inbox/<date>.json` already exists, reply "already done" and stop.
3. Read the slug list: `<dataDir>/codebook.json` - keys of `projects` are canonical slugs; `aliases` map alternative names to each slug.
4. Read yesterday's log: `<logDir>/<date>.md`. If it does not exist, reply "no log for <date>" and stop.
5. Tag the day by these rules:
   - MAJOR = substantive work (a section or several meaty bullets); MINOR = passing reference or status line.
   - Major weights sum to 1.0, proportional to share of the day's substantive content.
   - Routine status lines = minor at most - unless they are the day's ONLY content, in which case that routine item is the sole major with w=1.0.
   - If one project's tooling is merely USED in service of another project, the subject project gets the major credit.
   - If a workstream matches NO slug exactly, invent a new kebab-case slug and list it under `new`. NEVER force-fit a similar-sounding slug.
   - `oneline` = ONE factual summary of the day, max 70 characters, plain ASCII, dominant workstream first, fragments separated by semicolons. This is what makes `decode`/`where`/`similar` output readable, so do not skip it.
6. Write EXACTLY one new file - `<dataDir>/inbox/<date>.json` - containing only this JSON:
   `{"date":"<date>","major":[{"slug":"x","w":0.6},{"slug":"y","w":0.4}],"minor":["z"],"new":[],"oneline":"<the one-line day summary>"}`
7. Do NOT modify compositions.json, the logs, or any other file.
8. Reply with one line: the date and the major slugs you assigned.

Source revision check: compute the SHA256 of the source log with the shared `scripts/source-hash.mjs` helper before drafting, and include its `source_hash` in the proposal. The ingester rejects a proposal if that revision has changed. Keep all weights numeric and positive; their sum must be within 0.005 of 1.0.
