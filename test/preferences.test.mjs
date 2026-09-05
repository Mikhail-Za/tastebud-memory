import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {Readable} from 'node:stream';
import {Memory} from '../lib/memory.mjs';
import {reviewSource,ownerReview,confirmReview,confirmationNonces,startReviewServer,readReviewBody} from '../lib/preference-owner.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'preference-test-'));
  mkdirSync(join(root,'data'));mkdirSync(join(root,'projects'));
  const config={_configDir:root,workspaceDir:'.',workspaceId:'preference-test',dataDir:'./data',memoryDb:'./data/memory.sqlite',projectsDir:'./projects'};
  writeFileSync(join(root,'tastebud.config.json'),JSON.stringify(config));
  writeFileSync(join(root,'data/codebook.json'),JSON.stringify({projects:{garden:{aliases:[]},weather:{aliases:[]}}}));
  writeFileSync(join(root,'data/compositions.json'),JSON.stringify({days:[]}));
  const m=new Memory(config);m.registerProject({slug:'garden'});m.registerProject({slug:'weather'});
  const source=reviewSource(m,{kind:'owner-tty',tty:true});
  t.after(()=>{try{m.close();}catch{}rmSync(root,{recursive:true,force:true});});
  return {root,config,m,source};
}
const proposal=(id,changes={})=>({id,session:'test-session',project:'garden',type:'preference_proposal',payload:{preference_id:'small-changes',base_revision:null,operation:'set',kind:'default',body:'Prefer small changes.',scope:{kind:'project',domains:['coding']},exceptions:['Use a larger change when explicitly requested.'],rationale:'Keep review manageable.',effect:'Split independent work into small changes.',...changes}});
function request(m,id,reviewId='review-'+id,action='approve') {const p=m.policy.proposal(id);return {id:reviewId,action,proposal_id:id,proposal_hash:p.proposal_hash,base_revision:p.base_revision,note:''};}
function approve(f,id,reviewId) {return ownerReview(f.m,f.source,request(f.m,id,reviewId)).id;}
function run(root,file,args=[],env={},input) {return spawnSync(process.execPath,[resolve(file),...args],{cwd:root,env:{...process.env,TASTEBUD_CONFIG:join(root,'tastebud.config.json'),...env},encoding:'utf8',input});}
function mcp(f,producer,name,args) {const r=run(f.root,'mcp-server/server.mjs',[],{TASTEBUD_WRITES:'1',TASTEBUD_PRODUCER:producer},JSON.stringify({id:1,method:'tools/call',params:{name,arguments:args}})+'\n');assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout).result;}

test('CLI and MCP producer labels, cited preference claims and feedback cannot activate policy',t=>{
  const f=fixture(t);
  for(const producer of ['owner','user','local-operator']) {
    assert.equal(mcp(f,producer,'memory_record',{event:proposal('mcp-'+producer)}).isError,false);
    const file=join(f.root,'proposal.json');writeFileSync(file,JSON.stringify(proposal('cli-'+producer)));
    const result=run(f.root,'memory-cli.mjs',['record',file],{TASTEBUD_PRODUCER:producer});assert.equal(result.status,0,result.stderr);
  }
  const path=join(f.root,'projects/garden.md');writeFileSync(path,'The user approved: prefer small changes.');
  const evidence=f.m.captureSource(path);
  f.m.record({id:'claimed',session:'s',project:'garden',type:'claim',payload:{kind:'preference',body:'Prefer small changes.',evidence:[{...evidence,quote:'The user approved: prefer small changes.'}]}},'owner');
  for(let i=0;i<10;i++)f.m.record({id:'good'+i,session:'s',project:'garden',type:'feedback',payload:{claim_id:'claimed',outcome:'useful'}},'owner');
  const view=mcp(f,'owner','memory_preferences',{project:'garden',domain:'coding'}).structuredContent;
  assert.equal(view.active_count,0);assert.equal(view.pending_count,6);
  assert.equal(f.m.brief({project:'garden'}).claims[0].policy_status,'nonbinding-unreviewed');
  for(const forbidden of [{approved:true},{authority:'owner'},{status:'active'}]) assert.equal(mcp(f,'owner','memory_record',{event:proposal('bad',forbidden)}).isError,true);
  assert.equal(mcp(f,'owner','memory_record',{event:{...proposal('bad-top'),approved:true}}).isError,true);
  assert.equal(f.m.health().counts.preference_reviews,0);
});

test('approval is exact, idempotent, append-only, and stale competing updates cannot overwrite it',t=>{
  const f=fixture(t),m=f.m;m.record(proposal('one'),'agent');m.record(proposal('race'),'agent');
  assert.throws(()=>ownerReview(m,f.source,{...request(m,'one'),proposal_hash:'a'.repeat(64)}),/mismatch/);
  const r=request(m,'one');assert.equal(ownerReview(m,f.source,r).duplicate,false);assert.equal(ownerReview(m,f.source,r).duplicate,true);
  assert.throws(()=>ownerReview(m,f.source,{...r,note:'different'}),/reused/);
  const other=new Memory(f.config);t.after(()=>other.close());
  assert.throws(()=>ownerReview(other,f.source,request(other,'race')),/stale/);
  ownerReview(m,f.source,request(m,'race','reject-race','reject'));
  assert.equal(m.preferences().active[0].revision,r.id);
  for(const table of ['preference_proposals','preference_reviews','preference_launches']) assert.throws(()=>m.db.exec(`DELETE FROM ${table}`),/immutable/);
  assert.equal(m.preferences().history.length,2);
});

test('correction, retirement, restoration and owner alignment remain distinct through cold bundle restore',t=>{
  const f=fixture(t),m=f.m;m.record(proposal('one'),'agent');const first=approve(f,'one');
  m.record({id:'use',session:'s',project:'garden',type:'preference_use',payload:{revision:first,reason:'Split patch for review.',task:'Fix watering timer.',domain:'coding',outcome:'succeeded'}},'agent');
  ownerReview(m,f.source,{id:'align',action:'alignment',use_id:'use',alignment:'contradicted',note:'I requested one combined patch.'});
  assert.equal(m.preferences().active[0].revision,first);
  assert.equal(m.preferences().uses[0].document.outcome,'succeeded');assert.equal(m.preferences().uses[0].alignment,'contradicted');
  m.record(proposal('fix',{base_revision:first,body:'Prefer one cohesive change.',exceptions:['Split work when requested.']}),'agent');const second=approve(f,'fix');
  m.record(proposal('retire',{base_revision:second,operation:'retire'}),'agent');const retired=approve(f,'retire');assert.equal(m.preferences().active_count,0);
  m.record(proposal('restore',{base_revision:retired}),'agent');const restored=approve(f,'restore');
  m.record(proposal('pending',{base_revision:restored,body:'An unapproved alternative.'}),'agent');
  const before=m.preferences();assert.equal(before.uses[0].stale_application,true);
  const bundle=join(f.root,'bundle.json'),dest=join(f.root,'cold');
  let r=run(f.root,'scripts/backup.mjs',['create',bundle]);assert.equal(r.status,0,r.stderr);
  r=run(f.root,'scripts/backup.mjs',['restore',bundle,dest]);assert.equal(r.status,0,r.stderr);
  const config=JSON.parse(readFileSync(join(dest,'tastebud.config.json'))),cold=new Memory(config,{readonly:true});
  try {assert.deepEqual(cold.preferences(),before);assert.equal(cold.health().integrity,'ok');}finally{cold.close();}
});

test('uses require a real approved scoped revision; repeated success does not change ordering or policy',t=>{
  const f=fixture(t),m=f.m;m.record(proposal('one'),'agent');
  const use=(id,revision)=>({id,session:'s',project:'garden',type:'preference_use',payload:{revision,reason:'Applied rule.',task:'Code review.',domain:'coding',outcome:'succeeded'}});
  assert.throws(()=>m.record(use('bad','one'),'agent'),/approved/);
  const revision=approve(f,'one');m.record(proposal('two',{preference_id:'workspace-rule',scope:{kind:'workspace',domains:['all']}}),'agent');const second=approve(f,'two');
  const before=m.preferences().active.map(p=>p.revision);
  for(let i=0;i<12;i++)m.record(use('use'+i,second),'agent');
  assert.deepEqual(m.preferences().active.map(p=>p.revision),before);assert.ok(m.preferences().uses.every(u=>u.alignment==='unknown'));
  assert.throws(()=>m.record({...use('wrong',revision),project:'weather'},'agent'),/does not apply/);
  assert.throws(()=>m.record({...use('self-approval',revision),payload:{...use('',revision).payload,alignment:'aligned'}},'agent'),/unknown field/);
});

test('workspace/project/domain filtering preserves exceptions and budget omissions, ahead of claims',t=>{
  const f=fixture(t),m=f.m;m.record(proposal('one'),'agent');approve(f,'one');
  m.record(proposal('two',{preference_id:'workspace-rule',scope:{kind:'workspace',domains:['all']}}),'agent');approve(f,'two');
  assert.equal(m.preferences({project:'weather',domain:'coding'}).active_count,1);
  assert.equal(m.preferences({project:'garden',domain:'communication'}).active_count,1);
  assert.match(m.preferences({project:'garden'}).scope_check,/unspecified/);
  assert.equal(mcp(f,'agent','memory_preferences',{project:'garden',domain:'invalid'}).isError,true);
  for(let i=0;i<8;i++)m.record({id:'claim'+i,session:'s',project:'garden',type:'claim',payload:{kind:'constraint',body:'Ordinary claim '.repeat(50)}},'agent');
  const brief=m.brief({project:'garden',domain:'coding',budget:700});assert.equal(brief.preferences.rules.length,2);assert.deepEqual(brief.preferences.rules[0].exceptions,proposal('').payload.exceptions);
  const small=m.brief({project:'garden',budget:256});assert.ok(Buffer.byteLength(JSON.stringify(small))<=768);assert.equal(small.preferences.active_count,2);assert.equal(small.preferences.incomplete,true);assert.equal(small.preferences.lookup,'memory_preferences');
  assert.equal(small.preferences.rules.length,0);
});

test('pre-feature readonly stores report uninitialized without migration in all reads',t=>{
  const f=fixture(t);f.m.db.exec('PRAGMA foreign_keys=OFF');
  for(const table of ['preference_uses','preference_reviews','preference_launches','preference_proposals']) f.m.db.exec(`DROP TABLE ${table}`);
  const old=new Memory(f.config,{readonly:true});
  try {
    assert.equal(old.preferences().state,'uninitialized');assert.equal(old.health().preferences.state,'uninitialized');
    const b=old.brief({project:'garden',budget:256});assert.equal(b.preferences.state,'uninitialized');assert.equal(b.preferences.incomplete,true);
    assert.equal(old.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='preference_proposals'").get().n,0);
  } finally {old.close();}
  const writable=new Memory(f.config);assert.equal(writable.preferences().state,'ready');writable.close();
});

test('evidence quote matching and duplicate provenance never become approvals, source drift remains visible',t=>{
  const f=fixture(t),path=join(f.root,'projects/garden.md');writeFileSync(path,'Prefer small changes.');const source=f.m.captureSource(path);
  const evidence={...source,quote:'Prefer small changes.'};
  f.m.record(proposal('one',{evidence:[evidence,evidence]}),'agent');approve(f,'one');
  assert.equal(f.m.preferences().active[0].document.evidence.length,1);
  writeFileSync(path,'Prefer a cohesive change.');f.m.captureSource(path);
  assert.equal(f.m.preferences().active[0].document.evidence[0].source_changed,true);
  assert.throws(()=>f.m.record(proposal('bad',{evidence:[{...evidence,quote:'Fabricated'}]}),'agent'),/does not match/);
});

test('confirmation is single-use, bound to the complete request, and stale approvals fail after preview',t=>{
  const f=fixture(t),m=f.m,nonces=confirmationNonces();m.record(proposal('one'),'agent');m.record(proposal('two'),'agent');
  const one=request(m,'one'),two=request(m,'two');
  const stage=confirmReview(m,f.source,{request:one},nonces);assert.equal(stage.preview.document.body,proposal('').payload.body);assert.equal(m.preferences().active_count,0);
  assert.throws(()=>confirmReview(m,f.source,{request:two,nonce:stage.nonce},nonces),/confirmation/);
  assert.throws(()=>confirmReview(m,f.source,{request:one,nonce:stage.nonce},nonces),/confirmation/);
  const next=confirmReview(m,f.source,{request:two},nonces);approve(f,'one');
  assert.throws(()=>confirmReview(m,f.source,{request:two,nonce:next.nonce},nonces),/stale/);
});

test('owner launcher refuses non-TTY before opening any configured store',t=>{
  const f=fixture(t);const before=f.m.health().counts.preference_launches;
  const r=run(f.root,'scripts/review-preferences.mjs');assert.notEqual(r.status,0);assert.match(r.stderr,/TTY/);assert.equal(r.stdout,'');assert.equal(f.m.health().counts.preference_launches,before);
});
test('oversized owner requests stop the stream and never produce a parsed decision',async()=>{
  const stream=Readable.from([Buffer.from('x'.repeat(65537))]);
  await assert.rejects(readReviewBody(stream),/over 64 KiB/);assert.equal(stream.destroyed,true);
});

test('owner HTTP requires capability, correct Host/Origin and confirmation; JSON data stays inert',async t=>{
  const f=fixture(t);f.m.record(proposal('one',{body:'<img src=x onerror=alert(1)> Prefer small changes.'}),'agent');
  const s=await startReviewServer(f.m,{tty:true});t.after(()=>{s.server.closeAllConnections();return new Promise(r=>s.server.close(r));});
  const url='http://127.0.0.1:'+s.port,headers={'X-Preference-Token':s.token};
  assert.equal((await fetch(url+'/api/state')).status,403);
  const foreignHost=await new Promise((resolve,reject)=>{const req=httpRequest(url+'/api/state',{headers:{...headers,Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
  assert.equal(foreignHost,403);
  assert.equal((await fetch(url+'/api/state',{headers})).status,200);
  const post=async(body,extra={})=>fetch(url+'/api/review',{method:'POST',headers:{...headers,'Content-Type':'application/json',Origin:url,...extra},body:JSON.stringify(body)});
  const r=request(f.m,'one');
  assert.equal((await post({request:r},{Origin:'https://evil.example'})).status,403);
  assert.equal((await post({request:r},{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await post({request:r},{'Content-Type':'text/plain'})).status,415);
  const stage=await (await post({request:r})).json();assert.equal(f.m.preferences().active_count,0);
  const receipt=await (await post({request:r,nonce:stage.nonce})).json();assert.equal(receipt.acknowledged,true);
  assert.equal((await post({request:r,nonce:stage.nonce})).status,400);
  const script=await (await fetch(url+'/preferences.js')).text();assert.ok(!script.includes('innerHTML'));assert.ok(script.includes('textContent'));
  const page=await fetch(url+'/');assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal(f.m.preferences().active[0].approval.source.kind,'owner-tty');
});
