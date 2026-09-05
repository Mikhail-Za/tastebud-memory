/* Shared by the standalone owner page and a trusted host's review view. No agent
   data becomes markup; the host supplies only its authenticated transport. */
(function () {
  'use strict';
  function node(tag,text,cls) { var n=document.createElement(tag); if(text!==undefined)n.textContent=text; if(cls)n.className=cls; return n; }
  function button(parent,label,fn,primary) { var b=node('button',label,primary?'pr-primary':''); b.type='button'; b.onclick=fn; parent.appendChild(b); return b; }
  function detail(parent,title,data) { var d=node('details'); d.appendChild(node('summary',title)); d.appendChild(node('pre',JSON.stringify(data,null,2))); parent.appendChild(d); }
  function documentView(parent,p) {
    if(!p) { parent.appendChild(node('p','No approved preference.')); return; }
    var d=p.document;
    parent.appendChild(node('p',(d.operation==='retire'?'Retire preference':'Set preference')+' · '+d.kind));
    parent.appendChild(node('p',d.body));
    parent.appendChild(node('p','Scope: '+(d.scope.kind==='workspace'?'Workspace':p.project)+' · '+d.scope.domains.join(', ')));
    parent.appendChild(node('p','Exceptions: '+(d.exceptions.length?d.exceptions.join('\n'):'None specified')));
    parent.appendChild(node('p','Expected effect: '+d.effect));
    parent.appendChild(node('p','Reason: '+d.rationale,'pr-muted'));
  }
  function mount(root,request) {
    var panel=node('div',undefined,'preference-review'), state, busy=false;
    root.appendChild(panel);
    panel.appendChild(node('h1','Agent preferences'));
    panel.appendChild(node('p','You control what becomes a preference. Agents can suggest changes and report results.'));
    panel.appendChild(node('p','Preferences never grant permission. Your current instructions take priority. Review scope and exceptions before applying a rule.','pr-muted'));
    var status=node('p'); status.setAttribute('role','status'); status.setAttribute('aria-live','polite'); panel.appendChild(status);
    button(panel,'Refresh',refresh);
    var content=node('div'); panel.appendChild(content);
    async function work(fn) {
      if(busy)return; busy=true;
      try { await fn(); } catch(e) { status.textContent=e.message; }
      finally { busy=false; }
    }
    async function refresh() {
      try {
        var next=await request('state'); if(!panel.isConnected)return;
        state=next; render();
      } catch(e) { status.textContent=e.message; }
    }
    async function review(r,label) {
      await work(async function () {
        var staged=await request('review',{request:r});
        if(staged.status!=='confirm_required')throw new Error('Missing confirmation; refresh before continuing.');
        var accepted=await new Promise(function(resolve){
          var dialog=node('dialog'),title=node('h2',label+'?');dialog.className='preference-review';title.id='pr-confirm-title';dialog.setAttribute('aria-labelledby',title.id);dialog.appendChild(title);
          if(r.action==='alignment')dialog.appendChild(node('p',staged.preview.document.task+'\n'+staged.preview.document.reason+'\nAssessment: '+r.alignment));
          else {var diff=node('div',undefined,'pr-diff'),before=node('section'),after=node('section');before.appendChild(node('h3','Before'));documentView(before,staged.preview.current);after.appendChild(node('h3','After'));documentView(after,staged.preview);diff.append(before,after);dialog.appendChild(diff);}
          dialog.appendChild(node('p','Confirm this exact change within 60 seconds.','pr-muted'));
          function done(value){dialog.close();dialog.remove();resolve(value);}
          button(dialog,'Confirm',function(){done(true);},true);button(dialog,'Cancel',function(){done(false);});dialog.addEventListener('cancel',function(e){e.preventDefault();done(false);});panel.appendChild(dialog);dialog.showModal();
        });
        if(!accepted)return;
        var receipt=await request('review',{request:r,nonce:staged.nonce});
        if(!receipt.acknowledged)throw new Error('Decision not acknowledged. Refresh to inspect history.');
        await refresh(); status.textContent=label+' recorded. Receipt '+receipt.id;
      });
    }
    function draftForm(p,operation) {
      var old=content.querySelector('form'); if(old)old.remove();
      var form=node('form'), d=p?p.document:{kind:'default',body:'',scope:{kind:'project',domains:['all']},exceptions:[],rationale:'',effect:''};
      form.appendChild(node('h2',operation==='retire'?'Propose retirement':p?'Propose correction or restore':'New preference draft'));
      form.appendChild(node('p','Saving creates a pending draft. Review its before-and-after wording separately to activate it.','pr-muted'));
      var inputs={};
      function field(name,label,value,choices,multiline) {
        var l=node('label',label), input=node(choices?'select':multiline?'textarea':'input');
        if(choices)choices.forEach(function(c){var o=node('option',c);o.value=c;input.appendChild(o);});
        input.name=name;input.value=value;input.required=!['exceptions'].includes(name);l.appendChild(input);form.appendChild(l);inputs[name]=input;return input;
      }
      field('id','Preference ID',p?p.preference_id:'').readOnly=!!p;
      field('project','Originating project',p?p.project:state.projects[0],state.projects);
      field('kind','Kind',d.kind,['default','constraint']);
      field('scope','Scope',d.scope.kind,['project','workspace']);
      field('domains','Domains (comma-separated: all, planning, coding, operations, communication)',d.scope.domains.join(', '));
      field('body','Wording',d.body,null,true);
      field('exceptions','Exceptions (one per line)',d.exceptions.join('\n'),null,true);
      field('effect','Expected behavior',d.effect,null,true);
      field('rationale','Reason for this change',p?'':d.rationale,null,true);
      var submit=node('button','Save pending draft','pr-primary');submit.type='submit';form.appendChild(submit);
      button(form,'Cancel',function(){form.remove();});
      form.onsubmit=function(e){e.preventDefault();work(async function(){
        var v=function(k){return inputs[k].value;},id=crypto.randomUUID();
        // Copy evidence by its captured identity, stripping display-only health fields.
        var evidence=p?d.evidence.map(function(e){return {source_id:e.source_id,hash:e.hash,quote:e.quote};}):[];
        await request('draft',{id:id,session:'owner-review-draft',project:v('project'),type:'preference_proposal',payload:{preference_id:v('id'),base_revision:p?(p.current?p.current.revision:p.revision):null,operation:operation||'set',kind:v('kind'),body:v('body'),scope:{kind:v('scope'),domains:v('domains').split(',').map(function(s){return s.trim();})},exceptions:v('exceptions').split('\n').map(function(s){return s.trim();}).filter(Boolean),rationale:v('rationale'),effect:v('effect'),evidence:evidence}});
        await refresh();status.textContent='Draft saved. Review it below; it is not active.';
      });};
      content.prepend(form);inputs.body.focus();
    }
    function render() {
      content.textContent='';
      content.appendChild(node('p',state.state+' · '+state.active_count+' active · '+state.pending_count+' pending'));
      if(state.incomplete)content.appendChild(node('p','Preference register is incomplete. Initialize or inspect the store before relying on this view.','pr-warning'));
      if(state.projects.length)button(content,'New preference',function(){draftForm(null,'set');});
      content.appendChild(node('h2','Pending changes'));
      if(!state.pending.length)content.appendChild(node('p','No pending changes.'));
      state.pending.forEach(function(p){
        var card=node('article');card.dataset.proposal=p.event_id;
        card.appendChild(node('h3',p.preference_id));
        card.appendChild(node('p','Submitted by '+p.producer+' (unverified label) · '+p.recorded_at,'pr-muted'));
        if(p.stale)card.appendChild(node('p','Stale draft: another decision changed this preference. Create a fresh draft to approve a change.','pr-warning'));
        var diff=node('div',undefined,'pr-diff'),before=node('section'),after=node('section');
        before.appendChild(node('h4','Current approved state'));documentView(before,p.current);
        after.appendChild(node('h4','Proposed change'));documentView(after,p);
        diff.append(before,after);card.appendChild(diff);
        function decision(action){review({id:crypto.randomUUID(),action:action,proposal_id:p.event_id,proposal_hash:p.proposal_hash,base_revision:p.base_revision,note:''},(action==='approve'?'Approve ':'Reject ')+p.preference_id);}
        button(card,'Approve change',function(){decision('approve');},true).disabled=p.stale;
        button(card,'Reject',function(){decision('reject');});
        button(card,'Edit as a new draft',function(){draftForm({...p,revision:p.current?p.current.revision:null},'set');});
        detail(card,'Evidence, original base and proposal receipt',p);content.appendChild(card);
      });
      content.appendChild(node('h2','Active preferences'));
      if(!state.active.length)content.appendChild(node('p','No active preferences.'));
      state.active.forEach(function(p){var card=node('article');card.appendChild(node('h3',p.preference_id));documentView(card,p);card.appendChild(node('p','Approved '+p.approval.recorded_at+' via '+p.approval.source.kind,'pr-muted'));button(card,'Correct',function(){draftForm(p,'set');});button(card,'Retire',function(){draftForm(p,'retire');});detail(card,'Approval and evidence',p);content.appendChild(card);});
      content.appendChild(node('h2','Reported applications'));
      content.appendChild(node('p','Execution outcome is agent-reported. Your alignment assessment is separate and never changes a preference.','pr-muted'));
      if(!state.uses.length)content.appendChild(node('p','No applications reported yet. This does not prove no agent has used a preference.'));
      state.uses.forEach(function(u){var card=node('article');card.appendChild(node('h3',u.preference_id));card.appendChild(node('p',u.document.task+'\nReason: '+u.document.reason+'\nExecution: '+u.document.outcome+'\nYour assessment: '+u.alignment));if(u.stale_application)card.appendChild(node('p','Applied revision is no longer current.','pr-warning'));['aligned','contradicted','uncertain'].forEach(function(a){button(card,a,function(){review({id:crypto.randomUUID(),action:'alignment',use_id:u.event_id,alignment:a,note:''},'Mark application '+a);});});detail(card,'Applied revision and assessment history',u);content.appendChild(card);});
      var history=node('details');history.appendChild(node('summary','Full change history ('+state.history.length+')'));
      state.history.forEach(function(p){var card=node('article');card.appendChild(node('h3',p.preference_id+' · '+(p.review?p.review.action:'pending')));documentView(card,p);if(p.review&&p.review.action==='approve')button(card,'Restore this wording as a new draft',function(){draftForm({...p,revision:p.current?p.current.revision:null},'set');});detail(card,'History receipt',p);history.appendChild(card);});content.appendChild(history);
    }
    refresh();return {refresh:refresh};
  }
  window.PreferenceReview={mount:mount};
  var root=document.getElementById('preference-root');
  if(root){
    var token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
    mount(root,async function(path,body){var res=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{'X-Preference-Token':token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});var data=await res.json();if(!res.ok)throw new Error(data.error||'Request failed');return data;});
  }
})();
