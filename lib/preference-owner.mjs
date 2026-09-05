// Trusted host adapters only. Never expose these mutations as agent tools.
// Host authentication belongs to the caller; this module guarantees exact,
// atomic and reversible decisions, not human identity on a shared OS account.
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fields, string } from './preferences.mjs';
import { hash } from './schema.mjs';

export function reviewSource(memory, { kind, details = {}, tty = false }) {
  const id = randomUUID();
  memory.db.prepare('INSERT INTO preference_launches VALUES (?,?,?,?,?,?)').run(id,process.pid,Number(tty),kind,JSON.stringify(details),new Date().toISOString());
  return id;
}
export function ownerReview(memory, sourceId, request) {
  const action = request?.action;
  if (action === 'alignment') {
    fields(request,['id','action','use_id','alignment','note']);
    string(request.use_id,'use_id',200);
    if (!['aligned','contradicted','uncertain'].includes(request.alignment)) throw new Error('invalid owner alignment');
  } else {
    fields(request,['id','action','proposal_id','proposal_hash','base_revision','note']);
    if (!['approve','reject'].includes(action)) throw new Error('invalid review action');
    string(request.proposal_id,'proposal_id',200); string(request.proposal_hash,'proposal_hash',64);
    if (request.base_revision !== null) string(request.base_revision,'base_revision',200);
  }
  string(request.id,'review id',200);
  if (typeof request.note !== 'string' || request.note.length > 4000) throw new Error('invalid review note');
  return memory.transaction(() => {
    if (!memory.db.prepare('SELECT id FROM preference_launches WHERE id=?').get(sourceId)) throw new Error('unknown owner review source');
    const digest = hash(request), old = memory.db.prepare('SELECT * FROM preference_reviews WHERE id=?').get(request.id);
    if (old) {
      if (old.request_hash !== digest) throw new Error('review ID reused with different request');
      return { id:old.id, action:old.action, acknowledged:true, duplicate:true };
    }
    if (action === 'alignment') {
      if (!memory.db.prepare('SELECT event_id FROM preference_uses WHERE event_id=?').get(request.use_id)) throw new Error('unknown preference use');
    } else {
      const p = memory.policy.proposal(request.proposal_id);
      if (p.proposal_hash !== request.proposal_hash || p.base_revision !== request.base_revision) throw new Error('proposal hash or base revision mismatch; reread the proposal');
      if (memory.db.prepare('SELECT id FROM preference_reviews WHERE proposal_id=?').get(p.event_id)) throw new Error('proposal already reviewed');
      // Rejection may clear a stale draft; activation may never overwrite a newer decision.
      if (action === 'approve' && (memory.policy.current(p.preference_id)?.revision ?? null) !== p.base_revision) throw new Error('stale proposal; create a new draft against the current revision');
    }
    memory.db.prepare('INSERT INTO preference_reviews(id,launch_id,proposal_id,use_id,action,request,request_hash,recorded_at) VALUES (?,?,?,?,?,?,?,?)').run(request.id,sourceId,request.proposal_id ?? null,request.use_id ?? null,action,JSON.stringify(request),digest,new Date().toISOString());
    return { id:request.id, action, acknowledged:true, duplicate:false };
  });
}
export function ownerDraft(memory, event) {
  if (event?.type !== 'preference_proposal') throw new Error('only preference drafts accepted');
  return memory.record(event,'owner-page-unverified');
}
export function ownerState(memory) {
  return { ...memory.preferences(), projects:memory.db.prepare('SELECT slug FROM projects ORDER BY slug').all().map(p => p.slug) };
}
export function confirmationNonces() {
  const pending = new Map();
  return {
    issueNonce(target,action) {
      for (const [key,value] of pending) if (value.expires < Date.now()) pending.delete(key);
      if (pending.size >= 64) pending.clear();
      const nonce = randomBytes(24).toString('hex');
      pending.set(nonce,{target,action,expires:Date.now()+60000}); return nonce;
    },
    consumeNonce(nonce,target,action) {
      const value = pending.get(nonce); pending.delete(nonce);
      return !!value && value.expires >= Date.now() && value.target === target && value.action === action;
    },
  };
}
export function confirmReview(memory, sourceId, envelope, nonces) {
  fields(envelope,['request','nonce'],['request']);
  const r = envelope.request, target = 'preferences:'+hash(r);
  if (!r || !['approve','reject','alignment'].includes(r.action)) throw new Error('invalid review action');
  if (envelope.nonce === undefined) {
    const state = memory.preferences();
    const item = r.action === 'alignment' ? state.uses.find(u => u.event_id === r.use_id) : state.pending.find(p => p.event_id === r.proposal_id);
    if (!item) throw new Error('review target missing or already reviewed');
    if (r.action !== 'alignment' && (item.proposal_hash !== r.proposal_hash || item.base_revision !== r.base_revision || (r.action === 'approve' && item.stale))) throw new Error('proposal changed or stale; reread it');
    return {status:'confirm_required',nonce:nonces.issueNonce(target,r.action),ttl_s:60,preview:item};
  }
  if (!nonces.consumeNonce(envelope.nonce,target,r.action)) throw new Error('confirmation expired, used, or for another change');
  return ownerReview(memory,sourceId,r);
}

export const reviewAssets = {
  '/': ['preferences.html','text/html; charset=utf-8'],
  '/preferences.js': ['preferences.js','text/javascript; charset=utf-8'],
  '/preferences.css': ['preferences.css','text/css; charset=utf-8'],
};
export function reviewAsset(name) { return readFileSync(new URL('../web/'+name,import.meta.url)); }
export const reviewHeaders = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy':'no-referrer', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'X-Frame-Options':'DENY',
};
export function browserOrigin(req) {
  return req.headers.origin === 'http://'+req.headers.host
    && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
}
export function readReviewBody(req) {
  return new Promise((resolve,reject) => {
    let chunks = [], bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 65536) { chunks = []; reject(new Error('request over 64 KiB')); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('invalid JSON')); } });
    req.on('error',reject);
  });
}
export async function startReviewServer(memory, { tty = Boolean(process.stdin.isTTY && process.stdout.isTTY) } = {}) {
  if (!tty) throw new Error('Owner review requires an interactive terminal (stdin and stdout TTY). Agents must not launch it.');
  const token = randomBytes(32).toString('hex');
  const sourceId = reviewSource(memory,{kind:'owner-tty',tty:true});
  const nonces = confirmationNonces();
  let port;
  const server = createServer(async (req,res) => {
    const send = (code,data,type='application/json; charset=utf-8') => { res.writeHead(code,{...reviewHeaders,'Content-Type':type}); res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data)); };
    try {
      if (req.headers.host !== `127.0.0.1:${port}`) return send(403,{error:'invalid Host'});
      const asset = reviewAssets[req.url];
      if (asset && req.method === 'GET') return send(200,reviewAsset(asset[0]),asset[1]);
      const got = req.headers['x-preference-token'];
      if (typeof got !== 'string' || Buffer.byteLength(got) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(got),Buffer.from(token))) return send(403,{error:'invalid launch capability'});
      if (req.headers.origin && req.headers.origin !== 'http://'+req.headers.host) return send(403,{error:'invalid Origin'});
      if (req.url === '/api/state' && req.method === 'GET') return send(200,ownerState(memory));
      if (!['/api/review','/api/draft'].includes(req.url)) return send(404,{error:'not found'});
      if (req.method !== 'POST') return send(405,{error:'POST required'});
      if (!browserOrigin(req)) return send(403,{error:'same-origin owner action required'});
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return send(415,{error:'JSON required'});
      const body = await readReviewBody(req);
      return send(200,req.url === '/api/review' ? confirmReview(memory,sourceId,body,nonces) : ownerDraft(memory,body));
    } catch (e) { return send(400,{error:e.message}); }
  });
  server.headersTimeout=5000; server.requestTimeout=15000;
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  port = server.address().port;
  return { server, port, token, sourceId };
}
