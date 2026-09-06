import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Memory } from '../lib/memory.mjs';
import { vector } from '../lib/fingerprints.mjs';

const cli = resolve('memory-cli.mjs'), mcp=resolve('mcp-server/server.mjs');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tastebud-experience-'));
  mkdirSync(join(root, 'data')); mkdirSync(join(root, 'projects'));
  const config = { _configDir:root, workspaceDir:'.', dataDir:'./data', memoryDb:'./data/memory.sqlite', workspaceId:'fictional-workspace' };
  writeFileSync(join(root, 'tastebud.config.json'), JSON.stringify(config));
  const memory = new Memory(config);
  for (const slug of ['pump-control','greenhouse','orchard']) memory.registerProject({slug});
  writeFileSync(join(root, 'projects/evidence.md'), 'A bounded retry cleared the queue.\nThe adapted retry exceeded the heat limit.\nA correction narrowed the condition.');
  const source = memory.captureSource('projects/evidence.md', 'evidence');
  return {root,config,memory,source};
}
const evidence = (source, quote) => [{source_id:source.source_id,hash:source.hash,quote}];
const features = (environment='bench') => ({operations:['recover-queue'],mechanisms:['bounded-retry'],environments:[environment]});
const exp = (id, source, extra={}) => ({id,session:'capture',project:'pump-control',type:'experience',payload:{title:'Recover a stalled queue',problem:'A fictional queue stopped advancing.',mechanism:'Retries were unbounded.',intervention:'Bound retry attempts and inspect the terminal result.',conditions:['The operation is idempotent.'],limits:['Do not use after the heat threshold.'],features:features(),scope:'workspace',outcome:'succeeded',evidence:evidence(source,'A bounded retry cleared the queue.'),...extra}});
const app = (id, extra={}) => ({id,session:'apply',project:'greenhouse',type:'experience_application',payload:{application_id:'greenhouse-retry',experience_id:'exp-1',previous_event_id:null,context:'A fictional greenhouse queue is stalled.',features:features('greenhouse'),adaptation:'Use one retry and stop at the heat threshold.',assessments:[{condition:'The operation is idempotent.',status:'met',reason:'The fixture operation uses a stable request key.'}],checks:[],status:'planned',outcome:'unknown',evidence:[],...extra}});

test('workspace experience transfers by structure and keeps adverse details routed', () => {
  const f=fixture(), original=exp('exp-1',f.source), before=structuredClone(original);
  f.memory.record(original,'agent-a');
  assert.deepEqual(original,before);
  assert.equal(f.memory.record(original,'agent-a').duplicate,true);
  assert.equal(f.memory.experiences({project:'greenhouse',features:features('greenhouse')}).suggestions[0].id,'exp-1');
  assert.equal(f.memory.experiences({project:'greenhouse',features:{operations:[],mechanisms:[],environments:['bench']},mode:'fingerprint'}).suggestions.length,0);
  f.memory.record(app('app-plan'),'agent-b');
  f.memory.record(app('app-result',{previous_event_id:'app-plan',status:'evaluated',outcome:'failed',checks:[{name:'heat-limit',result:'failed'}],evidence:evidence(f.source,'The adapted retry exceeded the heat limit.')}),'agent-b');
  f.memory.record(app('app-recovery',{previous_event_id:'app-result',status:'evaluated',outcome:'succeeded',checks:[{name:'bounded-retry',result:'passed'}],evidence:evidence(f.source,'A bounded retry cleared the queue.')}),'agent-b');
  const third=f.memory.experience({project:'orchard',id:'exp-1'});
  assert.equal(third.application_counts.succeeded,1);
  assert.equal(third.application_counts.failed,0);
  assert.equal(third.application_history_counts.failed,1);
  assert.equal(third.application_history[0].outcome,'failed');
  assert.equal(third.applications[0].content_withheld,true);
  assert.equal(third.applications[0].context,undefined);
  const target=f.memory.experience({project:'greenhouse',id:'exp-1'});
  assert.equal(target.applications[0].fully_validated,true);
  assert.equal(target.application_history[0].fully_validated,false);
  unlinkSync(join(f.root,'projects/evidence.md')); mkdirSync(join(f.root,'projects/evidence.md'));
  assert.equal(f.memory.experiences({project:'greenhouse',features:features('greenhouse')}).suggestions[0].id,'exp-1');
  assert.doesNotThrow(()=>f.memory.brief({project:'greenhouse',task:'recover queue',features:features('greenhouse')}));
  const changed=f.memory.experience({project:'greenhouse',id:'exp-1'});
  assert.equal(changed.evidence[0].captured_source_changed,false);
  assert.equal(changed.evidence[0].filesystem_status,'unreadable');
  assert.equal(changed.applications[0].evidence[0].filesystem_status,'unreadable');
  f.memory.close();
});

test('validation rejects incomplete plans, scope crossing, contradictions and temporal references', () => {
  const f=fixture(); f.memory.record(exp('exp-1',f.source),'a');
  assert.throws(()=>f.memory.record(app('missing',{assessments:[]}), 'b'),/assess every/);
  assert.throws(()=>f.memory.record(app('contradiction',{status:'evaluated',outcome:'succeeded',checks:[{name:'probe',result:'failed'}],evidence:evidence(f.source,'The adapted retry exceeded the heat limit.')}),'b'),/contradicts/);
  assert.throws(()=>f.memory.record(exp('invalid-evidence',f.source,{evidence:[{...evidence(f.source,'A bounded retry cleared the queue.')[0],extra:true}]}),'a'),/unknown field/);
  f.memory.record(exp('local',f.source,{scope:'project'}),'a');
  assert.throws(()=>f.memory.record(app('cross',{experience_id:'local'}),'b'),/not visible/);
  const future=exp('future',f.source); future.occurred_at='2026-01-02T00:00:00.000Z'; f.memory.record(future,'a');
  const early=app('early',{experience_id:'future'}); early.occurred_at='2026-01-01T00:00:00.000Z';
  assert.throws(()=>f.memory.record(early,'b'),/strictly earlier/);
  assert.equal(f.memory.history('greenhouse').length,0);
  f.memory.close();
});

test('correction lineage makes earlier applications stale without rebinding IDs', () => {
  const f=fixture(); f.memory.record(exp('exp-1',f.source),'a'); f.memory.record(app('app-plan'),'b');
  f.memory.record(exp('exp-2',f.source,{supersedes:'exp-1',conditions:['The operation is idempotent.'],evidence:evidence(f.source,'A correction narrowed the condition.')}),'a');
  const card=f.memory.experiences({project:'orchard',features:features()}).suggestions[0];
  assert.deepEqual(card.lineage,['exp-1','exp-2']); assert.equal(card.application_counts.stale,1);
  const detail=f.memory.experience({project:'orchard',id:'exp-2'});
  assert.equal(detail.applications[0].experience_id,'exp-1'); assert.equal(detail.applications[0].stale_application,true);
  assert.throws(()=>f.memory.record(app('new-on-old',{application_id:'another'}),'b'),/current nonretired/);
  f.memory.close();
});

test('validation scans prior events across wall-clock rollback and rejects future-recorded references', () => {
  const f=fixture(); f.memory.record(exp('exp-1',f.source),'a');
  f.memory.record(exp('exp-2',f.source,{supersedes:'exp-1',evidence:evidence(f.source,'A correction narrowed the condition.')}),'a');
  f.memory.db.prepare('UPDATE events SET recorded_at=? WHERE id=?').run('2999-01-01T00:00:00.000Z','exp-2');
  assert.throws(()=>f.memory.record(exp('fork-after-rollback',f.source,{supersedes:'exp-1',evidence:evidence(f.source,'A correction narrowed the condition.')}),'a'),/already superseded/);
  f.memory.db.prepare('UPDATE events SET recorded_at=? WHERE id=?').run(new Date().toISOString(),'exp-2');
  f.memory.record(app('clock-plan',{experience_id:'exp-2'}),'b');
  const collision=app('collision',{experience_id:'exp-2'}); collision.project='orchard';
  assert.throws(()=>f.memory.record(collision,'c'),/workspace-global.*greenhouse/);
  f.memory.record(app('clock-result',{experience_id:'exp-2',previous_event_id:'clock-plan',status:'evaluated',outcome:'succeeded',checks:[{name:'retry',result:'passed'}],evidence:evidence(f.source,'A bounded retry cleared the queue.')}),'b');
  f.memory.db.prepare('UPDATE events SET recorded_at=? WHERE id=?').run('2999-01-01T00:00:00.000Z','clock-result');
  assert.throws(()=>f.memory.record(app('stale-after-rollback',{experience_id:'exp-2',previous_event_id:'clock-plan'}),'b'),/application changed/);
  assert.throws(()=>f.memory.record(app('future-reference',{experience_id:'exp-2',previous_event_id:'clock-result'}),'b'),/recorded_at/);
  f.memory.close();
});

test('two processes accept only one next application revision', async () => {
  const f=fixture(); f.memory.record(exp('exp-1',f.source),'a'); f.memory.record(app('app-plan'),'b'); f.memory.close();
  const events=['race-a','race-b'].map(id=>app(id,{previous_event_id:'app-plan',adaptation:`Competing adaptation ${id}.`}));
  for(let i=0;i<2;i++)writeFileSync(join(f.root,`race-${i}.json`),JSON.stringify(events[i]));
  const run=file=>new Promise(resolve=>{const p=spawn(process.execPath,[cli,'record',file],{cwd:f.root,env:{...process.env,TASTEBUD_CONFIG:join(f.root,'tastebud.config.json')}});p.on('close',resolve);});
  const statuses=await Promise.all(['race-0.json','race-1.json'].map(run));
  assert.deepEqual(statuses.sort(),[0,1]);
  const memory=new Memory(f.config); assert.equal(memory.history('greenhouse').filter(e=>e.type==='experience_application').length,2); memory.close();
});

test('two processes accept only one correction and retired lessons reject new applications', async () => {
  const f=fixture(); f.memory.record(exp('exp-1',f.source),'a'); f.memory.close();
  const corrections=['correction-a','correction-b'].map(id=>exp(id,f.source,{supersedes:'exp-1',evidence:evidence(f.source,'A correction narrowed the condition.')}));
  for(let i=0;i<2;i++)writeFileSync(join(f.root,`correction-${i}.json`),JSON.stringify(corrections[i]));
  const run=file=>new Promise(resolve=>{const p=spawn(process.execPath,[cli,'record',file],{cwd:f.root,env:{...process.env,TASTEBUD_CONFIG:join(f.root,'tastebud.config.json')}});p.on('close',resolve);});
  assert.deepEqual((await Promise.all(['correction-0.json','correction-1.json'].map(run))).sort(),[0,1]);
  const memory=new Memory(f.config), current=memory.experiences({project:'orchard',features:features()}).suggestions[0].id;
  memory.record(exp('retired',f.source,{supersedes:current,retired:true,evidence:evidence(f.source,'A correction narrowed the condition.')}),'a');
  assert.equal(memory.experiences({project:'orchard',features:features()}).suggestions.length,0);
  assert.equal(memory.experience({project:'orchard',id:current}).event_retired,false);
  assert.equal(memory.experience({project:'orchard',id:current}).retired,true);
  assert.equal(memory.experience({project:'orchard',id:'retired'}).event_retired,true);
  assert.throws(()=>memory.record(app('after-retire',{experience_id:'retired'}),'b'),/nonretired/); memory.close();
});

test('library entry points reject coercion and require explicit null predecessor', () => {
  const f=fixture(); f.memory.record(exp('exp-1',f.source),'a');
  assert.throws(()=>f.memory.experiences({project:'orchard',query:{toString(){return 'queue';}}}),/query must be a string/);
  assert.throws(()=>f.memory.experiences({project:'orchard',as_of:{}}),/as_of/);
  assert.throws(()=>f.memory.experiences({project:'orchard',mode:'magic',query:'queue'}),/invalid experience retrieval mode/);
  assert.throws(()=>f.memory.experiences({project:'orchard',query:'queue',extra:true}),/unknown field/);
  assert.throws(()=>f.memory.experiences({project:'orchard',features:{operations:null}}),/must be an array/);
  assert.throws(()=>f.memory.record(exp('null-retired',f.source,{retired:null}),'a'),/retired must be boolean/);
  assert.equal(f.memory.experiences({project:'orchard',features:{mechanisms:['bounded-retry']}}).suggestions[0].id,'exp-1');
  const missing=app('missing-previous'); delete missing.payload.previous_event_id;
  assert.throws(()=>f.memory.record(missing,'b'),/previous_event_id is required/);
  assert.throws(()=>f.memory.experience({project:'orchard',id:' exp-1 '}),/trimmed/); f.memory.close();
});

test('fresh MCP producers and consumers complete the capture to cited-outcome loop', () => {
  const f=fixture(); f.memory.close();
  const call=(producer,name,args)=>{const r=spawnSync(process.execPath,[mcp],{cwd:f.root,encoding:'utf8',env:{...process.env,TASTEBUD_CONFIG:join(f.root,'tastebud.config.json'),TASTEBUD_WRITES:'1',TASTEBUD_PRODUCER:producer},input:JSON.stringify({id:1,method:'tools/call',params:{name,arguments:args}})+'\n'});assert.equal(r.status,0,r.stderr);const result=JSON.parse(r.stdout).result;assert.equal(result.isError,false,result.content?.[0]?.text);return result.structuredContent;};
  const source=call('producer','memory_source',{path:'projects/evidence.md'});
  call('producer','memory_record',{event:exp('exp-1',source)});
  const cards=call('consumer','memory_experiences',{project:'greenhouse',query:'recover stalled work',features:features('greenhouse')}); assert.equal(cards.suggestions[0].id,'exp-1');
  assert.equal(call('consumer','memory_experience',{project:'greenhouse',id:'exp-1'}).conditions.length,1);
  call('consumer','memory_record',{event:app('app-plan')});
  call('consumer','memory_record',{event:app('app-result',{previous_event_id:'app-plan',status:'evaluated',outcome:'succeeded',checks:[{name:'retry',result:'passed'}],evidence:evidence(source,'A bounded retry cleared the queue.')})});
  assert.equal(call('reopened','memory_experience',{project:'greenhouse',id:'exp-1'}).applications[0].latest_event_id,'app-result');
});

test('legacy fingerprint bytes remain stable across dimensions', () => {
  const expected={4096:{'recipe-site':'1deb321c5d856b35164f12e61f07ce51a5b3d7a8900b904949ad65cf1b6b1b2e','garden-sensors':'ff481ce06112442652dafb641cf92ddb084cf5f050cae42ff3234ec393cab770','café':'64a6399b2a8f2bb81c8cd39fe96f9d6579105ccf479ce1d85d608edf2dd357cc'},512:{'recipe-site':'be191cb9bc6342150a223cc89f54d6292a50c68d5eafa50cff55f8e45b3650a3','garden-sensors':'803e82529485ceffcddbe4ed6f8e9832bc043fe14e1a32ad9fd1d6f167c75a8c','café':'4097b71d965ae951470d78cf096664faa706453492a60d5ec267a9cf0a968b64'}};
  for(const [d,labels] of Object.entries(expected))for(const [label,digest] of Object.entries(labels))assert.equal(createHash('sha256').update(Buffer.from(vector(label,Number(d)).buffer)).digest('hex'),digest);
});

test('legacy fingerprint CLI output remains byte-for-byte stable', () => {
  const fixtures=[
    [['decode','2026-01-12','--approx'],'e5b6c0c9e381608e211534556c8131598522ebc1c81abc75b55f49b9bd4448d1'],
    [['similar','2026-01-12'],'0185b93aa8160eda148f32171c9b413e26d88540d64d69e91ae134e717d51c28'],
    [['drift','recipe-site','10'],'6c517c961f0065dfd7cc95470033e8fd6ebb9f2200eb6d0bdb27bde47de25fcf'],
    [['tasteslike','sourdough-lab'],'bb6c894fe14abd0a45ee4beead93d903dc1de5e4c3c6e06ded7e1aac2fb10078'],
    [['similar','2026-01-19'],'25382cd8389f7af78a2738a301c7125cd7e70c856434e32e4ec3713dd66fcdff'],
    [['backtest','aquarium-controller','0.2'],'44c199dc1565bcd41851f99f530c4d2b49b1bbc4423bc87542a6711d756d0ae1']
  ];
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('TASTEBUD_')));
  for(const [args,digest] of fixtures){const r=spawnSync(process.execPath,[resolve('tastebud.mjs'),...args],{encoding:'utf8',env});assert.equal(r.status,0,r.stderr);assert.equal(createHash('sha256').update(r.stdout).digest('hex'),digest,args.join(' '));}
});

test('experience brief stays bounded and old no-task shape stays compatible', () => {
  const f=fixture(), old=f.memory.brief({project:'greenhouse',budget:256}); f.memory.record(exp('exp-1',f.source),'a');
  const brief=f.memory.brief({project:'greenhouse',task:'recover queue',features:features('greenhouse'),budget:256});
  assert.ok(Buffer.byteLength(JSON.stringify(brief))<=768); assert.ok('experiences' in brief); assert.equal('experiences' in old,false); assert.equal('experiences' in old.omitted,false); f.memory.close();
});

test('application outcomes never change retrieval scores or preferences', () => {
  const f=fixture(); f.memory.record(exp('exp-1',f.source),'a'); f.memory.record(exp('exp-0',f.source,{title:'Another bounded retry report'}),'a');
  const before=f.memory.experiences({project:'greenhouse',features:features()}).suggestions.map(x=>[x.id,x.scores.selected]);
  f.memory.record(app('app-plan'),'b');
  f.memory.record(app('app-result',{previous_event_id:'app-plan',status:'evaluated',outcome:'succeeded',checks:[{name:'retry',result:'passed'}],evidence:evidence(f.source,'A bounded retry cleared the queue.')}),'b');
  const after=f.memory.experiences({project:'greenhouse',features:features()}).suggestions.map(x=>[x.id,x.scores.selected]);
  assert.deepEqual(after,before); assert.equal(f.memory.preferences().active_count,0); f.memory.close();
});

test('frozen synthetic development corpus keeps relevant structural candidates retrievable', () => {
  const r=spawnSync(process.execPath,[resolve('evaluation/run.mjs')],{encoding:'utf8'}); assert.equal(r.status,0,r.stderr);
  const report=JSON.parse(r.stdout); assert.equal(report.corpus_sha256,'e362ff1fd95fcc8b9614a2b00a4179b966233849ac0ed2617b41902f2b017172');
  assert.equal(report.metrics.features.recall_at_k,1); assert.equal(report.metrics.fingerprint.recall_at_k,1); assert.equal(report.metrics.hybrid.recall_at_k,1);
});
