"use strict";
/**
 * src/webview/monitorPanel.ts — Aurora Privacy Dashboard
 * Redesigned: VS Code theme-integrated, emoji-free, clean layout
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMonitorHtml = buildMonitorHtml;
const charts_1 = require("./ui/charts");
const overview_1 = require("./ui/overview");
const synthetic_1 = require("./ui/synthetic");
const security_1 = require("./ui/security");
const livesecurity_1 = require("./ui/livesecurity");
const agent_1 = require("./ui/agent");
const parser_1 = require("./ui/parser");
function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function buildMonitorHtml(data) {
    const dataJson = JSON.stringify(data).replace(/<\/script/gi, '<\\/script');
    const logoUri = data.logoUri ?? '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Aurora</title>
<script src="${esc(data.chartUri)}"></script>
<script>\n${charts_1.CHART_INLINE_FALLBACK_SCRIPT}\n</script>\n<style>\n${charts_1.DASHBOARD_STYLES}\n
${parser_1.PARSER_STYLES}
</style>
</head>
<body>

<!-- Sticky header -->
<div class="hdr">
  <div class="logo">
  <div class="logo-mark">
      ${logoUri
        ? `<img src="${logoUri}" style="width:32px;height:32px;border-radius:7px;display:block;flex-shrink:0;object-fit:contain;" alt="Aurora"/>`
        : `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 1L16 5V13L9 17L2 13V5L9 1Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="9" cy="9" r="2.5" fill="currentColor"/></svg>`}
    </div>
    <div>
      <div class="logo-title">Aurora</div>
      <div class="logo-sub" id="hdr-sub">Privacy &amp; Synthetic Data Governance</div>
    </div>
  </div>
  <div class="hdr-right">
    <div class="data-mode-toggle" id="data-mode-toggle" style="display:none" title="Switch between original and synthetic data view">
      <button class="dmt-btn" id="dmt-orig" onclick="setDataMode('original')">Original</button>
      <button class="dmt-btn" id="dmt-synth" onclick="setDataMode('synthetic')">Synthetic</button>
    </div>
    <button class="hbtn hbtn-g" id="btn-export-synthetic" onclick="doExportSynthetic()" style="display:none">Export Synthetic</button>
    <button class="hbtn hbtn-g" onclick="vscode.postMessage({command:'anonymizeDataset'})" title="Auto-anonymize PII columns">Anonymize</button>
    <button class="hbtn hbtn-p" onclick="doExportReport()">Save Report</button>
  </div>
</div>

<!-- Status strip -->
<div class="strip">
  <div class="spill"><div><div class="sl" id="sl-risk">Risk Level</div><div class="sv" id="m-risk">&#8212;</div></div></div>
  <div class="spill"><div><div class="sl" id="sl-ps">Privacy Score</div><div class="sv" id="m-ps">&#8212;</div></div></div>
  <div class="spill"><div><div class="sl" id="sl-drift">Drift</div><div class="sv" id="m-drift">&#8212;</div></div></div>
  <div class="spill"><div><div class="sl" id="sl-dup">Duplicates</div><div class="sv" id="m-dup">&#8212;</div></div></div>
  <div class="spill"><div><div class="sl" id="sl-rows">Rows</div><div class="sv" id="m-rows">&#8212;</div></div></div>
</div>

<!-- Sanity warning banner -->
<div id="sanity-banner" style="display:none"></div>

<!-- Tab navigation -->
<div class="tabs">
  <button class="tab active"  onclick="showTab('parser',this)">Parser</button>
  <button class="tab"         onclick="showTab('overview',this)">Overview</button>
  <button class="tab" id="synthetic-tab" onclick="showTab('synthetic',this)" title="Available after generation">Synthetic Data</button>
  <button class="tab"         onclick="showTab('security',this)">Security</button>
  <button class="tab" id="live-sec-tab" onclick="showTab('livesecurity',this)">Live Monitor</button>
  <button class="tab"         onclick="showTab('aiinsights',this)">AI Agent</button>
</div>

${parser_1.PARSER_TAB_HTML}
${overview_1.OVERVIEW_TAB_HTML}
${synthetic_1.SYNTHETIC_TAB_HTML}
${security_1.SECURITY_TAB_HTML}
${livesecurity_1.LIVE_SECURITY_TAB_HTML}
${agent_1.AGENT_TAB_HTML}

<script>
console.log("[Aurora] webview script loaded");
const vscode = acquireVsCodeApi();
let D = {
  profile: null,
  generator: null,
  leakage: null,
  scanReport: null,
  intelligence: null,
  result: null,
  baseline: null,
  ast: null,
  attackReport: null,
  knowledgeGraph: null,
  lineage: null,
  cp: null,
};
D = Object.assign(D, ${dataJson} || {});
if(!D.generator && D.result) D.generator = D.result;
if(!D.profile && D.baseline) D.profile = D.baseline;

let activeTab = 'parser';

function updateDashboardState(d){
  if(!d) return;
  if(d.generator){
    D.generator = d.generator;
    D.result    = d.generator;
  } else if(d.result){
    D.result = d.result;
    // Also update D.generator when it exists but has no real data yet (row_count=0).
    // The initial panel load seeds D.generator={row_count:0}, so the plain
    // !D.generator guard never fires and the real result never propagates.
    if(!D.generator || !D.generator.row_count) D.generator = d.result;
  }
  if(d.profile){
    D.profile  = d.profile;
    D.baseline = d.profile;
  } else if(d.baseline){
    D.baseline = d.baseline;
    if(!D.profile) D.profile = d.baseline;
  }
  if(d.leakage)                    D.leakage        = d.leakage;
  if(d.scanReport)                 D.scanReport     = d.scanReport;
  if(d.intelligence !== undefined) D.intelligence   = d.intelligence;
  if(d.ast          !== undefined) D.ast            = d.ast;
  if(d.attackReport !== undefined) D.attackReport   = d.attackReport;
  if(d.knowledgeGraph !== undefined) D.knowledgeGraph = d.knowledgeGraph;
  if(d.lineage      !== undefined) D.lineage        = d.lineage;
  if(d.cp           !== undefined) D.cp             = d.cp;
  if(!D.generator && D.result)   D.generator = D.result;
  if(!D.profile   && D.baseline) D.profile   = D.baseline;
}

const chartRegistry = {};
function getOrCreateChart(id, config) {
  if (chartRegistry[id]) { try{chartRegistry[id].destroy();}catch(e){} }
  const canvas = document.getElementById(id);
  if(!canvas) return null;
  chartRegistry[id] = new Chart(canvas, config);
  return chartRegistry[id];
}
${charts_1.RISK_RADAR_SCRIPT}

function pct(v){ if(v==null)return '—'; return (v*100).toFixed(1)+'%'; }
function pctInt(v){ if(v==null)return 0; return Math.min(100,Math.max(0,Math.round(v*100))); }
function esc(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const C={
  p0:'#1e0057',p1:'#4c1d95',p2:'#6d28d9',p3:'#7c3aed',
  p4:'#8b5cf6',p5:'#a78bfa',p6:'#c084fc',p7:'#ddd6fe',
  fg2:'#9b8ec4',fg3:'#524870',card2:'#1e1e2e',card3:'#252538',
  green:'#34d399',red:'#f87171',orange:'#fb923c',yellow:'#fbbf24',
};

function rbadge(risk){
  const r=(risk||'unknown').toLowerCase();
  const cl=r==='critical'?'rc-crit':r==='warning'?'rc-warn':r==='low'?'rc-low':'rc-unk';
  return '<span class="rbadge '+cl+'">'+esc(r.toUpperCase())+'</span>';
}

function updateSyntheticTabState(){
  var samples = (typeof _getSamples === 'function') ? _getSamples() : [];
  var r = (D.generator && D.generator.row_count) ? D.generator
        : (D.result    && D.result.row_count)    ? D.result
        : (D.generator || D.result || {});
  var isGen = !!(samples.length > 0 || (r.row_count && r.row_count > 0));
  var tabBtn = document.getElementById('synthetic-tab');
  if(tabBtn){
    if(isGen){
      tabBtn.removeAttribute('disabled');
      tabBtn.style.opacity = '';
      tabBtn.style.cursor  = '';
      tabBtn.title = '';
    } else {
      tabBtn.setAttribute('disabled','true');
      tabBtn.style.opacity = '0.38';
      tabBtn.style.cursor  = 'not-allowed';
      tabBtn.title = 'Run generation first';
    }
  }
  var expBtn = document.getElementById('btn-export-synthetic');
  if(expBtn){
    if(isGen){
      var fmt = ((D && D.sourceKind) || 'csv').toUpperCase();
      var label = 'Export ' + (fmt === 'EXCEL' || fmt === 'PARQUET' ? 'CSV' : fmt);
      expBtn.textContent = label;
      expBtn.style.display = 'inline-flex';
    } else {
      expBtn.style.display = 'none';
    }
  }
}

function showTab(name, btn){
  // Guard: block synthetic tab before generation
  if(name === 'synthetic'){
    var r = (D.generator && D.generator.row_count) ? D.generator
          : (D.result    && D.result.row_count)    ? D.result
          : (D.generator || D.result || {});
    var isGen = !!(r.row_count && r.row_count > 0);
    if(!isGen){ return; }
  }
  activeTab = name;
  document.querySelectorAll(".tabpane").forEach(function(p){
    p.style.display = "none";
  });
  const target = document.getElementById("pane-"+name);
  if(target){ target.style.display = "block"; }
  document.querySelectorAll(".tab").forEach(function(t){
    t.classList.remove("active");
  });
  if(btn) btn.classList.add("active");

  switch(name){
    case 'overview':
      try{renderSanityBanner();}catch(e){}
      try{renderStrip();}catch(e){}
      try{renderDatasetSummary();}catch(e){}
      try{renderRiskRadar();}catch(e){}
      try{renderAnalysisCard();}catch(e){}
      try{renderC2();}catch(e){}
      try{renderC5();}catch(e){}
      try{renderC12();}catch(e){}
      try{renderRis();}catch(e){}
      try{renderIntelligenceRisk();}catch(e){}
      try{renderColumnRanking();}catch(e){}
      try{renderRecommendations();}catch(e){}
      try{renderTimeline();}catch(e){}
      try{refreshMLFidelity();}catch(e){}
      break;
    case 'synthetic':
      try{syntheticRendered=false;renderSynthetic(true);}catch(e){}
      break;
    case 'security':
      try{secRendered=false;renderSecurity();}catch(e){}
      break;
    case 'livesecurity':
      try{renderLiveSecurity();}catch(e){}
      break;
    case 'aiinsights':
      try{initAgentChat();}catch(e){}
      break;
    case 'parser':
      try{
        // Auto-parse pipeline dataset on first open if data is available
        if(!_parserData && (D.profile||D.baseline)){
          parserFromDataset();
        }
      }catch(e){}
      break;
  }
}

${overview_1.OVERVIEW_SCRIPT}

${synthetic_1.SYNTHETIC_SCRIPT}

function reqGen(){
  const nEl = document.getElementById('gen-n');
  const btn = document.getElementById('gen-btn');
  const n = parseInt((nEl && nEl.value)||'500', 10) || 500;
  if(btn){ btn.disabled=true; btn.textContent='Running…'; }
  document.getElementById('gen-status').textContent='Sending request…';
  vscode.postMessage({command:'runGenerator', n});
}
function doExportSynthetic(){
  var rows=_getSamples();
  if(!rows.length){ return; }
  // Detect source format from D.sourceKind (injected by extension.ts)
  var fmt=(D.sourceKind||'csv').toLowerCase();
  // Map xlsx→csv (can't write xlsx in webview), parquet→csv; json / jsonl stay json / jsonl
  if(fmt==='xlsx'||fmt==='excel') fmt='csv';
  if(fmt==='parquet') fmt='csv';
  var content, filename;
  if(fmt==='json'){
    content=JSON.stringify(rows,null,2);
    filename='synthetic_data.json';
  } else if(fmt==='jsonl'){
    content=rows.map(function(r){ return JSON.stringify(r); }).join(String.fromCharCode(10));
    filename='synthetic_data.jsonl';
  } else if(fmt==='tsv'){
    var cols=Object.keys(rows[0]||{});
    content=[cols.join('\t')].concat(rows.map(function(r){return cols.map(function(c){return r[c]!=null?String(r[c]):'';}).join('\t');})).join(String.fromCharCode(10));
    filename='synthetic_data.tsv';
  } else {
    // default CSV
    fmt='csv';
    var cols=Object.keys(rows[0]||{});
    content=[cols.join(',')].concat(rows.map(function(r){return cols.map(function(c){var v=r[c]!=null?r[c]:'';return String(v).includes(',')? '"'+String(v).replace(/"/g,'""')+'"':String(v);}).join(',');})).join(String.fromCharCode(10));
    filename='synthetic_data.csv';
  }
  vscode.postMessage({command:'exportCSV',csv:content,filename:filename,format:fmt});
}
function doExportReport(){
  var r=D.generator||D.result||{};
  var b=D.profile||D.baseline||{};
  var actualRows=_getSamples().length;
  vscode.postMessage({command:'exportReport',
    report:{generated_at:new Date().toISOString(),leakage:D.leakage,
      generation:{engine:r.generator_used,row_count:actualRows},
      schema:{numeric:Object.keys((b.columns&&b.columns.numeric)||{}),categorical:Object.keys((b.columns&&b.columns.categorical)||{})}},
    filename:'leakage_report.json'});
}

window.addEventListener('message',function(ev){
  var msg=ev.data;
  if(!msg||!msg.type) return;

  if(msg.type==='checkpointUpdate'&&msg.data){
    D.cp=msg.data;
    syntheticRendered=false; secRendered=false;
    renderStrip(); renderAnalysisCard(); renderTimeline();
  }

  if(msg.type==='generatorStatus'){
    var statusEl=document.getElementById('gen-status');
    if(statusEl) statusEl.textContent=msg.text||'';
    // Also forward status to parser tab
    try{ if(typeof parserUpdateGenStatus==='function') parserUpdateGenStatus(msg.text||''); }catch(e){}
    if(msg.text&&(msg.text.startsWith('Done')||msg.text.startsWith('Complete')||msg.text.startsWith('Warning')||msg.text.startsWith('Error')||msg.text.includes('complete')||msg.text.includes('failed'))){
      var btn=document.getElementById('gen-btn');
      if(btn){ btn.disabled=false; btn.textContent='Run Generator'; }
    }
  }

  if(msg.type==='resetGenBtn'){
    var btn2=document.getElementById('gen-btn');
    if(btn2){ btn2.disabled=false; btn2.textContent='Run Generator'; }
    var pBtn=document.getElementById('parser-gen-btn');
    if(pBtn){ pBtn.disabled=false; pBtn.textContent='\u25B6 Generate'; }
  }

  if(msg.type==='pipelineComplete'){
    updateDashboardState(msg.data || msg);
    syntheticRendered=false; secRendered=false;
    setDataMode('synthetic');
    renderAll();
    const ovBtn=document.querySelector('.tab[onclick*="overview"]');
    showTab('overview', ovBtn||null);
  }

  if(msg.type==='pipelineResult'){
    updateDashboardState(msg.data || msg);
    syntheticRendered=false; secRendered=false;
    setDataMode('synthetic');
    renderAll();
    const ovBtn2=document.querySelector('.tab[onclick*="overview"]');
    showTab('overview', ovBtn2||null);
  }
  if(msg.type==='aiResponse'){
    if(typeof agentHandleResponse==='function'){
      agentHandleResponse(msg.content, msg.model, msg.error);
    }
  }
  if(msg.type==='liveSecurityAlert'&&msg.alert){
    appendLiveAlert(msg.alert);
    flashTicker(msg.alert);
  }
  if(msg.type==='liveSecuritySeed'&&msg.alerts){
    msg.alerts.forEach(function(a){ appendLiveAlert(a, false); });
    updateLiveStats();
  }
  if(msg.type==='apiKeyStatus'){
    var dot=document.getElementById('agent-ctx-dot');
    var tag=document.getElementById('agent-model-tag');
    var status=document.getElementById('agent-key-status');
    var inp=document.getElementById('agent-api-key');
    if(dot) dot.className='agent-ctx-dot '+(msg.configured?'ok':'warn');
    if(tag) tag.textContent=msg.configured?(msg.model||'OpenRouter'):'';
    if(status){
      if(msg.configured){
        status.style.color='var(--aurora-green)';
        status.textContent='Key active';
      } else {
        status.style.color='var(--aurora-orange)';
        status.textContent='No key — paste one above';
      }
    }
    if(inp && msg.configured && !inp.value){
      inp.placeholder='Key active — paste a new key to update';
    }
    if(inp && !msg.configured){
      inp.placeholder='Paste API key then press Enter or click Save';
      inp.focus();
    }
  }
  if(msg.type==='agentResponse'){
    agentHandleResponse(msg.content, msg.model, msg.error, msg.artifact);
  }
  // ── Live tool progress pill (fires before each tool execution) ────────
  if(msg.type==='agentToolProgress'){
    if(typeof agentHandleToolProgress==='function'){
      agentHandleToolProgress(msg.toolName, msg.args||{});
    }
  }
  // ── Report ready (emitted by generate_report tool) ────────────────────
  if(msg.type==='agentReportReady'){
    if(typeof agentHandleReportReady==='function'){
      agentHandleReportReady(msg.content, msg.file_path);
    }
  }
  // ── Dataset updated (emitted by merge_and_update tool) ────────────────
  if(msg.type==='datasetUpdated'){
    var merged = {samples: msg.new_samples, row_count: msg.row_count};
    D.result    = merged;
    D.generator = merged;
    syntheticRendered = false;
    secRendered = false;
    if(typeof renderStrip==='function') try{renderStrip();}catch(e){}
    if(activeTab==='synthetic' && typeof renderSynthetic==='function'){
      try{renderSynthetic(true);}catch(e){}
    }
  }
  // ── Generated rows ONLY preview (not merged into dataset) ─────────────
  if(msg.type==='generatedRowsOnly'){
    var pill5=document.querySelector('.agent-tool-pill'); if(pill5) pill5.remove();
    if(typeof agentHideThinking==='function') agentHideThinking();
    var previewMsg = 'Preview — ' + msg.count + ' rows generated (not added to dataset):';
    if(typeof addAgentMessage==='function'){
      addAgentMessage(previewMsg, { type: 'csv', content: null, filePath: null, previewOnly: true, samples: msg.samples });
    }
  }
  // ── CSV exported (emitted by export_csv tool) ─────────────────────────
  if(msg.type==='csvExported'){
    var pill4=document.querySelector('.agent-tool-pill'); if(pill4) pill4.remove();
    if(typeof agentHideThinking==='function') agentHideThinking();
  }
  // ── agentControlResult removed — superseded by tool-based generation ──
  if(msg.type==='agentReportResult'){
    if(typeof agentHandleReportResult==='function') agentHandleReportResult(msg.content, msg.filePath, msg.error, msg.reportType||'governance');
  }
});

${agent_1.AGENT_SCRIPT}

${security_1.SECURITY_SCRIPT}

${livesecurity_1.LIVE_SECURITY_SCRIPT}

${parser_1.PARSER_SCRIPT}

function renderAll(){
  syntheticRendered=false;
  secRendered=false;
  try{updateSyntheticTabState();}catch(e){}
  try{updateDataModeToggle();}catch(e){}
  try{renderSanityBanner();}catch(e){}
  try{renderStrip();}catch(e){}
  try{renderDatasetSummary();}catch(e){}
  try{renderRiskRadar();}catch(e){}
  try{renderAnalysisCard();}catch(e){}
  try{renderC5();}catch(e){}
  try{renderC12();}catch(e){}
  try{renderRis();}catch(e){}
  try{renderIntelligenceRisk();}catch(e){}
  try{renderColumnRanking();}catch(e){}
  try{renderRecommendations();}catch(e){}
  try{renderTimeline();}catch(e){}
  try{refreshMLFidelity();}catch(e){}
  switch(activeTab){
    case 'synthetic':
      try{syntheticRendered=false;renderSynthetic(true);}catch(err){}
      break;
    case 'security':
      try{secRendered=false;renderSecurity();}catch(err){}
      break;
    case 'livesecurity':
      try{renderLiveSecurity();}catch(err){}
      break;
    case 'aiinsights':
      try{initAgentChat();}catch(err){}
      break;
    case 'parser':
      try{
        if(!_parserData && (D.profile||D.baseline)){
          parserFromDataset();
        }
      }catch(err){}
      break;
  }
  setTimeout(()=>{ try{renderC2();}catch(e){} },150);
}

// ── Data Mode Toggle (Original ↔ Synthetic) ──────────────────────────
var _dataMode = 'synthetic'; // 'original' | 'synthetic' — default synthetic when generated, else original

function updateDataModeToggle(){
  var r = (D.generator && D.generator.row_count) ? D.generator
        : (D.result    && D.result.row_count)    ? D.result
        : (D.generator || D.result || {});
  var isGen = !!(r.row_count && r.row_count > 0);
  var tog = document.getElementById('data-mode-toggle');
  if(!tog) return;
  tog.style.display = isGen ? 'flex' : 'none';
}

function setDataMode(mode){
  if(_dataMode === mode) return;
  _dataMode = mode;
  // Update button active states
  var origBtn  = document.getElementById('dmt-orig');
  var synthBtn = document.getElementById('dmt-synth');
  if(origBtn)  origBtn.classList.toggle('active',  mode === 'original');
  if(synthBtn) synthBtn.classList.toggle('active', mode === 'synthetic');
  // Re-render all tabs with new mode
  syntheticRendered = false;
  secRendered = false;
  try{ renderStrip(); }catch(e){}
  try{ renderDatasetSummary(); }catch(e){}
  try{ renderAnalysisCard(); }catch(e){}
  try{ renderC5(); }catch(e){}
  try{ renderC12(); }catch(e){}
  try{ renderRis(); }catch(e){}
  try{ renderIntelligenceRisk(); }catch(e){}
  try{ renderColumnRanking(); }catch(e){}
  try{ renderRecommendations(); }catch(e){}
  try{ renderTimeline(); }catch(e){}
  try{ renderSanityBanner(); }catch(e){}
  try{ refreshMLFidelity(); }catch(e){}
  switch(activeTab){
    case 'synthetic':
      try{ syntheticRendered=false; renderSynthetic(true); }catch(e){}
      break;
    case 'security':
      try{ secRendered=false; renderSecurity(); }catch(e){}
      break;
    case 'livesecurity':
      try{ renderLiveSecurity(); }catch(e){}
      break;
  }
  setTimeout(()=>{ try{renderC2();}catch(e){} },150);
}

// Expose mode getter for use in render functions
function isOriginalMode(){ return _dataMode === 'original'; }
function getActiveProfile(){
  if(_dataMode === 'synthetic'){
    // In synthetic mode, treat generator output as the profile for display
    var r = D.generator || D.result || {};
    if(r.row_count){ return r; }
  }
  return D.profile || D.baseline || {};
}
function getActiveResult(){
  if(_dataMode === 'original'){
    // In original mode, suppress generator data from being used as primary display
    return {};
  }
  return D.generator || D.result || {};
}

function _automate_init(){
  setTimeout(()=>{
    document.querySelectorAll(".tabpane").forEach(function(p){
      p.style.display = "none";
    });
    const parserPane = document.getElementById("pane-parser");
    if(parserPane) parserPane.style.display = "block";

    // ── Set default toggle mode: synthetic if generated, original otherwise ──
    const _hasGen = !!(D.generator && D.generator.row_count && D.generator.row_count > 0)
                 || !!(D.result    && D.result.row_count    && D.result.row_count    > 0);
    _dataMode = _hasGen ? 'synthetic' : 'original';
    const _dOrigBtn  = document.getElementById('dmt-orig');
    const _dSynthBtn = document.getElementById('dmt-synth');
    if(_dOrigBtn)  _dOrigBtn.classList.toggle('active',  !_hasGen);
    if(_dSynthBtn) _dSynthBtn.classList.toggle('active',  _hasGen);

    renderAll();
    try{updateSyntheticTabState();}catch(e){}
  },100);
}

_automate_init();
// Reference comments for validation audit: leakage.privacy_score leakage.risk_level leakage.membership_inference_auc leakage.duplicates_rate leakage.statistical_drift leakage.column_drift leakage.threat_details leakage.privacy_components leakage.avg_drift_score leakage.dataset_risk_score
</script>
</body>
</html>`;
}
//# sourceMappingURL=monitorPanel.js.map