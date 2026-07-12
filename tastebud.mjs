#!/usr/bin/env node
// Tastebud - compositional project fingerprints for agent memory.
// Give every project a deterministic high-dimensional identity vector; every day's work is a
// weighted blend of those vectors. One "taste" (a dot product) decomposes any day back into its
// ingredients - including detecting ingredients nobody has named yet.
//
// Usage: node tastebud.mjs <command> [args]
//   check                          validate data integrity
//   decode <date>                  rebuild a day's composition from its hypervector alone
//   where <slug>                   all days containing a project (major w / minor)
//   first <slug>                   first/last appearance, day count
//   cooccur <a> <b>                days where both projects are major
//   window <from> <to>             aggregate composition over a date range
//   diff <a1> <a2> <b1> <b2>       compare two windows: gone / new / shifted
//   gaps                           workstreams seen in logs but never given a project file
//   backtest <slug> [thr]          simulate a project being unknown; when would it be flagged?
//   drift <slug> [halflife]        EMA identity vector + entanglement with other projects
//   similar <date>                 nearest days by fingerprint cosine
//   tasteslike <slug>              nearest known relatives of an (unknown) ingredient
//   unknowns [--write]             open unknown ingredients for triage (writes a report with --write)
//   mint <slug> [opts]             safe codebook write (--class --parent --alias --undo --no-report)
//   alias <name> <target>          resolve an unknown by aliasing it onto an existing codebook slug
//   dismiss <slug> [note]          dismiss an unknown as a one-off (revives if seen meaningfully more)
//   watch <slug> [note]            park an unknown on the watchlist (decision ledger)
//   decisions                      print the persistent decision ledger grouped by status
//   autofile [--write]             auto-file the safe class of unknowns (has project file + seen as major)
//   color <date|slug>              hex color garnish (the metaphor this project started with)
//   digest                         plain-text status digest to stdout (Decide queue + pulse)
//
// Config: tastebud.config.json in the current directory or next to this script.
// Optional config keys used here: projectsDir (dir of <slug>.md project files) for autofile/has_file.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig, loadData } from './validate.mjs';

// Runtime floor: this engine uses ESM + global fetch (Node 18+). Fail fast with one line
// rather than a confusing "fetch is not defined" deeper in.
const NODE_MAJOR = parseInt(process.versions.node, 10);
if (NODE_MAJOR < 18) {
  console.error(`tastebud requires Node 18+ (uses ESM and global fetch); you have ${process.versions.node}.`);
  process.exit(1);
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const config = loadConfig(SCRIPT_DIR);
validateConfig(config, config._configDir);
const DATA = resolve(config._configDir, config.dataDir ?? './examples');
const D = config.dimensions ?? 4096;

// ---------- deterministic ±1 hypervectors ----------
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const vecCache = new Map();
function vec(slug) {
  if (vecCache.has(slug)) return vecCache.get(slug);
  const rng = mulberry32(fnv1a(slug));
  const v = new Int8Array(D);
  for (let i = 0; i < D; i++) v[i] = rng() < 0.5 ? -1 : 1;
  vecCache.set(slug, v);
  return v;
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < D; i++) s += a[i] * b[i]; return s; };
const norm = a => Math.sqrt(dot(a, a));

// ---------- data ----------
const { codebook, comps } = loadData(DATA);
const KNOWN = new Set(Object.keys(codebook.projects));

// normalize at load: dedupe minors that are also major, renormalize weights to 1.0
const days = comps.days.map(d => {
  const majSlugs = new Set(d.major.map(m => m.slug));
  const minor = [...new Set((d.minor ?? []).filter(s => !majSlugs.has(s)))];
  const total = d.major.reduce((s, m) => s + m.w, 0);
  const major = total > 0 ? d.major.map(m => ({ slug: m.slug, w: m.w / total })) : [];
  return { ...d, major, minor };
}).sort((a, b) => a.date.localeCompare(b.date));

function bundle(day, excluded = new Set()) {
  const b = new Float64Array(D);
  for (const { slug, w } of day.major) {
    if (excluded.has(slug)) continue;
    const v = vec(slug);
    for (let i = 0; i < D; i++) b[i] += w * v[i];
  }
  return b;
}
const estW = (b, slug) => dot(b, vec(slug)) / D;

function decodeBundle(b, candidates, minW = 0.04) {
  return candidates
    .map(slug => ({ slug, est: estW(b, slug) }))
    .filter(r => r.est >= minW)
    .sort((x, y) => y.est - x.est);
}
const allSlugsEver = [...new Set([...KNOWN, ...days.flatMap(d => d.major.map(m => m.slug))])];

const fmt = n => n.toFixed(3);
const byDate = Object.fromEntries(days.map(d => [d.date, d]));

// provenance marker for a day's tag: surface the writer trust tier so a reader can tell a
// supervised tag from an unattended cron or a degraded local-model fallback. Source lives
// in the compositions `flags` array (written by tagger.mjs).
function provTag(d) {
  const f = Array.isArray(d.flags) ? d.flags : [];
  if (!f.length) return '';
  const src = f.find(x => x !== 'nightly') || f.join(',');
  const mark = /oauth|cron/.test(src) ? '~cron'
             : /local|fallback/.test(src) ? '!local'
             : '*supervised';
  return `  [${mark}: ${src}]`;
}

// every alias across the codebook. `alias`-ing a slug truly resolves its unknown (it joins
// ALIASED) without mutating KNOWN, which other commands key on for codebook membership.
const ALIASED = new Set();
for (const p of Object.values(codebook.projects)) for (const a of (p.aliases || [])) ALIASED.add(a);

// ---------- taste-profile (shared by tasteslike + unknowns) ----------
// A slug's flavor comes from CONTEXT: the company it keeps (co-occurring major work, weighted
// by both shares and rarity). Rarity weighting (inverse day-frequency) down-weights ubiquitous
// companions (e.g. a daily monitor or ops chore) that say little about identity.
const df = new Map();
for (const d of days) for (const m of d.major) df.set(m.slug, (df.get(m.slug) ?? 0) + 1);
const activeDays = days.filter(d => d.major.length).length;
const idf = s => Math.log(1 + activeDays / (df.get(s) ?? 1));
function tasteProfile(slug) {
  const companions = new Map();
  let activity = 0;
  for (const d of days) {
    const m = d.major.find(x => x.slug === slug);
    if (!m) continue;
    activity += m.w;
    for (const o of d.major) if (o.slug !== slug)
      companions.set(o.slug, (companions.get(o.slug) ?? 0) + m.w * o.w * idf(o.slug));
  }
  const p = new Float64Array(D);
  for (const [cs, cw] of companions) { const v = vec(cs); for (let i = 0; i < D; i++) p[i] += cw * v[i]; }
  return { p, activity, companions };
}

// ---------- decision ledger (persistent triage memory; round-trips, snapshots before write) ----------
const LEDGER_PATH = join(DATA, 'unknowns-ledger.json');
const today = () => new Date().toISOString().slice(0, 10);  // UTC YYYY-MM-DD
function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return { version: 1, entries: {} };
  return JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
}
function saveLedger(led) {
  if (existsSync(LEDGER_PATH)) copyFileSync(LEDGER_PATH, LEDGER_PATH + '.bak');
  writeFileSync(LEDGER_PATH, JSON.stringify(led, null, 2), 'utf8');
}
function setLedger(slug, patch) {
  const led = loadLedger();
  led.entries[slug] = { ...(led.entries[slug] || {}), ...patch };
  saveLedger(led);
  return led;
}
// decided_on for a ledger slug (for report annotations); '?' if absent.
function led_decided_on(slug) {
  const e = loadLedger().entries[slug];
  return e?.decided_on ?? '?';
}

// optional project-file lookup: only meaningful when config.projectsDir is set; otherwise no
// project files exist (so autofile files nothing and gaps-by-file is inert).
const projectFileExists = slug =>
  config.projectsDir ? existsSync(join(resolve(config._configDir, config.projectsDir), slug + '.md')) : false;

// ---------- open-unknown rows (shared by `unknowns`, report writer, `autofile`) ----------
// open unknown = slug seen anywhere (major / minor / new) that is NOT a codebook key AND NOT an alias.
function computeUnknownRows() {
  const AGE = parseInt(process.env.TASTEBUD_UNKNOWN_AGE_DAYS ?? '14', 10);        // ESCALATE_AGE_DAYS
  const MIN = parseInt(process.env.TASTEBUD_UNKNOWN_MIN_DAYS ?? '3', 10);         // ESCALATE_MIN_DAYS
  const ALIAS_HINT = parseFloat(process.env.TASTEBUD_UNKNOWN_ALIAS_HINT ?? '0.40');
  const ALIAS_MIN_DAYS = parseInt(process.env.TASTEBUD_UNKNOWN_ALIAS_MIN_DAYS ?? '2', 10);
  // maturity gate: an unknown is "ripe" (worth asking about) only once it has been seen enough,
  // carried enough major mass, or aged enough. Until then it ripens silently (Maturing, FYI only).
  const RIPE_DAYS = parseInt(process.env.TASTEBUD_RIPE_DAYS ?? '2', 10);
  const RIPE_MASS = parseFloat(process.env.TASTEBUD_RIPE_MASS ?? '0.5');
  const RIPE_AGE = parseInt(process.env.TASTEBUD_RIPE_AGE_DAYS ?? '7', 10);
  const OVERDUE_AGE = parseInt(process.env.TASTEBUD_OVERDUE_AGE_DAYS ?? '14', 10);
  const REVIVE_DELTA = parseInt(process.env.TASTEBUD_REVIVE_DELTA_DAYS ?? '1', 10);
  const now = new Date();
  const todayUTC = Date.parse(now.toISOString().slice(0, 10) + 'T00:00:00Z');
  const ageDays = from => Math.round((todayUTC - Date.parse(from + 'T00:00:00Z')) / 86400000);
  const led = loadLedger();

  // gather every slug mention across major / minor / new, with its date and major weight
  const seen = new Map(); // slug -> { dates:Set, firstSeen, lastSeen, majorMass }
  const note = (slug, date, w) => {
    let e = seen.get(slug);
    if (!e) { e = { dates: new Set(), firstSeen: date, lastSeen: date, majorMass: 0 }; seen.set(slug, e); }
    e.dates.add(date);
    if (date < e.firstSeen) e.firstSeen = date;
    if (date > e.lastSeen) e.lastSeen = date;
    e.majorMass += w;
  };
  for (const d of days) {
    for (const m of d.major) note(m.slug, d.date, m.w);
    for (const s of d.minor) note(s, d.date, 0);
    for (const s of (d.new || [])) note(s, d.date, 0);
  }

  return [...seen.entries()]
    // resolved = a codebook key OR an alias of one; both drop off the unknown list.
    .filter(([slug]) => !KNOWN.has(slug) && !ALIASED.has(slug))
    .map(([slug, e]) => {
      const days_seen = e.dates.size;
      const age = ageDays(e.firstSeen);
      const escalated = age >= AGE && days_seen >= MIN;
      // maturity: ripens silently until it has been seen / massed / aged enough to be worth asking.
      const maturing = days_seen < RIPE_DAYS && e.majorMass < RIPE_MASS && age < RIPE_AGE;
      const ripe = !maturing;
      const overdue = ripe && age >= OVERDUE_AGE;
      // neighbors: top-3 rarity-weighted co-occurrence companions (reuse tasteslike logic)
      const { activity, companions } = tasteProfile(slug);
      const neighbors = [...companions.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([s, w]) => ({ slug: s, score: activity > 0 ? w / activity : 0 }));
      const top = neighbors[0];
      // ledger-backed decision state and "back from the dead" revival.
      const entry = led.entries[slug];
      const status = entry?.status ?? 'open';
      const revived = status === 'dismissed' && days_seen >= ((entry?.baseline_days ?? 0) + REVIVE_DELTA);
      // recommendation: confident alias if a strong, settled neighbor exists; else mint once ripe; else dismiss.
      let recommend, recommendTarget = null, reason;
      if (top && top.score >= ALIAS_HINT && days_seen >= ALIAS_MIN_DAYS) {
        recommend = 'alias'; recommendTarget = top.slug;
        reason = `keeps company almost entirely with ${top.slug} (${fmt(top.score)}); reads as the same work`;
      } else if (days_seen >= 2 && (days_seen >= RIPE_DAYS || e.majorMass >= RIPE_MASS)) {
        recommend = 'mint';
        reason = top
          ? `recurring with real mass; closest neighbor ${top.slug} (${fmt(top.score)}) is not close enough to alias`
          : 'recurring with real mass and no co-occurring companions; looks like its own workstream';
      } else if (days_seen === 1 && e.majorMass >= RIPE_MASS) {
        // One heavy day is not enough evidence for a permanent slug: a sole-major single day
        // is often a routine spike. Never recommend MINT off one day regardless of mass.
        recommend = 'watch';
        reason = `sole evidence is one heavy day (mass ${fmt(e.majorMass)}); could be a routine spike, watch for recurrence before minting`;
      } else {
        recommend = 'dismiss';
        reason = top
          ? `thin so far (${days_seen} day(s), mass ${fmt(e.majorMass)}); closest is ${top.slug} (${fmt(top.score)}) but too early to commit`
          : `thin so far (${days_seen} day(s), mass ${fmt(e.majorMass)}) and no companions; likely a one-off`;
      }
      if (revived && recommend === 'dismiss') {
        recommend = 'watch';
        reason = `active again after you dismissed it on ${entry.decided_on}; still thin (${days_seen} day(s), mass ${fmt(e.majorMass)}) but worth keeping an eye on`;
      }
      const suggestion = recommend === 'alias' ? `likely alias of ${recommendTarget}`
        : recommend === 'mint' ? 'looks mintable' : 'thin; dismiss or wait';
      return { slug, firstSeen: e.firstSeen, lastSeen: e.lastSeen, age, days_seen,
               major_mass: e.majorMass, escalated, neighbors, suggestion,
               status, maturing, ripe, overdue, revived, recommend, recommendTarget, reason };
    })
    .sort((a, b) =>
      (b.escalated - a.escalated) ||
      (b.major_mass - a.major_mass) ||
      (b.days_seen - a.days_seen) ||
      a.slug.localeCompare(b.slug));
}

// triage-ready markdown report (regenerated by `unknowns --write`, decision commands, `autofile`).
// Mature-before-asking: only ripe (and revived) rows reach Decide; the rest ripen quietly.
function writeUnknownsReport(rows = computeUnknownRows()) {
  const ymd = today();
  const nb = r => r.neighbors.length
    ? r.neighbors.map(n => `${n.slug} (${fmt(n.score)})`).join(', ')
    : '(none)';
  const verdict = r => r.recommend === 'mint' ? 'MINT'
    : r.recommend === 'alias' ? `ALIAS onto ${r.recommendTarget}`
    : r.recommend === 'watch' ? 'WATCH'
    : 'DISMISS';

  const decide = rows
    .filter(r => (r.status === 'open' && r.ripe) || r.revived)
    .sort((a, b) => (b.overdue - a.overdue) || (b.major_mass - a.major_mass) || a.slug.localeCompare(b.slug));
  const watching = rows.filter(r => r.status === 'watching');
  const maturing = rows.filter(r => r.status === 'open' && r.maturing);
  const dismissed = rows.filter(r => r.status === 'dismissed' && !r.revived).length;

  const out = [];
  out.push(`# Tastebud unknown-ingredient report (generated ${ymd})`);
  out.push('');
  out.push(`decide: ${decide.length} / watching: ${watching.length} / maturing: ${maturing.length} / dismissed: ${dismissed}`);
  out.push('');

  out.push('## Decide');
  out.push('');
  if (!decide.length) { out.push('(nothing ripe to decide right now.)'); out.push(''); }
  for (const r of decide) {
    out.push(`### ${r.slug}  [${r.overdue ? 'OVERDUE ' : ''}open ${r.age}d, ${r.days_seen} day(s), mass ${fmt(r.major_mass)}]`);
    out.push(`- keeps company with: ${nb(r)}`);
    out.push(`- recommend: **${verdict(r)}**: ${r.reason}`);
    if (r.revived) out.push(`- NOTE: you dismissed this on ${led_decided_on(r.slug)}, but it is active again`);
    out.push('');
  }

  if (watching.length) {
    out.push('## Watching');
    out.push('');
    for (const r of watching) out.push(`- ${r.slug} (watching since ${led_decided_on(r.slug)}): now ${r.days_seen} day(s), mass ${fmt(r.major_mass)}`);
    out.push('');
  }

  if (maturing.length) {
    out.push('## Maturing');
    out.push('');
    for (const r of maturing) out.push(`- ${r.slug} (${r.days_seen}d, mass ${fmt(r.major_mass)}, first seen ${r.firstSeen})`);
    out.push('');
  }

  const path = join(DATA, 'unknowns-report.md');
  writeFileSync(path, out.join('\n'), 'utf8');
  return path;
}

// ---------- codebook serializer (preserve one-entry-per-line scannable style; round-trips) ----------
// One project per line, column-aligned keys, with the existing in-entry spacing ({ "k": v, ... }).
// Valid JSON that round-trips; whitespace mirrors the hand-authored original for a minimal diff.
// Built structurally (each value JSON.stringify'd independently) so string contents never leak
// into the formatting: no regex-on-JSON that could misfire on a quote/comma inside an alias.
function jval(v) {
  // JSON value with a ", " separator between array elements (still valid JSON).
  return Array.isArray(v) ? `[${v.map(x => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v);
}
function spaced(entry) {
  const inner = Object.keys(entry)
    .map(k => `${JSON.stringify(k)}: ${jval(entry[k])}`)
    .join(', ');
  return inner ? `{ ${inner} }` : '{}';
}
function serializeCodebook(cb) {
  const keys = Object.keys(cb.projects);
  const labelLen = keys.reduce((m, k) => Math.max(m, JSON.stringify(k).length + 1), 0); // "key":
  const lines = ['{'];
  for (const k of Object.keys(cb)) {
    if (k === 'projects') continue;
    lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(cb[k])},`);
  }
  lines.push('  "projects": {');
  keys.forEach((k, i) => {
    const label = (JSON.stringify(k) + ':').padEnd(labelLen);
    lines.push(`    ${label} ${spaced(cb.projects[k])}${i < keys.length - 1 ? ',' : ''}`);
  });
  lines.push('  }', '}');
  return lines.join('\n') + '\n';
}

// ---------- mint core (shared by `mint` command and `autofile --write`) ----------
const MINT_CLASSES = ['product', 'business', 'ops', 'research', 'content', 'personal', 'meta'];
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CODEBOOK_PATH = join(DATA, 'codebook.json');
// returns { ok:true, ...info } on success, or { ok:false, error } refusing (writes nothing).
function mintSlug({ slug, parent = null, aliases = [], klass = 'product', undo = false }) {
  if (!SLUG_RE.test(slug)) return { ok: false, error: `bad slug "${slug}": must be kebab-case (^[a-z0-9]+(-[a-z0-9]+)*$)` };
  if (undo) {
    if (!KNOWN.has(slug)) return { ok: false, error: `nothing to undo: "${slug}" is not a codebook key` };
    // Only slugs THIS tool minted may be undone. A founding/hand-added slug has no "minted"
    // ledger status, so undo refuses it and can never delete a project you added by hand.
    const st = loadLedger().entries[slug]?.status;
    if (st !== 'minted') return { ok: false, error: `refusing to undo "${slug}": ledger status is "${st ?? 'none'}", not "minted" (undo only removes tool-minted slugs; founding/hand-added slugs are protected)` };
  } else {
    if (KNOWN.has(slug)) return { ok: false, error: `"${slug}" already exists in the codebook (renames are never done; add an alias instead)` };
    if (parent !== null && !KNOWN.has(parent)) return { ok: false, error: `bad parent "${parent}": not an existing codebook key` };
    if (!MINT_CLASSES.includes(klass)) return { ok: false, error: `bad class "${klass}": one of ${MINT_CLASSES.join('|')}` };
  }
  // snapshot before any write
  copyFileSync(CODEBOOK_PATH, CODEBOOK_PATH + '.bak');
  const has_file = undo ? undefined : projectFileExists(slug);
  if (undo) {
    delete codebook.projects[slug];
    KNOWN.delete(slug);
  } else {
    const entry = {};
    if (parent !== null) entry.parent = parent;
    entry.aliases = aliases;
    entry.class = klass;
    entry.has_file = has_file;
    codebook.projects[slug] = entry;
    KNOWN.add(slug);
  }
  writeFileSync(CODEBOOK_PATH, serializeCodebook(codebook), 'utf8');
  return { ok: true, slug, undo, parent, aliases, class: klass, has_file };
}

// ---------- commands ----------
const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'check') {
  let issues = 0;
  for (const d of days) {
    const sum = d.major.reduce((s, m) => s + m.w, 0);
    if (d.major.length && Math.abs(sum - 1) > 1e-9) { console.log(`WEIGHT ${d.date}: sum=${sum}`); issues++; }
    for (const m of d.major) if (!KNOWN.has(m.slug) && !(d.new || []).includes(m.slug))
      { console.log(`UNKNOWN-SLUG ${d.date}: ${m.slug} (major, not in codebook, not marked new)`); issues++; }
  }
  const t = days.find(d => d.major.length >= 2) ?? days[0];
  const rec = decodeBundle(bundle(t), t.major.map(m => m.slug));
  const ok = t.major.every(m => {
    const r = rec.find(x => x.slug === m.slug);
    return r && Math.abs(r.est - m.w) < 0.05;
  });
  console.log(`days=${days.length} slugs=${KNOWN.size} D=${D}`);
  console.log(`vector-recovery sanity (${t.date}): ${ok ? 'PASS' : 'FAIL'}`);
  console.log(issues ? `${issues} data issue(s) (normalized at load)` : 'no data issues');
  // Non-zero exit on any data issue or a failed vector-recovery so `check` is CI/script usable.
  if (issues || !ok) process.exitCode = 1;
}

else if (cmd === 'decode') {
  const d = byDate[args[0]];
  if (!d) { console.log('no such day'); process.exit(1); }
  const b = bundle(d);
  console.log(`${d.date} - ${d.oneline ?? ''}${provTag(d)}`);
  console.log('recovered from vector alone (vs actual):');
  for (const { slug, est } of decodeBundle(b, allSlugsEver)) {
    const actual = d.major.find(m => m.slug === slug);
    console.log(`  ${slug.padEnd(28)} est=${fmt(est)}  actual=${actual ? fmt(actual.w) : '-'}${KNOWN.has(slug) ? '' : '  [NOT IN CODEBOOK]'}`);
  }
  if (d.minor.length) console.log(`  minors (table): ${d.minor.join(', ')}`);
}

else if (cmd === 'where') {
  const slug = args[0];
  const hits = days.filter(d => d.major.some(m => m.slug === slug) || d.minor.includes(slug));
  for (const d of hits) {
    const m = d.major.find(x => x.slug === slug);
    console.log(`  ${d.date}  ${m ? 'MAJOR ' + fmt(m.w) : 'minor      '}  ${d.oneline ?? ''}${provTag(d)}`);
  }
  console.log(`${hits.length} day(s); major on ${hits.filter(d => d.major.some(m => m.slug === slug)).length}`);
}

else if (cmd === 'first') {
  const slug = args[0];
  const hits = days.filter(d => d.major.some(m => m.slug === slug) || d.minor.includes(slug));
  const majors = days.filter(d => d.major.some(m => m.slug === slug));
  if (!hits.length) { console.log('never seen'); process.exit(0); }
  console.log(`${slug}: first mention ${hits[0].date}, first major ${majors[0]?.date ?? '-'}, last ${hits[hits.length - 1].date}, ${hits.length} day(s)`);
}

else if (cmd === 'cooccur') {
  const [a, b] = args;
  const hits = days.filter(d => d.major.some(m => m.slug === a) && d.major.some(m => m.slug === b));
  hits.forEach(d => console.log(`  ${d.date}  ${d.oneline ?? ''}`));
  console.log(`${hits.length} day(s) with both ${a} and ${b} major`);
}

else if (cmd === 'window' || cmd === 'diff') {
  const agg = (from, to) => {
    const w = new Float64Array(D);
    const set = days.filter(d => d.date >= from && d.date <= to && d.major.length);
    for (const d of set) { const b = bundle(d); for (let i = 0; i < D; i++) w[i] += b[i] / set.length; }
    return { w, n: set.length };
  };
  if (cmd === 'window') {
    const { w, n } = agg(args[0], args[1]);
    console.log(`${args[0]} → ${args[1]} (${n} active days):`);
    decodeBundle(w, allSlugsEver, 0.02).slice(0, 14).forEach(r => console.log(`  ${r.slug.padEnd(28)} ${fmt(r.est)}`));
  } else {
    const A = agg(args[0], args[1]), B = agg(args[2], args[3]);
    const dA = Object.fromEntries(decodeBundle(A.w, allSlugsEver, 0.02).map(r => [r.slug, r.est]));
    const dB = Object.fromEntries(decodeBundle(B.w, allSlugsEver, 0.02).map(r => [r.slug, r.est]));
    console.log(`A=${args[0]}..${args[1]} (${A.n}d)  B=${args[2]}..${args[3]} (${B.n}d)`);
    console.log('GONE (in A, not B):'); Object.keys(dA).filter(s => !dB[s]).forEach(s => console.log(`  ${s.padEnd(28)} ${fmt(dA[s])} → 0`));
    console.log('NEW (in B, not A):'); Object.keys(dB).filter(s => !dA[s]).forEach(s => console.log(`  ${s.padEnd(28)} 0 → ${fmt(dB[s])}`));
    console.log('SHIFTED:'); Object.keys(dA).filter(s => dB[s]).forEach(s => console.log(`  ${s.padEnd(28)} ${fmt(dA[s])} → ${fmt(dB[s])}`));
  }
}

else if (cmd === 'gaps') {
  const seen = new Map();
  for (const d of days) for (const m of d.major) {
    const e = seen.get(m.slug) ?? { days: 0, mass: 0, first: d.date };
    e.days++; e.mass += m.w; seen.set(m.slug, e);
  }
  console.log('workstreams in logs with NO project file:');
  [...seen.entries()]
    .filter(([s]) => !KNOWN.has(s) || codebook.projects[s]?.has_file === false)
    .sort((a, b2) => b2[1].mass - a[1].mass)
    .forEach(([s, e]) => console.log(`  ${s.padEnd(28)} ${String(e.days).padStart(3)} day(s)  mass=${fmt(e.mass)}  first=${e.first}${KNOWN.has(s) ? '' : '  [NOT EVEN IN CODEBOOK]'}`));
}

else if (cmd === 'backtest') {
  const slug = args[0];
  const thr = parseFloat(args[1] ?? '0.20');
  const excluded = new Set([slug]);
  const firstAppear = days.find(d => d.major.some(m => m.slug === slug))?.date;
  if (!firstAppear) { console.log('slug never major; nothing to backtest'); process.exit(0); }
  console.log(`backtest: pretend "${slug}" is unknown. threshold=${thr}. true first major=${firstAppear}`);
  let firstFlag = null, flagged = 0;
  for (const d of days) {
    if (!d.major.length) continue;
    // Count only TARGET-ACTIVE days toward detection/lag. A day whose only unexplained mass is
    // some OTHER unknown slug (e.g. sourdough-lab) is not an aquarium-controller detection; it
    // would flag no matter which slug we backtested. Restricting to days the target is actually
    // major on stops that misattribution.
    if (!d.major.some(m => m.slug === slug)) continue;
    const unexplained = d.major.filter(m => excluded.has(m.slug) || !KNOWN.has(m.slug)).reduce((s, m) => s + m.w, 0);
    const b = bundle(d);
    const r = Float64Array.from(b);
    for (const s of KNOWN) {
      if (excluded.has(s)) continue;
      const e = estW(b, s);
      if (e < 0.04) continue;
      const v = vec(s);
      for (let i = 0; i < D; i++) r[i] -= e * v[i];
    }
    const resid = norm(b) > 0 ? norm(r) / norm(b) : 0;
    if (unexplained >= thr) {
      flagged++;
      if (!firstFlag) firstFlag = d.date;
      console.log(`  FLAG ${d.date}  unexplained=${fmt(unexplained)}  vec-residual=${fmt(resid)}  ${d.oneline ?? ''}`);
    }
  }
  if (firstFlag) {
    const lag = (new Date(firstFlag) - new Date(firstAppear)) / 86400000;
    console.log(`RESULT: first flag ${firstFlag} (lag ${lag} day(s) after true first major), ${flagged} day(s) flagged`);
  } else console.log('RESULT: never flagged - detector FAILED for this slug at this threshold');
}

else if (cmd === 'drift') {
  const slug = args[0];
  const halflife = parseFloat(args[1] ?? '10');
  const alpha = 1 - Math.pow(0.5, 1 / halflife);
  const ema = new Float64Array(D);
  let active = 0;
  for (const d of days) {
    const m = d.major.find(x => x.slug === slug);
    if (!m) continue;
    active++;
    const b = bundle(d);
    for (let i = 0; i < D; i++) ema[i] = ema[i] * (1 - alpha) + b[i] * alpha;
  }
  if (!active) { console.log('never major'); process.exit(0); }
  console.log(`${slug} identity after ${active} active day(s) (EMA halflife ${halflife}):`);
  console.log('entangled with (decoded from drift vector):');
  decodeBundle(ema, allSlugsEver, 0.03).slice(0, 8).forEach(r =>
    console.log(`  ${r.slug.padEnd(28)} ${fmt(r.est)}${r.slug === slug ? '  (self)' : ''}`));
}

else if (cmd === 'similar') {
  const d = byDate[args[0]];
  if (!d) { console.log('no such day'); process.exit(1); }
  const b = bundle(d), nb = norm(b);
  days.filter(x => x.date !== d.date && x.major.length)
    .map(x => { const c = bundle(x); return { date: x.date, cos: dot(b, c) / (nb * norm(c)), oneline: x.oneline ?? '' }; })
    .sort((x, y) => y.cos - x.cos).slice(0, 6)
    .forEach(r => console.log(`  ${r.date}  cos=${fmt(r.cos)}  ${r.oneline}`));
}

else if (cmd === 'tasteslike') {
  // "I don't know this ingredient, but it tastes like tarragon."
  // Slug vectors are orthogonal by construction, so flavor comes from CONTEXT: a project's
  // taste-profile is the company it keeps, rarity-weighted so ubiquitous background work
  // (daily monitors, ops chores) doesn't make everything taste the same.
  // (profile math lifted to module-scope tasteProfile/idf, shared with `unknowns`.)
  const slug = args[0];
  const profile = tasteProfile;
  const { p: target, activity, companions } = profile(slug);
  if (!activity) { console.log(`"${slug}" never appears as major - nothing to taste`); process.exit(0); }
  const cb = codebook.projects[slug];
  console.log(`${slug}${cb ? ` (${cb.class ?? 'project'})` : '  [UNKNOWN INGREDIENT - not in codebook]'}`);
  console.log('keeps company with (rarity-weighted co-occurrence):');
  const nt = norm(target);
  if (companions.size === 0 || nt === 0) {
    // A sole-major slug shares no day with other major work, so its taste profile is zero-norm;
    // a cosine would divide by zero (NaN). Report no profile and skip the tastes-like section.
    console.log('  (none - this slug never shares a day with other major work, so it has no taste profile yet)');
  } else {
    [...companions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .forEach(([s, w]) => console.log(`  ${s.padEnd(28)} ${fmt(w / activity)}`));
    console.log('tastes like (similar taste-profiles among known ingredients):');
    allSlugsEver
      .filter(s => s !== slug && KNOWN.has(s))
      .map(s => { const { p, activity: a } = profile(s); return a && norm(p) > 0 ? { slug: s, cos: dot(target, p) / (nt * norm(p)) } : null; })
      .filter(Boolean)
      .sort((x, y) => y.cos - x.cos)
      .slice(0, 5)
      .forEach(r => console.log(`  ${r.slug.padEnd(28)} cos=${fmt(r.cos)}`));
  }
}

else if (cmd === 'color') {
  const hsl2hex = (h, s, l) => {
    const f = n => { const k = (n + h / 30) % 12; const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); };
    return `#${f(0)}${f(8)}${f(4)}`;
  };
  const slugColor = s => hsl2hex(fnv1a(s) % 360, 0.65, 0.55);
  const d = byDate[args[0]];
  if (d) {
    let R = 0, G = 0, B = 0;
    for (const m of d.major) {
      const hex = slugColor(m.slug);
      R += m.w * parseInt(hex.slice(1, 3), 16); G += m.w * parseInt(hex.slice(3, 5), 16); B += m.w * parseInt(hex.slice(5, 7), 16);
    }
    const hex = `#${[R, G, B].map(x => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
    console.log(`${d.date} = ${hex}`);
    d.major.forEach(m => console.log(`  ${slugColor(m.slug)} ${m.slug} (${fmt(m.w)})`));
  } else console.log(`${args[0]} = ${slugColor(args[0])}`);
}

else if (cmd === 'unknowns') {
  // Surface unresolved "unknown ingredient" workstreams for weekly triage.
  // (Once filed/aliased in the codebook it is "resolved" and drops off this list.)
  const rows = computeUnknownRows();
  // maturity/decision tag per row: ledger status wins, else maturity bucket.
  const tag = r => r.status !== 'open' ? r.status.toUpperCase()
    : r.revived ? 'REVIVED'
    : r.overdue ? 'OVERDUE'
    : r.maturing ? 'maturing'
    : 'ripe';
  const verdict = r => r.recommend === 'alias' ? `alias->${r.recommendTarget}` : r.recommend;
  const decideN = rows.filter(r => (r.status === 'open' && r.ripe) || r.revived).length;
  const maturingN = rows.filter(r => r.status === 'open' && r.maturing).length;

  // ---- always: readable stdout summary ----
  console.log(`unknowns: ${rows.length} total  (decide ${decideN}, maturing ${maturingN})`);
  for (const r of rows) {
    console.log(`  ${r.slug.padEnd(28)} open ${String(r.age).padStart(3)}d  ${String(r.days_seen).padStart(2)} day(s)  mass=${fmt(r.major_mass)}  [${tag(r).padEnd(9)}]  -> ${verdict(r)}`);
  }

  // ---- optional: triage-ready markdown report ----
  if (process.argv.includes('--write')) {
    const path = writeUnknownsReport(rows);
    console.log(`wrote ${path}`);
  }
}

else if (cmd === 'mint') {
  // Safe codebook write: validate, snapshot codebook.json -> .bak, write, regenerate report.
  // Renames are never done; the codebook is a permanent slug->vector store. --undo reverses an add.
  const flag = name => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? (process.argv[i + 1] ?? '') : null;
  };
  const slug = args[0];
  const undo = process.argv.includes('--undo');
  if (!slug || slug.startsWith('--')) {
    console.log('usage: mint <slug> [--class C] [--parent P] [--alias a,b,c] [--undo] [--no-report]');
    process.exit(1);
  }
  const klass = flag('--class') ?? 'product';
  const parent = flag('--parent');                                    // null if not given
  const aliasRaw = flag('--alias');
  const aliases = aliasRaw ? aliasRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

  const res = mintSlug({ slug, parent, aliases, klass, undo });
  if (!res.ok) { console.log(`refused: ${res.error}`); process.exit(1); }

  // record the decision in the ledger: a successful add is `minted`; --undo clears the entry.
  if (res.undo) {
    const led = loadLedger();
    if (led.entries[res.slug]) { delete led.entries[res.slug]; saveLedger(led); }
  } else {
    setLedger(res.slug, { status: 'minted', decided_on: today() });
  }

  let reportNote = 'report skipped (--no-report)';
  if (!process.argv.includes('--no-report')) reportNote = `regenerated ${writeUnknownsReport()}`;

  if (res.undo) {
    console.log(`removed "${res.slug}" from codebook (restored backup at codebook.json.bak)`);
  } else {
    console.log(`minted "${res.slug}"  class=${res.class}  parent=${res.parent ?? '(none)'}  has_file=${res.has_file}  aliases=[${res.aliases.join(', ')}]`);
  }
  console.log(reportNote);
}

else if (cmd === 'alias') {
  // Resolve an unknown by aliasing it onto an existing codebook slug (true resolution: it leaves
  // the unknown list because ALIASED now contains it). Refuses self-conflicting cases. Snapshots first.
  const [name, target] = args;
  if (!name || !target) { console.log('usage: alias <name> <target-codebook-slug>'); process.exit(1); }
  if (!KNOWN.has(target)) { console.log(`refused: target "${target}" is not a codebook key`); process.exit(1); }
  if (KNOWN.has(name)) { console.log(`refused: "${name}" is already a codebook key (alias onto a slug, not a slug onto itself)`); process.exit(1); }
  const entry = codebook.projects[target];
  entry.aliases = entry.aliases || [];
  if (!entry.aliases.includes(name)) {
    entry.aliases.push(name);
    copyFileSync(CODEBOOK_PATH, CODEBOOK_PATH + '.bak');
    writeFileSync(CODEBOOK_PATH, serializeCodebook(codebook), 'utf8');
  }
  setLedger(name, { status: 'aliased', decided_on: today(), alias_target: target });
  console.log(`aliased "${name}" -> "${target}" (added to ${target}.aliases; "${name}" now resolves)`);
  // regenerate using a fresh computation so the just-aliased slug is reflected as resolved.
  console.log(`regenerated ${writeUnknownsReport()}`);
}

else if (cmd === 'dismiss') {
  // Dismiss an unknown as a one-off. Records baseline_days so it can REVIVE if seen meaningfully more.
  const slug = args[0];
  if (!slug) { console.log('usage: dismiss <slug> [note...]'); process.exit(1); }
  const note = args.slice(1).join(' ').trim();
  const row = computeUnknownRows().find(r => r.slug === slug);
  const baseline_days = row ? row.days_seen : 0;
  setLedger(slug, { status: 'dismissed', decided_on: today(), baseline_days, ...(note ? { note } : {}) });
  console.log(`dismissed "${slug}" (baseline ${baseline_days} day(s); revives if seen >= ${baseline_days + 1})${note ? `: ${note}` : ''}`);
  console.log(`regenerated ${writeUnknownsReport()}`);
}

else if (cmd === 'watch') {
  // Park an unknown on the watchlist: surfaces in Watching (terse), out of Decide, kept in view.
  const slug = args[0];
  if (!slug) { console.log('usage: watch <slug> [note...]'); process.exit(1); }
  const note = args.slice(1).join(' ').trim();
  setLedger(slug, { status: 'watching', decided_on: today(), ...(note ? { note } : {}) });
  console.log(`watching "${slug}" (since ${today()})${note ? `: ${note}` : ''}`);
  console.log(`regenerated ${writeUnknownsReport()}`);
}

else if (cmd === 'decisions') {
  // Print the persistent decision ledger grouped by status.
  const led = loadLedger();
  const entries = Object.entries(led.entries);
  if (!entries.length) { console.log('ledger empty (no decisions recorded).'); process.exit(0); }
  console.log(`decision ledger: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
  for (const status of ['watching', 'dismissed', 'minted', 'aliased']) {
    const group = entries.filter(([, e]) => e.status === status);
    if (!group.length) continue;
    console.log(`\n${status} (${group.length}):`);
    for (const [slug, e] of group.sort((a, b) => a[0].localeCompare(b[0]))) {
      const extra = e.alias_target ? ` -> ${e.alias_target}` : e.baseline_days != null ? ` (baseline ${e.baseline_days}d)` : '';
      console.log(`  ${slug.padEnd(28)} ${e.decided_on ?? '?'}${extra}${e.note ? `  // ${e.note}` : ''}`);
    }
  }
}

else if (cmd === 'autofile') {
  // Auto-file the SAFE class of open unknowns: those that BOTH have a project file
  // AND have appeared as a major at least once (major_mass > 0). Dry-run unless --write.
  const write = process.argv.includes('--write');
  const okSlug = s => SLUG_RE.test(s);   // same gate mintSlug enforces, so dry-run agrees with --write
  const candidates = computeUnknownRows()
    .filter(r => r.major_mass > 0 && okSlug(r.slug) && projectFileExists(r.slug));

  if (!candidates.length) {
    console.log(write ? 'nothing to autofile.' : 'dry run: nothing would be filed.');
    console.log('AUTOFILED: none');
    process.exit(0);
  }

  console.log(`${write ? 'filing' : 'dry run: would file'} ${candidates.length} unknown(s) (has project file + seen as major):`);
  if (write) { try { copyFileSync(CODEBOOK_PATH, CODEBOOK_PATH + '.pre-autofile.bak'); } catch {} }
  const filed = [];
  for (const r of candidates) {
    if (write) {
      const res = mintSlug({ slug: r.slug, klass: 'product' });      // has_file resolves to true; no parent
      if (!res.ok) { console.log(`  SKIP ${r.slug}: ${res.error}`); continue; }
      setLedger(r.slug, { status: 'minted', decided_on: today() });  // record the decision
      filed.push(r.slug);
      console.log(`  filed ${r.slug.padEnd(28)} class=product  has_file=${res.has_file}  mass=${fmt(r.major_mass)}`);
    } else {
      console.log(`  would file ${r.slug.padEnd(28)} class=product  mass=${fmt(r.major_mass)}`);
    }
  }
  if (write && filed.length) console.log(`regenerated ${writeUnknownsReport()} (pre-autofile snapshot: codebook.json.pre-autofile.bak; undo any slug with: mint <slug> --undo)`);

  const result = write ? filed : candidates.map(r => r.slug);
  console.log(`AUTOFILED: ${result.length ? result.join(' ') : 'none'}`);
}

else if (cmd === 'digest') {
  // Compose a plain-text status digest (aligned monospace, no markdown tables) and print to
  // stdout. Reuses computeUnknownRows / loadLedger / today / days / KNOWN / fmt. A notifier
  // (e.g. the sweeper's config.notifyCommand hook) can push this text wherever you like.
  const rows = computeUnknownRows();
  // Decide order MUST match writeUnknownsReport: overdue first, then major_mass desc, then slug.
  const decide = rows
    .filter(r => (r.status === 'open' && r.ripe) || r.revived)
    .sort((a, b) => (b.overdue - a.overdue) || (b.major_mass - a.major_mass) || a.slug.localeCompare(b.slug));
  const maturingN = rows.filter(r => r.status === 'open' && r.maturing).length;
  const latest = days[days.length - 1];
  const topSlug = latest && latest.major[0] ? latest.major[0].slug : '(none)';
  const latestDay = latest ? latest.date : '(none)';
  // Latest day's oneline rides along in the pulse/footer when present (truncated to 70 chars);
  // absent/empty oneline leaves the label as just the top slug, byte-identical to before.
  const oneline = latest && typeof latest.oneline === 'string' ? latest.oneline : '';
  const tagLabel = oneline ? `${topSlug}: "${oneline.slice(0, 70)}"` : topSlug;
  const slugN = KNOWN.size;
  const ymd = today();

  // recently: ledger entries decided today or yesterday (UTC), grouped by status.
  const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const recentByStatus = new Map();
  for (const [slug, e] of Object.entries(loadLedger().entries)) {
    if (e.decided_on === ymd || e.decided_on === yest) {
      if (!recentByStatus.has(e.status)) recentByStatus.set(e.status, []);
      recentByStatus.get(e.status).push(slug);
    }
  }
  const recent = [...recentByStatus.entries()]
    .map(([status, slugs]) => `${status} ${slugs.join(', ')}`)
    .join('; ');

  const verdict = r => r.recommend === 'mint' ? 'MINT'
    : r.recommend === 'alias' ? `ALIAS onto ${r.recommendTarget}`
    : r.recommend === 'watch' ? 'WATCH'
    : 'DISMISS';
  const mass2 = n => n.toFixed(2);

  const out = [];
  if (decide.length > 0) {
    // decide count on line 1: phone notification previews (and any first-line-only
    // transport) must carry the signal, not just a bare header.
    out.push(`🎨 Tastebud - ${ymd}: ${decide.length} need your call`);
    out.push('DECIDE:');
    for (const r of decide) {
      out.push(`  ${r.slug.padEnd(26)} ${r.age}d  mass ${mass2(r.major_mass)}  -> ${verdict(r)}`);
    }
    const f = decide[0].slug;
    out.push(`  reply: "dismiss ${f}" / "mint ${f}" / "watch ${f}" / "alias ${f} onto <someExistingCodebookSlug>"`);
    out.push('');
    out.push(`tagged ${latestDay} (${tagLabel}) | maturing ${maturingN} | ${slugN} slugs | ok`);
    if (recent) out.push(`recently: ${recent}`);
  } else {
    let pulse = `🎨 Tastebud - ${ymd}: tagged ${latestDay} (${tagLabel}). 0 to decide.`;
    if (maturingN > 0) pulse += ` ${maturingN} maturing.`;
    pulse += ` ${slugN} slugs, ok.`;
    out.push(pulse);
    if (recent) out.push(`recently: ${recent}`);
  }
  console.log(out.join('\n'));
}

else {
  console.log('commands: check decode where first cooccur window diff gaps backtest drift similar tasteslike color unknowns mint alias dismiss watch decisions autofile digest');
}
