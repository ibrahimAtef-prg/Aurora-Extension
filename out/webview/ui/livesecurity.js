"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LIVE_SECURITY_SCRIPT = exports.LIVE_SECURITY_TAB_HTML = void 0;
exports.LIVE_SECURITY_TAB_HTML = String.raw `
<!-- TAB: Live Security (Phase 4) -->
<div id="pane-livesecurity" class="tabpane">
  <div id="livesecurity-root">
  <div class="lsec-wrap">
    <div class="lsec-header">
      <div>
        <div class="lsec-title">Live Security Monitor</div>
        <div style="font-size:10px;color:var(--fg3);margin-top:2px">Real-time alerts from workspace scanner, prompt detector &amp; dataset monitor</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="lsec-badge safe" id="lsec-badge">● MONITORING</span>
        <button class="lsec-btn" onclick="clearLiveAlerts()">Clear</button>
        <button class="lsec-btn" onclick="exportAlerts()">Export JSON</button>
      </div>
    </div>

    <!-- Live ticker -->
    <div class="lsec-ticker" id="lsec-ticker" style="display:none">
      <div class="lsec-ticker-dot"></div>
      <span id="lsec-ticker-text">Alert received</span>
    </div>

    <!-- Stats row -->
    <div class="lsec-stats">
      <div class="lsec-stat-box"><div class="lsec-stat-n" id="ls-total" style="color:var(--p5)">0</div><div class="lsec-stat-l">Total</div></div>
      <div class="lsec-stat-box"><div class="lsec-stat-n" id="ls-critical" style="color:#f87171">0</div><div class="lsec-stat-l">Critical</div></div>
      <div class="lsec-stat-box"><div class="lsec-stat-n" id="ls-high" style="color:#fb923c">0</div><div class="lsec-stat-l">High</div></div>
      <div class="lsec-stat-box"><div class="lsec-stat-n" id="ls-blocked" style="color:#f87171">0</div><div class="lsec-stat-l">Blocked</div></div>
      <div class="lsec-stat-box"><div class="lsec-stat-n" id="ls-warned" style="color:#fbbf24">0</div><div class="lsec-stat-l">Warned</div></div>
    </div>

    <!-- Category filters -->
    <div class="lsec-filter">
      <span style="font-size:10px;color:var(--fg3);align-self:center">Filter:</span>
      <button class="lsec-chip active" onclick="setLsecFilter('all',this)">All</button>
      <button class="lsec-chip" onclick="setLsecFilter('secret_exposure',this)">Secrets</button>
      <button class="lsec-chip" onclick="setLsecFilter('pii_detected',this)">PII</button>
      <button class="lsec-chip" onclick="setLsecFilter('prompt_leakage',this)">Prompts</button>
      <button class="lsec-chip" onclick="setLsecFilter('dataset_risk',this)">Datasets</button>
      <button class="lsec-chip" onclick="setLsecFilter('policy_violation',this)">Policies</button>
    </div>

    <!-- Alert table -->
    <div class="lsec-table-wrap">
      <table class="lsec-table">
        <thead>
          <tr>
            <th>Severity</th>
            <th>Type</th>
            <th>File</th>
            <th>Line</th>
            <th>Pattern</th>
            <th>Policy</th>
            <th>Snippet</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody id="lsec-tbody">
          <tr><td colspan="8" class="lsec-empty">No alerts yet — scanner is active and monitoring your workspace.</td></tr>
        </tbody>
      </table>
    </div>
  </div>
  </div>
</div>
`;
exports.LIVE_SECURITY_SCRIPT = String.raw `
// ── Phase 4: Live Security Monitor ──────────────────────────────────────────
var _lsecAlerts = [];
var _lsecFilter = 'all';
var _tickerTimer = null;

var SEV_COL = { critical:'#f87171', high:'#fb923c', medium:'#fbbf24', low:'var(--green)' };
var CAT_ICON = {
  secret_exposure: 'KEY', pii_detected: 'PII',
  prompt_leakage: 'LLM', dataset_risk: 'DST', policy_violation: 'POL'
};

function renderLiveSecurity(){
  const root=document.getElementById('livesecurity-root');
  if(!root){ console.error('missing root container'); return; }

  // Mode-aware idle stats: original=baseline profile, synthetic=generator output
  const _lsIsOrig = typeof isOriginalMode==='function' ? isOriginalMode() : true;
  var b6 = D.profile||D.baseline||{};
  var hasBase6 = !!(b6.columns);
  var badgeEl = document.getElementById('lsec-badge');

  if(hasBase6 && _lsecAlerts.length===0){
    var allCols6=[...Object.values((b6.columns.numeric)||{}),...Object.values((b6.columns.categorical)||{})];
    var baseRows6=(b6.meta&&(b6.meta.row_count||b6.meta.row_count_estimate))||0;
    var avgNull6=allCols6.length?allCols6.reduce(function(s,c){return s+(c.null_ratio||0);},0)/allCols6.length:0;
    var totalCols6=allCols6.length;

    // In synthetic mode, show generator row count instead of baseline
    var gen6 = !_lsIsOrig ? (D.generator||D.result||{}) : {};
    var synthRows6 = (!_lsIsOrig && gen6.row_count) ? gen6.row_count : null;
    var displayRows6 = synthRows6!=null ? synthRows6 : baseRows6;
    var rowLabel6 = synthRows6!=null ? 'Synth Rows' : 'Dataset Rows';
    var rowColor6 = synthRows6!=null ? 'var(--aurora-green)' : 'var(--aurora-p5)';

    var statBoxes=root.querySelectorAll('.lsec-stat-box');
    if(statBoxes.length>=5){
      statBoxes[0].innerHTML='<div class="lsec-stat-n" style="color:'+rowColor6+'">'+displayRows6.toLocaleString()+'</div><div class="lsec-stat-l">'+rowLabel6+'</div>';
      statBoxes[1].innerHTML='<div class="lsec-stat-n" style="color:var(--fg2)">'+totalCols6+'</div><div class="lsec-stat-l">Columns</div>';
      statBoxes[2].innerHTML='<div class="lsec-stat-n" style="color:'+(avgNull6>0.1?C.orange:C.green)+'">'+(avgNull6*100).toFixed(1)+'%</div><div class="lsec-stat-l">Null Rate</div>';
      // In original mode: show PII col count + risk level instead of empty alert stats
      if(_lsIsOrig){
        var _lsPii6=0;
        if(typeof _parserData!=='undefined'&&_parserData&&_parserData.columns)
          _lsPii6=_parserData.columns.filter(function(c){return c.pii&&c.pii!=='none';}).length;
        else if(D.scanReport&&D.scanReport.high_risk_columns)
          _lsPii6=D.scanReport.high_risk_columns.length;
        var _lsRisk6='—';
        if(D.scanReport&&D.scanReport.risk_score!=null){var rs6=+D.scanReport.risk_score;_lsRisk6=rs6>=0.7?'HIGH':rs6>=0.4?'MOD':'LOW';}
        else if(_lsPii6>0){_lsRisk6=_lsPii6/Math.max(totalCols6,1)>=0.5?'HIGH':_lsPii6/Math.max(totalCols6,1)>=0.2?'MOD':'LOW';}
        var piiColor6=_lsPii6>0?'var(--aurora-orange)':'var(--aurora-green)';
        var riskColor6=_lsRisk6==='HIGH'?C.red:_lsRisk6==='MOD'?C.orange:C.green;
        statBoxes[3].innerHTML='<div class="lsec-stat-n" style="color:'+piiColor6+'">'+_lsPii6+'</div><div class="lsec-stat-l">PII Cols</div>';
        statBoxes[4].innerHTML='<div class="lsec-stat-n" style="color:'+riskColor6+';font-size:14px;font-weight:700">'+_lsRisk6+'</div><div class="lsec-stat-l">Risk Level</div>';
      } else {
        statBoxes[3].innerHTML='<div class="lsec-stat-n" style="color:var(--green)">0</div><div class="lsec-stat-l">Blocked</div>';
        statBoxes[4].innerHTML='<div class="lsec-stat-n" style="color:var(--green)">0</div><div class="lsec-stat-l">Warned</div>';
      }
    }
    if(badgeEl){ badgeEl.textContent='● MONITORING'; badgeEl.className='lsec-badge safe'; }
    var tbody=root.querySelector('#lsec-tbody');
    var modeLabel6 = synthRows6!=null
      ? 'Synthetic: '+synthRows6.toLocaleString()+' rows · '+totalCols6+' columns'
      : 'Baseline: '+baseRows6.toLocaleString()+' rows · '+totalCols6+' columns loaded.';
    if(tbody) tbody.innerHTML='<tr><td colspan="8" class="lsec-empty">No alerts — monitoring active. '+modeLabel6+'</td></tr>';
    return;
  }
  if(!_lsecAlerts.length){
    if(badgeEl){ badgeEl.textContent='● MONITORING'; badgeEl.className='lsec-badge safe'; }
    var tbody2=root.querySelector('#lsec-tbody');
    if(tbody2) tbody2.innerHTML='<tr><td colspan="8" class="lsec-empty">No alerts yet — scanner is active and monitoring your workspace.</td></tr>';
    updateLiveStats();
    return;
  }
  updateLiveStats();
  rebuildLiveTable();
}

function appendLiveAlert(alert, animate){
  if(animate===undefined) animate=true;
  _lsecAlerts.unshift(alert);
  if(_lsecAlerts.length > 200) _lsecAlerts.length = 200;
  updateLiveStats();
  rebuildLiveTable();
  if(animate) {
    var tab = document.getElementById('live-sec-tab');
    if(tab && !tab.classList.contains('on')) {
      tab.style.color='#f87171';
      tab.textContent='Live Monitor (' + countBySev('critical','high') + ')';
    }
  }
}

function countBySev(){
  var sevs = Array.prototype.slice.call(arguments);
  return _lsecAlerts.filter(function(a){ return sevs.indexOf(a.severity)!==-1; }).length;
}

function updateLiveStats(){
  var total    = _lsecAlerts.length;
  var critical = _lsecAlerts.filter(function(a){ return a.severity==='critical'; }).length;
  var high     = _lsecAlerts.filter(function(a){ return a.severity==='high'; }).length;
  var blocked  = _lsecAlerts.filter(function(a){ return a.policyAction==='blocked'; }).length;
  var warned   = _lsecAlerts.filter(function(a){ return a.policyAction==='warned'; }).length;

  var setEl = function(id, v){ var el=document.getElementById(id); if(el) el.textContent=v; };
  setEl('ls-total', total);
  setEl('ls-critical', critical);
  setEl('ls-high', high);
  setEl('ls-blocked', blocked);
  setEl('ls-warned', warned);

  var badge = document.getElementById('lsec-badge');
  if(badge) {
    if(critical > 0) {
      badge.textContent = '● ' + critical + ' CRITICAL';
      badge.className = 'lsec-badge active';
    } else if(total > 0) {
      badge.textContent = '● ' + total + ' ALERTS';
      badge.className = 'lsec-badge active';
    } else {
      badge.textContent = '● MONITORING';
      badge.className = 'lsec-badge safe';
    }
  }
}

function rebuildLiveTable(){
  var tbody = document.getElementById('lsec-tbody');
  if(!tbody) return;

  var filtered = _lsecFilter === 'all'
    ? _lsecAlerts
    : _lsecAlerts.filter(function(a){ return a.category === _lsecFilter; });

  if(filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="lsec-empty">' +
      (_lsecFilter === 'all'
        ? 'No alerts yet — scanner is active and monitoring your workspace.'
        : 'No alerts in this category.') +
      '</td></tr>';
    return;
  }

  var html = filtered.slice(0, 100).map(function(a) {
    var sevCls = a.severity || 'low';
    var polCls = a.policyAction || 'logged';
    var catIcon = CAT_ICON[a.category] || '•';
    var ts = a.timestamp ? a.timestamp.slice(11,19) : '';
    var snippet = a.snippet ? esc(a.snippet.substring(0,60)) : '—';
    return '<tr>' +
      '<td><span class="lsec-sev ' + sevCls + '">' + sevCls + '</span></td>' +
      '<td style="font-size:11px;font-weight:600;color:var(--fg)">' + catIcon + ' ' + esc(a.type) + '</td>' +
      '<td style="font-size:11px;color:var(--p5)">' + esc(a.file) + '</td>' +
      '<td style="font-size:11px;color:var(--fg3);text-align:center">' + (a.line || '—') + '</td>' +
      '<td style="font-size:10px;color:var(--fg2);max-width:180px">' + esc((a.pattern||'').substring(0,60)) + '</td>' +
      '<td><span class="lsec-policy ' + polCls + '">' + polCls + '</span></td>' +
      '<td class="lsec-snippet">' + snippet + '</td>' +
      '<td style="font-size:9px;color:var(--fg3);white-space:nowrap">' + ts + '</td>' +
      '</tr>';
  }).join('');

  tbody.innerHTML = html;
}

function setLsecFilter(cat, btn){
  _lsecFilter = cat;
  document.querySelectorAll('.lsec-chip').forEach(function(c){ c.classList.remove('active'); });
  if(btn) btn.classList.add('active');
  rebuildLiveTable();
}

function clearLiveAlerts(){
  _lsecAlerts = [];
  updateLiveStats();
  rebuildLiveTable();
  var tab = document.getElementById('live-sec-tab');
  if(tab) { tab.style.color=''; tab.textContent='Live Monitor'; }
}

function exportAlerts(){
  var data = JSON.stringify(_lsecAlerts, null, 2);
  vscode.postMessage({ command: 'exportReport', report: _lsecAlerts, filename: 'live_security_alerts.json' });
}

function flashTicker(alert){
  var ticker = document.getElementById('lsec-ticker');
  var text   = document.getElementById('lsec-ticker-text');
  if(!ticker || !text) return;
  var sev = (alert.severity || '').toUpperCase();
  var icon = CAT_ICON[alert.category] || '!';
  text.textContent = icon + ' [' + sev + '] ' + esc(alert.type) + ' detected in ' + esc(alert.file);
  ticker.style.display = 'flex';
  clearTimeout(_tickerTimer);
  _tickerTimer = setTimeout(function(){ ticker.style.display='none'; }, 6000);
}
`;
//# sourceMappingURL=livesecurity.js.map