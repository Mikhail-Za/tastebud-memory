#!/usr/bin/env node
// Fictional cold-process protocol demonstration; it is not evidence of autonomous learning.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { Memory } from '../lib/memory.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'), root=mkdtempSync(join(tmpdir(),'tastebud-transfer-demo-'));
const config={_configDir:root,workspaceDir:'.',workspaceId:'fictional-transfer-demo',dataDir:'./data',memoryDb:'./data/memory.sqlite',projectsDir:'./projects',memorySourceDirs:['./projects']};
mkdirSync(join(root,'data'));mkdirSync(join(root,'projects'));
writeFileSync(join(root,'tastebud.config.json'),JSON.stringify(config));
writeFileSync(join(root,'data/codebook.json'),JSON.stringify({projects:{'queue-lab':{aliases:[]},'greenhouse-lab':{aliases:[]},'orchard-lab':{aliases:[]}}}));
writeFileSync(join(root,'data/compositions.json'),JSON.stringify({days:[]}));
writeFileSync(join(root,'projects/evidence.md'),'Bounded retry cleared the fictional queue.\nThe greenhouse adaptation passed its heat check.\nLater inspection narrowed the safe condition.');
let memory=new Memory(config);for(const slug of ['queue-lab','greenhouse-lab','orchard-lab'])memory.registerProject({slug});memory.close();
const run=(file,args=[],input,configPath=join(root,'tastebud.config.json'))=>{const r=spawnSync(process.execPath,[join(repo,file),...args],{cwd:dirname(configPath),encoding:'utf8',input,env:{...process.env,TASTEBUD_CONFIG:configPath,TASTEBUD_PRODUCER:'fictional-demo'}});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
const source=run('memory-cli.mjs',['source','projects/evidence.md']);
const cite=quote=>[{source_id:source.source_id,hash:source.hash,quote}], features=environment=>({operations:['recover-queue'],mechanisms:['bounded-retry'],environments:[environment]});
const record=event=>run('memory-cli.mjs',['record'],JSON.stringify(event));
record({id:'experience-v1',session:'capture',project:'queue-lab',type:'experience',payload:{title:'Bound retries for an idempotent queue',problem:'A fictional worker repeats a stalled operation.',mechanism:'Unbounded retry hides terminal failure.',intervention:'Cap attempts and inspect the terminal result.',conditions:['The operation is idempotent.'],limits:['Stop at the equipment heat threshold.'],features:features('container'),scope:'workspace',outcome:'succeeded',evidence:cite('Bounded retry cleared the fictional queue.')}});
const cards=run('memory-cli.mjs',['experiences'],JSON.stringify({project:'greenhouse-lab',query:'recover stalled work',features:features('greenhouse')}));assert.equal(cards.suggestions[0].id,'experience-v1');
const detail=run('memory-cli.mjs',['experience'],JSON.stringify({project:'greenhouse-lab',id:'experience-v1'}));assert.equal(detail.conditions[0],'The operation is idempotent.');
record({id:'application-plan',session:'apply',project:'greenhouse-lab',type:'experience_application',payload:{application_id:'greenhouse-retry',experience_id:'experience-v1',previous_event_id:null,context:'A fictional greenhouse queue is stalled.',features:features('greenhouse'),adaptation:'Use one retry and stop at the lower greenhouse heat threshold.',assessments:[{condition:'The operation is idempotent.',status:'met',reason:'The request has a stable fixture key.'}],checks:[],status:'planned',outcome:'unknown',evidence:[]}});
record({id:'application-result',session:'apply',project:'greenhouse-lab',type:'experience_application',payload:{application_id:'greenhouse-retry',experience_id:'experience-v1',previous_event_id:'application-plan',context:'A fictional greenhouse queue is stalled.',features:features('greenhouse'),adaptation:'Use one retry and stop at the lower greenhouse heat threshold.',assessments:[{condition:'The operation is idempotent.',status:'met',reason:'The request has a stable fixture key.'}],checks:[{name:'heat-threshold',result:'passed'}],status:'evaluated',outcome:'succeeded',evidence:cite('The greenhouse adaptation passed its heat check.')}});
record({id:'experience-v2',session:'capture',project:'queue-lab',type:'experience',payload:{title:'Bound retries for an idempotent queue',problem:'A fictional worker repeats a stalled operation.',mechanism:'Unbounded retry hides terminal failure.',intervention:'Cap attempts and inspect the terminal result.',conditions:['The operation is idempotent.'],limits:['Stop at the equipment heat threshold.'],features:features('container'),scope:'workspace',outcome:'succeeded',supersedes:'experience-v1',evidence:cite('Later inspection narrowed the safe condition.')}});
record({id:'preference-proposal',session:'capture',project:'queue-lab',type:'preference_proposal',payload:{preference_id:'fictional-review-style',base_revision:null,operation:'set',kind:'default',body:'Prefer a small review batch.',scope:{kind:'workspace',domains:['coding']},exceptions:['Use a larger batch when explicitly requested.'],rationale:'Make fixture review clear.',effect:'Keep independent fixture edits compact.'}});
const bundle=join(root,'continuity.bundle.json'),cold=join(root,'cold');run('scripts/backup.mjs',['create',bundle]);run('scripts/backup.mjs',['restore',bundle,cold]);
const coldConfig=join(cold,'tastebud.config.json'), restored=run('memory-cli.mjs',['experience'],JSON.stringify({project:'orchard-lab',id:'experience-v2'}),coldConfig);
assert.deepEqual(restored.lineage,['experience-v1','experience-v2']);assert.equal(restored.applications[0].latest_event_id,'application-result');assert.equal(restored.applications[0].stale_application,true);assert.equal(restored.applications[0].content_withheld,true);
const preferences=run('memory-cli.mjs',['preferences','queue-lab','coding'],undefined,coldConfig);assert.equal(preferences.pending_count,1);
console.log(JSON.stringify({ok:true,synthetic:true,workspace_id:'fictional-transfer-demo',restored_experience_id:restored.id,evidence_hash:restored.evidence[0].hash,application_event_id:restored.applications[0].latest_event_id,preference_proposal_retained:true,notice:'Protocol demonstration only; no claim of autonomous learning.'},null,2));
rmSync(root,{recursive:true,force:true});
