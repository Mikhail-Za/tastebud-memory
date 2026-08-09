// Advisory single-writer lock + atomic file writes for tastebud's mutating commands.
// Stdlib only. The lock is cooperative: it guards THIS engine's own writers against each other
// (a second nightly sweep, a human command racing the cron), not against arbitrary editors.
//
// Design in one breath: a `.tastebud.lock` file created with open(...,'wx') beside the data dir
// is the token. Holding it is exclusive; a crashed holder is reaped ONLY when its recorded pid is
// provably not alive; release only unlinks a lock whose token is ours. writeAtomic never leaves a
// half-written target: it writes a same-dir temp, fsyncs, then renames over the target.

import {
  openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync,
  readFileSync, readdirSync, existsSync,
} from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

// Lock lives BESIDE the data dir (in its parent), not inside it, so a wipe of the data dir's
// contents never removes the lock mid-run and the lock never shows up as data.
function lockPath(dataDir) {
  const d = resolve(dataDir);
  return join(dirname(d), '.tastebud.lock');
}

// In-process reentrancy: the same process taking the lock twice (sweep-candidates holding it while
// promoteViaCandidate re-enters) refcounts instead of self-deadlocking.
const held = new Map(); // lockPath -> { count, token }

function sleep(ms) {
  // Synchronous, dependency-free pause. The engine's mutating path is entirely synchronous, so a
  // sync sleep between lock retries keeps the whole critical section straight-line and simple.
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

// writeSync may make a SHORT write (return fewer bytes than requested); loop until the whole buffer
// is on the fd. Every fd write in this module goes through here so a partial write never truncates.
export function writeFully(fd, buf) {
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw new Error('writeSync made no progress (0 bytes)'); // never spin forever
    off += n;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM: the pid exists, we just cannot signal it.
}

// Reap a lock ONLY when we can read it, parse a pid, and prove that pid is not alive. A lock we
// cannot parse is left alone (fail-safe): we would rather time out than delete a live holder's lock.
function tryReap(lp) {
  let rec;
  try { rec = JSON.parse(readFileSync(lp, 'utf8')); } catch { return false; }
  if (pidAlive(rec.pid)) return false;
  try { unlinkSync(lp); return true; } catch { return false; }
}

// On acquire we hold the lock, so no other engine writer is mid-write: any leftover temp matching
// OUR writeAtomic pattern (`.<hex>.tmp`) is an orphan from a crashed write and is safe to remove.
function cleanOrphanTmps(dataDir) {
  try {
    for (const name of readdirSync(dataDir)) {
      if (/\.[0-9a-f]+\.tmp$/.test(name)) {
        try { unlinkSync(join(dataDir, name)); } catch {}
      }
    }
  } catch {}
}

export function acquire(dataDir) {
  const lp = lockPath(dataDir);
  const cur = held.get(lp);
  if (cur) { cur.count++; return; }
  const token = randomBytes(16).toString('hex');
  const deadline = Date.now() + 30000; // 30s bounded acquire
  for (;;) {
    let fd, created = false;
    try {
      fd = openSync(lp, 'wx');
      created = true;
      writeFully(fd, Buffer.from(JSON.stringify({ pid: process.pid, startTime: Date.now(), token })));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      held.set(lp, { count: 1, token });
      cleanOrphanTmps(dataDir);
      return;
    } catch (e) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      if (e.code === 'EEXIST') {
        if (tryReap(lp)) continue;            // stale holder gone: retry immediately
        if (Date.now() > deadline)
          throw new Error(`tastebud: could not acquire ${basename(lp)} within 30s (another run holds it)`);
        sleep(250);
        continue;
      }
      // Setup failed AFTER we created the lock (write/fsync error): remove our half-written lock so
      // it is not a permanent, unreapable orphan (it records no valid pid), then surface the error.
      if (created) { try { unlinkSync(lp); } catch {} }
      throw e;
    }
  }
}

export function release(dataDir) {
  const lp = lockPath(dataDir);
  const cur = held.get(lp);
  if (!cur) return;
  if (--cur.count > 0) return;
  held.delete(lp);
  // Never unlink a lock we do not own: verify the on-disk token matches ours first.
  try {
    const rec = JSON.parse(readFileSync(lp, 'utf8'));
    if (rec.token === cur.token) unlinkSync(lp);
  } catch {}
}

// Run fn while holding the lock; always released, even on throw. fn is synchronous.
export function withLock(dataDir, fn) {
  acquire(dataDir);
  try { return fn(); }
  finally { release(dataDir); }
}

// Write `data` (string or Buffer) to `path` without ever exposing a half-written target:
// unique same-dir temp opened exclusively, written through the fd, fsync'd, closed, renamed over
// the target (atomic on a single volume). Best-effort parent-dir fsync. Temp removed on any error.
export function writeAtomic(path, data) {
  const tmp = path + '.' + randomBytes(6).toString('hex') + '.tmp';
  let fd;
  try {
    fd = openSync(tmp, 'wx');
    writeFully(fd, Buffer.isBuffer(data) ? data : Buffer.from(data));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    try { const dfd = openSync(dirname(resolve(path)), 'r'); fsyncSync(dfd); closeSync(dfd); } catch {}
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    if (existsSync(tmp)) { try { unlinkSync(tmp); } catch {} }
    throw e;
  }
}
