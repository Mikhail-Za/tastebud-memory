#!/usr/bin/env node
// Tastebud — compositional project fingerprints for agent memory.
// Give every project a deterministic high-dimensional identity vector; every day's work is a
// weighted blend of those vectors. One "taste" (a dot product) decomposes any day back into its
// ingredients — including detecting ingredients nobody has named yet.
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
//   color <date|slug>              hex color garnish (the metaphor this project started with)
//
// Config: tastebud.config.json in the current directory or next to this script.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
function loadConfig() {
  for (const dir of [process.cwd(), SCRIPT_DIR]) {
    const p = join(dir, 'tastebud.config.json');
    if (existsSync(p)) return { ...JSON.parse(readFileSync(p, 'utf8')), _configDir: dir };
  }
  throw new Error('tastebud.config.json not found (looked in cwd and script dir)');
}
const config = loadConfig();
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
const codebook = JSON.parse(readFileSync(join(DATA, 'codebook.json'), 'utf8'));
const comps = JSON.parse(readFileSync(join(DATA, 'compositions.json'), 'utf8'));
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
}

else if (cmd === 'decode') {
  const d = byDate[args[0]];
  if (!d) { console.log('no such day'); process.exit(1); }
  const b = bundle(d);
  console.log(`${d.date} — ${d.oneline ?? ''}`);
  console.log('recovered from vector alone (vs actual):');
  for (const { slug, est } of decodeBundle(b, allSlugsEver)) {
    const actual = d.major.find(m => m.slug === slug);
    console.log(`  ${slug.padEnd(28)} est=${fmt(est)}  actual=${actual ? fmt(actual.w) : '—'}${KNOWN.has(slug) ? '' : '  [NOT IN CODEBOOK]'}`);
  }
  if (d.minor.length) console.log(`  minors (table): ${d.minor.join(', ')}`);
}

else if (cmd === 'where') {
  const slug = args[0];
  const hits = days.filter(d => d.major.some(m => m.slug === slug) || d.minor.includes(slug));
  for (const d of hits) {
    const m = d.major.find(x => x.slug === slug);
    console.log(`  ${d.date}  ${m ? 'MAJOR ' + fmt(m.w) : 'minor      '}  ${d.oneline ?? ''}`);
  }
  console.log(`${hits.length} day(s); major on ${hits.filter(d => d.major.some(m => m.slug === slug)).length}`);
}

else if (cmd === 'first') {
  const slug = args[0];
  const hits = days.filter(d => d.major.some(m => m.slug === slug) || d.minor.includes(slug));
  const majors = days.filter(d => d.major.some(m => m.slug === slug));
  if (!hits.length) { console.log('never seen'); process.exit(0); }
  console.log(`${slug}: first mention ${hits[0].date}, first major ${majors[0]?.date ?? '—'}, last ${hits[hits.length - 1].date}, ${hits.length} day(s)`);
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
  } else console.log('RESULT: never flagged — detector FAILED for this slug at this threshold');
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
  const slug = args[0];
  const df = new Map();
  for (const d of days) for (const m of d.major) df.set(m.slug, (df.get(m.slug) ?? 0) + 1);
  const activeDays = days.filter(d => d.major.length).length;
  const idf = s => Math.log(1 + activeDays / (df.get(s) ?? 1));
  const profile = s => {
    const companions = new Map();
    let activity = 0;
    for (const d of days) {
      const m = d.major.find(x => x.slug === s);
      if (!m) continue;
      activity += m.w;
      for (const o of d.major) if (o.slug !== s)
        companions.set(o.slug, (companions.get(o.slug) ?? 0) + m.w * o.w * idf(o.slug));
    }
    const p = new Float64Array(D);
    for (const [cs, cw] of companions) { const v = vec(cs); for (let i = 0; i < D; i++) p[i] += cw * v[i]; }
    return { p, activity, companions };
  };
  const { p: target, activity, companions } = profile(slug);
  if (!activity) { console.log(`"${slug}" never appears as major — nothing to taste`); process.exit(0); }
  const cb = codebook.projects[slug];
  console.log(`${slug}${cb ? ` (${cb.class ?? 'project'})` : '  [UNKNOWN INGREDIENT — not in codebook]'}`);
  console.log('keeps company with (rarity-weighted co-occurrence):');
  [...companions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .forEach(([s, w]) => console.log(`  ${s.padEnd(28)} ${fmt(w / activity)}`));
  console.log('tastes like (similar taste-profiles among known ingredients):');
  const nt = norm(target);
  allSlugsEver
    .filter(s => s !== slug && KNOWN.has(s))
    .map(s => { const { p, activity: a } = profile(s); return a && norm(p) > 0 ? { slug: s, cos: dot(target, p) / (nt * norm(p)) } : null; })
    .filter(Boolean)
    .sort((x, y) => y.cos - x.cos)
    .slice(0, 5)
    .forEach(r => console.log(`  ${r.slug.padEnd(28)} cos=${fmt(r.cos)}`));
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

else {
  console.log('commands: check decode where first cooccur window diff gaps backtest drift similar tasteslike color');
}
