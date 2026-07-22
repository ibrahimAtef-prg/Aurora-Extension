"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PARSER_SCRIPT = exports.PARSER_STYLES = exports.PARSER_TAB_HTML = void 0;
exports.PARSER_TAB_HTML = String.raw `
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
      <button class="hbtn hbtn-g" id="parser-use-pipeline-btn" onclick="parserFromDataset()" style="display:none">Use Pipeline Dataset</button>
      <button class="hbtn hbtn-g" id="parser-export-btn" onclick="parserExportSchema()" style="display:none">Export Schema</button>

      <!-- ── Generate section ── -->
      <div style="display:flex;align-items:center;gap:6px;border-left:1px solid rgba(255,255,255,.10);padding-left:10px;margin-left:2px">
        <label style="font-size:10px;color:var(--fg3);white-space:nowrap">Rows:</label>
        <div class="num-wrap">
          <input type="number" id="parser-gen-rows" value="500" min="1" max="10000"
            style="width:62px;background:var(--vsc-input);border:1px solid var(--border);border-radius:5px;color:var(--fg);font-size:11px;padding:3px 7px;outline:none"/>
          <div class="num-arrows">
            <button onclick="var i=document.getElementById('parser-gen-rows');i.value=Math.min(10000,+i.value+1)" tabindex="-1" title="Increase">
              <svg width="8" height="5" viewBox="0 0 8 5" fill="none"><path d="M1 4L4 1L7 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <button onclick="var i=document.getElementById('parser-gen-rows');i.value=Math.max(1,+i.value-1)" tabindex="-1" title="Decrease">
              <svg width="8" height="5" viewBox="0 0 8 5" fill="none"><path d="M1 1L4 4L7 1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
        </div>
        <button id="parser-gen-btn" onclick="parserReqGen()"
          style="display:inline-flex;align-items:center;gap:6px;padding:5px 13px;background:var(--aurora-grad);color:#fff;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px var(--aurora-glow2);white-space:nowrap;transition:opacity .15s">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0">
            <path d="M2.5 2.18C2.5 1.45 3.28 1.01 3.9 1.38L11.1 5.7C11.71 6.07 11.71 6.93 11.1 7.3L3.9 11.62C3.28 11.99 2.5 11.55 2.5 10.82V2.18Z" fill="white"/>
          </svg>
          Generate
        </button>
      </div>
    </div>
  </div>

  <!-- Status bar (parse status + gen status) -->
  <div style="padding:4px 20px 0;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <div id="parser-status" style="font-size:10px;color:var(--fg3);min-height:16px;flex:1"></div>
    <div id="parser-gen-status" style="font-size:10px;color:var(--aurora-p5);min-height:16px;font-weight:500"></div>
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
</div>
`;
exports.PARSER_STYLES = String.raw `
.parser-stab{padding:3px 10px;font-size:9px;font-weight:600;cursor:pointer;border:none;background:transparent;color:var(--fg3);border-radius:5px;transition:all .15s}
.parser-stab.active{background:var(--aurora-p3);color:#fff}
.parser-stab:hover:not(.active){color:var(--fg);background:rgba(255,255,255,.06)}
.ptype-badge{display:inline-block;padding:1px 7px;border-radius:4px;font-size:9px;font-weight:600;font-family:monospace;letter-spacing:.01em}
.ptype-num{background:rgba(139,92,246,.14);color:var(--aurora-p5);border:1px solid rgba(139,92,246,.25)}
.ptype-cat{background:rgba(52,211,153,.10);color:var(--aurora-green);border:1px solid rgba(52,211,153,.22)}
.ptype-dt{background:rgba(251,191,36,.10);color:var(--aurora-yellow);border:1px solid rgba(251,191,36,.22)}
.ptype-bool{background:rgba(251,146,60,.10);color:var(--aurora-orange);border:1px solid rgba(251,146,60,.22)}
.ptype-unk{background:rgba(255,255,255,.05);color:var(--fg3);border:1px solid var(--border)}
.pii-entry{padding:8px 10px;border-radius:7px;display:flex;flex-direction:column;gap:4px;transition:border-color .2s}
.pii-entry.pii-high{background:rgba(248,113,113,.05);border:1px solid rgba(248,113,113,.30)}
.pii-entry.pii-med{background:rgba(251,146,60,.05);border:1px solid rgba(251,146,60,.25)}
.pii-entry.pii-low{background:rgba(52,211,153,.04);border:1px solid rgba(52,211,153,.18)}
.pii-entry.pii-none{background:transparent;border:1px solid var(--border);opacity:.55}
`;
exports.PARSER_SCRIPT = String.raw `
// ── Parser Tab ───────────────────────────────────────────────────────
var _parserData = null;

function parserDragOver(e){
  e.preventDefault();
  var dz=document.getElementById('parser-dropzone');
  if(dz){dz.style.borderColor='var(--aurora-p4)';dz.style.background='rgba(139,92,246,.06)';}
}
function parserDragLeave(e){
  var dz=document.getElementById('parser-dropzone');
  if(dz){dz.style.borderColor='';dz.style.background='';}
}
function parserDrop(e){
  e.preventDefault(); parserDragLeave(e);
  var files=e.dataTransfer&&e.dataTransfer.files;
  if(files&&files.length) parserLoadFile(files[0]);
}
function parserFileSelected(inp){
  if(inp.files&&inp.files.length) parserLoadFile(inp.files[0]);
}
function parserLoadFile(file){
  _parserSetStatus('Reading '+file.name+'...');
  var ext=(file.name.split('.').pop()||'').toLowerCase();
  if(ext==='csv'||ext==='tsv'){
    var r=new FileReader();
    r.onload=function(e){ _parserParseCSV(e.target.result, file.name, ext==='tsv'?'\t':','); };
    r.readAsText(file);
  } else if(ext==='json'){
    var r2=new FileReader();
    r2.onload=function(e){ _parserParseJSON(e.target.result, file.name); };
    r2.readAsText(file);
  } else {
    _parserSetStatus('Format not supported in browser — use Parse Pipeline Dataset for loaded data');
  }
}

function parserFromDataset(){
  var b=D.profile||D.baseline||{};
  var l=D.leakage||{};
  var sc=D.scanReport||{};
  if(!b.columns){
    _parserSetStatus('No dataset in pipeline. Run Parse + Baseline first.');
    return;
  }
  _parserSetStatus('Parsing pipeline dataset...');
  var numCols=Object.keys((b.columns&&b.columns.numeric)||{});
  var catCols=Object.keys((b.columns&&b.columns.categorical)||{});
  var piiCols=new Set((l.pii_columns||[]).concat(sc.high_risk_columns||[]).concat(
    (sc.pii_findings||[]).map(function(f){return f.column;})
  ).filter(Boolean));
  var ranking=(l.sensitive_column_ranking||[]);
  var rankMap={};
  ranking.forEach(function(r){rankMap[r.column]=r;});
  var numMeta=b.columns.numeric||{};
  var catMeta=b.columns.categorical||{};
  var columns=[];
  numCols.forEach(function(col){
    var s=numMeta[col]||{};
    var ps=(rankMap[col]&&rankMap[col].score)||0;
    columns.push({name:col,type:'numeric',sdvType:'numerical',
      pii:piiCols.has(col)?'high':ps>0.4?'medium':'none',piiScore:ps,
      piiReason:piiCols.has(col)?'Flagged by PII scanner':'',
      mean:s.mean,std:s.std,min:s.min,max:s.max,
      nullRate:s.null_ratio||0,unique:s.unique_count||null,sample:s.mean!=null?s.mean.toFixed(2):'—'});
  });
  catCols.forEach(function(col){
    var s=catMeta[col]||{};
    var ps=(rankMap[col]&&rankMap[col].score)||0;
    var guessedPii=_parserGuessPII(col,[s.most_frequent||'']);
    columns.push({name:col,type:'categorical',sdvType:'categorical',
      pii:piiCols.has(col)?'high':guessedPii.level!=='none'?guessedPii.level:ps>0.4?'medium':'none',
      piiScore:piiCols.has(col)?0.9:guessedPii.score,
      piiReason:piiCols.has(col)?'Flagged by PII scanner':guessedPii.reason,
      mean:null,std:null,min:null,max:null,
      nullRate:s.null_ratio||0,unique:s.unique_count||null,sample:s.most_frequent||'—'});
  });
  var rows=b.meta&&(b.meta.row_count||b.meta.row_count_estimate);
  _parserData={filename:'Pipeline Dataset',rows:rows,cols:columns.length,columns:columns,source:'pipeline'};
  _parserRenderAll();
  _parserSetStatus('Parsed '+columns.length+' columns from pipeline'+(rows?' · '+rows.toLocaleString()+' rows':''));
}

function _parserParseCSV(text, fname, sep){
  var lines=text.split(/\r?\n/).filter(function(l){return l.trim();});
  if(!lines.length){_parserSetStatus('Empty file');return;}
  var headers=lines[0].split(sep).map(function(h){return h.replace(/^"|"$/g,'').trim();});
  var totalRows=lines.length-1;
  var maxSamp=Math.min(totalRows,500);
  var rows=[];
  for(var i=1;i<=maxSamp;i++){
    var parts=_splitCSVLine(lines[i],sep);
    var row={};
    headers.forEach(function(h,hi){row[h]=(parts[hi]||'').replace(/^"|"$/g,'').trim();});
    rows.push(row);
  }
  var columns=headers.map(function(col){
    var vals=rows.map(function(r){return r[col];}).filter(function(v){return v!==''&&v!=null;});
    var nullRate=rows.length?(rows.length-vals.length)/rows.length:0;
    var numVals=vals.filter(function(v){return !isNaN(+v)&&v!=='true'&&v!=='false';}).map(Number);
    var isNum=vals.length>0&&numVals.length/vals.length>0.85;
    var isBool=new Set(vals.map(function(v){return v.toLowerCase();})).size<=2&&['true','false','yes','no','0','1'].some(function(x){return vals.some(function(v){return v.toLowerCase()===x;});});
    var unique=new Set(vals).size;
    var type=isNum?'numeric':isBool?'boolean':'categorical';
    var pii=_parserGuessPII(col,vals);
    var stats={};
    if(isNum&&numVals.length){
      stats.mean=numVals.reduce(function(a,b){return a+b;},0)/numVals.length;
      stats.min=Math.min.apply(null,numVals);stats.max=Math.max.apply(null,numVals);
      var v=numVals.reduce(function(a,x){return a+Math.pow(x-stats.mean,2);},0)/numVals.length;
      stats.std=Math.sqrt(v);
    }
    return {name:col,type:type,sdvType:isNum?'numerical':'categorical',
      pii:pii.level,piiScore:pii.score,piiReason:pii.reason,
      mean:stats.mean,std:stats.std,min:stats.min,max:stats.max,
      nullRate:nullRate,unique:unique,sample:vals.length?String(vals[0]).substring(0,28):'—'};
  });
  _parserData={filename:fname,rows:totalRows,cols:headers.length,columns:columns,source:'file'};
  _parserRenderAll();
  _parserSetStatus('Parsed '+headers.length+' columns · '+totalRows.toLocaleString()+' rows (sampled '+maxSamp+')');
  var upBtn=document.getElementById('parser-use-pipeline-btn');if(upBtn)upBtn.style.display='';
}

function _splitCSVLine(line, sep){
  if(sep==='\t') return line.split('\t');
  var result=[],cur='',inQ=false;
  for(var i=0;i<line.length;i++){
    var ch=line[i];
    if(ch==='"'){inQ=!inQ;}
    else if(ch===sep&&!inQ){result.push(cur);cur='';}
    else{cur+=ch;}
  }
  result.push(cur);
  return result;
}

function _parserParseJSON(text, fname){
  var data=JSON.parse(text);
  var rows=Array.isArray(data)?data:(data.data||data.rows||[data]);
  if(!rows.length){_parserSetStatus('Empty JSON');return;}
  var headers=Object.keys(rows[0]||{});
  var samp=rows.slice(0,500);
  var columns=headers.map(function(col){
    var vals=samp.map(function(r){return r[col];}).filter(function(v){return v!=null&&v!=='';});
    var nullRate=samp.length?(samp.length-vals.length)/samp.length:0;
    var strVals=vals.map(String);
    var numVals=vals.filter(function(v){return typeof v==='number'||(!isNaN(+v)&&v!=='');}).map(Number);
    var isNum=vals.length>0&&numVals.length/vals.length>0.85;
    var unique=new Set(strVals).size;
    var pii=_parserGuessPII(col,strVals);
    var stats={};
    if(isNum&&numVals.length){
      stats.mean=numVals.reduce(function(a,b){return a+b;},0)/numVals.length;
      stats.min=Math.min.apply(null,numVals);stats.max=Math.max.apply(null,numVals);
      var vv=numVals.reduce(function(a,x){return a+Math.pow(x-stats.mean,2);},0)/numVals.length;
      stats.std=Math.sqrt(vv);
    }
    return {name:col,type:isNum?'numeric':'categorical',sdvType:isNum?'numerical':'categorical',
      pii:pii.level,piiScore:pii.score,piiReason:pii.reason,
      mean:stats.mean,std:stats.std,min:stats.min,max:stats.max,
      nullRate:nullRate,unique:unique,sample:String(vals[0]||'—').substring(0,28)};
  });
  _parserData={filename:fname,rows:rows.length,cols:headers.length,columns:columns,source:'file'};
  _parserRenderAll();
  _parserSetStatus('Parsed '+headers.length+' columns · '+rows.length.toLocaleString()+' rows');
  var upBtn=document.getElementById('parser-use-pipeline-btn');if(upBtn)upBtn.style.display='';
}

var _PII_H=[
  {re:/ssn|social.sec/i,r:'Social Security Number'},
  {re:/passport/i,r:'Passport'},
  {re:/credit.card|card.num|cvv/i,r:'Payment card'},
  {re:/^email$|e.?mail/i,r:'Email address'},
  {re:/password|passwd|secret|api.?key|token$/i,r:'Credential'},
  {re:/ip.?addr/i,r:'IP address'},
  {re:/phone|mobile|tel$/i,r:'Phone number'},
  {re:/dob|date.?of.?birth|birth.?date/i,r:'Date of birth'},
];
var _PII_M=[
  {re:/^name$|full.?name|first.?name|last.?name|surname/i,r:'Name'},
  {re:/^address$|street|postcode|zip$/i,r:'Address'},
  {re:/^age$|gender|sex$/i,r:'Quasi-identifier'},
  {re:/race|ethnicity|religion/i,r:'Sensitive attribute'},
  {re:/salary|income|wage/i,r:'Financial'},
  {re:/employee.?id|user.?id|account.?id/i,r:'Identifier'},
];
function _parserGuessPII(col, vals){
  for(var i=0;i<_PII_H.length;i++) if(_PII_H[i].re.test(col)) return {level:'high',score:.9,reason:_PII_H[i].r};
  var emailRe=/^[^@]+@[^@]+\.[a-z]{2,}$/i;
  if(vals.slice(0,20).filter(function(v){return emailRe.test(v);}).length>3) return {level:'high',score:.85,reason:'Email pattern in values'};
  for(var j=0;j<_PII_M.length;j++) if(_PII_M[j].re.test(col)) return {level:'medium',score:.5,reason:_PII_M[j].r};
  return {level:'none',score:0,reason:''};
}

function _parserRenderAll(){
  var d=_parserData; if(!d) return;
  document.getElementById('parser-empty').style.display='none';
  document.getElementById('parser-results').style.display='block';
  var expBtn=document.getElementById('parser-export-btn');
  if(expBtn) expBtn.style.display='';

  // Summary cards
  var piiCount=d.columns.filter(function(c){return c.pii!=='none';}).length;
  var cleanCount=d.columns.filter(function(c){return c.pii==='none';}).length;
  var el=document.getElementById('p-stat-rows'); if(el) el.textContent=d.rows!=null?d.rows.toLocaleString():'—';
  el=document.getElementById('p-stat-cols'); if(el) el.textContent=d.cols;
  el=document.getElementById('p-stat-pii');  if(el) el.textContent=piiCount;
  el=document.getElementById('p-stat-clean');if(el) el.textContent=cleanCount;

  // Re-render the strip so PII Cols in header badge stays in sync
  try{ if(typeof renderStrip==='function') renderStrip(); }catch(e){}

  // Schema sub-tab
  _parserRenderSchema();
  _parserRenderPII();
  _parserRenderTypeChart();
  _parserRenderNullOverview();
}

function parserSubTab(name, btn){
  ['schema','stats','nulls'].forEach(function(n){
    var p=document.getElementById('psub-'+n); if(p) p.style.display='none';
    var b=document.getElementById('pstab-'+n); if(b) b.classList.remove('active');
  });
  var target=document.getElementById('psub-'+name); if(target) target.style.display='';
  if(btn) btn.classList.add('active');
  if(name==='stats') _parserRenderStats();
  if(name==='nulls') _parserRenderNullsTable();
}

function _parserTypeCls(t){
  return t==='numeric'?'ptype-num':t==='categorical'?'ptype-cat':t==='boolean'?'ptype-bool':t==='datetime'?'ptype-dt':'ptype-unk';
}
function _piiB(level){
  if(level==='high')   return '<span class="rbadge rc-crit" style="font-size:8px">HIGH</span>';
  if(level==='medium') return '<span class="rbadge rc-warn" style="font-size:8px">MED</span>';
  return '<span style="font-size:8px;color:var(--fg3)">—</span>';
}

function _parserRenderSchema(){
  var d=_parserData; if(!d) return;
  var numC=d.columns.filter(function(c){return c.type==='numeric';}).length;
  var catC=d.columns.filter(function(c){return c.type==='categorical';}).length;
  var sub=document.getElementById('p-schema-sub');
  if(sub) sub.textContent=numC+' numeric · '+catC+' categorical · '+d.cols+' total';
  var tbody=document.getElementById('parser-schema-body'); if(!tbody) return;
  tbody.innerHTML=d.columns.map(function(col,i){
    var nullPct=Math.round((col.nullRate||0)*100);
    var nc=nullPct>20?'var(--aurora-red)':nullPct>5?'var(--aurora-orange)':'var(--fg2)';
    return '<tr style="border-bottom:1px solid var(--border)">'
      +'<td style="padding:5px 12px;color:var(--fg3);font-size:9px">'+(i+1)+'</td>'
      +'<td style="padding:5px 12px;font-weight:600;color:var(--fg)">'+esc(col.name)+'</td>'
      +'<td style="padding:5px 12px"><span class="ptype-badge '+_parserTypeCls(col.type)+'">'+col.type+'</span></td>'
      +'<td style="padding:5px 12px;font-size:10px;color:var(--fg3)">'+esc(col.sdvType)+'</td>'
      +'<td style="padding:5px 12px">'+_piiB(col.pii)+'</td>'
      +'<td style="padding:5px 12px;font-size:10px;color:'+nc+'">'+nullPct+'%</td>'
      +'<td style="padding:5px 12px;font-size:10px;color:var(--fg3)">'+(col.unique!=null?col.unique.toLocaleString():'—')+'</td>'
      +'<td style="padding:5px 12px;font-size:9px;color:var(--fg3);font-family:monospace;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(String(col.sample||'—'))+'</td>'
      +'</tr>';
  }).join('');
}

function _parserRenderStats(){
  var d=_parserData; if(!d) return;
  var numCols=d.columns.filter(function(c){return c.type==='numeric'&&c.mean!=null;});
  var body=document.getElementById('parser-stats-body'); if(!body) return;
  if(!numCols.length){body.innerHTML='<div style="color:var(--fg3);font-size:11px;padding:8px">No numeric columns with statistics.</div>';return;}
  body.innerHTML=numCols.map(function(col){
    var range=col.max-col.min||1;
    var mp=Math.max(0,Math.min(100,Math.round(((col.mean-col.min)/range)*100)));
    return '<div class="card" style="padding:12px;gap:8px">'
      +'<div style="display:flex;align-items:center;justify-content:space-between"><span style="font-size:11px;font-weight:600;color:var(--fg)">'+esc(col.name)+'</span><span class="ptype-badge ptype-num">numeric</span></div>'
      +'<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px">'
      +['mean','std','min','max'].map(function(k){var v=col[k];return '<div style="background:var(--bg3);border-radius:6px;padding:6px;text-align:center"><div style="font-size:12px;font-weight:700;color:var(--aurora-p5)">'+(v!=null?v.toFixed(3):'—')+'</div><div style="font-size:8px;color:var(--fg3);text-transform:uppercase;margin-top:1px">'+k+'</div></div>';}).join('')
      +'</div>'
      +'<div><div style="display:flex;justify-content:space-between;font-size:8px;color:var(--fg3);margin-bottom:2px"><span>'+col.min.toFixed(2)+'</span><span style="color:var(--aurora-p5)">mean '+col.mean.toFixed(2)+'</span><span>'+col.max.toFixed(2)+'</span></div>'
      +'<div style="height:5px;background:rgba(255,255,255,.06);border-radius:3px;position:relative">'
      +'<div style="position:absolute;left:'+mp+'%;top:-1px;width:2px;height:7px;background:var(--aurora-p4);border-radius:1px"></div>'
      +'<div style="height:5px;width:'+mp+'%;background:rgba(139,92,246,.25);border-radius:3px"></div>'
      +'</div></div>'
      +'</div>';
  }).join('');
}

function _parserRenderNullsTable(){
  var d=_parserData; if(!d) return;
  var body=document.getElementById('parser-nulls-body'); if(!body) return;
  var cols=d.columns.slice().sort(function(a,b){return (b.nullRate||0)-(a.nullRate||0);});
  var maxR=Math.max.apply(null,cols.map(function(c){return c.nullRate||0;}))||0.01;
  body.innerHTML=cols.map(function(col){
    var pct=Math.round((col.nullRate||0)*100);
    var color=pct>20?'var(--aurora-red)':pct>5?'var(--aurora-orange)':'var(--aurora-p4)';
    var barW=Math.round(((col.nullRate||0)/maxR)*100);
    return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)">'
      +'<div style="width:110px;font-size:10px;color:var(--fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0">'+esc(col.name)+'</div>'
      +'<div style="flex:1;height:5px;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden">'
      +'<div style="height:5px;width:'+barW+'%;background:'+color+';border-radius:3px;transition:width .5s ease"></div>'
      +'</div>'
      +'<div style="width:32px;text-align:right;font-size:9px;color:'+color+'">'+pct+'%</div>'
      +'</div>';
  }).join('');
}

function _parserRenderPII(){
  var d=_parserData; if(!d) return;
  var body=document.getElementById('parser-pii-body'); if(!body) return;
  var sorted=d.columns.slice().sort(function(a,b){return (b.piiScore||0)-(a.piiScore||0);});
  var html=sorted.map(function(col){
    var cls=col.pii==='high'?'pii-high':col.pii==='medium'?'pii-med':col.pii==='none'?'pii-none':'pii-low';
    var scoreColor=col.pii==='high'?'var(--aurora-red)':col.pii==='medium'?'var(--aurora-orange)':'var(--fg3)';
    return '<div class="pii-entry '+cls+'">'
      +'<div style="display:flex;align-items:center;gap:6px">'
      +'<span style="font-size:11px;font-weight:600;color:var(--fg);flex:1">'+esc(col.name)+'</span>'
      +_piiB(col.pii)
      +(col.piiScore>0?'<span style="font-size:10px;font-weight:700;color:'+scoreColor+'">'+(col.piiScore*100).toFixed(0)+'%</span>':'')
      +'</div>'
      +(col.piiReason?'<div style="font-size:9px;color:var(--fg3)">'+esc(col.piiReason)+'</div>':'')
      +'</div>';
  }).join('');
  if(!sorted.length) html='<div style="color:var(--fg3);font-size:11px;padding:8px">Run parser to see PII analysis.</div>';
  body.innerHTML=html;
}

function _parserRenderTypeChart(){
  var d=_parserData; if(!d) return;
  var body=document.getElementById('parser-type-chart'); if(!body) return;
  var types={numeric:0,categorical:0,boolean:0,datetime:0,unknown:0};
  d.columns.forEach(function(c){types[c.type]=(types[c.type]||0)+1;});
  var total=d.cols||1;
  var colors={numeric:'var(--aurora-p4)',categorical:'var(--aurora-green)',boolean:'var(--aurora-orange)',datetime:'var(--aurora-yellow)',unknown:'var(--fg3)'};
  body.innerHTML=Object.keys(types).filter(function(t){return types[t]>0;}).map(function(t){
    var pct=Math.round((types[t]/total)*100);
    return '<div style="display:flex;flex-direction:column;gap:3px">'
      +'<div style="display:flex;justify-content:space-between;font-size:10px">'
      +'<span style="color:var(--fg2)">'+t+'</span>'
      +'<span style="font-weight:600;color:var(--fg)">'+types[t]+' <span style="color:var(--fg3);font-weight:400">('+pct+'%)</span></span>'
      +'</div>'
      +'<div style="height:7px;background:rgba(255,255,255,.06);border-radius:4px;overflow:hidden">'
      +'<div style="height:7px;width:'+pct+'%;background:'+colors[t]+';border-radius:4px;opacity:.75;transition:width .6s ease"></div>'
      +'</div>'
      +'</div>';
  }).join('');
}

function _parserRenderNullOverview(){
  var d=_parserData; if(!d) return;
  var body=document.getElementById('parser-null-overview'); if(!body) return;
  var withNulls=d.columns.filter(function(c){return (c.nullRate||0)>0;}).slice().sort(function(a,b){return (b.nullRate||0)-(a.nullRate||0);});
  var noNulls=d.columns.filter(function(c){return !(c.nullRate||0);});
  if(!withNulls.length){
    body.innerHTML='<div style="color:var(--aurora-green);font-size:11px;font-weight:600;padding:8px">No missing values detected</div>';
    return;
  }
  var html=withNulls.map(function(col){
    var pct=Math.round((col.nullRate||0)*100);
    var color=pct>20?'var(--aurora-red)':pct>5?'var(--aurora-orange)':'var(--aurora-p4)';
    return '<div style="display:flex;align-items:center;gap:8px;padding:3px 0;border-bottom:1px solid var(--border)">'
      +'<div style="width:90px;font-size:10px;color:var(--fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0">'+esc(col.name)+'</div>'
      +'<div style="flex:1;height:5px;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden">'
      +'<div style="height:5px;width:'+pct+'%;background:'+color+';border-radius:3px"></div>'
      +'</div>'
      +'<div style="width:28px;text-align:right;font-size:9px;font-weight:600;color:'+color+'">'+pct+'%</div>'
      +'</div>';
  }).join('');
  if(noNulls.length){
    html+='<div style="font-size:9px;color:var(--fg3);margin-top:8px;padding-top:4px;border-top:1px solid var(--border)">'+noNulls.length+' column'+(noNulls.length===1?'':'s')+' fully complete</div>';
  }
  body.innerHTML=html;
}

// ── Parser Generate ──────────────────────────────────────────────────
function parserReqGen(){
  var nEl=document.getElementById('parser-gen-rows');
  var n=parseInt((nEl&&nEl.value)||'500',10)||500;
  // keep the overview input in sync
  var ovEl=document.getElementById('gen-n');
  if(ovEl) ovEl.value=String(n);
  var btn=document.getElementById('parser-gen-btn');
  if(btn){btn.disabled=true;btn.style.opacity='0.55';btn.textContent='\u23F3 Generating\u2026';}
  _parserSetGenStatus('Generating '+n.toLocaleString()+' rows\u2026');
  var genBtn=document.getElementById('gen-btn');
  if(genBtn){genBtn.disabled=true;genBtn.textContent='Running\u2026';}
  vscode.postMessage({command:'runGenerator',n:n});
}

function parserUpdateGenStatus(text){
  if(!text) return;
  _parserSetGenStatus(text);
  var done=text.startsWith('Done')||text.startsWith('Complete')||text.startsWith('Warning')||text.startsWith('Error')||text.includes('complete')||text.includes('failed');
  if(done){
    var btn=document.getElementById('parser-gen-btn');
    if(btn){btn.disabled=false;btn.style.opacity='1';btn.innerHTML='<svg width="13" height="13" viewBox="0 0 13 13" fill="none" style="flex-shrink:0"><path d="M2.5 2.18C2.5 1.45 3.28 1.01 3.9 1.38L11.1 5.7C11.71 6.07 11.71 6.93 11.1 7.3L3.9 11.62C3.28 11.99 2.5 11.55 2.5 10.82V2.18Z" fill="white"/></svg> Generate';}
    if(text.startsWith('Done')||text.includes('complete')){
      _parserSetGenStatus('\u2713 Generation complete \u2014 check Overview for results');
    }
  }
}

function _parserSetGenStatus(msg){
  var el=document.getElementById('parser-gen-status');
  if(el) el.textContent=msg||'';
}

function parserExportSchema(){
  if(!_parserData) return;
  var out={source:_parserData.filename,parsed_at:new Date().toISOString(),
    row_count:_parserData.rows,column_count:_parserData.cols,
    columns:_parserData.columns.map(function(c){return {
      name:c.name,inferred_type:c.type,sdv_type:c.sdvType,
      pii_level:c.pii,pii_score:c.piiScore,pii_reason:c.piiReason||null,
      null_rate:c.nullRate,unique_values:c.unique,
      stats:c.mean!=null?{mean:c.mean,std:c.std,min:c.min,max:c.max}:null};})};
  vscode.postMessage({command:'exportReport',report:out,filename:'aurora_schema.json'});
}
function _parserSetStatus(msg){
  var el=document.getElementById('parser-status'); if(el) el.textContent=msg;
}
`;
//# sourceMappingURL=parser.js.map