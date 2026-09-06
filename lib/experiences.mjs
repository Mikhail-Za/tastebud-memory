import { hash, slugRE } from './schema.mjs';
import { bundle, cosine } from './fingerprints.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const EXPERIENCE_PROTOCOL = 'tastebud-experience/1';
export const FINGERPRINT = { algorithm: 'fnv1a-mulberry32-bundle-cosine', version: 1, dimensions: 512, hybrid_weights: { lexical: 0.55, fingerprint: 0.45 }, noise_gate: 'at-least-one-exact-operation-or-mechanism' };
const ROLES = ['operations', 'mechanisms', 'environments'];
const MODES = ['lexical', 'features', 'fingerprint', 'hybrid'];
const OUTCOMES = ['unknown', 'succeeded', 'failed'];
const APP_OUTCOMES = ['unknown', 'succeeded', 'failed', 'not-applied'];
const own = (object, allowed, label) => {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(`${label} must be an object`);
  const extra = Object.keys(object).filter(k => !allowed.includes(k));
  if (extra.length) throw new Error(`${label} has unknown field: ${extra[0]}`);
};
const text = (value, label, max = 4000) => {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > max) throw new Error(`${label} must be trimmed nonempty text (max ${max})`);
  return value;
};
const list = (value, label, max = 32, itemMax = 1000) => {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be an array (max ${max})`);
  const out = value.map((v, i) => text(v, `${label}[${i}]`, itemMax));
  if (new Set(out).size !== out.length) throw new Error(`${label} contains duplicates`);
  return out;
};
const tag = (value, label) => {
  text(value, label, 80);
  if (!slugRE.test(value)) throw new Error(`${label} must be a normalized slug`);
  return value;
};
export function features(value, { required = true } = {}) {
  if (value == null && !required) value = {};
  own(value, ROLES, 'features');
  const out = {};
  for (const role of ROLES) out[role] = list(Object.hasOwn(value,role) ? value[role] : [], `features.${role}`, 24, 80).map((v, i) => tag(v, `features.${role}[${i}]`));
  if (required && !ROLES.some(role => out[role].length)) throw new Error('features require at least one role tag');
  return out;
}
const qualified = value => ROLES.flatMap(role => value[role].map(v => `${role}:${v}`));
const words = value => new Set(String(value).toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
const timestamp = value => {
  if (value == null) return new Date().toISOString();
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('as_of must be a valid ISO timestamp');
  return new Date(value).toISOString();
};
// ponytail: bounded full scans avoid a schema migration; add a projection/index only after measured event volume makes this slow.
const rows = (memory, when = new Date().toISOString()) => memory.db.prepare("SELECT e.*,p.slug project FROM events e JOIN projects p ON p.id=e.project_id WHERE e.type IN ('experience','experience_application') AND e.recorded_at<=? AND e.occurred_at<=? ORDER BY e.seq").all(when, when).map(r => ({ ...r, payload: JSON.parse(r.payload) }));
const priorRows = (memory, seq) => memory.db.prepare("SELECT e.*,p.slug project FROM events e JOIN projects p ON p.id=e.project_id WHERE e.type IN ('experience','experience_application') AND e.seq<? ORDER BY e.seq").all(seq).map(r => ({ ...r, payload: JSON.parse(r.payload) }));
const lineageCurrent = (experiences, candidate) => !experiences.some(row => row.payload.supersedes === candidate.id);
const sourceVisible = (row, project) => row.project === project.slug || row.payload.scope === 'workspace';
const ref = (memory, id, row, type) => {
  id = text(id, `${type} reference id`, 200);
  const prior = memory.db.prepare('SELECT e.*,p.slug project FROM events e JOIN projects p ON p.id=e.project_id WHERE e.id=?').get(id);
  if (!prior || prior.type !== type) throw new Error(`${id} must reference an existing ${type} event`);
  if (prior.seq >= row.seq || prior.occurred_at > row.occurred_at || prior.recorded_at > row.recorded_at) throw new Error(`${id} must be a strictly earlier event by sequence, occurred_at and recorded_at`);
  return { ...prior, payload: JSON.parse(prior.payload) };
};
const evidence = (memory, value, required) => {
  if (!Array.isArray(value ?? [])) throw new Error('evidence must be an array');
  const items = (value ?? []).map((e,i) => {
    own(e, ['source_id','hash','quote'], `evidence[${i}]`);
    const source_id=text(e.source_id,`evidence[${i}].source_id`,200), digest=text(e.hash,`evidence[${i}].hash`,64), quote=text(e.quote,`evidence[${i}].quote`,4000);
    if(!/^[a-f0-9]{64}$/.test(digest))throw new Error(`evidence[${i}].hash must be lowercase SHA256`);
    return {source_id,hash:digest,quote};
  });
  const out = memory.evidence(items);
  if (required && !out.length) throw new Error('matching captured evidence is required');
  return out;
};
const size = payload => { if (Buffer.byteLength(JSON.stringify(payload)) > 64 * 1024) throw new Error('experience payload exceeds 64 KiB'); };

export function validateExperience(memory, row, payload) {
  own(payload, ['title','problem','mechanism','intervention','conditions','limits','features','scope','outcome','evidence','supersedes','retired'], 'experience payload');
  size(payload);
  payload.title = text(payload.title, 'title', 300);
  payload.problem = text(payload.problem, 'problem');
  payload.mechanism = text(payload.mechanism, 'mechanism');
  payload.intervention = text(payload.intervention, 'intervention');
  payload.conditions = list(payload.conditions, 'conditions');
  payload.limits = list(payload.limits, 'limits');
  payload.features = features(payload.features);
  if (!['project','workspace'].includes(payload.scope)) throw new Error('scope must be project or workspace');
  if (!OUTCOMES.includes(payload.outcome)) throw new Error('invalid experience outcome');
  if (Object.hasOwn(payload,'retired') && typeof payload.retired !== 'boolean') throw new Error('retired must be boolean');
  payload.evidence = evidence(memory, payload.evidence, payload.outcome !== 'unknown' || !!payload.supersedes || !!payload.retired);
  if (payload.supersedes != null) {
    payload.supersedes = text(payload.supersedes, 'supersedes', 200);
    const prior = ref(memory, payload.supersedes, row, 'experience');
    if (prior.project_id !== row.project_id) throw new Error('superseded experience must have the same origin project');
    if (prior.payload.scope !== payload.scope) throw new Error('experience scope cannot change in a correction');
    const all = priorRows(memory,row.seq).filter(r => r.type === 'experience');
    if (!lineageCurrent(all, prior)) throw new Error('experience already superseded; correct its current revision');
    for (let p = prior; p?.payload.supersedes; p = ref(memory, p.payload.supersedes, row, 'experience')) if (p.payload.supersedes === row.id) throw new Error('experience correction cycle');
  }
  return payload;
}

export function validateApplication(memory, row, payload) {
  own(payload, ['application_id','experience_id','previous_event_id','context','features','adaptation','assessments','checks','status','outcome','evidence','share'], 'experience application payload');
  size(payload);
  payload.application_id = tag(payload.application_id, 'application_id');
  payload.experience_id = text(payload.experience_id, 'experience_id', 200);
  if (!Object.hasOwn(payload, 'previous_event_id')) throw new Error('previous_event_id is required (null on first application)');
  if (payload.previous_event_id !== null) payload.previous_event_id = text(payload.previous_event_id, 'previous_event_id', 200);
  payload.context = text(payload.context, 'context');
  payload.features = features(payload.features);
  payload.adaptation = text(payload.adaptation, 'adaptation');
  if (!['planned','evaluated','declined'].includes(payload.status)) throw new Error('invalid application status');
  if (!APP_OUTCOMES.includes(payload.outcome)) throw new Error('invalid application outcome');
  if (!['project','workspace'].includes(payload.share ?? 'project')) throw new Error('share must be project or workspace');
  payload.share ??= 'project';
  const source = ref(memory, payload.experience_id, row, 'experience');
  const all = priorRows(memory,row.seq), experiences = all.filter(r => r.type === 'experience');
  if (source.payload.scope === 'project' && source.project_id !== row.project_id) throw new Error('project-scoped experience is not visible to this project');
  if (source.payload.scope === 'project' && payload.share === 'workspace') throw new Error('project-scoped experience application cannot be workspace-shared');
  const applications = all.filter(r => r.type === 'experience_application' && r.payload.application_id === payload.application_id);
  const current = applications.at(-1);
  if (!current) {
    if (payload.previous_event_id != null) throw new Error('first application previous_event_id must be null');
    if (!lineageCurrent(experiences, source) || source.payload.retired) throw new Error('new application requires a current nonretired experience');
  } else {
    if (current.project_id !== row.project_id) throw new Error(`application_id is workspace-global and already belongs to ${current.project}; prefix it with the target project`);
    if (current.payload.experience_id !== payload.experience_id) throw new Error('application source experience is immutable');
    if (payload.previous_event_id !== current.id) throw new Error('application changed or previous_event_id missing; reread detail before updating');
    ref(memory, payload.previous_event_id, row, 'experience_application');
  }
  if (!Array.isArray(payload.assessments) || payload.assessments.length !== source.payload.conditions.length) throw new Error('assess every source condition exactly once');
  const expected = new Set(source.payload.conditions);
  payload.assessments = payload.assessments.map((a, i) => {
    own(a, ['condition','status','reason'], `assessments[${i}]`);
    const condition = text(a.condition, `assessments[${i}].condition`, 1000), reason = text(a.reason, `assessments[${i}].reason`, 2000);
    if (!expected.delete(condition) || !['met','unmet','unknown'].includes(a.status)) throw new Error('assessment condition/status mismatch');
    return { condition, status: a.status, reason };
  });
  if (expected.size) throw new Error('assess every source condition exactly once');
  if (!Array.isArray(payload.checks) || payload.checks.length > 32) throw new Error('checks must be an array (max 32)');
  payload.checks = payload.checks.map((c, i) => { own(c, ['name','result'], `checks[${i}]`); if (!['passed','failed','unknown'].includes(c.result)) throw new Error('invalid check result'); return { name: text(c.name, `checks[${i}].name`, 200), result: c.result }; });
  if (new Set(payload.checks.map(c => c.name)).size !== payload.checks.length) throw new Error('check names must be unique');
  if (payload.status === 'planned' && payload.outcome !== 'unknown') throw new Error('planned application outcome must be unknown');
  if (payload.status === 'planned' && payload.checks.some(c => c.result !== 'unknown')) throw new Error('planned application check results must be unknown');
  if (payload.status === 'declined' && payload.outcome !== 'not-applied') throw new Error('declined application outcome must be not-applied');
  if (payload.status === 'declined' && payload.checks.some(c => c.result !== 'unknown')) throw new Error('declined application cannot report executed check results');
  if (payload.status === 'evaluated' && payload.outcome === 'not-applied') throw new Error('evaluated application cannot be not-applied');
  if (payload.status === 'evaluated' && payload.outcome === 'unknown' && payload.checks.some(c => c.result === 'failed')) throw new Error('failed check requires a failed evaluated outcome');
  if (payload.outcome === 'succeeded' && payload.checks.some(c => c.result !== 'passed')) throw new Error('succeeded outcome contradicts check results');
  if (payload.outcome === 'failed' && !payload.checks.some(c => c.result === 'failed')) throw new Error('failed outcome requires a failed check');
  const known = payload.status === 'evaluated' && ['succeeded','failed'].includes(payload.outcome);
  if (known && !payload.checks.length) throw new Error('known evaluated outcome requires checks');
  payload.evidence = evidence(memory, payload.evidence, known);
  return payload;
}

function family(experiences, experience) {
  const ids = new Set([experience.id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const e of experiences) {
      if (ids.has(e.id) && e.payload.supersedes && !ids.has(e.payload.supersedes)) { ids.add(e.payload.supersedes); changed = true; }
      if (ids.has(e.payload.supersedes) && !ids.has(e.id)) { ids.add(e.id); changed = true; }
    }
  }
  return ids;
}

const diagnosticEvidence = (memory, evidence) => evidence.map(e => {
  const source = memory.db.prepare('SELECT path,current_hash,archived FROM sources WHERE id=?').get(e.source_id), path=source&&resolve(memory.root,source.path);
  let filesystem_status;
  if (!source) filesystem_status='missing-record';
  else if (!existsSync(path)) filesystem_status=source.archived?'archived-in-store':'missing-file';
  else try { filesystem_status=hash(readFileSync(path))===source.current_hash?'current':'changed'; } catch { filesystem_status='unreadable'; }
  return { ...e, path: source?.path, captured_source_changed: source?.current_hash !== e.hash, filesystem_status, archived: !!source?.archived, diagnostics_as_of: 'current' };
});

function applicationSummary(memory, all, experience, reader, includeDetails=true) {
  const experiences = all.filter(r => r.type === 'experience'), ids = family(experiences, experience);
  const currentExperience = experiences.filter(e => ids.has(e.id) && lineageCurrent(experiences, e)).at(-1) ?? experience;
  const apps = all.filter(r => r.type === 'experience_application' && ids.has(r.payload.experience_id));
  const latest = [...new Map(apps.map(r => [r.payload.application_id, r])).values()];
  const counts = { planned: 0, succeeded: 0, failed: 0, unknown: 0, declined: 0, stale: 0 };
  for (const app of latest) {
    if (app.payload.status === 'declined') counts.declined++; else if (app.payload.status === 'planned') counts.planned++; else counts[app.payload.outcome]++;
    if (app.payload.experience_id !== currentExperience.id) counts.stale++;
  }
  const expose = app => {
    const shared = app.project === reader.slug || app.payload.share === 'workspace';
    const condition_status = Object.fromEntries(['met','unmet','unknown'].map(status => [status, app.payload.assessments.filter(a => a.status === status).length]));
    const fully_validated = app.payload.status === 'evaluated' && app.payload.outcome === 'succeeded' && app.payload.evidence.length > 0 && app.payload.experience_id === currentExperience.id && !currentExperience.payload.retired && condition_status.unmet === 0 && condition_status.unknown === 0 && app.payload.checks.length > 0 && app.payload.checks.every(c => c.result === 'passed');
    return { application_id: app.payload.application_id, experience_id: app.payload.experience_id, event_id: app.id, latest_event_id:app.id, seq:app.seq, occurred_at:app.occurred_at, recorded_at:app.recorded_at, project: app.project, status: app.payload.status, outcome: app.payload.outcome, stale_application: app.payload.experience_id !== currentExperience.id, content_withheld: !shared, ...(shared ? { context: app.payload.context, adaptation: app.payload.adaptation, assessments: app.payload.assessments, condition_status, checks: app.payload.checks, fully_validated, evidence: diagnosticEvidence(memory,app.payload.evidence), share: app.payload.share } : {}) };
  };
  const priority = values => [...values].sort((a,b) => Number(b.payload.outcome === 'failed')-Number(a.payload.outcome === 'failed') || b.seq-a.seq);
  const historical_counts = { events: apps.length, failed: apps.filter(a => a.payload.outcome === 'failed').length, declined: apps.filter(a => a.payload.status === 'declined').length };
  const histories = priority(latest), history = priority(apps);
  const targets = [...new Set(apps.map(a => a.project))].sort();
  return { counts, historical_counts, target_projects: targets.slice(0, 50), target_projects_omitted: Math.max(0, targets.length-50), histories: includeDetails ? histories.slice(0, 20).map(expose) : [], omitted: Math.max(0, histories.length-20), history: includeDetails ? history.slice(0, 20).map(expose) : [], history_omitted: Math.max(0, history.length-20) };
}

export function candidates(memory, args = {}) {
  own(args, ['project','query','features','mode','as_of','limit'], 'experience query');
  let { project: name, query = '', features: requested, mode, as_of, limit = 8 } = args;
  name=text(name,'project',200);
  if (typeof query !== 'string') throw new Error('query must be a string');
  const project = memory.project(name), when = timestamp(as_of);
  mode ??= requested == null ? 'lexical' : 'features';
  if (!MODES.includes(mode)) throw new Error('invalid experience retrieval mode');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be an integer from 1 to 50');
  const wanted = requested == null ? null : features(requested);
  if ((mode === 'features' || mode === 'fingerprint') && !wanted) throw new Error(`${mode} mode requires features`);
  if (!String(query).trim() && !wanted) return { protocol: EXPERIENCE_PROTOCOL, mode, suggestions: [], notice: 'No query or structural features supplied; no speculative matches.' };
  const all = rows(memory, when), exps = all.filter(r => r.type === 'experience'), qwords = words(query), qlabels = wanted ? qualified(wanted) : [], qbundle = wanted ? bundle(qlabels, FINGERPRINT.dimensions) : null;
  const suggestions = exps.filter(e => lineageCurrent(exps, e) && !e.payload.retired && sourceVisible(e, project)).map(e => {
    const labels = qualified(e.payload.features), matched = Object.fromEntries(ROLES.map(role => [role, e.payload.features[role].filter(v => wanted?.[role].includes(v))]));
    const structural = matched.operations.length + matched.mechanisms.length, shared = Object.values(matched).flat().length, ewords = words([e.payload.title,e.payload.problem,e.payload.mechanism,e.payload.intervention,...e.payload.conditions,...e.payload.limits].join(' '));
    const lexical = qwords.size ? [...qwords].filter(w => ewords.has(w)).length / qwords.size : 0;
    const exact = wanted && structural ? shared / new Set([...qlabels, ...labels]).size : 0;
    const fingerprint = wanted && structural ? Math.max(0, cosine(qbundle, bundle(labels, FINGERPRINT.dimensions))) : 0;
    const score = mode === 'lexical' ? lexical : mode === 'features' ? exact : mode === 'fingerprint' ? fingerprint : wanted ? FINGERPRINT.hybrid_weights.lexical * lexical + FINGERPRINT.hybrid_weights.fingerprint * fingerprint : lexical;
    const applications = applicationSummary(memory, all, e, project, false);
    const lineage = [...family(exps, e)].sort((a,b) => exps.find(x=>x.id===a).seq-exps.find(x=>x.id===b).seq);
    return { id: e.id, hash: e.payload_hash, origin_project: e.project, title: e.payload.title, reported_outcome: e.payload.outcome, scope: e.payload.scope, lineage: lineage.slice(-20), lineage_omitted: Math.max(0,lineage.length-20), algorithm: FINGERPRINT, scores: { lexical, features: exact, fingerprint, selected: score }, matched_features: matched, environment_differences: wanted ? { requested_only: wanted.environments.filter(v => !e.payload.features.environments.includes(v)), source_only: e.payload.features.environments.filter(v => !wanted.environments.includes(v)) } : null, conditions_count: e.payload.conditions.length, limits_count: e.payload.limits.length, application_counts: applications.counts, application_history_counts: applications.historical_counts, application_projects: applications.target_projects, application_projects_omitted: applications.target_projects_omitted, requires_detail: { tool: 'memory_experience', id: e.id }, notice: 'Suggestion only; inspect conditions, limits, evidence and applications before deciding applicability.' };
  }).filter(c => c.scores.selected > 0).sort((a,b) => b.scores.selected-a.scores.selected || a.id.localeCompare(b.id)).slice(0, limit);
  return { protocol: EXPERIENCE_PROTOCOL, mode, algorithm: FINGERPRINT, suggestions };
}

export function detail(memory, args = {}) {
  own(args, ['project','id','as_of'], 'experience detail query');
  let { project:name,id,as_of }=args;
  name=text(name,'project',200);
  id = text(id, 'experience id', 200);
  const project = memory.project(name), when = timestamp(as_of), all = rows(memory, when), exps = all.filter(r => r.type === 'experience'), event = exps.find(e => e.id === id);
  if (!event || !sourceVisible(event, project)) throw new Error('experience not found or not visible to this project');
  const lineage = [], seen = new Set(); let cursor = event;
  while (cursor && !seen.has(cursor.id)) { lineage.unshift(cursor.id); seen.add(cursor.id); cursor = exps.find(e => e.id === cursor.payload.supersedes); }
  let current = event; while (true) { const next = exps.find(e => e.payload.supersedes === current.id); if (!next) break; lineage.push(next.id); current = next; }
  const applications = applicationSummary(memory, all, event, project);
  const boundedLineage=lineage.slice(-50);
  return { protocol: EXPERIENCE_PROTOCOL, id: event.id, hash: event.payload_hash, origin_project: event.project, occurred_at: event.occurred_at, recorded_at: event.recorded_at, ...event.payload, evidence: diagnosticEvidence(memory,event.payload.evidence), lineage:boundedLineage, lineage_omitted:lineage.length-boundedLineage.length, current_event_id: current.id, current: current.id === event.id, event_retired:!!event.payload.retired, retired: !!current.payload.retired, applications: applications.histories, application_counts: applications.counts, application_history_counts:applications.historical_counts, applications_omitted: applications.omitted, application_history:applications.history, application_history_omitted:applications.history_omitted, application_projects:applications.target_projects, application_projects_omitted:applications.target_projects_omitted, complete_history: [...new Set([event.project,...applications.target_projects])].map(project => ({ tool:'memory_history', project })), notice: 'Reported outcomes and matching quotes are evidence reports, not independent verification or permission.' };
}
