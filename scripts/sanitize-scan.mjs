#!/usr/bin/env node
// Pre-publish sanitizer: scan the FULL publish manifest for anything that must never leave the
// private engine. Prints CLEAN, or every offending file:line and exits non-zero.
//
// Manifest = `git ls-files` + untracked-but-not-ignored files, minus .git/, the git-excluded plan
// docs, and the local review dir. The scan is case-insensitive.
//
// Two kinds of forbidden content:
//   1. Fixed terms + an owner-provided private-slug denylist. The denylist lives in a local,
//      git-ignored file; if it is ABSENT the scan FAILS CLOSED (we refuse to certify a repo we
//      could not fully check).
//   2. The maintainer name is intentionally present in a FIXED set of attribution/URL lines; any
//      occurrence OUTSIDE that allowlist fails.
//
// The forbidden terms are assembled from fragments so this scanner file never matches itself.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

// Only PLAN-PORT.md is intentionally excluded (the git-excluded plan doc). Everything else the
// manifest returns is scanned: git already omits ignored paths, so a file that becomes TRACKED can
// never slip past a hard-coded directory carve-out.
const EXCLUDE_EXACT = new Set(['PLAN-PORT.md']);
const manifest = [...new Set([...git(['ls-files']), ...git(['ls-files', '--others', '--exclude-standard'])])]
  .filter(f => !EXCLUDE_EXACT.has(f) && !f.startsWith('.git/'));

// Private-slug denylist (git-ignored, owner-provided). Absent => FAIL CLOSED.
const DENY_FILE = '.sanitize-denylist.local';
if (!existsSync(join(ROOT, DENY_FILE))) {
  console.error(`sanitize-scan: FAIL CLOSED - ${DENY_FILE} is missing, so the private-slug denylist cannot be checked. Refusing to certify.`);
  process.exit(1);
}
const denyTerms = readFileSync(join(ROOT, DENY_FILE), 'utf8')
  .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')).map(s => s.toLowerCase());

// Fixed forbidden terms, assembled from fragments so they do not appear literally in this file.
const FIXED = ['z' + 'aidm', 'open' + 'claw', 'ax' + 'iom', 'pal' + 'ette', '87389' + '02498', 'c:' + '\\'];
const badTerms = [...FIXED, ...denyTerms];

// Maintainer name: allowed ONLY at these exact locations (LICENSE + README attribution + repo URLs).
const NAME = 'mikh' + 'ail';
const allowedAttribution = (file,line) =>
  (file === 'LICENSE' && /^Copyright \(c\) \d{4} /i.test(line)) ||
  (file === 'README.md' && (line.toLowerCase() === ('MIT. Built by ' + NAME + ' Zaidi with Claude (Anthropic), June 2026.').toLowerCase() || line.toLowerCase() === ('Public repository: https://github.com/' + NAME + '-Za/tastebud-memory').toLowerCase()));


const offenders = [];
for (const f of manifest) {
  let text;
  // An unreadable manifest file means we cannot certify it: that is a BLOCKING failure, never a
  // silent skip that could let an incomplete scan report CLEAN.
  try { text = readFileSync(join(ROOT, f), 'utf8'); }
  catch (e) { offenders.push(`${f}: UNREADABLE (${e.code || e.message}) - cannot certify, refusing to pass`); continue; }
  text.split('\n').forEach((line, i) => {
    const lc = line.toLowerCase();
    for (const term of badTerms) if (term && lc.includes(term)) offenders.push(`${f}:${i + 1}: forbidden term "${term}"`);
    if (lc.includes(NAME)) {
      const loc = `${f}:${i + 1}`;
      if (!allowedAttribution(f,line)) offenders.push(`${loc}: unexpected maintainer-name occurrence (not in the intentional-attribution allowlist)`);
    }
  });
}

if (offenders.length) {
  for (const o of offenders) console.error(o);
  console.error(`sanitize-scan: ${offenders.length} offending line(s) across ${manifest.length} scanned file(s)`);
  process.exit(1);
}
console.log(`CLEAN (${manifest.length} files scanned)`);
