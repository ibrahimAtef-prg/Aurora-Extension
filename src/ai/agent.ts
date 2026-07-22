export const AGENT_TAB_HTML = String.raw`
<!-- TAB: AI Insights (Phase 5 — Agent Chat) -->
<div id="pane-aiinsights" class="tabpane">
  <div id="agent-root">
  <!-- Context status bar -->
  <div class="agent-ctx-bar">
    <div class="agent-ctx-dot" id="agent-ctx-dot"></div>
    <span id="agent-ctx-label">No dataset loaded — run the pipeline first for grounded responses</span>
    <span style="margin-left:auto;color:var(--fg3)" id="agent-model-tag"></span>
  </div>
  <!-- API key config — always visible -->
  <div class="agent-config" id="agent-config-row">
    <label>🔑 Provider</label>
    <select id="agent-provider" class="agent-config-select" onchange="agentProviderChanged()">
      <option value="openrouter">OpenRouter (free models)</option>
      <option value="openai">OpenAI</option>
      <option value="anthropic">Anthropic</option>
      <option value="groq">Groq</option>
      <option value="together">Together AI</option>
      <option value="mistral">Mistral</option>
    </select>
    <input class="agent-config-input" id="agent-api-key" type="password"
      placeholder="Paste API key then press Enter or click Save"
      onkeydown="if(event.key==='Enter') agentSaveKey()" />
    <button class="agent-config-btn" onclick="agentSaveKey()">Save</button>
    <span class="agent-config-ok" id="agent-config-ok" style="display:none">✓ Saved</span>
    <span id="agent-key-status" style="font-size:10px;margin-left:4px"></span>
    <a id="agent-key-link" href="https://openrouter.ai/keys" style="color:#fb923c;font-size:10px;text-decoration:underline;margin-left:auto" target="_blank">Get free key ↗</a>
  </div>
  <!-- Confirm overlay removed — agent now acts autonomously via function-calling tools -->
  <!-- PART 4: Primary chat interface -->
  <div class="agent-chat">
    <div id="agent-messages" class="agent-messages">
      <div class="agent-ai">👋 Hi! I'm the Aurora Autonomous Agent. I have direct access to your pipeline — I can <strong>generate data, analyze it, export CSV, and write governance reports</strong> without any confirmation steps.<br><br>Just tell me what to do. For example: <em>"Add 500 more rows"</em> or <em>"Analyze privacy risks and generate a report."</em></div>
    </div>
    <div class="agent-input-row">
      <input id="agent-text" class="agent-text-input"
        placeholder="Ask about this dataset… e.g. Add 200 more rows"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();agentSendFromInput();}" />
      <button id="agent-send-simple" class="agent-send-simple" onclick="agentSendFromInput()">Send ↑</button>
    </div>
  </div>
  <!-- Legacy two-column layout kept for sidebar quick-actions (hidden by default) -->
  <div class="agent-layout" style="display:none" id="agent-legacy-layout">
    <div class="agent-sidebar">
      <div class="agent-sidebar-hdr">🤖 Quick Actions</div>
      <button class="aab" onclick="agentSend('Explain this dataset — structure, key columns, relationships, and risks.')"><span class="aab-icon">📋</span><span><span class="aab-label">Explain Dataset</span></span></button>
      <button class="aab" onclick="agentSend('Detect anomalies in this dataset — drift, skew, missing values, outliers.')"><span class="aab-icon">🔍</span><span><span class="aab-label">Detect Anomalies</span></span></button>
      <button class="aab" onclick="agentSend('Which columns are the riskiest and why?')"><span class="aab-icon">⚠️</span><span><span class="aab-label">Risky Columns</span></span></button>
      <button class="aab" onclick="agentSend('What columns contain PII and how should I protect them?')"><span class="aab-icon">👤</span><span><span class="aab-label">PII Protection</span></span></button>
      <button class="aab" onclick="agentSend('What are the GDPR implications of this dataset?')"><span class="aab-icon">⚖️</span><span><span class="aab-label">GDPR Analysis</span></span></button>
      <button class="aab" onclick="agentClear()" style="color:var(--fg3);margin-top:auto"><span class="aab-icon">🗑️</span><span><span class="aab-label">Clear Chat</span></span></button>
    </div>
    <div class="agent-main">
      <div class="agent-history" id="agent-history"><div class="agent-empty" id="agent-empty"><div class="agent-empty-icon">🤖</div><div class="agent-empty-title">Aurora Autonomous Agent</div><div class="agent-empty-sub">Ask any question about your dataset.</div></div></div>
      <div class="agent-input-area"><textarea class="agent-input" id="agent-input" rows="1" placeholder="Ask about your dataset…" onkeydown="agentKeydown(event)"></textarea><button class="agent-send-btn" id="agent-send-btn" onclick="agentSendInput()">Send ↑</button></div>
    </div>
  </div>
  </div>
</div>
`;

export const AGENT_SCRIPT = String.raw`
// ── PART 5+6: Simple chat message helpers ───────────────────────────────
function addUserMessage(text){
  var msgs=document.getElementById('agent-messages');
  if(!msgs) return;
  var el=document.createElement('div');
  el.className='agent-user';
  el.textContent=text;
  msgs.appendChild(el);
  msgs.scrollTop=msgs.scrollHeight;
}

function addAgentMessage(text, artifact){
  var msgs=document.getElementById('agent-messages');
  if(!msgs) return;
  // Remove any lingering tool-pill from this turn
  var pill=msgs.querySelector('.agent-tool-pill');
  if(pill) pill.remove();
  var el=document.createElement('div');
  el.className='agent-ai';
  renderFormattedContent(el, text);
  if(artifact){
    var card=document.createElement('div');
    card.className='agent-artifact-card';
    var icon=document.createElement('span'); icon.className='artifact-icon';
    var lbl=document.createElement('span');  lbl.className='artifact-label';
    var btn=document.createElement('button'); btn.className='artifact-export-btn';
    if(artifact.type==='csv' && artifact.previewOnly){
      // ONLY mode — preview card, no export button
      icon.textContent='📋';
      lbl.textContent=(artifact.samples ? artifact.samples.length : '?')+' rows preview (not added to dataset)';
      card.appendChild(icon); card.appendChild(lbl);
      el.appendChild(card);
    } else if(artifact.type==='csv'){
      var srcKind = ((typeof D !== 'undefined' && D.sourceKind) || 'csv').toUpperCase();
      var expLabel = 'Export ' + (srcKind === 'EXCEL' || srcKind === 'PARQUET' ? 'CSV' : srcKind);
      icon.textContent='📊'; lbl.textContent='Synthetic dataset ready'; btn.textContent=expLabel;
      btn.onclick=function(){ btn.disabled=true; btn.textContent='Saving…'; agentExportCSV(btn); };
      card.appendChild(icon); card.appendChild(lbl); card.appendChild(btn);
      el.appendChild(card);
    } else if(artifact.type==='comparison_chart'){
      var chartWrap=document.createElement('div');
      chartWrap.style.cssText='background:var(--vscode-editor-background,#1e1e1e);border-radius:8px;padding:12px;margin-top:8px;';
      var chartTitle=document.createElement('div');
      chartTitle.style.cssText='font-size:12px;font-weight:600;color:var(--vscode-foreground,#ccc);margin-bottom:4px;';
      chartTitle.textContent='Baseline vs Synthetic — Mean Delta (%) per Column';
      var chartSub=document.createElement('div');
      chartSub.style.cssText='font-size:10px;color:#888;margin-bottom:8px;';
      chartSub.textContent='Green < 2%  |  Orange 2–10%  |  Red > 10%  (scale-normalised)';
      chartWrap.appendChild(chartTitle);
      chartWrap.appendChild(chartSub);
      var canvas=document.createElement('canvas');
      // Height scales with column count so bars never get squished
      var colCount=(artifact.columns||[]).length;
      var canvasH=Math.max(160, Math.min(colCount*28+40, 520));
      canvas.style.cssText='width:100%;height:'+canvasH+'px;display:block;';
      // Set explicit pixel dimensions so the fallback renderer reads correct W/H
      canvas.width=740;
      canvas.height=canvasH;
      chartWrap.appendChild(canvas);
      el.appendChild(chartWrap);
      setTimeout(function(){
        if(typeof Chart==='undefined'){ chartTitle.textContent+=' (Chart.js unavailable)'; return; }
        var cols=artifact.columns||[];
        var bMeans=artifact.baseline_means||[];
        var sMeans=artifact.synthetic_means||[];
        // Compute delta% per column (scale-invariant)
        var deltas=cols.map(function(_,i){
          var b=bMeans[i]; var s=sMeans[i];
          if(b==null||s==null||b===0) return 0;
          return parseFloat((((s-b)/Math.abs(b))*100).toFixed(2));
        });
        var colours=deltas.map(function(d){
          var a=Math.abs(d);
          return a>10?'rgba(192,0,0,0.82)':a>=2?'rgba(212,106,0,0.82)':'rgba(26,122,74,0.82)';
        });
        var borderColours=deltas.map(function(d){
          var a=Math.abs(d);
          return a>10?'rgb(192,0,0)':a>=2?'rgb(212,106,0)':'rgb(26,122,74)';
        });
        new Chart(canvas,{
          type:'bar',
          data:{
            labels:cols,
            datasets:[{
              label:'Delta %',
              data:deltas,
              backgroundColor:colours,
              borderColor:borderColours,
              borderWidth:1,
            }],
          },
          options:{
            indexAxis:'y',
            responsive:true,
            maintainAspectRatio:false,
            plugins:{
              legend:{display:false},
              tooltip:{callbacks:{label:function(ctx){
                var i=ctx.dataIndex;
                var d=deltas[i];
                var b=bMeans[i]!=null?bMeans[i].toFixed(4):'—';
                var s=sMeans[i]!=null?sMeans[i].toFixed(4):'—';
                return ['Δ: '+(d>0?'+':'')+d+'%','Baseline: '+b,'Synthetic: '+s];
              }}}
            },
            scales:{
              x:{
                title:{display:true,text:'Delta (%)',color:'#888',font:{size:10}},
                ticks:{color:'var(--vscode-foreground,#ccc)',font:{size:9}},
                grid:{color:'rgba(255,255,255,0.06)'},
                // zero reference line
                afterBuildTicks:function(ax){ if(!ax.ticks.find(function(t){return t.value===0;})) ax.ticks.push({value:0}); }
              },
              y:{ticks:{color:'var(--vscode-foreground,#ccc)',font:{size:9}},grid:{color:'rgba(255,255,255,0.03)'}},
            },
          },
        });
      },50);
    } else {
      var isStatSummary=artifact.reportType==='statistical';
      icon.textContent=isStatSummary?'📊':'📄';
      lbl.textContent=isStatSummary?'Statistical Summary ready':'Governance report ready';
      btn.textContent='Export Report';
      btn.onclick=function(){ btn.disabled=true; btn.textContent='Saving…'; agentExportReport(artifact.content, artifact.filePath, btn); };
      card.appendChild(icon); card.appendChild(lbl); card.appendChild(btn);
      el.appendChild(card);
    }
  }
  msgs.appendChild(el);
  msgs.scrollTop=msgs.scrollHeight;
}

// BUG-17 fix: rich text renderer for agent messages
function renderFormattedContent(el, text){
  var BT=String.fromCharCode(96);
  var marker=BT+BT+BT;
  var segments=[];
  var pos=0;
  while(true){
    var next=text.indexOf(marker,pos);
    if(next===-1){segments.push({type:'text',content:text.substring(pos)});break;}
    if(next>pos) segments.push({type:'text',content:text.substring(pos,next)});
    var closePos=text.indexOf(marker,next+3);
    if(closePos===-1){segments.push({type:'text',content:text.substring(next)});break;}
    var inner=text.substring(next+3,closePos);
    var nl=inner.indexOf(String.fromCharCode(10));
    var lang=nl!==-1?inner.substring(0,nl).trim().toLowerCase():'';
    var code=nl!==-1?inner.substring(nl+1).trim():inner.trim();
    segments.push({type:'code',lang:lang,content:code});
    pos=closePos+3;
  }

  // Render inline markdown: **bold** and ${'\`'}code${'\`'}
  function renderInline(parent, line){
    var parts=line.split(/(\*\*[^*]+\*\*|${'\`'}[^${'\`'}]+${'\`'})/g);
    parts.forEach(function(part){
      if(/^\*\*[^*]+\*\*$/.test(part)){
        var b=document.createElement('strong');
        b.textContent=part.slice(2,-2);
        parent.appendChild(b);
      } else if(/^${'\`'}[^${'\`'}]+${'\`'}$/.test(part)){
        var c=document.createElement('code');
        c.style.cssText='background:var(--card2,#1e1e2e);border-radius:3px;padding:0 3px;font-size:11px;';
        c.textContent=part.slice(1,-1);
        parent.appendChild(c);
      } else if(part){
        parent.appendChild(document.createTextNode(part));
      }
    });
  }

  // Collect and render a markdown table
  function renderTable(tableLines){
    var tbl=document.createElement('table');
    tbl.style.cssText='width:100%;border-collapse:collapse;font-size:11px;margin:6px 0;';
    tableLines.forEach(function(row,ri){
      if(/^\|[-: |]+\|$/.test(row.trim())) return; // skip separator row
      var tr=document.createElement('tr');
      var cells=row.replace(/^\||\|$/g,'').split('|');
      cells.forEach(function(cell){
        var td=ri===0?document.createElement('th'):document.createElement('td');
        td.style.cssText='border:1px solid rgba(255,255,255,0.12);padding:3px 8px;text-align:left;'+(ri===0?'background:rgba(255,255,255,0.07);font-weight:600;':'');
        renderInline(td, cell.trim());
        tr.appendChild(td);
      });
      tbl.appendChild(tr);
    });
    el.appendChild(tbl);
  }

  segments.forEach(function(seg){
    if(seg.type==='code'){
      var pre=document.createElement('pre');
      pre.style.cssText='background:var(--card2,#1e1e2e);border:1px solid var(--border,#2a2a3b);border-radius:8px;padding:8px;font-size:11px;overflow-x:auto;margin:4px 0;white-space:pre-wrap';
      pre.textContent=seg.content;
      if(seg.lang==='sql'){
        var copyBtn=document.createElement('button');
        copyBtn.className='agent-sql-copy'; copyBtn.textContent='Copy';
        (function(c){copyBtn.onclick=function(){vscode.postMessage({command:'copyToClipboard',text:c});copyBtn.textContent='Copied!';setTimeout(function(){copyBtn.textContent='Copy';},1500);};})(seg.content);
        var wrap=document.createElement('div'); wrap.className='agent-sql';
        wrap.appendChild(pre); wrap.appendChild(copyBtn);
        el.appendChild(wrap);
      } else {
        el.appendChild(pre);
      }
    } else if(seg.content){
      var lines=seg.content.split(String.fromCharCode(10));
      var i=0;
      while(i<lines.length){
        var line=lines[i];
        // ── Heading levels ──────────────────────────────────────────────────
        if(/^#{1,4}\s/.test(line)){
          var level=line.match(/^(#+)/)[1].length;
          var hEl=document.createElement(level<=2?'strong':'span');
          var sizes=['14px','13px','12px','11px'];
          hEl.style.cssText='display:block;margin:'+(level===1?'10px 0 5px':'6px 0 3px')+';font-size:'+(sizes[Math.min(level-1,3)])+';font-weight:600;'+(level<=2?'border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:2px;':'');
          renderInline(hEl, line.replace(/^#+\s*/,''));
          el.appendChild(hEl);
          i++; continue;
        }
        // ── Table block ─────────────────────────────────────────────────────
        if(/^\|/.test(line)){
          var tableLines=[];
          while(i<lines.length && /^\|/.test(lines[i])){
            tableLines.push(lines[i]); i++;
          }
          renderTable(tableLines);
          continue;
        }
        // ── List item ───────────────────────────────────────────────────────
        if(/^[\-\*]\s/.test(line)){
          var li=document.createElement('div');
          li.style.cssText='display:flex;gap:6px;margin:2px 0;align-items:flex-start;';
          var dot=document.createElement('span');
          dot.textContent='•';
          dot.style.cssText='color:#888;flex-shrink:0;margin-top:1px;';
          var txt=document.createElement('span');
          renderInline(txt, line.replace(/^[\-\*]\s/,''));
          li.appendChild(dot); li.appendChild(txt);
          el.appendChild(li);
          i++; continue;
        }
        // ── Numbered list ───────────────────────────────────────────────────
        if(/^\d+\.\s/.test(line)){
          var nli=document.createElement('div');
          nli.style.cssText='display:flex;gap:6px;margin:2px 0;';
          var num=document.createElement('span');
          num.textContent=line.match(/^(\d+\.)/)[1];
          num.style.cssText='color:#888;flex-shrink:0;min-width:18px;';
          var ntxt=document.createElement('span');
          renderInline(ntxt, line.replace(/^\d+\.\s/,''));
          nli.appendChild(num); nli.appendChild(ntxt);
          el.appendChild(nli);
          i++; continue;
        }
        // ── Horizontal rule ─────────────────────────────────────────────────
        if(/^---+$/.test(line.trim())){
          var hr=document.createElement('hr');
          hr.style.cssText='border:none;border-top:1px solid rgba(255,255,255,0.1);margin:6px 0;';
          el.appendChild(hr);
          i++; continue;
        }
        // ── Empty line → small spacer ────────────────────────────────────────
        if(line.trim()===''){
          var sp=document.createElement('div'); sp.style.height='4px';
          el.appendChild(sp);
          i++; continue;
        }
        // ── Normal paragraph line ────────────────────────────────────────────
        var p=document.createElement('div');
        p.style.cssText='margin:1px 0;';
        renderInline(p, line);
        el.appendChild(p);
        i++;
      }
    }
  });
}

// PART 6: Send from the simple input bar
function agentSendFromInput(){
  var input=document.getElementById('agent-text');
  if(!input) return;
  var text=(input.value||'').trim();
  if(!text) return;
  if(_agentThinking) return;

  // ── Route known commands to their dedicated handlers ──────────────────────
  // These bypass agentChat so they hit the correct pipeline (docx generation,
  // direct export, etc.) instead of the generic generate-rows fallback.
  var lower = text.toLowerCase();
  if(/\bgenerate\s+statistical\s+summary\b|\bstat(istical)?\s+(summary|report)\b/i.test(text)){
    input.value='';
    agentStatReport();
    return;
  }
  if(/\bgenerate\s+(report|governance\s+report)\b/i.test(text)){
    input.value='';
    agentRequestReport();
    return;
  }
  if(/\bexport\s+(it|csv|dataset|data)\b|\bsave\s+(csv|dataset|data)\b/i.test(text)){
    input.value='';
    addUserMessage(text);
    _agentHistory.push({role:'user',content:text,ts:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})});
    agentExportCSV(null);
    return;
  }

  _agentThinking=true;
  console.log('[Aurora] agentChat request:', text);
  addUserMessage(text);
  input.value='';
  _agentHistory.push({role:'user',content:text,ts:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})});
  // Show thinking indicator
  var msgs=document.getElementById('agent-messages');
  if(msgs){
    var think=document.createElement('div');
    think.className='agent-ai thinking';
    think.id='agent-thinking-msg';
    think.textContent='… thinking';
    msgs.appendChild(think);
    msgs.scrollTop=msgs.scrollHeight;
  }
  var sendBtn=document.getElementById('agent-send-simple');
  if(sendBtn) sendBtn.disabled=true;
  var histPayload=_agentHistory.slice(0,-1).map(function(m){return{role:m.role,content:m.content};});
  var liveContext={};
  try{
    if(typeof D!=='undefined'&&D){
      liveContext.cp=D.cp||null;
      liveContext.generatorRows=(D.result||D.generator||{}).row_count||null;
      liveContext.generatorUsed=(D.result||D.generator||{}).generator_used||null;
      if(D.leakage) liveContext.leakage=D.leakage;
      if(D.scanReport) liveContext.scanReport=D.scanReport;
      if(D.profile||D.baseline) liveContext.profile=D.profile||D.baseline;
    }
  }catch(e){}
  _agentMsgCounter++;
  var msgId='am-'+_agentMsgCounter;
  vscode.postMessage({command:'agentChat', message:text, history:histPayload, liveContext:liveContext, msgId:msgId});
}

// BUG-16 fix: only send checkApiKey once per session
var _apiKeyChecked=false;

// PART 2+5: initAgentChat — called when AI Insights tab is shown
function initAgentChat(){
  const root=document.getElementById('agent-root');
  if(!root){ console.error('missing root container'); return; }
  try{ agentProviderChanged(); }catch(e){}
  if(!_apiKeyChecked){
    vscode.postMessage({command:'checkApiKey'});
    _apiKeyChecked=true;
  }
  var dot=document.getElementById('agent-ctx-dot');
  var label=document.getElementById('agent-ctx-label');
  if(dot&&label){
    var hasData=D&&(D.baseline||D.leakage||D.result||D.profile||D.generator);
    if(hasData){
      dot.className='agent-ctx-dot ok';
      var numCols=Object.keys(((D.profile||D.baseline||{}).columns&&(D.profile||D.baseline||{}).columns.numeric)||{}).length;
      var catCols=Object.keys(((D.profile||D.baseline||{}).columns&&(D.profile||D.baseline||{}).columns.categorical)||{}).length;
      var rows=(D.baseline&&D.baseline.meta&&D.baseline.meta.row_count)||(D.result&&D.result.row_count)||(D.generator&&D.generator.row_count)||'?';
      var risk=(D.leakage&&D.leakage.risk_level)||'—';
      var ps=D.leakage&&D.leakage.privacy_score!=null?Math.round(D.leakage.privacy_score*100)+'%':'—';
      label.textContent='✓ Dataset loaded — '+rows+' rows · '+(numCols+catCols)+' cols · risk: '+risk+' · privacy: '+ps;
    } else {
      dot.className='agent-ctx-dot none';
      label.textContent='No dataset loaded — run the generator first';
    }
  }
  if(typeof agentInitCtxBar==='function') agentInitCtxBar();
}

// ── Phase 5: AI Data Governance Agent Chat ───────────────────────────────────
var _agentHistory = [];  // {role, content, ts}
var _agentThinking = false;
var _agentMsgCounter = 0;

// ── Provider info map ──────────────────────────────────────────────────
var PROVIDER_INFO = {
  openrouter: { label:'OpenRouter', placeholder:'Paste sk-or-… key', link:'https://openrouter.ai/keys',     linkText:'Get free key ↗' },
  openai:     { label:'OpenAI',     placeholder:'Paste sk-… key',     link:'https://platform.openai.com/api-keys', linkText:'Get key ↗' },
  anthropic:  { label:'Anthropic',  placeholder:'Paste sk-ant-… key', link:'https://console.anthropic.com/settings/keys', linkText:'Get key ↗' },
  groq:       { label:'Groq',       placeholder:'Paste gsk_… key',    link:'https://console.groq.com/keys', linkText:'Get free key ↗' },
  together:   { label:'Together AI',placeholder:'Paste API key',      link:'https://api.together.ai/settings/api-keys', linkText:'Get key ↗' },
  mistral:    { label:'Mistral',    placeholder:'Paste API key',      link:'https://console.mistral.ai/api-keys', linkText:'Get key ↗' },
};

function agentProviderChanged(){
  var sel=document.getElementById('agent-provider');
  var inp=document.getElementById('agent-api-key');
  var link=document.getElementById('agent-key-link');
  if(!sel||!inp) return;
  var info=PROVIDER_INFO[sel.value]||PROVIDER_INFO.openrouter;
  inp.placeholder=info.placeholder;
  if(link){ link.href=info.link; link.textContent=info.linkText; }
  var status=document.getElementById('agent-key-status');
  if(status){
    var savedKey=null;
    try{ savedKey=localStorage.getItem('automate_api_key_'+sel.value); }catch(e){}
    if(savedKey){
      status.style.color='var(--green)';
      status.textContent='✓ Key loaded for '+info.label;
    } else {
      status.style.color='#fb923c';
      status.textContent='No key for '+info.label;
    }
  }
}

// ── Phase 2/3: API key save (localStorage + extension) ───────────────
function agentSaveKey(){
  var inp=document.getElementById('agent-api-key');
  var sel=document.getElementById('agent-provider');
  if(!inp) return;
  var key=(inp.value||'').trim();
  var provider=(sel?sel.value:null)||'openrouter';
  if(!key){ inp.focus(); return; }
  try{
    localStorage.setItem('automate_api_key_'+provider, key);
    localStorage.setItem('automate_api_provider', provider);
  }catch(e){}
  vscode.postMessage({command:'setApiKey', apiKey:key, provider:provider});
  var ok=document.getElementById('agent-config-ok');
  if(ok){ ok.style.display=''; setTimeout(function(){ ok.style.display='none'; },2000); }
  var status=document.getElementById('agent-key-status');
  var info=PROVIDER_INFO[provider]||PROVIDER_INFO.openrouter;
  var masked=key.slice(0,6)+'…'+key.slice(-4);
  if(status){ status.style.color='var(--green)'; status.textContent='✓ '+info.label+': '+masked; }
  inp.value='';
  inp.placeholder='Key saved — paste a new key to update';
  vscode.postMessage({command:'checkApiKey'});
}

function agentInitCtxBar(){
  var dot   = document.getElementById('agent-ctx-dot');
  var label = document.getElementById('agent-ctx-label');
  if(!dot||!label) return;
  var hasData = D && (D.baseline || D.leakage || D.result);
  if(hasData){
    dot.className='agent-ctx-dot ok';
    var numCols = Object.keys((D.baseline&&D.baseline.columns&&D.baseline.columns.numeric)||{}).length;
    var catCols = Object.keys((D.baseline&&D.baseline.columns&&D.baseline.columns.categorical)||{}).length;
    var rows  = (D.baseline&&D.baseline.meta&&D.baseline.meta.row_count) || (D.result&&D.result.row_count) || '?';
    var cols  = numCols + catCols;
    var risk  = (D.leakage&&D.leakage.risk_level) || '—';
    var ps    = D.leakage&&D.leakage.privacy_score!=null ? Math.round(D.leakage.privacy_score*100)+'%' : '—';
    label.textContent = '✓ Dataset loaded — '+rows+' rows · '+cols+' cols · risk: '+risk+' · privacy: '+ps+'. Responses grounded in pipeline data.';
  } else {
    dot.className='agent-ctx-dot none';
    label.textContent = 'No dataset loaded — run the pipeline first for grounded responses';
  }
}

function agentRender(){
  agentInitCtxBar();
  var hist = document.getElementById('agent-history');
  var empty = document.getElementById('agent-empty');
  if(!hist) return;
  if(_agentHistory.length===0){
    if(empty) empty.style.display='';
    return;
  }
  if(empty) empty.style.display='none';
  var existing = hist.querySelectorAll('.agent-msg,.agent-thinking').length;
  var toRender  = _agentHistory.slice(existing);
  toRender.forEach(function(m){ hist.appendChild(agentBuildBubble(m)); });
  hist.scrollTop=hist.scrollHeight;
}

function extractCodeBlocks(text) {
  var BT = String.fromCharCode(96);
  var marker = BT + BT + BT;
  var blocks = [];
  var pos = 0;
  while (true) {
    var start = text.indexOf(marker, pos);
    if (start === -1) break;
    var end = text.indexOf(marker, start + 3);
    if (end === -1) break;
    var block = text.substring(start + 3, end).trim();
    blocks.push(block);
    pos = end + 3;
  }
  return blocks;
}

function agentBuildBubble(m){
  var wrap = document.createElement('div');
  wrap.className='agent-msg '+(m.role==='user'?'user':'assistant');
  var bubble = document.createElement('div');
  bubble.className='agent-bubble';
  var txt = m.content||'';
  var BT = String.fromCharCode(96);
  var marker = BT + BT + BT;
  var segments = [];
  var pos = 0;
  while (true) {
    var next = txt.indexOf(marker, pos);
    if (next === -1) { segments.push({type:'text', content:txt.substring(pos)}); break; }
    if (next > pos) segments.push({type:'text', content:txt.substring(pos, next)});
    var closePos = txt.indexOf(marker, next + 3);
    if (closePos === -1) { segments.push({type:'text', content:txt.substring(next)}); break; }
    var inner = txt.substring(next + 3, closePos);
    var newline = inner.indexOf(String.fromCharCode(10));
    var lang = newline !== -1 ? inner.substring(0, newline).trim().toLowerCase() : '';
    var code = newline !== -1 ? inner.substring(newline + 1).trim() : inner.trim();
    segments.push({type:'code', lang:lang, content:code});
    pos = closePos + 3;
  }
  segments.forEach(function(seg){
    if (seg.type === 'code' && seg.lang === 'sql') {
      var sqlDiv=document.createElement('div'); sqlDiv.className='agent-sql';
      sqlDiv.textContent=seg.content;
      var btn=document.createElement('button'); btn.className='agent-sql-copy'; btn.textContent='Copy';
      (function(c){ btn.onclick=function(){vscode.postMessage({command:'copyToClipboard',text:c});btn.textContent='Copied!';setTimeout(function(){btn.textContent='Copy';},1500);}; })(seg.content);
      sqlDiv.appendChild(btn);
      bubble.appendChild(sqlDiv);
    } else if (seg.type === 'code') {
      var pre=document.createElement('pre'); pre.style.cssText='background:var(--card2);border:1px solid var(--border);border-radius:8px;padding:8px;font-size:11px;overflow-x:auto;margin:4px 0';
      pre.textContent=seg.content; bubble.appendChild(pre);
    } else if (seg.content) {
      var span=document.createElement('span'); span.textContent=seg.content; bubble.appendChild(span);
    }
  });
  var meta=document.createElement('div'); meta.className='agent-msg-meta';
  meta.textContent=(m.role==='user'?'You':'Agent')+(m.ts?' · '+m.ts:'')+(m.model?' · '+m.model:'');
  wrap.appendChild(bubble); wrap.appendChild(meta);
  return wrap;
}

function agentShowThinking(){
  var hist=document.getElementById('agent-history');
  if(!hist) return;
  var div=document.createElement('div'); div.className='agent-thinking'; div.id='agent-thinking-bubble';
  div.innerHTML='<span></span><span></span><span></span>';
  hist.appendChild(div); hist.scrollTop=hist.scrollHeight;
}
function agentHideThinking(){
  var el=document.getElementById('agent-thinking-bubble'); if(el) el.remove();
  var el2=document.getElementById('agent-thinking-msg'); if(el2) el2.remove();
}

function agentStripActionBlocks(text){
  var cleaned = text.replace(/<actions>[\s\S]*?<\/actions>/g,'').trim();
  cleaned = cleaned.replace(/(?:[a-z0-9_\-\\\/#:;&]{1,8}){25,}/gi, '').trim();
  return cleaned;
}

function agentSend(text){
  var msg=(text||'').trim();
  if(!msg||_agentThinking) return;
  var input=document.getElementById('agent-input');
  if(input&&!text){ msg=input.value.trim(); if(!msg) return; input.value=''; }
  if(input&&text){ input.value=''; }
  var ts=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  _agentHistory.push({role:'user',content:msg,ts:ts});
  var empty=document.getElementById('agent-empty'); if(empty) empty.style.display='none';
  agentRender();
  agentShowThinking();
  _agentThinking=true;
  var btn=document.getElementById('agent-send-btn'); if(btn) btn.disabled=true;
  _agentMsgCounter++;
  var msgId='am-'+_agentMsgCounter;
  var histPayload=_agentHistory.slice(0,-1).map(function(m){return{role:m.role,content:m.content};});
  var liveCtx2={};
  try{
    if(typeof D!=='undefined'&&D){
      liveCtx2.cp=D.cp||null;
      liveCtx2.generatorRows=(D.result||D.generator||{}).row_count||null;
      liveCtx2.generatorUsed=(D.result||D.generator||{}).generator_used||null;
      if(D.leakage) liveCtx2.leakage=D.leakage;
      if(D.scanReport) liveCtx2.scanReport=D.scanReport;
      if(D.profile||D.baseline) liveCtx2.profile=D.profile||D.baseline;
    }
  }catch(e){}
  vscode.postMessage({command:'agentChat',message:msg,history:histPayload,msgId:msgId,liveContext:liveCtx2});
}

function agentKeydown(e){
  if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); agentSendInput(); }
}
function agentSendInput(){
  var input=document.getElementById('agent-input');
  if(!input) return;
  agentSend(input.value);
  input.value='';
}

function agentAction(action){
  if(_agentThinking) return;
  var labels={
    explainDataset:'Explain this dataset — structure, key columns, relationships, and risks.',
    detectAnomalies:'Detect anomalies in this dataset — drift, skew, missing values, outliers.',
    suggestCleaning:'Suggest a data cleaning plan — imputation, outlier handling, PII masking.',
    recommendGovernance:'Recommend a governance action plan — masking, anonymisation, compliance.'
  };
  var displayMsg=labels[action]||action;
  var ts=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  _agentHistory.push({role:'user',content:displayMsg,ts:ts});
  var empty=document.getElementById('agent-empty'); if(empty) empty.style.display='none';
  agentRender();
  agentShowThinking();
  _agentThinking=true;
  var btn=document.getElementById('agent-send-btn'); if(btn) btn.disabled=true;
  _agentMsgCounter++;
  var msgId='am-'+_agentMsgCounter;
  vscode.postMessage({command:'agentAction',action:action,msgId:msgId});
}

function agentSQLPrompt(){
  var q=prompt('Describe the SQL query you need:','Find all records where income > 100000');
  if(!q) return;
  var ts=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  _agentHistory.push({role:'user',content:'Generate SQL: '+q,ts:ts});
  var empty=document.getElementById('agent-empty'); if(empty) empty.style.display='none';
  agentRender();
  agentShowThinking();
  _agentThinking=true;
  var btn=document.getElementById('agent-send-btn'); if(btn) btn.disabled=true;
  _agentMsgCounter++;
  vscode.postMessage({command:'agentAction',action:'generateSQL',sqlQuestion:q,msgId:'am-'+_agentMsgCounter});
}

// ── Artifact export helpers ───────────────────────────────────────────────
function agentExportCSV(btn){
  var rows=[];
  try{
    var src=(typeof D!=='undefined')&&(D.result||D.generator);
    rows=(src&&src.samples)||[];
  }catch(e){}
  if(!rows.length){
    if(btn){ btn.disabled=false; btn.textContent='Export CSV'; }
    addAgentMessage('⚠ No sample data available to export. Run the generator first.');
    return;
  }
  var cols=Object.keys(rows[0]||{});
  var csv=[cols.join(',')].concat(rows.map(function(r){
    return cols.map(function(c){
      var v=r[c]!=null?String(r[c]):'';
      return v.includes(',')||v.includes('"')||v.includes('\n') ? '"'+v.replace(/"/g,'""')+'"' : v;
    }).join(',');
  })).join('\n');
  vscode.postMessage({command:'exportCSV', csv:csv, filename:'generated_data.csv'});
  if(btn){ btn.textContent='✓ Saved'; setTimeout(function(){ btn.disabled=false; btn.textContent='Export CSV'; },2000); }
  else { addAgentMessage('✅ Dataset exported — **generated_data.csv** saved to your workspace.'); }
}

function agentExportReport(content, filePath, btn){
  vscode.postMessage({command:'exportArtifact', type:'report', content:content||'', filePath:filePath||null, filename:'aurora_report.docx'});
  if(btn){ btn.textContent='✓ Saved'; setTimeout(function(){ btn.disabled=false; btn.textContent='Export Report'; },2000); }
}

// ── Tool progress pill — shown when agent calls a tool (live progress) ──────
var TOOL_LABELS = {
  get_dataset_state: '🔍 Reading dataset state…',
  generate_rows:     '⚙️ Generating rows…',
  merge_and_update:  '🔀 Merging rows into dataset…',
  analyze_dataset:   '📊 Analyzing dataset…',
  generate_report:   '📋 Writing governance report…',
  export_csv:        '💾 Exporting CSV…',
  combine_datasets:  '🔗 Combining synthetic and original datasets…',
};

function agentHandleToolProgress(toolName, args){
  var msgs = document.getElementById('agent-messages');
  if(!msgs) return;
  // Replace any previous pill for this turn
  var old = msgs.querySelector('.agent-tool-pill');
  if(old) old.remove();
  // Also remove the generic "thinking" indicator — pill replaces it
  var think = document.getElementById('agent-thinking-msg');
  if(think) think.remove();
  var pill = document.createElement('div');
  pill.className = 'agent-tool-pill';
  var label = TOOL_LABELS[toolName] || ('⚙️ Calling ' + toolName + '…');
  if(toolName === 'generate_rows' && args && args.count) {
    label = '⚙️ Generating ' + args.count + ' rows…';
  }
  pill.textContent = label;
  msgs.appendChild(pill);
  msgs.scrollTop = msgs.scrollHeight;
}

// ── Handle agentReportReady (from generate_report tool) ──────────────────────
function agentHandleReportReady(content, filePath){
  var ts=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  var summary='📄 Report ready'+(filePath?' — '+filePath:'')+'.'
  addAgentMessage(summary, {type:'report', content:content, filePath:filePath});
}

function agentHandleResponse(content, model, error, artifact){
  agentHideThinking();
  _agentThinking=false;
  var btn=document.getElementById('agent-send-btn'); if(btn) btn.disabled=false;
  var simpleBtn=document.getElementById('agent-send-simple'); if(simpleBtn) simpleBtn.disabled=false;
  var ts=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  if(error){
    var errLow = error ? error.toLowerCase() : '';
    var isKeyError = errLow.indexOf('api key')!==-1
      || errLow.indexOf('not configured')!==-1
      || errLow.indexOf('authentication')!==-1
      || errLow.indexOf('unauthorized')!==-1
      || errLow.indexOf('invalid key')!==-1
      || errLow.indexOf('invalid api')!==-1
      || error.indexOf('401')!==-1;
    if(isKeyError){
      var inp2=document.getElementById('agent-api-key');
      var status2=document.getElementById('agent-key-status');
      if(inp2) inp2.focus();
      if(status2){ status2.style.color='#fb923c'; status2.textContent='No key — paste one above'; }
      var keyMsg='🔑 API key not configured. Select your provider and paste your API key in the bar above.';
      _agentHistory.push({role:'assistant',content:keyMsg,ts:ts});
      addAgentMessage(keyMsg);
    } else {
      _agentHistory.push({role:'assistant',content:'⚠ Error: '+error,ts:ts});
      addAgentMessage('⚠ Error: '+error);
    }
  } else {
    // Autonomous agent never emits XML action blocks — render content directly
    var displayContent = content || 'Done.';
    _agentHistory.push({role:'assistant',content:displayContent,ts:ts,model:model});
    var tag=document.getElementById('agent-model-tag'); if(tag) tag.textContent=model||'';
    // Bug 4 fix: synthesise csv artifact card when the response signals a successful export
    // but the extension didn't attach an artifact (e.g. export ran via the agentic loop).
    var resolvedArtifact = artifact || null;
    if(!resolvedArtifact && content && /(?:✅[^\n]*(?:exported|saved|csv|merged\b.*\brows?|\b\d+\b.*\bnew\s+rows?\b)|\b(?:added|generated|merged|created)\b[^\n]*\b\d+\b[^\n]*\bnew\s+(?:synthetic\s+)?rows?\b|\b\d+\b[^\n]*\bnew\s+(?:synthetic\s+)?rows?\b[^\n]*(?:added|merged|generated)|\bdataset\b.*\bnow\s+contains?\b.*\b\d[\d,]+\s+rows?\b)/i.test(content)){
      resolvedArtifact = {type:'csv', content:content, filePath:null};
    }
    addAgentMessage(displayContent, resolvedArtifact);
  }
  console.log('[Aurora] agent response received');
}

// ── Report request ────────────────────────────────────────────────────────
function agentRequestReport(){
  if(_agentThinking) return;
  _agentThinking=true;
  addUserMessage('Generate Report');
  _agentHistory.push({role:'user',content:'Generate Report',ts:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})});
  var msgs=document.getElementById('agent-messages');
  if(msgs){
    var think=document.createElement('div');
    think.className='agent-ai thinking';
    think.id='agent-thinking-msg';
    think.textContent='... generating report';
    msgs.appendChild(think);
    msgs.scrollTop=msgs.scrollHeight;
  }
  var sendBtn=document.getElementById('agent-send-simple');
  if(sendBtn) sendBtn.disabled=true;
  vscode.postMessage({command:'agentReport'});
}

// ── Handle report result from extension ───────────────────────────────────
// reportType: 'governance' (default) | 'statistical' — controls the displayed title
function agentHandleReportResult(content, filePath, error, reportType){
  agentHideThinking();
  _agentThinking=false;
  var simpleBtn=document.getElementById('agent-send-simple'); if(simpleBtn) simpleBtn.disabled=false;
  var ts=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  if(error){
    var msg='⚠ Report error: '+error;
    _agentHistory.push({role:'assistant',content:msg,ts:ts});
    addAgentMessage(msg);
  } else {
    // Bug 3 fix: use the correct title based on which pipeline generated the report
    var title = (reportType==='statistical')
      ? '📊 Statistical Summary generated'
      : '📄 Governance report generated';
    var summary=title+(filePath?' — '+filePath:'')+'.'
    _agentHistory.push({role:'assistant',content:summary,ts:ts});
    addAgentMessage(summary, {type:'report', content:content, filePath:filePath});
  }
}

// ── Stat summary report request ───────────────────────────────────────────
function agentStatReport(){
  if(_agentThinking) return;
  _agentThinking=true;
  addUserMessage('Generate Statistical Summary');
  _agentHistory.push({role:'user',content:'Generate Statistical Summary',ts:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})});
  var msgs=document.getElementById('agent-messages');
  if(msgs){
    var think=document.createElement('div');
    think.className='agent-ai thinking';
    think.id='agent-thinking-msg';
    think.textContent='... generating statistical summary';
    msgs.appendChild(think);
    msgs.scrollTop=msgs.scrollHeight;
  }
  var sendBtn=document.getElementById('agent-send-simple');
  if(sendBtn) sendBtn.disabled=true;
  vscode.postMessage({command:'agentStatReport'});
}

// BUG-05 fix: clear BOTH visible chat (agent-messages) AND legacy (agent-history)
function agentClear(){
  _agentHistory=[];
  _agentThinking=false;
  var msgs=document.getElementById('agent-messages');
  if(msgs){
    msgs.innerHTML='<div class="agent-ai">👋 Hi! I\'m the Aurora Autonomous Agent. I have direct tool access to your pipeline — tell me what to do.</div>';
  }
  var hist=document.getElementById('agent-history');
  if(hist){
    hist.innerHTML='';
    var emptyDiv=document.createElement('div'); emptyDiv.className='agent-empty'; emptyDiv.id='agent-empty';
    emptyDiv.innerHTML='<div class="agent-empty-icon">🤖</div><div class="agent-empty-title">Aurora Autonomous Agent</div><div class="agent-empty-sub">Ask any question about your dataset — privacy risks, SQL generation, anomalies, cleaning strategies, or governance actions.<br><br>I can also generate data, export CSV, and write reports directly.</div>';
    hist.appendChild(emptyDiv);
  }
  var sendBtn=document.getElementById('agent-send-simple');
  if(sendBtn) sendBtn.disabled=false;
  var sendBtn2=document.getElementById('agent-send-btn');
  if(sendBtn2) sendBtn2.disabled=false;
}

// Legacy fallback for old askAI (non-chat path)
function askAI(){
  var q=document.getElementById('ai-question');
  if(q) agentSend(q.value);
}
function askQuick(q){ agentSend(q); }
`;
