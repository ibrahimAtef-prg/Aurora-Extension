"use strict";
/**
 * src/webview/monitorPanel.ts — AutoMate Aurora Privacy Dashboard
 *
 * Fixes applied:
 *  - chartRegistry prevents Canvas-already-in-use crash (Chart.js CDN + inline fallback)
 *  - All metrics use REAL backend data (leakage, baseline, result)
 *  - Aurora Purple theme, card-grid layout, hover glows, micro-animations
 *  - Tab navigation: Overview | Schema | Synthetic | Threats | Diagnostics
 *  - Sticky header, status strip with real values
 *  - postMessage-based incremental updates (no full re-render)
 *  - Pipeline Timeline card showing real stage data
 *  - No fake/hash-based calculations
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMonitorHtml = buildMonitorHtml;
const charts_1 = require("./ui/charts");
const overview_1 = require("./ui/overview");
const synthetic_1 = require("./ui/synthetic");
const security_1 = require("./ui/security");
const livesecurity_1 = require("./ui/livesecurity");
const agent_1 = require("./ui/agent");
function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function buildMonitorHtml(data) {
    const dataJson = JSON.stringify(data).replace(/<\/script/gi, '<\\/script');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Privacy & Synthetic Data Governance</title>
<script src="${esc(data.chartUri)}"></script>
<script>\n${charts_1.CHART_INLINE_FALLBACK_SCRIPT}\n</script>\n<style>\n${charts_1.DASHBOARD_STYLES}\n</style>
</head>
<body>

<!-- Sticky header -->
<div class="hdr">
  <div class="logo">
    <div class="logo-icon"></div>
    <div>
      <div class="logo-title">Aurora</div>
      <div class="logo-sub" id="hdr-sub">Privacy & Synthetic Data Governance</div>
    </div>
  </div>
  <div class="hdr-right">
    <button class="hbtn hbtn-g" onclick="doExportCSV()">Export CSV</button>
    <button class="hbtn hbtn-g" onclick="vscode.postMessage({command:'automate.anonymizeDataset'})" title="Auto-anonymize PII columns">Anonymize</button>
    <button class="hbtn hbtn-p" onclick="doExportReport()">Save Report</button>
  </div>
</div>

<!-- Status strip -->
<div class="strip">
  <div class="spill"><div><div class="sl">Risk Level</div><div class="sv" id="m-risk">&#8212;</div></div></div>
  <div class="spill"><div><div class="sl">Privacy Score</div><div class="sv" id="m-ps">&#8212;</div></div></div>
  <div class="spill"><div><div class="sl">Drift</div><div class="sv" id="m-drift">&#8212;</div></div></div>

  <div class="spill"><div><div class="sl">Duplicates</div><div class="sv" id="m-dup">&#8212;</div></div></div>
  <div class="spill"><div><div class="sl">Rows</div><div class="sv" id="m-rows">&#8212;</div></div></div>
</div>

<!-- Sanity warning banner (populated by JS) -->
<div id="sanity-banner" style="display:none"></div>

<!-- Tab navigation -->
<div class="tabs">
  <button class="tab active"  onclick="showTab('overview',this)">Overview</button>
  <button class="tab"     onclick="showTab('synthetic',this)">Synthetic Data</button>
  <button class="tab"     onclick="showTab('security',this)">Security</button>
  <button class="tab" id="live-sec-tab" onclick="showTab('livesecurity',this)">Live Monitor</button>
  <button class="tab"     onclick="showTab('aiinsights',this)">AI Agent</button>
</div>

${overview_1.OVERVIEW_TAB_HTML}
${synthetic_1.SYNTHETIC_TAB_HTML}
${security_1.SECURITY_TAB_HTML}
${livesecurity_1.LIVE_SECURITY_TAB_HTML}
${agent_1.AGENT_TAB_HTML}



<!-- TAB: Parser -->
<div id="pane-parser" class="tabpane">

  <!-- Top action bar — same pattern as other tabs -->
  <div style="padding:12px 20px 0;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <div>
      <div style="font-size:13px;font-weight:700;color:var(--fg)">Dataset Parser</div>
      <div style="font-size:10px;color:var(--fg3);margin-top:1px">Analyse schema, column types, and PII surface before generating synthetic data</div>
    </div>
    <div style="margin-left:auto;display:flex;gap:6px;align-items:center">
      <label style="padding:5px 14px;background:var(--aurora-grad);color:#fff;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px var(--aurora-glow2)">
        Open File
        <input type="file" id="parser-file-input" accept=".csv,.json,.tsv" style="display:none" onchange="parserFileSelected(this)"/>
      </label>
      <button class="hbtn hbtn-g" onclick="parserFromDataset()">Use Pipeline Dataset</button>
      <button class="hbtn hbtn-g" id="parser-export-btn" onclick="parserExportSchema()" style="display:none">Export Schema</button>
    </div>
  </div>

  <!-- Status bar -->
  <div style="padding:4px 20px 0">
    <div id="parser-status" style="font-size:10px;color:var(--fg3);min-height:16px"></div>
  </div>

  <!-- Empty state — shown before parse -->
  <div id="parser-empty" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:60px 20px;text-align:center">
    <div id="parser-dropzone"
      style="width:320px;border:2px dashed var(--border2);border-radius:12px;padding:32px 24px;display:flex;flex-direction:column;align-items:center;gap:10px;transition:border-color .2s,background .2s;cursor:default"
      ondragover="parserDragOver(event)" ondragleave="parserDragLeave(event)" ondrop="parserDrop(event)">
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none" style="opacity:.35">
        <rect x="5" y="7" width="30" height="26" rx="4" stroke="var(--aurora-p4)" stroke-width="1.8"/>
        <path d="M12 17h16M12 22h11M12 27h7" stroke="var(--aurora-p5)" stroke-width="1.4" stroke-linecap="round"/>
        <path d="M26 3v10h10" stroke="var(--aurora-p4)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M26 3l10 10" stroke="var(--aurora-p4)" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
      <div style="font-size:12px;font-weight:600;color:var(--fg2)">Drop a CSV or JSON file here</div>
      <div style="font-size:10px;color:var(--fg3)">or use the buttons above to open a file or parse the active pipeline dataset</div>
    </div>
  </div>

  <!-- Results grid — same .grid system as Overview -->
  <div id="parser-results" style="display:none">

    <!-- Row 1: summary cards -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:14px 20px 0">

      <div class="card" style="flex-direction:row;align-items:center;gap:14px;padding:12px 16px">
        <div style="display:flex;flex-direction:column;gap:2px">
          <div style="font-size:22px;font-weight:800;letter-spacing:-.04em;background:var(--aurora-grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent" id="p-stat-rows">—</div>
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--fg3)">Rows</div>
        </div>
      </div>

      <div class="card" style="flex-direction:row;align-items:center;gap:14px;padding:12px 16px">
        <div style="display:flex;flex-direction:column;gap:2px">
          <div style="font-size:22px;font-weight:800;letter-spacing:-.04em;color:var(--fg)" id="p-stat-cols">—</div>
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--fg3)">Columns</div>
        </div>
      </div>

      <div class="card" style="flex-direction:row;align-items:center;gap:14px;padding:12px 16px">
        <div style="display:flex;flex-direction:column;gap:2px">
          <div style="font-size:22px;font-weight:800;letter-spacing:-.04em;color:var(--aurora-p5)" id="p-stat-pii">—</div>
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--fg3)">PII Columns</div>
        </div>
      </div>

      <div class="card" style="flex-direction:row;align-items:center;gap:14px;padding:12px 16px">
        <div style="display:flex;flex-direction:column;gap:2px">
          <div style="font-size:22px;font-weight:800;letter-spacing:-.04em;color:var(--aurora-green)" id="p-stat-clean">—</div>
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--fg3)">Clean Columns</div>
        </div>
      </div>

    </div>

    <!-- Row 2: Schema table (wide) + PII card -->
    <div style="display:grid;grid-template-columns:1fr 320px;gap:12px;padding:12px 20px 0">

      <!-- Schema table card -->
      <div class="card" style="padding:0;overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--border)">
          <div>
            <div class="ct">Column Schema</div>
            <div class="cs" id="p-schema-sub">Type inference · nullable · unique values</div>
          </div>
          <!-- Sub-tabs -->
          <div style="display:flex;gap:1px;background:var(--bg3);border-radius:7px;padding:2px">
            <button class="parser-stab active" id="pstab-schema" onclick="parserSubTab('schema',this)">Schema</button>
            <button class="parser-stab" id="pstab-stats"  onclick="parserSubTab('stats',this)">Stats</button>
            <button class="parser-stab" id="pstab-nulls"  onclick="parserSubTab('nulls',this)">Nulls</button>
          </div>
        </div>
        <!-- Schema view -->
        <div id="psub-schema" style="overflow-x:auto;max-height:420px;overflow-y:auto">
          <table style="width:100%;border-collapse:collapse;font-size:11px" id="parser-schema-table">
            <thead>
              <tr>
                <th style="padding:7px 12px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);background:var(--bg3);border-bottom:1px solid var(--border);position:sticky;top:0">#</th>
                <th style="padding:7px 12px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);background:var(--bg3);border-bottom:1px solid var(--border);position:sticky;top:0">Column</th>
                <th style="padding:7px 12px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);background:var(--bg3);border-bottom:1px solid var(--border);position:sticky;top:0">Type</th>
                <th style="padding:7px 12px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);background:var(--bg3);border-bottom:1px solid var(--border);position:sticky;top:0">SDV Type</th>
                <th style="padding:7px 12px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);background:var(--bg3);border-bottom:1px solid var(--border);position:sticky;top:0">PII</th>
                <th style="padding:7px 12px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);background:var(--bg3);border-bottom:1px solid var(--border);position:sticky;top:0">Nulls</th>
                <th style="padding:7px 12px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);background:var(--bg3);border-bottom:1px solid var(--border);position:sticky;top:0">Unique</th>
                <th style="padding:7px 12px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);background:var(--bg3);border-bottom:1px solid var(--border);position:sticky;top:0">Sample</th>
              </tr>
            </thead>
            <tbody id="parser-schema-body"></tbody>
          </table>
        </div>
        <!-- Stats view -->
        <div id="psub-stats" style="display:none;overflow-y:auto;max-height:420px;padding:12px 14px">
          <div id="parser-stats-body" style="display:flex;flex-direction:column;gap:10px"></div>
        </div>
        <!-- Nulls view -->
        <div id="psub-nulls" style="display:none;overflow-y:auto;max-height:420px;padding:12px 14px">
          <div id="parser-nulls-body" style="display:flex;flex-direction:column;gap:4px"></div>
        </div>
      </div>

      <!-- PII card -->
      <div class="card" style="padding:0;overflow:hidden">
        <div style="padding:12px 14px;border-bottom:1px solid var(--border)">
          <div class="ct">PII Risk Surface</div>
          <div class="cs">Privacy exposure by column</div>
        </div>
        <div id="parser-pii-body" style="overflow-y:auto;max-height:420px;padding:10px 12px;display:flex;flex-direction:column;gap:6px"></div>
      </div>

    </div>

    <!-- Row 3: Null heatmap + type breakdown -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px 20px 20px">

      <!-- Type breakdown card -->
      <div class="card">
        <div class="ch">
          <div><div class="ct">Type Distribution</div><div class="cs">Inferred column types</div></div>
        </div>
        <div id="parser-type-chart" style="display:flex;flex-direction:column;gap:6px;flex:1;justify-content:center"></div>
      </div>

      <!-- Null overview card -->
      <div class="card">
        <div class="ch">
          <div><div class="ct">Null Rate by Column</div><div class="cs">Missing value prevalence</div></div>
        </div>
        <div id="parser-null-overview" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:3px"></div>
      </div>

    </div>
  </div>
</div><script>
const vscode = acquireVsCodeApi();
// D holds all pipeline data — plain JS, no TypeScript annotations
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

// ── Stable global tab state ──────────────────────────────────────────
let activeTab = 'overview';

// ── updateDashboardState — single source of truth for D mutations ──
function updateDashboardState(d){
  if(!d) return;
  if(d.generator){
    D.generator = d.generator;
    D.result    = d.generator;
  } else if(d.result){
    D.result = d.result;
    if(!D.generator) D.generator = d.result;
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
  // Ensure mirrors stay consistent
  if(!D.generator && D.result)   D.generator = D.result;
  if(!D.profile   && D.baseline) D.profile   = D.baseline;
}

// ── Chart registry ──────────────────────────────────────────────────
const chartRegistry = {};
function getOrCreateChart(id, config) {
  if (chartRegistry[id]) { try{chartRegistry[id].destroy();}catch(e){} }
  const canvas = document.getElementById(id);
  if(!canvas) return null;
  chartRegistry[id] = new Chart(canvas, config);
  return chartRegistry[id];
}
${charts_1.RISK_RADAR_SCRIPT}

// ── Helpers ─────────────────────────────────────────────────────────
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

function showTab(name, btn){
  activeTab = name;

  document.querySelectorAll(".tabpane").forEach(function(p){
    p.style.display = "none";
  });

  const target = document.getElementById("pane-"+name);
  if(target){
    target.style.display = "block";
  }

  document.querySelectorAll(".tab").forEach(function(t){
    t.classList.remove("active");
  });

  if(btn) btn.classList.add("active");

  renderAll();
}

${overview_1.OVERVIEW_SCRIPT}

// ── Schema tab ──────────────────────────────────────────────────────

${synthetic_1.SYNTHETIC_SCRIPT}

// ── Threats tab ──────────────────────────────────────────────────────

// ── Export ───────────────────────────────────────────────────────────
function reqGen(){
  const nEl = document.getElementById('gen-n');
  const btn = document.getElementById('gen-btn');
  const n = parseInt((nEl && nEl.value)||'500', 10) || 500;
  if(btn){ btn.disabled=true; btn.textContent='Running…'; }
  document.getElementById('gen-status').textContent='Sending request…';
  vscode.postMessage({command:'runGenerator', n});
}
function doExportCSV(){
  var rows=_getSamples();
  if(!rows.length){ return; }
  var cols=Object.keys(rows[0]||{});
  var csv=[cols.join(',')].concat(rows.map(function(r){return cols.map(function(c){var v=r[c]!=null?r[c]:'';return String(v).includes(',')? '"'+String(v).replace(/"/g,'""')+'"':String(v);}).join(',');})).join(String.fromCharCode(10));
  vscode.postMessage({command:'exportCSV',csv:csv,filename:'synthetic_data.csv'});
}
function doExportReport(){
  var r=D.generator||D.result||{};
  var b=D.profile||D.baseline||{};
  vscode.postMessage({command:'exportReport',
    report:{generated_at:new Date().toISOString(),leakage:D.leakage,
      generation:{engine:r.generator_used,row_count:r.row_count},
      schema:{numeric:Object.keys((b.columns&&b.columns.numeric)||{}),categorical:Object.keys((b.columns&&b.columns.categorical)||{})}},
    filename:'leakage_report.json'});
}

// ── Incremental postMessage update ───────────────────────────────────
window.addEventListener('message',function(ev){
  var msg=ev.data;
  if(!msg||!msg.type) return;
  console.log('[AutoMate] message received:', msg.type);

  if(msg.type==='checkpointUpdate'&&msg.data){
    D.cp=msg.data;
    syntheticRendered=false; secRendered=false;
    renderStrip(); renderC1(); renderTimeline();
  }

  if(msg.type==='generatorStatus'){
    var statusEl=document.getElementById('gen-status');
    if(statusEl) statusEl.textContent=msg.text||'';
    if(msg.text&&(msg.text.startsWith('Done')||msg.text.includes('complete')||msg.text.startsWith('Error')||msg.text.startsWith('Warning')||msg.text.includes('failed'))){
      var btn=document.getElementById('gen-btn');
      if(btn){ btn.disabled=false; btn.textContent='Run Generator'; }
    }
  }

  if(msg.type==='resetGenBtn'){
    var btn2=document.getElementById('gen-btn');
    if(btn2){ btn2.disabled=false; btn2.textContent='Run Generator'; }
  }

  // ── pipelineComplete (legacy): full data bundle ──────────────────────
  if(msg.type==='pipelineComplete'){
    updateDashboardState(msg.data || msg);
    console.log('[AutoMate] pipelineComplete — rows:', (D.generator||D.result||{}).row_count,
      'leakage:', !!D.leakage, 'scan:', !!D.scanReport);
    syntheticRendered=false; secRendered=false;
    renderAll();
  }

  // ── pipelineResult: spec field names from extension ──────────────────
  if(msg.type==='pipelineResult'){
    updateDashboardState(msg.data || msg);
    console.log('[AutoMate] pipelineResult — rows:', (D.generator||D.result||{}).row_count,
      'leakage:', !!D.leakage, 'scan:', !!D.scanReport);
    syntheticRendered=false; secRendered=false;
    renderAll();
  }
  if(msg.type==='aiResponse'){
    if(msg.error){
      document.getElementById('ai-status').textContent='⚠ Error';
      document.getElementById('ai-response').textContent='Error: '+msg.error;
      document.getElementById('ai-response').style.borderColor='rgba(248,113,113,.4)';
    } else {
      document.getElementById('ai-status').textContent=' Response received';
      document.getElementById('ai-response').textContent=msg.content||'No content returned.';
      document.getElementById('ai-response').style.borderColor='rgba(52,211,153,.3)';
      document.getElementById('ai-model').textContent='Model: '+(msg.model||'unknown');
    }
  }
  // ── Phase 4: Live Security Alert ──────────────────────────────────────
  if(msg.type==='liveSecurityAlert'&&msg.alert){
    appendLiveAlert(msg.alert);
    flashTicker(msg.alert);
  }
  if(msg.type==='liveSecuritySeed'&&msg.alerts){
    msg.alerts.forEach(function(a){ appendLiveAlert(a, false); });
    updateLiveStats();
  }
  // ── API key status response ──────────────────────────────────────────
  if(msg.type==='apiKeyStatus'){
    var banner=document.getElementById('agent-key-banner');
    var dot=document.getElementById('agent-ctx-dot');
    var row=document.getElementById('agent-config-row');
    // Hide inline config row once key is confirmed; show it if key is missing
    if(row) row.style.display=msg.configured?'none':'';
    if(banner) banner.style.display='none'; // inline config row replaces the old banner
    if(dot) dot.className='agent-ctx-dot '+(msg.configured?'ok':'warn');
    var tag=document.getElementById('agent-model-tag');
    if(tag) tag.textContent=msg.configured?('AI '+(msg.model||'OpenRouter')):'';
  }
  // ── Phase 5: Agent Chat response ──────────────────────────────────────
  if(msg.type==='agentResponse'){
    agentHandleResponse(msg.content, msg.model, msg.error);
  }
});

${agent_1.AGENT_SCRIPT}

${security_1.SECURITY_SCRIPT}

${livesecurity_1.LIVE_SECURITY_SCRIPT}

// ── End Phase 4 Live Security ────────────────────────────────────────────────

// renderIntelligenceRisk, renderColumnRanking, renderRecommendations
// are defined in OVERVIEW_SCRIPT — do not redeclare here.

// ── PART 3: renderAll — uses activeTab global, not fragile DOM query ──

// ── Parser tab state ────────────────────────────────────────────────
var _parserData = null;
var _parserFile = null;
var _parserActiveResult = 'schema';

function parserDragOver(e){
  e.preventDefault();
  var dz=document.getElementById('parser-dropzone');
  if(dz){dz.style.borderColor='var(--aurora-p4)';dz.style.background='rgba(139,92,246,.07)';}
}
function parserDragLeave(e){
  var dz=document.getElementById('parser-dropzone');
  if(dz){dz.style.borderColor='';dz.style.background='';}
}
function parserDrop(e){
  e.preventDefault();
  parserDragLeave(e);
  var files=e.dataTransfer&&e.dataTransfer.files;
  if(files&&files.length) parserLoadFile(files[0]);
}
function parserFileSelected(input){
  if(input.files&&input.files.length) parserLoadFile(input.files[0]);
}

function parserLoadFile(file){
  _parserFile=file;
  var infoEl=document.getElementById('parser-file-info');
  var fnEl=document.getElementById('parser-fname');
  var metaEl=document.getElementById('parser-file-meta');
  var runBtn=document.getElementById('parser-run-btn');
  if(fnEl) fnEl.textContent=file.name;
  if(metaEl) metaEl.innerHTML=
    '<div style="font-size:9px;color:var(--fg3)">Size</div><div style="font-size:10px;font-weight:600;color:var(--fg)">'+_parserFormatBytes(file.size)+'</div>'+
    '<div style="font-size:9px;color:var(--fg3)">Type</div><div style="font-size:10px;font-weight:600;color:var(--aurora-p5)">'+file.name.split('.').pop().toUpperCase()+'</div>';
  if(infoEl) infoEl.style.display='flex';
  if(runBtn) runBtn.disabled=false;
  _parserSetStatus('File loaded — click Run Parser to analyse');
}

function parserFromDataset(){
  var b=D.profile||D.baseline||{};
  var ast=D.ast||{};
  if(!b.columns && !ast.dataset){
    _parserSetStatus('No dataset loaded. Run the pipeline first.');
    return;
  }
  _parserSetStatus('Parsing from pipeline data...');
  setTimeout(function(){
    _parserBuildFromPipeline();
  },80);
}

function _parserBuildFromPipeline(){
  var b=D.profile||D.baseline||{};
  var ast=D.ast||{};
  var sc=D.scanReport||{};
  var l=D.leakage||{};
  var numCols=Object.keys((b.columns&&b.columns.numeric)||{});
  var catCols=Object.keys((b.columns&&b.columns.categorical)||{});
  var piiCols=new Set((l.pii_columns||[]).concat(sc.high_risk_columns||[]).concat(
    (sc.pii_findings||[]).map(function(f){return f.column;})
  ).filter(Boolean));
  var ranking=(l.sensitive_column_ranking||[]);
  var rankMap={};
  ranking.forEach(function(r){rankMap[r.column]=r;});

  var columns=[];
  numCols.forEach(function(col){
    var stats=(b.columns.numeric||{})[col]||{};
    var piiScore=(rankMap[col]&&rankMap[col].score)||0;
    columns.push({
      name:col, type:'numeric', sdvType:'numerical',
      pii: piiCols.has(col)?'high':piiScore>0.4?'medium':'none',
      piiScore: piiScore,
      mean:stats.mean, std:stats.std, min:stats.min, max:stats.max,
      nullRate:stats.null_rate||0, unique:null,
      sample: stats.mean!=null?stats.mean.toFixed(2):'—'
    });
  });
  catCols.forEach(function(col){
    var stats=(b.columns.categorical||{})[col]||{};
    var piiScore=(rankMap[col]&&rankMap[col].score)||0;
    columns.push({
      name:col, type:'categorical', sdvType:'categorical',
      pii: piiCols.has(col)?'high':piiScore>0.4?'medium':'none',
      piiScore: piiScore,
      mean:null, std:null, min:null, max:null,
      nullRate:stats.null_rate||0,
      unique:stats.num_unique||null,
      sample:stats.most_frequent||'—'
    });
  });

  _parserData={
    filename:'Pipeline Dataset',
    rows: (b.meta&&(b.meta.row_count||b.meta.row_count_estimate))||null,
    cols: columns.length,
    columns: columns,
    source:'pipeline'
  };
  _parserRenderAll();
  _parserSetStatus('Parsed '+columns.length+' columns from pipeline data');
}

function runParser(){
  if(_parserFile){
    _parserSetStatus('Reading file...');
    var ext=(_parserFile.name.split('.').pop()||'').toLowerCase();
    if(ext==='csv'||ext==='tsv'){
      var reader=new FileReader();
      reader.onload=function(e){
        try{
          _parserParseCSV(e.target.result, _parserFile.name, ext==='tsv'?'\t':',');
        }catch(err){
          _parserSetStatus('Parse error: '+err.message);
        }
      };
      reader.readAsText(_parserFile);
    } else if(ext==='json'){
      var reader2=new FileReader();
      reader2.onload=function(e){
        try{
          _parserParseJSON(e.target.result, _parserFile.name);
        }catch(err){
          _parserSetStatus('Parse error: '+err.message);
        }
      };
      reader2.readAsText(_parserFile);
    } else {
      _parserSetStatus('File parsed structurally ('+ext.toUpperCase()+' — detailed stats require backend)');
      _parserData={filename:_parserFile.name, rows:null, cols:0, columns:[], source:'file'};
      parserFromDataset();
    }
  }
}

function _parserParseCSV(text, fname, sep){
  var lines=text.split(/\r?\n/).filter(function(l){return l.trim();});
  if(!lines.length){_parserSetStatus('Empty file');return;}
  var headers=lines[0].split(sep).map(function(h){return h.replace(/^"|"$/g,'').trim();});
  var rows=[];
  var maxSample=Math.min(lines.length-1, 500);
  for(var i=1;i<=maxSample;i++){
    var parts=lines[i].split(sep);
    var row={};
    headers.forEach(function(h,hi){row[h]=(parts[hi]||'').replace(/^"|"$/g,'').trim();});
    rows.push(row);
  }
  var totalRows=lines.length-1;
  var columns=headers.map(function(col){
    var vals=rows.map(function(r){return r[col];}).filter(function(v){return v!==''&&v!=null;});
    var nullCount=rows.length-vals.length;
    var nullRate=rows.length?nullCount/rows.length:0;
    var numVals=vals.filter(function(v){return !isNaN(+v)&&v!=='';}).map(Number);
    var isNum=numVals.length/Math.max(vals.length,1)>0.85;
    var unique=new Set(vals).size;
    var sdvType=isNum?'numerical':'categorical';
    var inferredType=isNum?'numeric':unique<=2&&vals.length>0?'boolean':'categorical';
    var pii=_parserGuessPII(col, vals);
    var stats={};
    if(isNum&&numVals.length){
      stats.mean=numVals.reduce(function(a,b){return a+b;},0)/numVals.length;
      stats.min=Math.min.apply(null,numVals);
      stats.max=Math.max.apply(null,numVals);
      var variance=numVals.reduce(function(a,v){return a+Math.pow(v-stats.mean,2);},0)/numVals.length;
      stats.std=Math.sqrt(variance);
    }
    return {
      name:col, type:inferredType, sdvType:sdvType, pii:pii.level, piiScore:pii.score, piiReason:pii.reason,
      mean:stats.mean, std:stats.std, min:stats.min, max:stats.max,
      nullRate:nullRate, unique:unique,
      sample:vals.length?vals[0]:'—'
    };
  });
  _parserData={filename:fname, rows:totalRows, cols:headers.length, columns:columns, source:'file'};
  _parserRenderAll();
  _parserSetStatus('Parsed '+headers.length+' columns, '+totalRows.toLocaleString()+' rows (sampled '+maxSample+')');
}

function _parserParseJSON(text, fname){
  var data=JSON.parse(text);
  var rows=Array.isArray(data)?data:(data.data||data.rows||[data]);
  if(!rows.length){_parserSetStatus('Empty JSON');return;}
  var headers=Object.keys(rows[0]||{});
  var sample=rows.slice(0,500);
  var columns=headers.map(function(col){
    var vals=sample.map(function(r){return r[col];}).filter(function(v){return v!=null&&v!=='';});
    var nullRate=sample.length?(sample.length-vals.length)/sample.length:0;
    var numVals=vals.filter(function(v){return typeof v==='number'||(typeof v==='string'&&!isNaN(+v)&&v!=='');}).map(Number);
    var isNum=numVals.length/Math.max(vals.length,1)>0.85;
    var unique=new Set(vals.map(String)).size;
    var pii=_parserGuessPII(col, vals.map(String));
    var stats={};
    if(isNum&&numVals.length){
      stats.mean=numVals.reduce(function(a,b){return a+b;},0)/numVals.length;
      stats.min=Math.min.apply(null,numVals);
      stats.max=Math.max.apply(null,numVals);
      var v2=numVals.reduce(function(a,v){return a+Math.pow(v-stats.mean,2);},0)/numVals.length;
      stats.std=Math.sqrt(v2);
    }
    return {
      name:col, type:isNum?'numeric':'categorical', sdvType:isNum?'numerical':'categorical',
      pii:pii.level, piiScore:pii.score, piiReason:pii.reason,
      mean:stats.mean, std:stats.std, min:stats.min, max:stats.max,
      nullRate:nullRate, unique:unique, sample:String(vals[0]||'—').substring(0,30)
    };
  });
  _parserData={filename:fname, rows:rows.length, cols:headers.length, columns:columns, source:'file'};
  _parserRenderAll();
  _parserSetStatus('Parsed '+headers.length+' columns, '+rows.length.toLocaleString()+' rows');
}

// PII heuristic guesser
var _PII_PATTERNS={
  high:[
    {re:/ssn|social.sec|social_sec/i, reason:'Social Security Number'},
    {re:/passport/i, reason:'Passport number'},
    {re:/credit.card|card.num|cvv|ccnum/i, reason:'Payment card data'},
    {re:/^email$|e.?mail/i, reason:'Email address'},
    {re:/password|passwd|secret|token|api.?key/i, reason:'Credential / secret'},
    {re:/ip.?addr|ip_address/i, reason:'IP address'},
    {re:/phone|mobile|tel$/i, reason:'Phone number'},
    {re:/dob|date.?of.?birth|birth.?date/i, reason:'Date of birth'},
  ],
  medium:[
    {re:/^name$|full.?name|first.?name|last.?name|surname|fname|lname/i, reason:'Full or partial name'},
    {re:/^address$|street|city|postcode|zip|state$/i, reason:'Address component'},
    {re:/^age$|gender|sex$/i, reason:'Quasi-identifier'},
    {re:/race|ethnicity|religion|nationality/i, reason:'Sensitive attribute'},
    {re:/salary|income|wage/i, reason:'Financial quasi-identifier'},
    {re:/employee.?id|emp.?id|user.?id|account.?id/i, reason:'Identifier'},
  ]
};
function _parserGuessPII(colName, sampleVals){
  for(var i=0;i<_PII_PATTERNS.high.length;i++){
    if(_PII_PATTERNS.high[i].re.test(colName)) return {level:'high',score:0.9,reason:_PII_PATTERNS.high[i].reason};
  }
  // Value-level check for email pattern
  var emailRe=/^[^@]+@[^@]+\.[a-z]{2,}$/i;
  var emailCount=sampleVals.slice(0,20).filter(function(v){return emailRe.test(v);}).length;
  if(emailCount>3) return {level:'high',score:0.85,reason:'Email address pattern in values'};
  for(var j=0;j<_PII_PATTERNS.medium.length;j++){
    if(_PII_PATTERNS.medium[j].re.test(colName)) return {level:'medium',score:0.5,reason:_PII_PATTERNS.medium[j].reason};
  }
  return {level:'none',score:0,reason:''};
}

function _parserRenderAll(){
  var d=_parserData;
  if(!d) return;
  var emptyEl=document.getElementById('parser-empty');
  if(emptyEl) emptyEl.style.display='none';
  var rcEl=document.getElementById('parser-row-count');
  if(rcEl) rcEl.textContent=(d.rows!=null?d.rows.toLocaleString()+' rows · ':'')+d.cols+' columns';
  var expBtn=document.getElementById('parser-export-btn');
  if(expBtn) expBtn.disabled=false;
  parserShowResult(_parserActiveResult, document.getElementById('prtab-'+_parserActiveResult));
}

function parserShowResult(name, btn){
  _parserActiveResult=name;
  var panels=['schema','stats','pii','nulls'];
  panels.forEach(function(p){
    var el=document.getElementById('parser-result-'+p);
    if(el) el.style.display='none';
    var tb=document.getElementById('prtab-'+p);
    if(tb) tb.classList.remove('active');
  });
  var target=document.getElementById('parser-result-'+name);
  if(target) target.style.display='flex';
  if(btn) btn.classList.add('active');
  if(!_parserData) return;
  switch(name){
    case 'schema': _parserRenderSchema(); break;
    case 'stats':  _parserRenderStats(); break;
    case 'pii':    _parserRenderPII(); break;
    case 'nulls':  _parserRenderNulls(); break;
  }
}

function _parserTypeClass(t){
  return t==='numeric'?'ptype-num':t==='categorical'?'ptype-cat':t==='boolean'?'ptype-bool':t==='datetime'?'ptype-dt':t==='id'?'ptype-id':'ptype-unk';
}
function _parserPIIBadge(level){
  if(level==='high') return '<span class="rbadge rc-crit" style="font-size:8px">HIGH</span>';
  if(level==='medium') return '<span class="rbadge rc-warn" style="font-size:8px">MED</span>';
  return '<span style="font-size:8px;color:var(--fg3)">—</span>';
}

function _parserRenderSchema(){
  if(!_parserData) return;
  var cols=_parserData.columns;
  var numCount=cols.filter(function(c){return c.type==='numeric';}).length;
  var catCount=cols.filter(function(c){return c.type==='categorical';}).length;
  var piiCount=cols.filter(function(c){return c.pii!=='none';}).length;
  var sumEl=document.getElementById('parser-schema-summary');
  if(sumEl) sumEl.textContent=numCount+' numeric · '+catCount+' categorical · '+piiCount+' PII';
  var tbody=document.getElementById('parser-schema-body');
  if(!tbody) return;
  tbody.innerHTML=cols.map(function(col,i){
    var nullPct=col.nullRate!=null?Math.round(col.nullRate*100):0;
    var nullColor=nullPct>20?'var(--aurora-red)':nullPct>5?'var(--aurora-orange)':'var(--fg2)';
    var sampleStr=String(col.sample||'—').substring(0,25);
    return '<tr style="border-bottom:1px solid var(--border)">'
      +'<td style="padding:6px 10px;color:var(--fg3);font-size:9px">'+(i+1)+'</td>'
      +'<td style="padding:6px 10px;font-weight:600;color:var(--fg)">'+esc(col.name)+'</td>'
      +'<td style="padding:6px 10px"><span class="ptype-badge '+_parserTypeClass(col.type)+'">'+col.type+'</span></td>'
      +'<td style="padding:6px 10px;font-size:10px;color:var(--fg3)">'+esc(col.sdvType)+'</td>'
      +'<td style="padding:6px 10px">'+_parserPIIBadge(col.pii)+'</td>'
      +'<td style="padding:6px 10px;font-size:10px;color:'+nullColor+'">'+nullPct+'%</td>'
      +'<td style="padding:6px 10px;font-size:10px;color:var(--fg3)">'+(col.unique!=null?col.unique.toLocaleString():'—')+'</td>'
      +'<td style="padding:6px 10px;font-size:9px;color:var(--fg3);font-family:monospace;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(sampleStr)+'">'+esc(sampleStr)+'</td>'
      +'</tr>';
  }).join('');
}

function _parserRenderStats(){
  if(!_parserData) return;
  var cols=_parserData.columns.filter(function(c){return c.type==='numeric'&&c.mean!=null;});
  var body=document.getElementById('parser-stats-body');
  if(!body) return;
  if(!cols.length){
    body.innerHTML='<div style="color:var(--fg3);font-size:11px">No numeric columns with statistics available.</div>';
    return;
  }
  body.innerHTML=cols.map(function(col){
    var range=col.max-col.min||1;
    var meanPct=Math.round(((col.mean-col.min)/range)*100);
    return '<div class="stat-card">'
      +'<div class="stat-card-hdr"><span class="stat-name">'+esc(col.name)+'</span><span class="ptype-badge ptype-num">numeric</span></div>'
      +'<div class="stat-grid">'
      +['mean','std','min','max'].map(function(k){
        var v=col[k];
        return '<div class="stat-cell"><div class="stat-cell-v">'+(v!=null?v.toFixed(3):'—')+'</div><div class="stat-cell-l">'+k+'</div></div>';
      }).join('')
      +'</div>'
      +'<div>'
      +'<div style="display:flex;justify-content:space-between;font-size:9px;color:var(--fg3);margin-bottom:3px"><span>'+col.min.toFixed(2)+'</span><span>mean</span><span>'+col.max.toFixed(2)+'</span></div>'
      +'<div style="height:6px;background:rgba(255,255,255,.06);border-radius:3px;position:relative">'
      +'<div style="position:absolute;left:'+meanPct+'%;width:2px;height:100%;background:var(--aurora-p4);border-radius:1px"></div>'
      +'</div>'
      +'</div>'
      +'</div>';
  }).join('');
}

function _parserRenderPII(){
  if(!_parserData) return;
  var cols=_parserData.columns.slice().sort(function(a,b){return (b.piiScore||0)-(a.piiScore||0);});
  var body=document.getElementById('parser-pii-body');
  if(!body) return;
  var highCols=cols.filter(function(c){return c.pii==='high';});
  var medCols=cols.filter(function(c){return c.pii==='medium';});
  var noneCols=cols.filter(function(c){return c.pii==='none';});
  var html='';
  if(highCols.length){
    html+='<div style="font-size:10px;font-weight:600;color:var(--aurora-red);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">High Risk ('+highCols.length+')</div>';
    html+=highCols.map(function(c){
      return '<div class="pii-row pii-high">'
        +'<div style="display:flex;align-items:center;gap:8px"><span style="font-size:12px;font-weight:700;color:var(--fg)">'+esc(c.name)+'</span>'
        +'<span class="rbadge rc-crit" style="font-size:8px">'+c.pii.toUpperCase()+'</span>'
        +'<span style="margin-left:auto;font-size:10px;font-weight:700;color:var(--aurora-red)">'+(c.piiScore*100).toFixed(0)+'%</span></div>'
        +(c.piiReason?'<div style="font-size:10px;color:var(--fg2)">'+esc(c.piiReason)+'</div>':'')
        +'<div style="font-size:9px;color:var(--fg3)">Recommendation: Apply pseudonymization or masking before synthesis</div>'
        +'</div>';
    }).join('');
  }
  if(medCols.length){
    html+='<div style="font-size:10px;font-weight:600;color:var(--aurora-orange);margin:10px 0 4px;text-transform:uppercase;letter-spacing:.05em">Medium Risk ('+medCols.length+')</div>';
    html+=medCols.map(function(c){
      return '<div class="pii-row pii-med">'
        +'<div style="display:flex;align-items:center;gap:8px"><span style="font-size:12px;font-weight:700;color:var(--fg)">'+esc(c.name)+'</span>'
        +'<span class="rbadge rc-warn" style="font-size:8px">MED</span>'
        +'<span style="margin-left:auto;font-size:10px;font-weight:700;color:var(--aurora-orange)">'+(c.piiScore*100).toFixed(0)+'%</span></div>'
        +(c.piiReason?'<div style="font-size:10px;color:var(--fg2)">'+esc(c.piiReason)+'</div>':'')
        +'<div style="font-size:9px;color:var(--fg3)">Recommendation: Consider k-anonymity or generalisation</div>'
        +'</div>';
    }).join('');
  }
  if(!highCols.length&&!medCols.length){
    html='<div style="padding:20px;text-align:center;color:var(--aurora-green);font-size:12px;font-weight:600">No PII detected in '+_parserData.cols+' columns</div>';
  }
  if(noneCols.length){
    html+='<div style="font-size:10px;font-weight:600;color:var(--fg3);margin:10px 0 4px;text-transform:uppercase;letter-spacing:.05em">Clean ('+noneCols.length+')</div>';
    html+=noneCols.map(function(c){
      return '<div class="pii-row pii-none" style="display:flex;align-items:center;gap:8px">'
        +'<span style="font-size:11px;color:var(--fg2)">'+esc(c.name)+'</span>'
        +'<span class="rbadge rc-low" style="font-size:8px;margin-left:auto">CLEAN</span>'
        +'</div>';
    }).join('');
  }
  body.innerHTML=html;
}

function _parserRenderNulls(){
  if(!_parserData) return;
  var cols=_parserData.columns.slice().sort(function(a,b){return (b.nullRate||0)-(a.nullRate||0);});
  var body=document.getElementById('parser-nulls-body');
  if(!body) return;
  var maxRate=Math.max.apply(null,cols.map(function(c){return c.nullRate||0;}));
  var html='<div style="font-size:11px;font-weight:600;color:var(--fg);margin-bottom:8px">Null / Missing Value Analysis</div>';
  html+=cols.map(function(col){
    var pct=Math.round((col.nullRate||0)*100);
    var color=pct>20?'var(--aurora-red)':pct>5?'var(--aurora-orange)':'var(--aurora-p4)';
    var barW=maxRate>0?Math.round(((col.nullRate||0)/maxRate)*100):0;
    return '<div class="null-row">'
      +'<div class="null-col" title="'+esc(col.name)+'">'+esc(col.name)+'</div>'
      +'<div class="null-bar-w"><div class="null-bar-f" style="width:'+barW+'%;background:'+color+'"></div></div>'
      +'<div class="null-pct" style="color:'+color+'">'+pct+'%</div>'
      +'</div>';
  }).join('');
  body.innerHTML=html;
}

function parserExportSchema(){
  if(!_parserData) return;
  var out={
    source: _parserData.filename,
    parsed_at: new Date().toISOString(),
    row_count: _parserData.rows,
    column_count: _parserData.cols,
    columns: _parserData.columns.map(function(c){
      return {
        name:c.name, inferred_type:c.type, sdv_type:c.sdvType,
        pii_level:c.pii, pii_score:c.piiScore, pii_reason:c.piiReason||null,
        null_rate:c.nullRate, unique_values:c.unique,
        stats:c.mean!=null?{mean:c.mean,std:c.std,min:c.min,max:c.max}:null
      };
    })
  };
  vscode.postMessage({command:'exportReport', report:out, filename:'aurora_schema.json'});
}

function _parserFormatBytes(b){
  if(b<1024) return b+'B';
  if(b<1048576) return (b/1024).toFixed(1)+'KB';
  return (b/1048576).toFixed(1)+'MB';
}

function _parserSetStatus(msg){
  var el=document.getElementById('parser-status');
  if(el) el.textContent=msg;
}

function renderAll(){
  console.log("[AutoMate] renderAll called");
  console.log("[AutoMate] generator rows:", D.generator?.row_count);
  console.log("[AutoMate] leakage:", !!D.leakage);
  console.log("[AutoMate] activeTab:", activeTab);

  // Reset render guards so new pipeline data always redraws tabs
  syntheticRendered=false;
  secRendered=false;
  try{renderSanityBanner();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderStrip();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderDatasetSummary();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderRiskRadar();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderC1();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderC5();}catch(e){console.error("[AutoMate] render error",e)}   // Feature Drift Heatmap — must run after data loads
  try{renderC12();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderRis();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderIntelligenceRisk();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderColumnRanking();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderRecommendations();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderTimeline();}catch(e){console.error("[AutoMate] render error",e)}
  try{initDistCols();if(_distCols.length)renderDistributionComparison(_distCols[0]);}catch(e){console.error("[AutoMate] render error",e)}
  // Force-render whichever tab is active using stable global state
  switch(activeTab){
    case 'synthetic':
      try{syntheticRendered=false;renderSynthetic(true);}catch(err){console.error("[AutoMate] render error",err)}
      break;
    case 'security':
      try{secRendered=false;renderSecurity();}catch(err){console.error("[AutoMate] render error",err)}
      break;
    case 'livesecurity':
      try{renderLiveSecurity();}catch(err){console.error("[AutoMate] render error",err)}
      break;
    case 'aiinsights':
      try{initAgentChat();}catch(err){console.error("[AutoMate] render error",err)}
      break;
  }
  setTimeout(()=>{
    try{renderC2();}catch(e){}
  },150);
}

function _automate_init(){
  setTimeout(()=>{
    document.querySelectorAll(".tabpane").forEach(function(p){
      p.style.display = "none";
    });

    const overview = document.getElementById("pane-overview");
    if(overview) overview.style.display = "block";

    renderAll();
  },100);
}

/* Boot — defined here, so _automate_init is guaranteed to exist */
_automate_init();

console.log("[AutoMate] tab panes:", document.querySelectorAll(".tabpane").length);
</script>
</body>
</html>`;
}
//# sourceMappingURL=monitorPanel.js.map