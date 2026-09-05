// Explicit policy is derived only from owner reviews. Producer labels and recall
// signals are provenance, never authority. See docs/preferences.md for the boundary.
import { hash } from './schema.mjs';

export const DOMAINS = ['planning', 'coding', 'operations', 'communication'];
export const POLICY_NOTICE = 'Preferences never grant permission. Current user instructions control. Check scope and exceptions; report consequential use.';
export const fields = (value, allowed, required = allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown field: ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`missing field: ${key}`);
};
export const string = (s, label, max = 4000) => {
  if (typeof s !== 'string' || !s.trim() || s.length > max) throw new Error(`invalid ${label} (nonempty text, max ${max})`);
  return s.trim();
};
export function domainCheck(domain) {
  if (domain !== undefined && !DOMAINS.includes(domain)) throw new Error('invalid domain');
}
const tables = ['preference_proposals', 'preference_uses', 'preference_launches', 'preference_reviews'];

export class Preferences {
  constructor(memory, readonly) {
    this.memory = memory; this.db = memory.db;
    if (!readonly) memory.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS preference_proposals(
          event_id TEXT PRIMARY KEY REFERENCES events(id), preference_id TEXT NOT NULL,
          base_revision TEXT REFERENCES preference_reviews(id), document TEXT NOT NULL, proposal_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS preference_uses(
          event_id TEXT PRIMARY KEY REFERENCES events(id), revision TEXT NOT NULL REFERENCES preference_reviews(id), document TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS preference_launches(id TEXT PRIMARY KEY, pid INTEGER NOT NULL, tty INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('owner-tty','fleet-browser','owner-chat')), details TEXT NOT NULL, created_at TEXT NOT NULL,
          CHECK((kind='owner-tty' AND tty=1) OR (kind IN ('fleet-browser','owner-chat') AND tty=0)));
        CREATE TABLE IF NOT EXISTS preference_reviews(
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
          launch_id TEXT NOT NULL REFERENCES preference_launches(id),
          proposal_id TEXT UNIQUE REFERENCES preference_proposals(event_id), use_id TEXT REFERENCES preference_uses(event_id),
          action TEXT NOT NULL CHECK(action IN ('approve','reject','alignment')),
          request TEXT NOT NULL, request_hash TEXT NOT NULL, recorded_at TEXT NOT NULL,
          CHECK((action IN ('approve','reject') AND proposal_id IS NOT NULL AND use_id IS NULL)
            OR (action='alignment' AND proposal_id IS NULL AND use_id IS NOT NULL)));
        CREATE INDEX IF NOT EXISTS preference_ids ON preference_proposals(preference_id);
      `);
      for (const table of tables) for (const operation of ['UPDATE', 'DELETE']) this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
        BEGIN SELECT RAISE(ABORT, 'preference history is immutable'); END;`);
    });
  }
  ready() { return tables.every(t => this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)); }
  proposal(id) {
    const row = this.db.prepare(`SELECT p.*,e.producer,e.session,e.project_id,e.recorded_at,j.slug AS project
      FROM preference_proposals p JOIN events e ON e.id=p.event_id JOIN projects j ON j.id=e.project_id WHERE p.event_id=?`).get(id);
    if (!row) throw new Error('unknown preference proposal');
    return { ...row, document: JSON.parse(row.document) };
  }
  current(id) {
    return this.db.prepare(`SELECT r.id AS revision,p.event_id FROM preference_reviews r
      JOIN preference_proposals p ON p.event_id=r.proposal_id WHERE p.preference_id=? AND r.action='approve' ORDER BY r.seq DESC LIMIT 1`).get(id);
  }
  record(event, project) {
    fields(event, ['id','session','project','type','payload','occurred_at'], ['id','session','project','type','payload']);
    const p = event.payload;
    if (event.type === 'preference_proposal') {
      fields(p, ['preference_id','base_revision','operation','kind','body','scope','exceptions','rationale','effect','evidence'], ['preference_id','base_revision','operation','kind','body','scope','exceptions','rationale','effect']);
      const id = string(p.preference_id, 'preference_id', 100);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error('preference_id must be a slug');
      if (p.base_revision !== null) {
        string(p.base_revision, 'base_revision', 200);
        const base = this.db.prepare(`SELECT p.preference_id FROM preference_reviews r JOIN preference_proposals p ON p.event_id=r.proposal_id WHERE r.id=? AND r.action='approve'`).get(p.base_revision);
        if (base?.preference_id !== id) throw new Error('base_revision must be an approved revision of this preference');
      }
      if (!['set','retire'].includes(p.operation) || !['default','constraint'].includes(p.kind)) throw new Error('invalid preference operation or kind');
      if (p.operation === 'retire' && p.base_revision === null) throw new Error('retirement requires a base revision');
      fields(p.scope, ['kind','domains']);
      if (!['project','workspace'].includes(p.scope.kind)) throw new Error('invalid preference scope');
      const domains = p.scope.domains;
      if (!Array.isArray(domains) || !domains.length || domains.length > 4 || domains.some(d => !['all',...DOMAINS].includes(d)) || new Set(domains).size !== domains.length || (domains.includes('all') && domains.length !== 1)) throw new Error('invalid scope domains');
      if (!Array.isArray(p.exceptions) || p.exceptions.length > 20) throw new Error('exceptions must be an explicit array (max 20)');
      const evidence = this.memory.evidence(p.evidence ?? []);
      const document = { operation: p.operation, kind: p.kind, body: string(p.body, 'body'), scope: { kind: p.scope.kind, domains: [...domains].sort() }, exceptions: p.exceptions.map(e => string(e, 'exception', 1000)), rationale: string(p.rationale, 'rationale'), effect: string(p.effect, 'effect'), evidence: [...new Map(evidence.map(e => [hash(e), e])).values()] };
      const digest = hash({ preference_id: id, base_revision: p.base_revision, project_id: project.id, document });
      this.db.prepare('INSERT INTO preference_proposals VALUES (?,?,?,?,?)').run(event.id, id, p.base_revision, JSON.stringify(document), digest);
    } else {
      fields(p, ['revision','reason','task','domain','outcome']);
      domainCheck(p.domain);
      if (!DOMAINS.includes(p.domain) || !['succeeded','failed','unknown'].includes(p.outcome)) throw new Error('invalid use domain or outcome');
      const revision = string(p.revision, 'revision', 200);
      const r = this.db.prepare("SELECT proposal_id FROM preference_reviews WHERE id=? AND action='approve'").get(revision);
      if (!r) throw new Error('use must reference an approved revision');
      const proposal = this.proposal(r.proposal_id), d = proposal.document;
      if (d.operation !== 'set' || !this.matches(proposal, project.id, p.domain)) throw new Error('revision does not apply to this project/domain');
      const document = { reason: string(p.reason,'reason'), task: string(p.task,'task'), domain:p.domain, outcome:p.outcome };
      this.db.prepare('INSERT INTO preference_uses VALUES (?,?,?)').run(event.id, revision, JSON.stringify(document));
    }
  }
  matches(p, projectId, domain) {
    return (!projectId || p.document.scope.kind === 'workspace' || p.project_id === projectId)
      && (!domain || p.document.scope.domains.includes('all') || p.document.scope.domains.includes(domain));
  }
  view({ project, domain, as_of = new Date().toISOString() } = {}) {
    domainCheck(domain);
    if (!Number.isFinite(Date.parse(as_of))) throw new Error('invalid as_of');
    const when = new Date(as_of).toISOString(), projectId = project ? this.memory.project(project).id : null;
    const out = { state: this.ready() ? 'ready' : 'uninitialized', active_count: 0, pending_count: 0, incomplete: !this.ready(), lookup: 'memory_preferences', notice: POLICY_NOTICE, scope_check: domain ? 'Check exceptions and overlapping rules.' : 'Domain unspecified: check each rule before use.', active: [], pending: [], history: [], uses: [] };
    if (out.state === 'uninitialized') return out;
    // ponytail: full scan suits a small explicit register; add SQL pagination if it grows large.
    const proposals = this.db.prepare(`SELECT p.event_id FROM preference_proposals p JOIN events e ON e.id=p.event_id WHERE e.recorded_at<=? AND e.occurred_at<=? ORDER BY e.seq`).all(when,when).map(p => this.proposal(p.event_id));
    const reviews = this.db.prepare(`SELECT r.*,l.pid,l.tty,l.kind,l.details,l.created_at FROM preference_reviews r JOIN preference_launches l ON l.id=r.launch_id WHERE r.recorded_at<=? ORDER BY r.seq`).all(when).map(r => ({ id:r.id, seq:r.seq, proposal_id:r.proposal_id, use_id:r.use_id, action:r.action, request:JSON.parse(r.request), recorded_at:r.recorded_at, source:{ launch_id:r.launch_id, pid:r.pid, tty:!!r.tty, kind:r.kind, details:JSON.parse(r.details), created_at:r.created_at } }));
    const byEvent = new Map(proposals.map(p => [p.event_id,p])), byRevision = new Map(), current = new Map(), decided = new Map();
    for (const r of reviews) {
      if (r.proposal_id) decided.set(r.proposal_id,r);
      const p = byEvent.get(r.proposal_id);
      if (r.action === 'approve' && p) { const revision = { ...p, revision:r.id, approval:r }; byRevision.set(r.id,revision); current.set(p.preference_id,revision); }
    }
    const visible = p => p && this.matches(p,projectId,domain);
    const decorate = p => ({ ...p, producer_verified:false, document:{ ...p.document, evidence:p.document.evidence.map(e => {
      const s = this.db.prepare('SELECT * FROM sources WHERE id=?').get(e.source_id);
      return { ...e, path:s.path, source_changed:s.current_hash !== e.hash, archived:!!s.archived };
    }) } });
    out.active = [...current.values()].filter(p => p.document.operation === 'set' && visible(p)).sort((a,b) => Number(b.document.scope.kind === 'project') - Number(a.document.scope.kind === 'project') || Number(!b.document.scope.domains.includes('all')) - Number(!a.document.scope.domains.includes('all')) || a.approval.seq - b.approval.seq).map(decorate);
    for (const p of proposals) {
      const before = byRevision.get(p.base_revision) ?? null, latest = current.get(p.preference_id) ?? null, review = decided.get(p.event_id) ?? null;
      if (!visible(p) && !visible(before) && !visible(latest)) continue;
      const item = { ...decorate(p), before:before ? decorate(before) : null, current:latest ? decorate(latest) : null, review, stale:(latest?.revision ?? null) !== p.base_revision };
      out.history.push(item);
      if (!review) out.pending.push(item);
    }
    const uses = this.db.prepare(`SELECT u.*,e.producer,e.session,e.project_id,e.recorded_at FROM preference_uses u JOIN events e ON e.id=u.event_id WHERE e.recorded_at<=? AND e.occurred_at<=? ORDER BY e.seq DESC`).all(when,when);
    for (const u of uses) {
      const p = byRevision.get(u.revision), d = JSON.parse(u.document);
      if (!p || (projectId && u.project_id !== projectId) || (domain && d.domain !== domain)) continue;
      const alignment = reviews.filter(r => r.use_id === u.event_id);
      out.uses.push({ ...u, document:d, preference_id:p.preference_id, preference:decorate(p), producer_verified:false, current_revision:current.get(p.preference_id)?.revision, stale_application:current.get(p.preference_id)?.revision !== u.revision, alignment:alignment.at(-1)?.request.alignment ?? 'unknown', alignment_history:alignment });
    }
    out.active_count = out.active.length; out.pending_count = out.pending.length;
    return out;
  }
}
