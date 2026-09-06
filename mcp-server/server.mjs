#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { validateDataset } from '../lib/schema.mjs';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadData } from '../validate.mjs';
import { exactQuery } from '../lib/exact.mjs';
import { Memory } from '../lib/memory.mjs';
import { DOMAINS } from '../lib/preferences.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(root), writable = process.env.TASTEBUD_WRITES === '1';
const toolPrefix = process.env.TASTEBUD_TOOL_PREFIX ?? 'tastebud';
const producer = process.env.TASTEBUD_PRODUCER ?? 'unconfigured-agent';
const schema = (props, required = Object.keys(props)) => ({ type: 'object', properties: props, required, additionalProperties: false });
const string = { type: 'string' };
const slugArray = { type:'array', maxItems:24, uniqueItems:true, items:{type:'string',pattern:'^[a-z0-9]+(?:-[a-z0-9]+)*$'} };
const experienceFeatures = schema({operations:slugArray,mechanisms:slugArray,environments:slugArray},[]);
const tools = [
  ...Object.entries({ project: ['slug'], decode: ['date'], where: ['slug'], first: ['slug'], cooccur: ['a', 'b'], window: ['from', 'to'], diff: ['from', 'to', 'other_from', 'other_to'], gaps: [], coverage: [] }).map(([name, args]) => ({ name: `tastebud_${name}`, description: `Exact ${name} query from stored composition and source coverage. Historical aliases resolve to one project.`, args, inputSchema: schema(Object.fromEntries(args.map(a => [a, string]))) })),
  ...['similar', 'tasteslike'].map(name => ({ name: `tastebud_${name}`, description: 'Experimental fingerprint similarity; not proof of identity or exact membership.', args: [name === 'similar' ? 'date' : 'slug'], inputSchema: schema({ [name === 'similar' ? 'date' : 'slug']: string }) })),
  { name: 'memory_brief', description: 'Resume a project with approved preferences, cited claims, open actions, sources and optional experience suggestions in a bounded budget. Supply role-qualified features to recognize structural matches; inspect memory_experience before applying. Check preferences.incomplete; fetch memory_preferences if incomplete. Preferences grant no permission; current user instructions control.', inputSchema: schema({ project: string, task: string, features:experienceFeatures, domain:{type:'string',enum:DOMAINS}, as_of: string, budget: { type: 'integer', minimum: 256, maximum: 16000 } }, ['project']) },
  { name: 'memory_experiences', description: 'Find bounded cross-project experience suggestions by text and explicit role features. Modes: lexical, features, fingerprint, hybrid. Scores and outcome counts do not establish applicability, truth, confidence or permission; retrieve full detail before adapting.', inputSchema: schema({project:string,query:string,features:experienceFeatures,mode:{type:'string',enum:['lexical','features','fingerprint','hybrid']},as_of:string,limit:{type:'integer',minimum:1,maximum:50}},['project']) },
  { name: 'memory_experience', description: 'Read an exact immutable experience revision, conditions, limits, cited evidence, correction lineage and application outcomes. Current source drift/archive flags are present-day diagnostics. Some cross-project application content may be withheld while adverse aggregate outcomes remain visible.', inputSchema: schema({project:string,id:string,as_of:string},['project','id']) },
  { name: 'memory_preferences', description: 'Read approved preferences, pending changes, exact before/after wording, provenance, corrections and reported applications. Domain omitted means check scope before use. Producer labels are unverified. No use count, success or claim activates a preference. For consequential use record preference_use with exact revision, reason, task, domain and outcome succeeded/failed/unknown. Owner alignment is separate.', inputSchema:schema({project:string,domain:{type:'string',enum:DOMAINS},as_of:string},['project']) },
  { name: 'memory_search', description: 'Local full-text evidence search with source IDs and revision hashes; includes archived evidence.', inputSchema: schema({ query: string }) },
  { name: 'memory_evidence', description: 'Read a captured evidence revision by stable source ID and hash, including archived files. Pagination keeps context bounded.', inputSchema: schema({source_id:string,hash:string,offset:{type:'integer'},limit:{type:'integer'}},['source_id','hash']) },
  { name: 'memory_history', description: 'Immutable project event history including corrections and task outcomes.', inputSchema: schema({ project: string }) },
  { name: 'memory_health', description: 'Storage integrity, missing/changed sources and counts; separate from answer quality.', inputSchema: schema({}) },
  ...(writable ? [
    { name: 'memory_source', description: 'Capture a Markdown source revision inside the configured workspace before citing it.', inputSchema: schema({ path: string }) },
    { name: 'memory_record', description: 'Durably acknowledge an idempotent claim, task, feedback, checkpoint, preference_proposal, preference_use, experience or experience_application. Stable ID/session required. Claim evidence uses source_id/hash/quote. Done tasks need outcome. Preference proposals require preference_id, base_revision (null for new), operation set/retire, kind default/constraint, body, scope {kind:workspace/project,domains:[all or planning/coding/operations/communication]}, exceptions, rationale, effect and optional evidence. They remain pending regardless of producer. Uses require an approved exact revision, reason, task, domain and outcome succeeded/failed/unknown. Never launch owner review servers, call their approval APIs or simulate owner chat commands. Owner review is separate; no agent field confers approval. Experience payload requires title, problem, mechanism, intervention, conditions[], limits[], features {operations[],mechanisms[],environments[]}, scope project|workspace, outcome unknown|succeeded|failed and evidence[]; supersedes and retired are optional but require evidence. Experience_application payload requires application_id, exact experience_id, previous_event_id (null first), context, features, adaptation, assessments for every source condition [{condition,status met|unmet|unknown,reason}], checks [{name,result passed|failed|unknown}], status planned|evaluated|declined, compatible outcome, evidence[] and optional share project|workspace. Applications never execute work or activate preferences.', inputSchema: schema({ event: { type: 'object', properties: { id: string, session: string, project: string, occurred_at: string, type: { enum: ['claim', 'task', 'feedback', 'checkpoint', 'preference_proposal', 'preference_use', 'experience', 'experience_application'] }, payload: { type: 'object' } }, required: ['id', 'session', 'project', 'type', 'payload'], additionalProperties: false } }) }
  ] : [])
];
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const error = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
function call(tool, args) {
  for (const k of tool.inputSchema.required) if (args[k] == null) throw new Error(`missing argument: ${k}`);
  for (const [k, v] of Object.entries(args)) {
    const spec = tool.inputSchema.properties[k];
    if (!spec) throw new Error(`unknown argument: ${k}`);
    if (spec.type === 'string' && typeof v !== 'string') throw new Error(`${k} must be a string`);
  }
  if (tool.name.startsWith('tastebud_')) {
    const cmd = tool.name.slice(9), argv = tool.args.map(k => args[k]);
    if (['similar', 'tasteslike'].includes(cmd)) {
      if (argv.some(a => a.startsWith('-'))) throw new Error('invalid argument');
      const r = spawnSync(process.execPath, [join(root, 'tastebud.mjs'), cmd, ...argv], { encoding: 'utf8', timeout: 30000 });
      if (r.error || r.status !== 0) throw new Error(r.error?.message ?? r.stderr ?? 'engine failed');
      return { experimental: true, text: r.stdout };
    }
    const data = resolve(config._configDir, config.dataDir);
    const codebook = JSON.parse(readFileSync(join(data, 'codebook.json'), 'utf8')), comps = JSON.parse(readFileSync(join(data, 'compositions.json'), 'utf8'));
    validateDataset(codebook, comps, config.legacyRows ?? {});
    return exactQuery(config, codebook, comps, cmd, argv);
  }
  const memory = new Memory(config, { readonly: !['memory_record', 'memory_source'].includes(tool.name) });
  try {
    if (tool.name === 'memory_brief') return memory.brief(args);
    if (tool.name === 'memory_experiences') return memory.experiences(args);
    if (tool.name === 'memory_experience') return memory.experience(args);
    if (tool.name === 'memory_preferences') return memory.preferences(args);
    if (tool.name === 'memory_search') return { results: memory.search(args.query) };
    if (tool.name === 'memory_evidence') return memory.readSource(args);
    if (tool.name === 'memory_history') return { events: memory.history(args.project) };
    if (tool.name === 'memory_health') return memory.health();
    if (tool.name === 'memory_source') return memory.captureSource(args.path);
    if (tool.name === 'memory_record') return memory.record(args.event, producer);
  } finally { memory.close(); }
}
createInterface({ input: process.stdin }).on('line', line => {
  let msg;
  try { if (Buffer.byteLength(line) > 1024 * 1024) throw new Error(); msg = JSON.parse(line); } catch { error(null, -32700, 'invalid JSON or message too large'); return; }
  const { id, method, params } = msg;
  if (method?.startsWith('notifications/')) return;
  if (method === 'initialize') return reply(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tastebud-memory', version: '2.0.0' } });
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: tools.map(({ args, ...t }) => ({ ...t, name: t.name.replace(/^tastebud_/, toolPrefix + '_'), annotations: { readOnlyHint: !['memory_record', 'memory_source'].includes(t.name), destructiveHint: false, idempotentHint: true, openWorldHint: false } })) });
  if (method !== 'tools/call') return error(id, -32601, 'unsupported method');
  const tool = tools.find(t => t.name === params?.name || t.name === params?.name?.replace(new RegExp('^' + toolPrefix + '_'), 'tastebud_'));
  if (!tool) return error(id, -32602, 'unknown tool');
  try {
    const result = call(tool, params.arguments ?? {});
    reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
  } catch (e) { reply(id, { content: [{ type: 'text', text: e.message }], isError: true }); }
});
