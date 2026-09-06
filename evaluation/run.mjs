#!/usr/bin/env node
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Memory } from '../lib/memory.mjs';
import { FINGERPRINT } from '../lib/experiences.mjs';

const here=dirname(fileURLToPath(import.meta.url)), corpusPath=join(here,'corpus.json'), queryPath=resolve(process.argv[2] ?? join(here,'development.json'));
const corpusBytes=readFileSync(corpusPath), queryBytes=readFileSync(queryPath), corpus=JSON.parse(corpusBytes), evaluation=JSON.parse(queryBytes);
if(corpus.version!=='tastebud-experience-corpus/1'||evaluation.version!=='tastebud-experience-eval/1'||!Array.isArray(evaluation.queries))throw new Error('unsupported evaluation input');
const root=mkdtempSync(join(tmpdir(),'tastebud-eval-')), memory=new Memory({_configDir:root,workspaceDir:'.',memoryDb:'memory.sqlite',workspaceId:'synthetic-evaluation'});
try{
  for(const slug of [...new Set([...corpus.experiences.map(e=>e.project),...evaluation.queries.map(q=>q.request.project)])])memory.registerProject({slug});
  for(const e of corpus.experiences){const {id,project,transfer_limits,...payload}=e;memory.record({id,session:'synthetic-corpus',project,type:'experience',payload:{...payload,limits:[...payload.limits,...transfer_limits],scope:'workspace',outcome:'unknown',evidence:[]}},'synthetic-evaluator');}
  const k=Number(evaluation.k??3), modes=['lexical','features','fingerprint','hybrid'], metrics={};
  for(const mode of modes){let recalled=0,rr=0;const start=performance.now(),cases=[];for(const q of evaluation.queries){const ids=memory.experiences({...q.request,mode,limit:Math.max(k,10)}).suggestions.map(x=>x.id),rank=Math.min(...q.relevant_ids.map(id=>{const i=ids.indexOf(id);return i<0?Infinity:i+1;}));const hits=q.relevant_ids.filter(id=>ids.slice(0,k).includes(id)).length;recalled+=hits/q.relevant_ids.length;rr+=Number.isFinite(rank)?1/rank:0;cases.push({id:q.id,top_k:ids.slice(0,k),relevant_ids:q.relevant_ids,recall:hits/q.relevant_ids.length,reciprocal_rank:Number.isFinite(rank)?1/rank:0});}metrics[mode]={recall_at_k:recalled/evaluation.queries.length,mrr:rr/evaluation.queries.length,elapsed_ms:Number((performance.now()-start).toFixed(3)),cases};}
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
  console.log(JSON.stringify({protocol:'tastebud-experience-evaluation/1',synthetic:true,split:evaluation.split,k,corpus_sha256:sha(corpusBytes),queries_sha256:sha(queryBytes),algorithm:FINGERPRINT,metrics,limits:['Synthetic labels test deterministic retrieval contracts only.','Elapsed time is development-machine diagnostic data.','Results do not establish semantic reasoning, applicability, or general HDC superiority.']},null,2));
}finally{memory.close();rmSync(root,{recursive:true,force:true});}
