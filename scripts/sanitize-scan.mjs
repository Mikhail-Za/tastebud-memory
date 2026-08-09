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

const EXCLUDE_EXACT = new Set(['PLAN-PORT.md']);
const EXCLUDE_PREFIX = ['.git/', 'review-20260808/'];
const manifest = [...new Set([...git(['ls-files']), ...git(['ls-files', '--others', '--exclude-standard'])])]
  .filter(f => !EXCLUDE_EXACT.has(f) && !EXCLUDE_PREFIX.some(p => f.startsWith(p)));

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
const NAME_ALLOW = new Set([
  'LICENSE:3',
  'README.md:225',
  'README.md:240',
  'README.md:246',
  'README.md:343',
]);

const offenders = [];
for (const f of manifest) {
  let text;
  try { text = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
  text.split('\n').forEach((line, i) => {
    const lc = line.toLowerCase();
    for (const term of badTerms) if (term && lc.includes(term)) offenders.push(`${f}:${i + 1}: forbidden term "${term}"`);
    if (lc.includes(NAME)) {
      const loc = `${f}:${i + 1}`;
      if (!NAME_ALLOW.has(loc)) offenders.push(`${loc}: unexpected maintainer-name occurrence (not in the intentional-attribution allowlist)`);
    }
  });
}

if (offenders.length) {
  for (const o of offenders) console.error(o);
  console.error(`sanitize-scan: ${offenders.length} offending line(s) across ${manifest.length} scanned file(s)`);
  process.exit(1);
}
console.log(`CLEAN (${manifest.length} files scanned)`);
