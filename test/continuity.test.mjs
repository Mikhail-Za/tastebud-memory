import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, appendFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Memory } from '../lib/memory.mjs';
import { validateDay, validateDataset, aliasIndex, hash } from '../lib/schema.mjs';
import { exactQuery } from '../lib/exact.mjs';
import { ingest } from '../lib/ingest.mjs';
import { applyOutbox } from '../lib/outbox.mjs';

const engine = resolve('tastebud.mjs'), cli = resolve('memory-cli.mjs'), mcp = resolve('mcp-server/server.mjs');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tastebud-test-'));
  for (const name of ['data', 'logs', 'projects', 'candidates', 'telemetry', 'memory/projects']) mkdirSync(join(root, name), { recursive: true });
  const config = { _configDir: root, dataDir: './data', workspaceDir: '.', workspaceId: 'test-workspace', logDirs: ['./logs'], projectsDir: './projects', candidatesDir: './candidates', memoryDb: './data/memory.sqlite', timezone: 'America/Chicago', dimensions: 4096 };
  const cb = { projects: { garden: { aliases: ['old-garden'], class: 'product' }, weather: { aliases: [], class: 'product' } } };
  writeFileSync(join(root, 'tastebud.config.json'), JSON.stringify(config));
  writeFileSync(join(root, 'data/codebook.json'), JSON.stringify(cb));
  writeFileSync(join(root, 'data/compositions.json'), JSON.stringify({ days: [] }));
  const memory = new Memory(config);
  memory.registerProject({ slug: 'garden', aliases: ['old-garden'] });
  return { root, config, cb, memory, data: join(root, 'data') };
}
function run(file, args, root, extra = {}) { return spawnSync(process.execPath, [file, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...extra } }); }
function child(file, args, root, extra = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [file, ...args], { cwd: root, env: { ...process.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', status => resolve({ status, out, err }));
  });
}
const event = (id, type, payload) => ({ id, session: 'test-session', project: 'garden', type, payload });
const day = date => ({ date, major: [{ slug: 'garden', w: 1 }], minor: [], new: [] });

test('raw schema rejects invalid weights, dates, duplicate slugs, alias collisions and duplicate dates', () => {
  for (const bad of [ { ...day('2026-02-30') }, { ...day('2026-01-01'), major: [{ slug: 'garden', w: 2 }, { slug: 'weather', w: -1 }] }, { ...day('2026-01-01'), major: [{ slug: 'garden', w: .5 }, { slug: 'garden', w: .5 }] }, { ...day('2026-01-01'), minor: ['garden'] } ]) assert.throws(() => validateDay(bad));
  assert.throws(() => aliasIndex({ projects: { a: { aliases: ['same'] }, b: { aliases: ['SAME'] } } }));
  assert.throws(() => validateDataset({ projects: {} }, { days: [day('2026-01-01'), day('2026-01-01')] }));
});
test('exact aliases, tiny weights, windows and missing coverage retain table truth', () => {
  const f = fixture();
  const comps = { days: [{ date: '2026-01-01', major: [{ slug: 'old-garden', w: .999 }, { slug: 'weather', w: .001 }], minor: [] }] };
  writeFileSync(join(f.root, 'logs/2026-01-02.md'), 'An untagged day');
  assert.equal(exactQuery(f.config, f.cb, comps, 'first', ['garden']).first, '2026-01-01');
  assert.equal(exactQuery(f.config, f.cb, comps, 'window', ['2026-01-01', '2026-01-02']).projects.length, 2);
  assert.equal(exactQuery(f.config, f.cb, comps, 'coverage').rows.find(r => r.date === '2026-01-02').status, 'untagged');
  f.memory.close();
});
test('codebook sync removes and transfers aliases atomically while retaining project history', () => {
  const f = fixture(), id = f.memory.project('garden').id;
  f.memory.record(event('before-unalias', 'claim', { kind: 'fact', body: 'Preserve this history.' }), 'agent-a');
  assert.equal(run(cli, ['sync'], f.root).status, 0);
  assert.equal(run(engine, ['unalias', 'old-garden'], f.root).status, 0);
  const synced = run(cli, ['sync'], f.root);
  assert.equal(synced.status, 0, synced.stderr);
  assert.throws(() => f.memory.brief({ project: 'old-garden' }), /unknown project/);
  assert.equal(f.memory.project('garden').id, id);
  assert.equal(f.memory.history('garden')[0].id, 'before-unalias');
  f.memory.syncProjects([{ slug: 'garden', aliases: ['shared'] }, { slug: 'weather' }]);
  f.memory.syncProjects([{ slug: 'weather', aliases: ['shared'] }, { slug: 'garden' }]);
  assert.equal(f.memory.project('shared').slug, 'weather');
  assert.throws(() => f.memory.syncProjects([{ slug: 'garden', aliases: ['duplicate'] }, { slug: 'weather', aliases: ['duplicate'] }]), /alias collision/);
  assert.equal(f.memory.project('shared').slug, 'weather');
  assert.equal(f.memory.project('garden').id, id);
  assert.equal(f.memory.history('garden').length, 1);
  f.memory.close();
});
test('ingestion dry run, strict date, source edit review, immutable proposal and correction history', () => {
  const f = fixture(), source = join(f.root, 'logs/2026-01-01.md'); writeFileSync(source, 'First evidence');
  const input = { data: f.data, date: '2026-01-01', raw: day('2026-01-01'), sourcePath: source };
  const before = readFileSync(join(f.data, 'compositions.json'), 'utf8');
  assert.equal(ingest(input).status, 'dry-run');
  assert.equal(readFileSync(join(f.data, 'compositions.json'), 'utf8'), before);
  assert.throws(() => ingest({ ...input, raw: day('1999-01-01'), write: true }));
  assert.equal(ingest({ ...input, write: true }).status, 'ingested');
  writeFileSync(source, 'Corrected evidence');
  assert.equal(ingest({ ...input, write: true }).status, 'needs-review');
  assert.equal(ingest({ ...input, write: true, revise: true }).status, 'revised');
  assert.equal(readdirSync(join(f.data, 'source-versions')).length, 2);
  assert.equal(readdirSync(join(f.data, 'composition-revisions')).length, 1);
  f.memory.close();
});
test('concurrent ingestion acknowledges both dates without a lost update', async () => {
  const f = fixture(); f.memory.close();
  for (const date of ['2026-01-01', '2026-01-02']) {
    writeFileSync(join(f.root, `${date}.json`), JSON.stringify(day(date)));
    writeFileSync(join(f.root, `logs/${date}.md`), `Evidence for ${date}`);
  }
  const rs = await Promise.all(['2026-01-01', '2026-01-02'].map(date => child(cli, ['ingest', date, `${date}.json`, `logs/${date}.md`, '--write'], f.root)));
  for (const r of rs) assert.equal(r.status, 0, r.err);
  assert.equal(JSON.parse(readFileSync(join(f.data, 'compositions.json'))).days.length, 2);
});
test('idempotent receipts reject conflicting ID reuse and rollback invalid events', () => {
  const f = fixture(), e = event('e1', 'claim', { kind: 'fact', body: 'Check irrigation' });
  assert.equal(f.memory.record(e, 'agent-a').duplicate, false);
  assert.equal(f.memory.record(e, 'agent-a').duplicate, true);
  assert.throws(() => f.memory.record(e, 'agent-b'));
  assert.throws(() => f.memory.record(event('bad', 'task', { id: 't', title: 'Ship', status: 'done' }), 'agent-a'));
  assert.equal(f.memory.history('garden').length, 1);
  f.memory.close();
});
test('a cross-agent correction changes current guidance and retains cited history', () => {
  const f = fixture(), path = join(f.root, 'projects/garden.md');
  writeFileSync(path, 'Water daily.\nCorrection: water weekly.');
  const source = f.memory.captureSource(path);
  f.memory.record(event('c1', 'claim', { kind: 'decision', body: 'Water daily.', evidence: [{ ...source, quote: 'Water daily.' }] }), 'agent-a');
  f.memory.record(event('c2', 'claim', { kind: 'decision', body: 'Water weekly.', supersedes: 'c1', evidence: [{ ...source, quote: 'Correction: water weekly.' }] }), 'agent-b');
  const brief = f.memory.brief({ project: 'old-garden', task: 'watering' });
  assert.deepEqual(brief.claims.map(c => c.id), ['c2']);
  assert.equal(brief.claims[0].producer, 'agent-b');
  assert.equal(f.memory.history('garden').length, 2);
  assert.throws(() => f.memory.record(event('c3', 'claim', { kind: 'decision', body: 'Invented', evidence: [{ ...source, quote: 'Not in the file' }] }), 'agent-b'));
  f.memory.close();
});
test('tasks retain dependencies, require completion outcome, and disappear from open brief when done', () => {
  const f = fixture();
  f.memory.record(event('t1', 'task', { id: 'review', title: 'Review changes', status: 'open', owner: 'agent-a' }), 'agent-a');
  f.memory.record(event('t2', 'task', { id: 'ship', title: 'Ship changes', status: 'blocked', dependencies: ['review'], next_action: 'Wait for review' }), 'agent-b');
  f.memory.record(event('t3', 'task', { id: 'review', title: 'Review changes', status: 'done', previous_event_id: 't1', outcome: 'All checks passed' }), 'agent-a');
  assert.deepEqual(f.memory.brief({ project: 'garden' }).open_actions.map(t => t.id), ['ship']);
  f.memory.close();
});
test('brief is bounded and explicitly reports omitted items', () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) f.memory.record(event(`c${i}`, 'claim', { kind: 'fact', body: 'Context '.repeat(80) }), 'agent-a');
  const brief = f.memory.brief({ project: 'garden', budget: 256 });
  assert.ok(Buffer.byteLength(JSON.stringify(brief)) <= 256 * 3);
  assert.ok(brief.omitted.claims > 0);
  f.memory.close();
});
test('crash before SQLite commit leaves no receipt; retries and concurrent writers retain every event', async () => {
  const f = fixture(); f.memory.close();
  writeFileSync(join(f.root, 'crash.json'), JSON.stringify(event('crash', 'claim', { kind: 'fact', body: 'Crash test' })));
  assert.equal(run(cli, ['record', 'crash.json'], f.root, { TASTEBUD_TEST_CRASH: 'before-commit' }).status, 137);
  const memory = new Memory(f.config); assert.equal(memory.history('garden').length, 0); memory.close();
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => {
    writeFileSync(join(f.root, `e${i}.json`), JSON.stringify(event(`e${i}`, 'claim', { kind: 'fact', body: `Fact ${i}` })));
    return child(cli, ['record', `e${i}.json`], f.root, { TASTEBUD_PRODUCER: `agent-${i}` });
  }));
  for (const r of rs) assert.equal(r.status, 0, r.err);
  const m = new Memory(f.config); assert.equal(m.history('garden').length, 8); m.close();
});
test('archived evidence and a cold restored database answer the same history', async () => {
  const f = fixture(), path = join(f.root, 'projects/garden.md'); writeFileSync(path, 'Rare irrigation constraint survives archival.');
  const source = f.memory.captureSource(path);
  f.memory.record(event('c', 'claim', { kind: 'constraint', body: 'Retain irrigation rule', evidence: [{ ...source, quote: 'Rare irrigation constraint survives archival.' }] }), 'agent-a');
  f.memory.archive(source.source_id); unlinkSync(path);
  assert.equal(f.memory.search('irrigation').length, 1);
  const target = join(f.root, 'restored.sqlite'); await f.memory.backup(target);
  const restored = new Memory({ ...f.config, memoryDb: target }, { readonly: true });
  assert.equal(restored.brief({ project: 'garden' }).claims[0].evidence[0].archived, true);
  assert.deepEqual(restored.history('garden'), f.memory.history('garden'));
  restored.close(); f.memory.close();
});
test('legacy outbox recovers a partial heading and preserves producer arrivals after snapshot', () => {
  const f = fixture(), target = join(f.root, 'memory/projects/garden.md'), live = join(f.root, 'telemetry/memory-intents.jsonl');
  writeFileSync(target, '## intent one\n');
  const rec = id => ({ id, kind: 'update', target: 'memory/projects/garden.md', body: [`Complete body ${id}`] });
  writeFileSync(live, JSON.stringify(rec('one')) + '\n');
  const before = hash(readFileSync(target));
  applyOutbox(f.root, { dry: true }); assert.equal(hash(readFileSync(target)), before);
  const first = applyOutbox(f.root, { afterSnapshot: () => appendFileSync(live, JSON.stringify(rec('two')) + '\n') });
  assert.equal(first.applied, 1); assert.match(readFileSync(target, 'utf8'), /Complete body one/);
  assert.equal(applyOutbox(f.root).applied, 1);
  assert.match(readFileSync(target, 'utf8'), /Complete body two/);
  assert.equal(applyOutbox(f.root).applied, 0);
  f.memory.close();
});
test('MCP exposes structured results and marks invalid dates as errors', () => {
  const f = fixture(); f.memory.close();
  const request = name => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { date: '2026-02-30' } } }) + '\n';
  const r = spawnSync(process.execPath, [mcp], { cwd: f.root, encoding: 'utf8', input: request('tastebud_decode') });
  assert.equal(JSON.parse(r.stdout).result.isError, true);
  const list = spawnSync(process.execPath, [mcp], { cwd: f.root, encoding: 'utf8', input: JSON.stringify({ id: 2, method: 'tools/list' }) + '\n' });
  assert.ok(!JSON.parse(list.stdout).result.tools.some(t => t.name === 'memory_record'));
});
test('empty store check succeeds and alias creation cannot shadow another alias', () => {
  const f = fixture(); f.memory.close();
  assert.equal(run(engine, ['check'], f.root).status, 0);
  assert.equal(run(engine, ['mint', 'old-garden', '--no-report'], f.root).status, 1);
  assert.equal(run(engine, ['alias', 'old-garden', 'weather'], f.root).status, 1);
});

test('promoted documents can evolve while immutable promotion evidence remains verifiable', () => {
  const f = fixture(); f.memory.close();
  for (const name of ['codebook.json','compositions.json']) writeFileSync(join(f.data,name),readFileSync(resolve('examples',name)));
  for (const date of ['2026-01-19','2026-01-20']) writeFileSync(join(f.root,'logs',date+'.md'),readFileSync(resolve('examples/logs',date+'.md')));
  writeFileSync(join(f.root,'candidates/weather-station.md'),readFileSync(resolve('examples/project-candidates/weather-station.md')));
  assert.equal(run(engine,['promote','weather-station'],f.root).status,0);
  appendFileSync(join(f.root,'projects/weather-station.md'),'\n## Progress\nAdded a rain gauge.\n');
  assert.equal(run(engine,['check'],f.root).status,0);
  assert.equal(run(engine,['mint','weather-station','--undo'],f.root).status,1);
  assert.match(readFileSync(join(f.root,'projects/weather-station.md'),'utf8'),/rain gauge/);
});

test('public nightly dry runs preserve invalid and stale inbox proposals and never call fallback', () => {
  const f=fixture();f.memory.close();mkdirSync(join(f.data,'inbox'));
  writeFileSync(join(f.root,'logs/2026-01-01.md'),'A completed garden log');
  writeFileSync(join(f.data,'inbox/2026-01-01.json'),JSON.stringify({...day('1999-01-01'),major:[{slug:'garden',w:2}]}));
  const before=readdirSync(f.data).sort();
  const r=run(resolve('tagger.mjs'),['nightly','2026-01-01'],f.root);
  assert.equal(r.status,0,r.stderr);assert.deepEqual(readdirSync(f.data).sort(),before);
  assert.equal(JSON.parse(readFileSync(join(f.data,'compositions.json'))).days.length,0);
  assert.ok(readFileSync(join(f.data,'inbox/2026-01-01.json')).length);
});

test('task optimistic revisions reject stale concurrent updates', () => {
  const f=fixture();
  f.memory.record(event('task1','task',{id:'t',title:'Review',status:'open'}),'a');
  f.memory.record(event('task2','task',{id:'t',title:'Review',status:'done',outcome:'Reviewed',previous_event_id:'task1'}),'b');
  assert.throws(()=>f.memory.record(event('task3','task',{id:'t',title:'Review',status:'blocked',previous_event_id:'task1'}),'a'),/task changed/);
  assert.equal(f.memory.history('garden').length,2);f.memory.close();
});

test('relocated and archived source IDs still resolve to original evidence', async () => {
  const f=fixture(),src=join(f.root,'projects/garden.md'),dest=join(f.root,'projects/archive.md');
  writeFileSync(src,'An important original constraint.');const rec=f.memory.captureSource(src);
  writeFileSync(dest,readFileSync(src));unlinkSync(src);
  assert.equal(f.memory.relocateSource(rec.source_id,dest).source_id,rec.source_id);
  f.memory.archive(rec.source_id);
  assert.equal(f.memory.readSource({source_id:rec.source_id,hash:rec.hash}).content,'An important original constraint.');
  f.memory.close();
});

test('configured MCP producers complete a handoff without losing the open action', () => {
  const f=fixture();f.memory.close();
  const call=(producer,name,args)=>{
    const r=spawnSync(process.execPath,[mcp],{cwd:f.root,encoding:'utf8',env:{...process.env,TASTEBUD_WRITES:'1',TASTEBUD_PRODUCER:producer},input:JSON.stringify({id:1,method:'tools/call',params:{name,arguments:args}})+'\n'});
    assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout).result;
  };
  const write=call('agent-a','memory_record',{event:event('handoff1','task',{id:'resume-work',title:'Verify irrigation controller',status:'open',next_action:'Run the dry sensor test'})});
  assert.equal(write.isError,false);
  const brief=call('agent-b','memory_brief',{project:'old-garden',task:'Resume controller work'}).structuredContent;
  assert.equal(brief.open_actions[0].next_action,'Run the dry sensor test');
  const done=call('agent-b','memory_record',{event:event('handoff2','task',{id:'resume-work',title:'Verify irrigation controller',status:'done',outcome:'Dry sensor test passed',previous_event_id:brief.open_actions[0].revision_event_id})});
  assert.equal(done.isError,false);
  const history=call('agent-a','memory_history',{project:'garden'}).structuredContent.events;
  assert.deepEqual(history.map(e=>e.producer),['agent-a','agent-b']);
});

test('turn capture retains producer provenance and never promotes a summary into a claim', () => {
  const f=fixture();f.memory.close();
  writeFileSync(join(f.root,'tastebud.config.json'),JSON.stringify({...f.config,captureDefaultProject:'garden'}));
  const input=JSON.stringify({type:'agent-turn-complete','thread-id':'thread-1','last-assistant-message':'Finished the controller review. The next session should examine the sensor timing issue before deployment; verification is still incomplete.'});
  for(const producer of ['agent-a','agent-b'])assert.equal(run(resolve('scripts/capture.mjs'),[input,'--receipt'],f.root,{TASTEBUD_PRODUCER:producer}).status,0);
  const m=new Memory(f.config);assert.equal(m.health().counts.events,2);assert.equal(m.health().counts.claims,0);assert.equal(m.brief({project:'garden'}).checkpoints[0].status,'unreviewed-checkpoint');m.close();
});

test('failed delivery stays durable and only a matching receipt acknowledges it', async () => {
  const {deliver}=await import('../lib/delivery.mjs');
  const f=fixture(),stub=join(f.root,'transport.mjs'),flag=join(f.root,'ready');
  writeFileSync(stub,`import {existsSync} from 'node:fs'; console.log(existsSync(process.argv[2])?'RECEIPT 123':'exit zero without delivery');`);
  const cfg={notifyArgs:[process.execPath,stub,flag,'{message}'],notifyAckPattern:'RECEIPT [0-9]+'};
  assert.equal(deliver(cfg,f.data,'A multiline\nmessage with literal $ and ` text').ok,false);
  writeFileSync(flag,'ready');
  const result=deliver(cfg,f.data,'A multiline\nmessage with literal $ and ` text');assert.equal(result.ok,true);assert.equal(result.pending,0);f.memory.close();
});

test('outbox body verification rejects substring matches and failed intents remain reviewable', () => {
  const f=fixture(),target=join(f.root,'memory/projects/garden.md'),queue=join(f.root,'telemetry/memory-intents.jsonl');
  writeFileSync(target,'A partial assertion containing the requested body fragment inside other text.\n');
  const rec={id:'body',kind:'update',target:'memory/projects/garden.md',body:['requested body fragment']};
  writeFileSync(queue,JSON.stringify(rec)+'\n'+JSON.stringify({...rec,id:'missing',target:'memory/missing/x.md'})+'\n');
  assert.equal(applyOutbox(f.root).applied,1);assert.match(readFileSync(target,'utf8'),/\n- requested body fragment\n/);
  applyOutbox(f.root);assert.equal(applyOutbox(f.root).deadletters,1);
  mkdirSync(join(f.root,'memory/missing'));writeFileSync(join(f.root,'memory/missing/x.md'),'# Repaired target\n');
  assert.equal(applyOutbox(f.root,{retryIds:['missing']}).deadletters,0);f.memory.close();
});
