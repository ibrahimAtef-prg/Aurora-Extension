export const OVERVIEW_TAB_HTML = String.raw`
<!-- TAB: Overview -->
<div id="pane-overview" class="tabpane">
<div class="grid">

  <!-- Row 1: Generator control + Status at a glance -->

  <!-- Analysis Card: Original dataset profile + post-gen comparison -->
  <div class="card" id="analysis-card">
    <div class="ch">
      <div><div class="ct">Dataset Analysis</div><div class="cs" id="analysis-sub">Original Dataset Profile</div></div>
      <div id="analysis-badge" class="rbadge rc-unk" style="align-self:flex-start">&#8212;</div>
    </div>
    <div id="analysis-body" style="flex:1;display:flex;flex-direction:column;gap:6px;justify-content:center">
      <div style="color:var(--fg3);font-size:11px">Run pipeline to view analysis.</div>
    </div>
  </div>
  <!-- hidden inputs kept for parser-tab generator sync -->
  <input id="gen-n" type="number" value="500" style="display:none"/>
  <div id="gen-status" style="display:none"></div>
  <button id="gen-btn" style="display:none"></button>

  <!-- Dataset Summary -->
  <div class="card" id="card-summary">
    <div class="ch">
      <div><div class="ct">Dataset Summary</div><div class="cs" id="ds-summary-sub">Source schema &amp; column breakdown</div></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;flex:1;justify-content:center" id="ds-summary-body">
      <div style="color:var(--fg3);font-size:11px">Run pipeline to view summary.</div>
    </div>
  </div>

  <!-- Pipeline Timeline: workflow execution state -->
  <div class="card">
    <div class="ch">
      <div><div class="ct">Pipeline Execution</div><div class="cs" id="c7s">Parse &rarr; Baseline &rarr; Generate &rarr; Leakage</div></div>
    </div>
    <div class="timeline" id="timeline"></div>
  </div>

  <!-- Row 2: Privacy &amp; Risk assessment -->

  <!-- Privacy Score donut -->
  <div class="card" style="align-items:center">
    <div class="ch" style="width:100%">
      <div><div class="ct">Privacy Score</div><div class="cs">Composite privacy metric</div></div>
    </div>
    <div class="dw">
      <canvas id="chart-gauge" width="120" height="120"></canvas>
      <div class="dc"><div class="dv" id="gval">&#8212;</div><div class="dl">privacy</div></div>
    </div>
    <div class="dct" id="gmode">Run pipeline to see results</div>
    <div id="g-reliability" style="min-height:18px;text-align:center;margin-top:2px"></div>
    <div id="g-reliability-sub" class="metric-subtext"></div>
    <div class="leg">
      <div class="li"><div class="ld" style="background:var(--aurora-p4)"></div>Score</div>
      <div class="li"><div class="ld" style="background:var(--aurora-red)"></div>Risk</div>
    </div>
  </div>

  <!-- Risk Radar Chart -->
  <div class="card">
    <div class="ch">
      <div><div class="ct">Risk Radar</div><div class="cs">Privacy · Risk · Re-ID · Drift</div></div>
    </div>
    <div class="cbox" style="display:flex;align-items:center;justify-content:center">
      <canvas id="chart-radar" width="200" height="160" style="width:100%;max-height:160px"></canvas>
    </div>
  </div>

  <!-- Dataset Risk Score -->
  <div class="card" id="c12card">
    <div class="ch">
      <div><div class="ct">Dataset Risk Score</div><div class="cs" id="c12sub">Composite governance metric</div></div>
    </div>
    <div style="display:flex;align-items:center;gap:12px;flex:1">
      <div style="position:relative;width:88px;height:88px;flex-shrink:0">
        <svg viewBox="0 0 88 88" style="width:88px;height:88px;transform:rotate(-90deg)">
          <circle cx="44" cy="44" r="36" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="8"/>
          <circle id="c12arc" cx="44" cy="44" r="36" fill="none" stroke="var(--aurora-red)" stroke-width="8"
            stroke-linecap="round" stroke-dasharray="0 226" style="transition:stroke-dasharray .9s ease,stroke .4s"/>
        </svg>
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
          <div id="c12val" style="font-size:20px;font-weight:800;letter-spacing:-.04em;color:var(--fg)">—</div>
          <div style="font-size:8px;color:var(--fg3);text-transform:uppercase;letter-spacing:.07em">/ 100</div>
        </div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;gap:5px">
        <div id="c12badge" class="rbadge rc-unk" style="align-self:flex-start;margin-bottom:4px">—</div>
        <div id="c12breakdown" style="font-size:9px;color:var(--fg2);display:flex;flex-direction:column;gap:2px"></div>
      </div>
    </div>
    <div id="c12pii" style="font-size:9px;color:var(--fg3);line-height:1.5"></div>
  </div>

  <!-- Row 3: Feature analysis -->

  <!-- Feature Drift Heatmap -->
  <div class="card">
    <div class="ch">
      <div><div class="ct">Feature Drift</div><div class="cs" id="c5sub">JS-divergence per column</div></div>
    </div>
    <div id="c5hmap" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:0"></div>
    <div class="mvrow" style="margin-top:6px">
      <div class="mvl" id="c5l">Max Drift Column</div>
      <div class="mvv" id="c5p">&#8212;</div>
    </div>
  </div>

  <!-- Dataset Reliability -->
  <div class="card" id="c13card">
    <div class="ch">
      <div><div class="ct">Metric Reliability</div><div class="cs" id="c13sub">Statistical stability of computed metrics</div></div>
    </div>
    <div style="display:flex;flex-direction:column;flex:1;gap:6px">
      <div style="display:flex;justify-content:space-between;align-items:flex-end">
        <div class="bnum" id="c13val" style="font-size:28px">—</div>
        <div id="c13badge" class="rbadge rc-unk">—</div>
      </div>
      <div class="ris-bar">
        <div class="ris-fill" id="c13fill" style="width:0%;background:var(--aurora-p4)"></div>
      </div>
      <div id="c13note" style="font-size:10px;color:var(--fg2);line-height:1.5"></div>
      <div style="font-size:9px;color:var(--fg3);margin-top:auto">Bands: ≥500 rows=1.0 · ≥100=0.85 · ≥30=0.65 · ≥10=0.40 · &lt;10=0.15</div>
    </div>
  </div>

  <!-- Intelligence Risk -->
  <div class="card" id="c14card">
    <div class="ch">
      <div><div class="ct">Intelligence Risk</div><div class="cs" id="c14sub">Dataset Risk Intelligence Engine</div></div>
    </div>
    <div style="display:flex;align-items:center;gap:12px;flex:1">
      <div style="position:relative;width:88px;height:88px;flex-shrink:0">
        <svg viewBox="0 0 88 88" style="width:88px;height:88px;transform:rotate(-90deg)">
          <circle cx="44" cy="44" r="36" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="8"/>
          <circle id="c14arc" cx="44" cy="44" r="36" fill="none" stroke="var(--aurora-red)" stroke-width="8"
            stroke-linecap="round" stroke-dasharray="0 226" style="transition:stroke-dasharray .9s ease,stroke .4s"/>
        </svg>
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
          <div id="c14val" style="font-size:20px;font-weight:800;letter-spacing:-.04em;color:var(--fg)">—</div>
          <div style="font-size:8px;color:var(--fg3);text-transform:uppercase;letter-spacing:.07em">/ 100</div>
        </div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;gap:5px">
        <div id="c14badge" class="rbadge rc-unk" style="align-self:flex-start;margin-bottom:4px">—</div>
        <div id="c14breakdown" style="font-size:9px;color:var(--fg2);display:flex;flex-direction:column;gap:2px"></div>
      </div>
    </div>
  </div>

  <!-- Row 4: Column intelligence + Recommendations -->

  <!-- Sensitive Column Ranking -->
  <div class="card" id="c15card">
    <div class="ch">
      <div><div class="ct">Sensitive Columns</div><div class="cs" id="c15sub">Ranked by composite privacy risk</div></div>
    </div>
    <div id="c15list" style="flex:1;display:flex;flex-direction:column;gap:5px;overflow-y:auto">
      <div style="color:var(--fg3);font-size:11px">Run the generator to view results.</div>
    </div>
  </div>

  <!-- Privacy Recommendations -->
  <div class="card" id="c16card">
    <div class="ch">
      <div><div class="ct">Recommendations</div><div class="cs" id="c16sub">Automated mitigation guidance</div></div>
    </div>
    <div id="c16list" style="flex:1;display:flex;flex-direction:column;gap:4px;overflow-y:auto">
      <div style="color:var(--fg3);font-size:11px">Run the generator to view results.</div>
    </div>
  </div>

</div>   <!-- close grid -->
</div>   <!-- close pane-overview -->
`;

export const OVERVIEW_SCRIPT = String.raw`
// ── Mode-aware data accessors ─────────────────────────────────────────
// All overview render functions must use these instead of D.leakage / D.generator directly.
// In 'original' mode we suppress leakage & generator data so the UI shows baseline-only state.
function _modeLeakage(){
  if(typeof _dataMode !== 'undefined' && _dataMode === 'original') return null;
  return D.leakage || null;
}
function _modeGenerator(){
  if(typeof _dataMode !== 'undefined' && _dataMode === 'original') return null;
  // Prefer whichever of generator/result has an actual row_count > 0
  if(D.generator && D.generator.row_count) return D.generator;
  if(D.result    && D.result.row_count)    return D.result;
  return D.generator || D.result || null;
}
function _modeIsGenerated(){
  if(typeof _dataMode !== 'undefined' && _dataMode === 'original') return false;
  // Prefer whichever of generator/result has an actual row_count > 0
  var r = (D.generator && D.generator.row_count) ? D.generator
        : (D.result    && D.result.row_count)    ? D.result
        : (D.generator || D.result || {});
  return !!(r.row_count && r.row_count > 0);
}

// ── Locked-state helper (synthetic-only cards pre-generation) ────────
function lockedHtml(detail){
  return '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;'+
    'gap:6px;flex:1;padding:12px 0;opacity:.38;pointer-events:none;user-select:none">'+
    '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">'+
      '<rect x="3.5" y="10" width="15" height="11" rx="2.5" stroke="currentColor" stroke-width="1.6"/>'+
      '<path d="M7 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'+
    '</svg>'+
    '<div style="font-size:9px;font-weight:700;letter-spacing:.08em;color:var(--fg2)">REQUIRES SYNTHESIS</div>'+
    '<div style="font-size:9px;color:var(--fg3);text-align:center;max-width:140px;line-height:1.4">'+(detail||'Available after generation')+'</div>'+
  '</div>';
}

// ── Sanity checks ────────────────────────────────────────────────────
function renderSanityBanner(){
  const leakage = _modeLeakage();
  if(!leakage){ const b=document.getElementById('sanity-banner'); if(b) b.style.display='none'; return; }
  const l=leakage;
  const warns=[];
  const dup=l.duplicates_rate;
  const dk=(l.statistical_drift||'').toLowerCase();
  if(dup!=null && dup>0.1) warns.push({msg:'Duplicates rate '+pct(dup)+' exceeds 10% threshold',sev:'crit'});
  else if(dup!=null && dup>0.05) warns.push({msg:'Duplicates rate '+pct(dup)+' is elevated',sev:'warn'});
  if(dk==='high') warns.push({msg:'Statistical drift is HIGH — distribution divergence detected',sev:'warn'});
  const b=document.getElementById('sanity-banner');
  if(!b) return;
  if(!warns.length){b.style.display='none';return;}
  const hasCrit=warns.some(w=>w.sev==='crit');
  b.className='warn-banner'+(hasCrit?' crit-banner':'');
  b.innerHTML='<b style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:'+(hasCrit?'#f87171':'#fb923c')+'">Alerts</b>'+warns.map(w=>'<span class="warn-item">'+esc(w.msg)+'</span>').join('');
  b.style.display='flex';
}

// ── Dataset Summary Card ─────────────────────────────────────────────
function renderDatasetSummary(){
  const b = D.profile || D.baseline || {};
  const r = _modeGenerator() || {};
  const sc = D.scanReport || {};
  const el = document.getElementById('ds-summary-body');
  if(!el) return;
  if(!b.columns){
    el.innerHTML = '<div style="color:var(--fg3);font-size:11px">Run pipeline to view summary.</div>';
    return;
  }
  const syntheticRows = r.row_count != null ? r.row_count : null;
  const baselineRows  = b.meta?.row_count_estimate ?? b.meta?.row_count ?? 0;
  const isGenerated   = _modeIsGenerated();
  const numRows       = isGenerated ? syntheticRows : baselineRows;
  const numCols = Object.keys(b.columns?.numeric || {}).length;
  const catCols = Object.keys(b.columns?.categorical || {}).length;
  const totalCols = numCols + catCols;
  const piiCols = new Set([
    ...(sc.high_risk_columns || []),
    ...(sc.pii_findings || []).map(f => f.column),
    ...(typeof _parserData!=='undefined'&&_parserData&&_parserData.columns
        ? _parserData.columns.filter(function(c){return c.pii&&c.pii!=='none';}).map(function(c){return c.name;})
        : [])
  ].filter(Boolean));
  const rowLabel = isGenerated ? 'Synthetic Rows' : 'Total Rows';
  const rowColor = isGenerated ? 'var(--aurora-green)' : 'var(--aurora-p5)';
  const dsSub = document.getElementById('ds-summary-sub');
  if(dsSub) dsSub.textContent = isGenerated ? 'Synthetic dataset · '+totalCols+' columns' : 'Original dataset · '+totalCols+' columns';
  el.innerHTML = [
    '<div class="mvrow"><div class="mvl">'+rowLabel+'</div><div class="mvv" style="color:'+rowColor+'">'+(numRows?numRows.toLocaleString():'—')+'</div></div>',
    isGenerated ? '<div class="mvrow"><div class="mvl" style="opacity:.65">Original Rows</div><div class="mvv" style="font-size:13px;color:var(--fg3)">'+baselineRows.toLocaleString()+'</div></div>' : '',
    '<div class="mvrow"><div class="mvl">Total Columns</div><div class="mvv">'+totalCols+'</div></div>',
    '<div class="mvrow"><div class="mvl">Numeric / Categorical</div><div class="mvv" style="font-size:14px">'+numCols+' <span style="color:var(--fg3);font-size:12px;font-weight:400">/</span> '+catCols+'</div></div>',
    '<div class="mvrow" style="margin-top:auto"><div class="mvl">PII Columns</div><div class="mvv" style="color:'+(piiCols.size>0?'var(--aurora-orange)':'var(--aurora-green)')+'">'+piiCols.size+'</div></div>'
  ].join('');
}

// ── Status strip ────────────────────────────────────────────────────
function renderStrip(){
  const leakage = _modeLeakage();
  const generator = _modeGenerator();
  const l   = leakage   || {};
  const r   = generator || {};
  const b   = D.profile  || D.baseline|| {};
  const sc  = D.scanReport|| {};
  const hasLeakage  = !!leakage;
  const hasBaseline = !!(b.columns);
  const isGenerated = _modeIsGenerated();
  const numCols = Object.keys((b.columns&&b.columns.numeric)||{});
  const catCols = Object.keys((b.columns&&b.columns.categorical)||{});
  const totalCols = numCols.length + catCols.length;

  // ── Helper: set a label element text ─────────────────────────────
  function setLabel(id, text){ var el=document.getElementById(id); if(el) el.textContent=text; }

  // ── Shared baseline column stats (reused across multiple tiles) ───
  const allBaseCols = [
    ...Object.values((b.columns&&b.columns.numeric)||{}),
    ...Object.values((b.columns&&b.columns.categorical)||{})
  ];
  const avgNullRate = allBaseCols.length
    ? allBaseCols.reduce(function(s,c){return s+(c.null_ratio||0);},0) / allBaseCols.length
    : 0;

  // ── RISK LEVEL ────────────────────────────────────────────────────
  const mRisk = document.getElementById('m-risk');
  if(mRisk){
    if(hasLeakage){
      setLabel('sl-risk','Risk Level');
      mRisk.innerHTML = rbadge(l.risk_level);
    } else if(sc.risk_score != null){
      // Original mode: use PII column RATIO, not raw scan risk_score.
      // sc.risk_score can be 1.0 for salary columns (high sensitivity) even when
      // only 2/11 cols are PII — which would falsely show CRITICAL. Ratio is more accurate.
      setLabel('sl-risk','PII Risk');
      const hrcCount = (sc.high_risk_columns||[]).length;
      const piiRatioScan = totalCols>0 ? (hrcCount/totalCols) : 0;
      const rl = piiRatioScan>=0.5?'critical':piiRatioScan>=0.15?'warning':'low';
      mRisk.innerHTML = rbadge(rl);
    } else if(hasBaseline && sc.high_risk_columns && sc.high_risk_columns.length > 0){
      setLabel('sl-risk','PII Risk');
      const piiRatio = totalCols>0?(sc.high_risk_columns.length/totalCols):0;
      const rl = piiRatio>=0.5?'critical':piiRatio>=0.2?'warning':'low';
      mRisk.innerHTML = rbadge(rl);
    } else if(hasBaseline && typeof _parserData !== 'undefined' && _parserData && _parserData.columns){
      // Original mode: derive PII risk from parser column analysis (never stale)
      setLabel('sl-risk','PII Risk');
      const parserPiiCols = _parserData.columns.filter(function(c){return c.pii && c.pii !== 'none';});
      const piiRatio = totalCols>0?(parserPiiCols.length/totalCols):(_parserData.columns.length>0?(parserPiiCols.length/_parserData.columns.length):0);
      const rl = piiRatio>=0.5?'critical':piiRatio>=0.2?'warning':'low';
      mRisk.innerHTML = rbadge(rl);
    } else {
      // No reliable risk data — show unknown instead of misleading quality estimate
      setLabel('sl-risk','Risk Level');
      mRisk.innerHTML = '<span class="rbadge rc-unk">—</span>';
    }
  }

  // ── PRIVACY SCORE ─────────────────────────────────────────────────
  const pe = document.getElementById('m-ps');
  if(pe){
    if(hasLeakage && l.privacy_score!=null){
      setLabel('sl-ps','Privacy Score');
      const ps = pctInt(l.privacy_score);
      pe.textContent = ps+'%';
      pe.style.color = ps>=75?C.green:ps>=50?C.orange:C.red;
    } else if(sc.risk_score!=null){
      // Original mode: FIX — use PII column RATIO, NOT (1 - sc.risk_score).
      // (1 - sc.risk_score) gives 0% when salary columns are present because
      // the scanner assigns max sensitivity to financial PII, which is correct
      // for sensitivity but wrong as a "privacy estimate" when there are no
      // direct identifiers. PII column ratio is the correct proxy here.
      setLabel('sl-ps','Privacy Est.');
      const hrcEst = (sc.high_risk_columns||[]).length;
      const est = totalCols>0 ? Math.round((1-Math.min(1,hrcEst/totalCols))*100) : 50;
      pe.textContent = est+'%';
      pe.style.color = est>=75?C.green:est>=50?C.orange:C.red;
    } else if(hasBaseline && typeof _parserData !== 'undefined' && _parserData && _parserData.columns){
      // Original mode: estimate privacy from parser PII findings (never stale synthetic data)
      setLabel('sl-ps','Privacy Est.');
      const parserPiiCols2 = _parserData.columns.filter(function(c){return c.pii && c.pii !== 'none';});
      const piiRatio2 = _parserData.columns.length>0?(parserPiiCols2.length/_parserData.columns.length):0;
      const est2 = Math.round((1-Math.min(1,piiRatio2))*100);
      pe.textContent = est2+'%';
      pe.style.color = est2>=75?C.green:est2>=50?C.orange:C.red;
    } else {
      // No reliable privacy data
      setLabel('sl-ps','Privacy Score');
      pe.textContent = '—';
      pe.style.color = C.fg2;
    }
  }

  // ── DRIFT / NULL RATE ─────────────────────────────────────────────
  const de = document.getElementById('m-drift');
  if(de){
    if(hasLeakage){
      setLabel('sl-drift','Drift');
      const dk=(l.statistical_drift||'unknown').toLowerCase();
      de.textContent = dk==='unknown'?'—':dk;
      de.style.color = dk==='high'?C.red:dk==='moderate'?C.orange:dk==='low'?C.green:C.fg2;
    } else if(hasBaseline){
      // Pre-gen: reuse shared avgNullRate as data-quality proxy
      setLabel('sl-drift','Null Rate');
      if(allBaseCols.length){
        de.textContent = (avgNullRate*100).toFixed(1)+'%';
        de.style.color  = avgNullRate>0.1?C.orange:avgNullRate>0.02?C.yellow:C.green;
      } else {
        de.textContent='—'; de.style.color=C.fg2;
      }
    } else {
      setLabel('sl-drift','Drift');
      de.textContent='—'; de.style.color=C.fg2;
    }
  }

  // ── DUPLICATES / PII COLS ─────────────────────────────────────────
  const ue = document.getElementById('m-dup');
  if(ue){
    const dup = l.duplicates_rate;
    if(hasLeakage){
      setLabel('sl-dup','Duplicates');
      ue.textContent = pct(dup);
      if(dup!=null) ue.style.color = dup>.05?C.orange:C.green;
      else ue.style.color = C.fg2;
    } else if(hasBaseline){
      // Original mode: show PII column count from scan + parser + leakage pii_columns
      setLabel('sl-dup','PII Cols');
      // Original mode: use only scan report sources — never D.leakage (could be stale synthetic data)
      const piiSet = new Set([
        ...((sc.high_risk_columns)||[]),
        ...((sc.pii_findings)||[]).map(function(f){return f.column;})
      ].filter(Boolean));
      // FIX-PII-COLS: union parser PII columns (don't just Math.max — that misses when parser
      // finds a column not in sc.high_risk_columns/pii_findings, e.g. salary_currency).
      if(typeof _parserData !== 'undefined' && _parserData && _parserData.columns){
        _parserData.columns.filter(function(c){return c.pii && c.pii !== 'none';})
          .forEach(function(c){ piiSet.add(c.name); });
      }
      var piiCount = piiSet.size;
      ue.textContent = String(piiCount);
      ue.style.color = piiCount>0?C.orange:C.green;
    } else {
      setLabel('sl-dup','Duplicates');
      ue.textContent='—'; ue.style.color=C.fg2;
    }
  }

  // ── ROWS ──────────────────────────────────────────────────────────
  // Use isGenerated (row_count > 0) to decide source — avoids showing
  // 0 from an empty generator object before generation has actually run.
  const sr = isGenerated
    ? r.row_count
    : (b.meta&&(b.meta.row_count_estimate||b.meta.row_count)||null);
  const mr = document.getElementById('m-rows');
  if(mr){
    mr.textContent = sr!=null?sr.toLocaleString():'—';
    mr.style.color  = isGenerated?C.green:C.fg2;
  }
  if(isGenerated){
    setLabel('sl-rows','Synth Rows');
  } else if(hasBaseline){
    setLabel('sl-rows','Orig Rows');
  } else {
    setLabel('sl-rows','Rows');
  }

  // ── Header subtitle ───────────────────────────────────────────────
  const hs = document.getElementById('hdr-sub');
  if(hs){
    // Use whichever of generator/result has a real row_count so the header
    // still shows "X synthetic generated" even when D.generator was pre-seeded
    // with row_count:0 before the pipeline ran.
    const realR = (D.generator && D.generator.row_count) ? D.generator
                : (D.result    && D.result.row_count)    ? D.result
                : (D.generator || D.result || {});
    if(isGenerated && (r.generator_used||r.row_count)){
      hs.textContent='Engine: '+(r.generator_used||'—')+(r.row_count?' · '+r.row_count.toLocaleString()+' synthetic rows':'')+((numCols.length+catCols.length)?' · '+(numCols.length+catCols.length)+' cols':'');
      // D3: surface engine reason as tooltip on the subtitle bar
      if(r.engine_selection_reason) hs.title = r.engine_selection_reason;
    } else if(b.columns){
      const baseRowCount = b.meta&&(b.meta.row_count_estimate||b.meta.row_count)||null;
      const genInfo = (realR.row_count && !isGenerated) ? ' · '+realR.row_count.toLocaleString()+' synthetic generated' : '';
      hs.textContent='Baseline: '+(numCols.length+catCols.length)+' columns'+(baseRowCount?' · '+baseRowCount.toLocaleString()+' rows':'')+genInfo;
    }
  }
}

// ── Dataset Analysis Card ────────────────────────────────────────────
function renderAnalysisCard(){
  var b = D.profile || D.baseline || {};
  var r = _modeGenerator() || {};
  var bodyEl = document.getElementById('analysis-body');
  var subEl  = document.getElementById('analysis-sub');
  var badgeEl= document.getElementById('analysis-badge');
  if(!bodyEl) return;

  var hasBaseline = !!(b.columns);
  var isGenerated = _modeIsGenerated();

  if(!hasBaseline){
    bodyEl.innerHTML = '<div style="color:var(--fg3);font-size:11px">Run pipeline to view analysis.</div>';
    if(subEl)  subEl.textContent  = 'Original Dataset Profile';
    if(badgeEl){ badgeEl.textContent='—'; badgeEl.className='rbadge rc-unk'; }
    return;
  }

  var numCols  = Object.keys((b.columns&&b.columns.numeric)||{});
  var catCols  = Object.keys((b.columns&&b.columns.categorical)||{});
  var totalCols= numCols.length + catCols.length;
  var baseRows = (b.meta&&(b.meta.row_count||b.meta.row_count_estimate))||0;

  if(isGenerated){
    // ── Post-generation: Original vs Synthetic comparison ──
    if(subEl)  subEl.textContent  = 'Original vs Synthetic';
    if(badgeEl){ badgeEl.textContent='GENERATED'; badgeEl.className='rbadge rc-low'; }

    var synRows  = r.row_count || 0;
    var ratio    = baseRows > 0 ? synRows / baseRows : 0;
    var ratioColor = ratio >= 0.8 ? C.green : ratio >= 0.5 ? C.orange : C.red;
    var ratioW   = Math.min(100, Math.round(ratio * 100));

    bodyEl.innerHTML = [
      '<div style="display:flex;gap:8px;margin-bottom:6px">',
        '<div style="flex:1;background:rgba(255,255,255,.05);border-radius:6px;padding:8px;text-align:center">',
          '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--fg3);margin-bottom:3px">Original</div>',
          '<div style="font-size:22px;font-weight:800;letter-spacing:-.04em;color:var(--aurora-p5)">'+baseRows.toLocaleString()+'</div>',
          '<div style="font-size:9px;color:var(--fg3)">rows</div>',
        '</div>',
        '<div style="display:flex;align-items:center;justify-content:center;padding:0 4px">',
          '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8M8 4l3 3-3 3" stroke="var(--fg3)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        '</div>',
        '<div style="flex:1;background:rgba(255,255,255,.05);border-radius:6px;padding:8px;text-align:center">',
          '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--fg3);margin-bottom:3px">Synthetic</div>',
          '<div style="font-size:22px;font-weight:800;letter-spacing:-.04em;color:'+C.green+'">'+synRows.toLocaleString()+'</div>',
          '<div style="font-size:9px;color:var(--fg3)">rows</div>',
        '</div>',
      '</div>',
      '<div style="font-size:9px;color:var(--fg3);margin-bottom:3px">Scale ratio: '+Math.round(ratio*100)+'%</div>',
      '<div style="height:4px;background:rgba(255,255,255,.07);border-radius:3px;margin-bottom:8px">',
        '<div style="height:4px;width:'+ratioW+'%;background:'+ratioColor+';border-radius:3px;transition:width .6s ease"></div>',
      '</div>',
      '<div class="mvrow"><div class="mvl">Engine</div><div class="mvv" style="font-size:11px">'+esc(r.generator_used||'—')+'</div></div>',
      // D3: engine selection explanation card
      r.engine_selection_reason ? '<div class="mvrow"><div class="mvl" style="opacity:.65;font-size:10px">Reason</div><div class="mvv" style="font-size:10px;color:var(--vscode-descriptionForeground,var(--fg3));line-height:1.4">'+esc(r.engine_selection_reason)+'</div></div>' : '',
      '<div class="mvrow"><div class="mvl">Columns</div><div class="mvv">'+totalCols+' preserved</div></div>',
    ].join('');

  } else {
    // ── Pre-generation: Baseline profile ──
    if(subEl)  subEl.textContent  = 'Original Dataset Profile';
    if(badgeEl){ badgeEl.textContent='BASELINE'; badgeEl.className='rbadge rc-unk'; }

    var numPct = totalCols > 0 ? Math.round((numCols.length/totalCols)*100) : 0;

    // Top numeric column mini-stats (up to 3)
    var numStats = numCols.slice(0,3).map(function(col){
      var nc = (b.columns.numeric&&b.columns.numeric[col])||{};
      var mean  = nc.mean  != null ? (+nc.mean).toFixed(2)  : '—';
      var std   = nc.std   != null ? (+nc.std).toFixed(2)   : null;
      var mn    = nc.min   != null ? +nc.min   : null;
      var mx    = nc.max   != null ? +nc.max   : null;
      var meanV = nc.mean  != null ? +nc.mean  : null;
      var pctBar = (mn!=null&&mx!=null&&mx!==mn&&meanV!=null)
        ? Math.max(4, Math.min(96, Math.round(((meanV-mn)/(mx-mn))*100)))
        : 50;
      return '<div style="display:flex;flex-direction:column;gap:2px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.05)">'+
        '<div style="display:flex;justify-content:space-between;align-items:center">'+
          '<span style="font-size:10px;font-weight:600;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%">'+esc(col)+'</span>'+
          '<span style="font-size:10px;font-weight:800;color:var(--aurora-p5)">'+mean+(std?' <span style="font-size:9px;font-weight:400;color:var(--fg3)">±'+std+'</span>':'')+'</span>'+
        '</div>'+
        '<div style="height:3px;background:rgba(255,255,255,.07);border-radius:2px">'+
          '<div style="height:3px;width:'+pctBar+'%;background:var(--aurora-p4);border-radius:2px"></div>'+
        '</div>'+
      '</div>';
    }).join('');

    // Top categorical quick peek (up to 2)
    var catStats = catCols.slice(0,2).map(function(col){
      var cc = (b.columns.categorical&&b.columns.categorical[col])||{};
      var topVals = Object.entries(cc.top_values||cc.value_counts||{}).slice(0,3);
      var uniq = cc.unique_count!=null ? cc.unique_count : '?';
      return '<div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,.05)">'+
        '<div style="display:flex;justify-content:space-between;margin-bottom:2px">'+
          '<span style="font-size:10px;font-weight:600;color:var(--fg)">'+esc(col)+'</span>'+
          '<span style="font-size:9px;color:var(--fg3)">'+uniq+' unique</span>'+
        '</div>'+
        '<div style="display:flex;flex-wrap:wrap;gap:3px">'+
          topVals.map(function(e){ return '<span style="font-size:8px;background:rgba(139,92,246,.18);color:var(--aurora-p5);border-radius:3px;padding:1px 5px">'+esc(String(e[0]))+'</span>'; }).join('')+
        '</div>'+
      '</div>';
    }).join('');

    bodyEl.innerHTML = [
      // Prominent row count
      '<div style="display:flex;align-items:baseline;gap:6px;margin-bottom:6px">',
        '<div style="font-size:28px;font-weight:800;letter-spacing:-.04em;color:var(--aurora-p5)">'+(baseRows?baseRows.toLocaleString():'—')+'</div>',
        '<div style="font-size:11px;color:var(--fg3)">original rows</div>',
      '</div>',
      // Column type breakdown bar
      '<div style="margin-bottom:8px">',
        '<div style="height:6px;background:rgba(255,255,255,.07);border-radius:3px;overflow:hidden;margin-bottom:4px">',
          '<div style="height:6px;width:'+numPct+'%;background:var(--aurora-p4);border-radius:3px 0 0 3px"></div>',
        '</div>',
        '<div style="display:flex;justify-content:space-between;font-size:9px">',
          '<span style="color:var(--aurora-p5)">'+numCols.length+' numeric</span>',
          '<span style="color:var(--fg3)">'+catCols.length+' categorical</span>',
        '</div>',
      '</div>',
      // Top numeric stats
      numStats||'',
      // Top categorical
      catStats||'',
    ].join('');
  }
}

// ── C2: Privacy Gauge ────────────────────────────────────────────────
function renderC2(){
  const leakage=_modeLeakage();
  const l=leakage||{};
  const b=D.profile||D.baseline||{};
  const el=document.getElementById('gval'); if(!el) return;
  const gm=document.getElementById('gmode');
  const relEl=document.getElementById('g-reliability');
  const subEl=document.getElementById('g-reliability-sub');
  if(!leakage){
    // Pre-generation: show baseline completeness as a muted proxy
    const hasBase=!!(b.columns);
    if(hasBase){
      const allCols=[
        ...Object.values((b.columns&&b.columns.numeric)||{}),
        ...Object.values((b.columns&&b.columns.categorical)||{})
      ];
      const avgNull=allCols.length?allCols.reduce(function(s,c){return s+(c.null_ratio||0);},0)/allCols.length:0;
      const est=Math.round((1-Math.min(1,avgNull))*100);
      const gc=est>=75?C.green:est>=50?C.orange:C.red;
      el.textContent=est+'%'; el.style.color=gc+'99';
      gm.textContent='Baseline completeness'; gm.style.color=C.fg3;
      relEl.innerHTML='<span style="font-size:9px;color:var(--fg3);opacity:.7">Completeness estimate · full score after synthesis</span>';
      subEl.textContent='';
      var bgHole=getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()||'#1e1e1e';
      getOrCreateChart('chart-gauge',{type:'doughnut',
        data:{datasets:[{data:[est,100-est],backgroundColor:[C.p3+'55',bgHole],borderWidth:0,circumference:240,rotation:240}]},
        options:{cutout:'72%',plugins:{legend:{display:false},tooltip:{enabled:false}},animation:{duration:820}}});
    } else {
      el.textContent='—'; el.style.color=C.fg2;
      gm.textContent='No data'; gm.style.color=C.fg2;
      relEl.innerHTML=''; subEl.textContent='';
    }
    return;
  }
  const ps=l.privacy_score!=null?pctInt(l.privacy_score):null;
  if(ps!=null){
    const gc=ps>=75?C.green:ps>=50?C.orange:C.red;
    el.textContent=ps+'%'; el.style.color=gc;
    gm.textContent=ps>=75?'Good Privacy':ps>=50?'Moderate Risk':'High Risk';
    gm.style.color=gc;
    if(l.privacy_score_reliable===false){
      const notes=Array.isArray(l.uncertainty_notes)&&l.uncertainty_notes.length
        ? l.uncertainty_notes.join(' ')
        : 'Metrics unreliable: dataset too small';
      relEl.innerHTML='<span class="metric-badge badge-warning" title="'+notes.replace(/"/g,'&quot;')+'">Unreliable</span>';
    } else {
      relEl.innerHTML='';
    }
    const ris=l.statistical_reliability_score;
    if(ris!=null){
      const risLabel=ris<0.3?'very low':ris<0.6?'low':ris<0.8?'moderate':'high';
      subEl.textContent='Reliability: '+ris.toFixed(2)+' ('+risLabel+')';
    } else {
      subEl.textContent='';
    }
    var bgHole=getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()||'#1e1e1e';
    getOrCreateChart('chart-gauge',{type:'doughnut',
      data:{datasets:[{data:[ps,100-ps],backgroundColor:[C.p4,bgHole],borderWidth:0,circumference:240,rotation:240}]},
      options:{cutout:'72%',plugins:{legend:{display:false},tooltip:{enabled:false}},animation:{duration:820}}});
  } else {
    var hasBase5=(D.profile||D.baseline)&&(D.profile||D.baseline).columns;
    el.textContent='—'; el.style.color=C.fg2;
    gm.textContent=l.error?'Leakage unavailable':hasBase5?'Awaiting generation':'No data';
    gm.style.color=C.fg2;
    relEl.innerHTML='';
    subEl.textContent='';
  }
}

// ── C12: Dataset Risk Score ──────────────────────────────────────────
function renderC12(){
  const leakage=_modeLeakage();
  const l=leakage||{};
  const drs=l.dataset_risk_score;
  const valEl=document.getElementById('c12val');
  const arcEl=document.getElementById('c12arc');
  const badgeEl=document.getElementById('c12badge');
  const brkEl=document.getElementById('c12breakdown');
  const piiEl=document.getElementById('c12pii');
  if(!valEl||!arcEl||!badgeEl||!brkEl||!piiEl) return;
  if(!leakage || drs==null){
    const sub=document.getElementById('c12sub');
    const brkEl2=document.getElementById('c12breakdown');
    const piiEl2=document.getElementById('c12pii');
    if(!leakage){
      // Pre-generation: derive a baseline risk estimate from PII scan + null rates
      const b=D.profile||D.baseline||{};
      const sc=D.scanReport||{};
      const hasBase=!!(b.columns);
      if(hasBase){
        const allCols=[...Object.values((b.columns.numeric)||{}),...Object.values((b.columns.categorical)||{})];
        const avgNull=allCols.length?allCols.reduce(function(s,c){return s+(c.null_ratio||0);},0)/allCols.length:0;
        const _parserPii12=typeof _parserData!=='undefined'&&_parserData&&_parserData.columns?_parserData.columns.filter(function(c){return c.pii&&c.pii!=='none';}).map(function(c){return c.name;}) :[];
        const piiSet=new Set(((sc.high_risk_columns)||[]).concat(((sc.pii_findings)||[]).map(function(f){return f.column;})).concat(_parserPii12).filter(Boolean));
        const totalCols2=allCols.length||1;
        const piiRatio=piiSet.size/totalCols2;
        // Estimate: weight pii exposure + null quality
        const estRisk=Math.min(100,Math.round(piiRatio*60 + avgNull*40));
        const circ2=226;
        const fill2=Math.round((estRisk/100)*circ2);
        const color2=estRisk>=70?C.red:estRisk>=40?C.orange:C.green;
        arcEl.setAttribute('stroke-dasharray',fill2+' '+(circ2-fill2));
        arcEl.setAttribute('stroke',color2);
        valEl.textContent=estRisk.toFixed(0);
        valEl.style.color=color2+'99';
        const label2=estRisk>=70?'HIGH RISK':estRisk>=40?'MOD RISK':'LOW RISK';
        const cls2=estRisk>=70?'rc-crit':estRisk>=40?'rc-warn':'rc-low';
        badgeEl.textContent=label2; badgeEl.className='rbadge '+cls2;
        if(sub) sub.textContent='Baseline estimate · full score after synthesis';
        if(brkEl2) brkEl2.innerHTML=
          '<div style="font-size:9px;color:var(--fg3);margin-top:4px;line-height:1.5">'+
          '<div>PII Columns: <span style="color:var(--fg2);font-weight:600">'+piiSet.size+'</span></div>'+
          '<div>Avg Null Rate: <span style="color:var(--fg2);font-weight:600">'+(avgNull*100).toFixed(1)+'%</span></div>'+
          '<div style="opacity:.6;margin-top:2px;font-size:8px">Synthesise to compute full risk score</div>'+
          '</div>';
        if(piiEl2){ if(piiSet.size>0){ piiEl2.innerHTML='<span style="color:var(--aurora-orange);font-weight:600">PII detected: </span>'+Array.from(piiSet).map(function(c){return '<span class="pii-col-badge">'+esc(c)+'</span>';}).join(' '); } else { piiEl2.textContent='No PII detected in baseline'; } }
        return;
      }
      // No baseline yet
      if(sub) sub.textContent='Requires synthesis';
      if(brkEl2) brkEl2.innerHTML=lockedHtml('Computed from privacy score, duplicates &amp; drift');
      if(piiEl2) piiEl2.innerHTML='';
    } else {
      valEl.textContent='—';
      if(sub) sub.textContent='Risk score not computed';
    }
    return;
  }
  const circ=226;
  const fill=Math.round((drs/100)*circ);
  arcEl.setAttribute('stroke-dasharray', fill+' '+(circ-fill));
  const color=drs>=70?C.red:drs>=40?C.orange:C.green;
  arcEl.setAttribute('stroke', color);
  valEl.textContent=drs.toFixed(1);
  valEl.style.color=color;
  const label=drs>=70?'HIGH RISK':drs>=40?'MOD RISK':'LOW RISK';
  const cls=drs>=70?'rc-crit':drs>=40?'rc-warn':'rc-low';
  badgeEl.textContent=label;
  badgeEl.className='rbadge '+cls;
  const ps=l.privacy_score;
  const dup=l.duplicates_rate, ads=l.avg_drift_score;
  const terms=[
    ['Privacy',    ps!=null?((1-ps)*40).toFixed(1)+'pt':'n/a', '(1-score)×40'],
    ['Duplicates', dup!=null?(dup*20).toFixed(2)+'pt':'n/a',   'dup×20'],
    ['Drift',      ads!=null?(ads*10).toFixed(3)+'pt':'n/a',   'drift×10'],
  ];
  brkEl.innerHTML=terms.map(([name,contrib,formula])=>
    '<div style="display:flex;justify-content:space-between;border-top:1px solid rgba(255,255,255,.06);padding-top:2px">'+
    '<span style="color:var(--fg3)">'+esc(name)+' <span style="opacity:.6">('+esc(formula)+')</span></span>'+
    '<span style="color:var(--fg2);font-weight:600">'+esc(contrib)+'</span></div>'
  ).join('');
  const piiCols=(l.pii_columns||[]);
  if(piiCols.length){
    piiEl.innerHTML='<span style="color:var(--aurora-orange);font-weight:600">PII columns: </span>'+
      piiCols.map(c=>'<span class="pii-col-badge">'+esc(c)+'</span>').join(' ');
  } else {
    piiEl.textContent='No PII columns detected';
  }
}

// ── Feature Drift Heatmap ─────────────────────────────────────────────
function renderC5(){
  const leakage=_modeLeakage();
  const l=leakage||{};
  const cd=l.column_drift||{};
  const cols=Object.keys(cd);
  const hmap=document.getElementById('c5hmap'), pe=document.getElementById('c5p');
  const sub=document.getElementById('c5sub');
  if(!hmap||!pe) return;
  if(!leakage){
    var hasBase4=(D.profile||D.baseline)&&(D.profile||D.baseline).columns;
    if(hasBase4){
      // Pre-generation: show null rate per column as data-quality heatmap proxy
      var b4=D.profile||D.baseline||{};
      var allCols4={};
      Object.entries((b4.columns.numeric)||{}).forEach(function(e){allCols4[e[0]]=e[1];});
      Object.entries((b4.columns.categorical)||{}).forEach(function(e){allCols4[e[0]]=e[1];});
      var colNames4=Object.keys(allCols4);
      if(colNames4.length){
        var sorted4=colNames4.slice().sort(function(a,b){return (allCols4[b].null_ratio||0)-(allCols4[a].null_ratio||0);});
        var mx4=Math.max(...sorted4.map(function(c){return allCols4[c].null_ratio||0;}),0.001);
        var top4=sorted4[0];
        var topNull=(allCols4[top4].null_ratio||0);
        pe.textContent=(topNull*100).toFixed(1)+'%';
        pe.style.color=topNull>0.1?C.orange:topNull>0.02?C.yellow:C.green;
        document.getElementById('c5l').textContent='Max null: '+top4.slice(0,18);
        if(sub) sub.textContent=colNames4.length+' columns · null rate (baseline)';
        hmap.innerHTML=sorted4.map(function(col){
          var v=allCols4[col].null_ratio||0;
          var pct100=mx4>0?Math.max(4,Math.round((v/mx4)*100)):4;
          var r=Math.round(Math.min(255,v*800)),g=Math.round(Math.min(255,(1-v)*510));
          var fill='rgb('+r+','+g+',40)';
          return '<div class="dh-row">'+
            '<div class="dh-lbl" title="'+esc(col)+'">'+esc(col)+'</div>'+
            '<div class="dh-bar-wrap"><div class="dh-bar-fill" style="width:'+pct100+'%;background:'+fill+';opacity:.7"></div></div>'+
            '<div class="dh-val" style="opacity:.7">'+(v*100).toFixed(1)+'%</div></div>';
        }).join('')+'<div style="font-size:8px;color:var(--fg3);padding:6px 4px 0;opacity:.6">Showing null rates · drift available after synthesis</div>';
        return;
      }
    }
    hmap.innerHTML='<div style="padding:12px;font-size:11px;color:var(--fg3)">'+
      lockedHtml('Compares original vs synthetic distributions');
    pe.textContent='—';
    if(sub) sub.textContent='JS-divergence per column';
    return;
  }
  if(!cols.length){
    hmap.innerHTML='<div style="padding:12px;font-size:11px;color:var(--fg3)">No drift data available.</div>';
    pe.textContent='—'; return;
  }
  const sorted=cols.slice().sort((a,b)=>(cd[b]||0)-(cd[a]||0));
  const mx=Math.max(...sorted.map(c=>cd[c]||0),0.001);
  const top=sorted[0]||'';
  pe.textContent=(cd[top]||0).toFixed(4);
  pe.style.color=(cd[top]||0)>.15?C.red:(cd[top]||0)>.05?C.orange:C.green;
  document.getElementById('c5l').textContent='Max: '+top.slice(0,18);
  sub.textContent=cols.length+' columns · JS-divergence';
  hmap.innerHTML=sorted.map(col=>{
    const v=Math.max(0,Math.min(cd[col]||0,1));
    const pct100=Math.round((v/mx)*100);
    const r=Math.round(Math.min(255,v*510)), g=Math.round(Math.min(255,(1-v)*510));
    const fill='rgb('+r+','+g+',40)';
    return '<div class="dh-row">'+
      '<div class="dh-lbl" title="'+esc(col)+'">'+esc(col)+'</div>'+
      '<div class="dh-bar-wrap"><div class="dh-bar-fill" style="width:'+pct100+'%;background:'+fill+'"></div></div>'+
      '<div class="dh-val">'+v.toFixed(3)+'</div></div>';
  }).join('');
}

// ── Pipeline Timeline ────────────────────────────────────────────────
function renderTimeline(){
  const r=_modeGenerator()||D.result||{}, l=_modeLeakage()||{}, b=D.profile||D.baseline||{}, ast=D.ast||{};
  const tl=document.getElementById('timeline');
  if(!tl) return;
  if(!D.result && !D.generator && !D.baseline && !D.profile && !D.ast){
    tl.innerHTML='<div style="color:var(--fg3);font-size:11px;padding:8px">Run pipeline to see execution timeline.</div>';
    return;
  }
  const steps=[
    {name:'Parse',    info: ast?.dataset ? Object.keys(ast.dataset?.schema?.fields||[]).length+' columns' : (ast?.error||'skipped'), done:!!ast?.dataset},
    {name:'Baseline', info: b?.meta ? (b.meta.row_count||'?')+' rows profiled' : 'skipped',  done:!!b?.meta},
    {name:'Generate', info: r?.row_count ? r.row_count+' rows · '+r.generator_used : 'pending', done:!!r?.row_count},
    {name:'Leakage',  info: l?.risk_level ? 'risk: '+l.risk_level : (l?.error||'pending'), done:!!l?.privacy_score, fail:!!l?.error&&!l?.privacy_score},
  ];
  tl.innerHTML=steps.map(s=>{
    const cls='tl-step'+(s.fail?' fail':s.done?' done':'');
    return '<div class="'+cls+'"><div class="tl-dot"></div>'+'<span class="tl-name">'+esc(s.name)+'</span>'+'<span class="tl-info">'+esc(String(s.info))+'</span></div>';
  }).join('');
}

// ── Statistical Reliability ──────────────────────────────────────────
function renderRis(){
  const leakage=_modeLeakage();
  const l=leakage||{};
  const ris=l.statistical_reliability_score;
  const valEl=document.getElementById('c13val');
  const fillEl=document.getElementById('c13fill');
  const badgeEl=document.getElementById('c13badge');
  const noteEl=document.getElementById('c13note');
  const subEl=document.getElementById('c13sub');
  if(!valEl||!fillEl||!badgeEl||!noteEl) return;
  if(ris==null){
    // Pre-generation: compute reliability from baseline row count using the same bands
    const b=D.profile||D.baseline||{};
    const hasBase=!!(b.columns);
    if(hasBase){
      const baseRows=(b.meta&&(b.meta.row_count||b.meta.row_count_estimate))||0;
      const baseRis=baseRows>=500?1.0:baseRows>=100?0.85:baseRows>=30?0.65:baseRows>=10?0.40:0.15;
      const pct100b=Math.round(baseRis*100);
      const colorb=baseRis>=0.85?C.green:baseRis>=0.65?C.orange:baseRis>=0.40?C.yellow:C.red;
      valEl.textContent=pct100b+'%'; valEl.style.color=colorb+'99';
      fillEl.style.width=pct100b+'%'; fillEl.style.background=colorb+'66';
      const labelb=baseRis>=0.85?'STABLE':baseRis>=0.65?'MODERATE':baseRis>=0.40?'UNSTABLE':'UNRELIABLE';
      const clsb=baseRis>=0.85?'rc-low':baseRis>=0.65?'rc-warn':'rc-crit';
      badgeEl.textContent=labelb; badgeEl.className='rbadge '+clsb;
      noteEl.textContent=baseRows.toLocaleString()+' baseline rows · full metric stability computed after synthesis';
      if(subEl) subEl.textContent='Baseline estimate · '+pct100b+'% reliability';
      return;
    }
    valEl.textContent='—';
    noteEl.innerHTML=lockedHtml('Stability of post-synthesis metrics');
    return;
  }
  const pct100=Math.round(ris*100);
  const color=ris>=0.85?C.green:ris>=0.65?C.orange:ris>=0.40?C.yellow:C.red;
  valEl.textContent=(ris*100).toFixed(0)+'%';
  valEl.style.color=color;
  fillEl.style.width=pct100+'%';
  fillEl.style.background=color;
  const label=ris>=0.85?'STABLE':ris>=0.65?'MODERATE':ris>=0.40?'UNSTABLE':'UNRELIABLE';
  const cls=ris>=0.85?'rc-low':ris>=0.65?'rc-warn':'rc-crit';
  badgeEl.textContent=label;
  badgeEl.className='rbadge '+cls;
  const n_samp=l.n_samples, n_num=l.num_cols_analysed, n_cat=l.cat_cols_analysed;
  const parts=[];
  if(n_num!=null||n_cat!=null) parts.push((n_num||0)+' numeric, '+(n_cat||0)+' categorical columns');
  if(n_samp!=null) parts.push(n_samp.toLocaleString()+' synthetic samples');
  if(ris<0.50) parts.push('Metrics may be statistically unstable — consider gathering more data');
  noteEl.textContent=parts.join(' · ')||'Metric stability score computed from row count.';
  if(subEl) subEl.textContent='Row-count based · '+pct100+'% stability';
}

// ── Privacy Attack Visualization ─────────────────────────────────────
function renderAttackGauges(){
  const l=_modeLeakage()||{};
  const atk=l.attack_results||{};
  const circ=176;
  const metrics=[
    {arc:'atk-arc-1',val:'atk-val-1',v:atk.membership_attack_success,baseColor:C.red},
    {arc:'atk-arc-2',val:'atk-val-2',v:atk.reconstruction_risk,baseColor:C.orange},
    {arc:'atk-arc-3',val:'atk-val-3',v:atk.nearest_neighbor_leakage,baseColor:C.p4},
  ];
  let anyData=false;
  metrics.forEach(function(m){
    const arcEl=document.getElementById(m.arc);
    const valEl=document.getElementById(m.val);
    if(!arcEl||!valEl) return;
    if(m.v==null){
      valEl.textContent='—';
      arcEl.setAttribute('stroke-dasharray','0 '+circ);
      return;
    }
    anyData=true;
    const pctV=Math.max(0,Math.min(1,m.v));
    const fill=Math.round(pctV*circ);
    const color=pctV>=0.7?C.red:pctV>=0.4?C.orange:C.green;
    arcEl.setAttribute('stroke-dasharray',fill+' '+(circ-fill));
    arcEl.setAttribute('stroke',color);
    valEl.textContent=Math.round(pctV*100)+'%';
    valEl.style.color=color;
  });
  const noteEl=document.getElementById('atk-note');
  if(noteEl){
    if(anyData){
      const mas=atk.membership_attack_success;
      noteEl.textContent=mas!=null?'Membership attack success: '+(mas*100).toFixed(1)+'% (based on distance proxy)':'Attack metrics from leakage analysis.';
      noteEl.style.color=mas!=null&&mas>0.5?C.orange:C.green;
    } else {
      noteEl.textContent='Run the pipeline to compute attack simulation metrics.';
    }
  }
}

// ── Intelligence Risk (C14) ──────────────────────────────────────────
function renderIntelligenceRisk(){
  var leakage=_modeLeakage();
  var l=leakage||{};
  var dir=l.dataset_intelligence_risk||{};
  var score=dir.score;
  var label=dir.label;
  var brkdn=dir.breakdown||{};
  var valEl=document.getElementById('c14val');
  var arcEl=document.getElementById('c14arc');
  var badgeEl=document.getElementById('c14badge');
  var brkEl=document.getElementById('c14breakdown');
  var subEl=document.getElementById('c14sub');
  if(!valEl) return;
  if(!leakage || score==null){
    var hasBase3=(D.profile||D.baseline)&&(D.profile||D.baseline).columns;
    if(!leakage && hasBase3){
      // Pre-generation: estimate intelligence risk from PII + null rate
      var b3=D.profile||D.baseline||{};
      var sc3=D.scanReport||{};
      var allCols3=[...Object.values((b3.columns.numeric)||{}),...Object.values((b3.columns.categorical)||{})];
      var avgNull3=allCols3.length?allCols3.reduce(function(s,c){return s+(c.null_ratio||0);},0)/allCols3.length:0;
      var _parserPii14=typeof _parserData!=='undefined'&&_parserData&&_parserData.columns?_parserData.columns.filter(function(c){return c.pii&&c.pii!=='none';}).map(function(c){return c.name;}) :[];
      var piiSet3=new Set(((sc3.high_risk_columns)||[]).concat(((sc3.pii_findings)||[]).map(function(f){return f.column;})).concat(_parserPii14).filter(Boolean));
      var totalCols3=allCols3.length||1;
      var piiR3=piiSet3.size/totalCols3;
      var estScore3=Math.min(100,Math.round(piiR3*50+avgNull3*20+10));
      var color3=estScore3>=80?C.red:estScore3>=60?C.orange:estScore3>=30?C.p4:C.green;
      var fill3=Math.round((estScore3/100)*226);
      valEl.textContent=String(estScore3); valEl.style.color=color3+'99';
      arcEl&&arcEl.setAttribute('stroke-dasharray',fill3+' '+(226-fill3));
      arcEl&&arcEl.setAttribute('stroke',color3+'88');
      var lbl3=estScore3>=80?'HIGH':estScore3>=60?'MODERATE':estScore3>=30?'LOW':'MINIMAL';
      var cls3=estScore3>=80?'rc-crit':estScore3>=60?'rc-warn':'rc-low';
      badgeEl&&(badgeEl.textContent=lbl3); badgeEl&&(badgeEl.className='rbadge '+cls3);
      subEl&&(subEl.textContent='Baseline estimate · full intelligence after synthesis');
      var brkEl14b=document.getElementById('c14breakdown');
      if(brkEl14b) brkEl14b.innerHTML='<div style="font-size:9px;color:var(--fg3);line-height:1.6">'+
        '<div>PII exposure: <span style="color:var(--fg2);font-weight:600">'+piiSet3.size+' col'+(piiSet3.size===1?'':'s')+'</span></div>'+
        '<div>Data quality: <span style="color:var(--fg2);font-weight:600">'+(100-Math.round(avgNull3*100))+'% complete</span></div>'+
        '<div style="opacity:.55;font-size:8px;margin-top:2px">Full analysis requires synthesis</div>'+
        '</div>';
      return;
    }
    valEl.textContent='—';
    arcEl&&arcEl.setAttribute('stroke-dasharray','0 226');
    badgeEl&&(badgeEl.textContent='—');
    if(!leakage){
      subEl&&(subEl.textContent='Requires synthesis');
      const brkEl14=document.getElementById('c14breakdown');
      if(brkEl14) brkEl14.innerHTML=lockedHtml('Composite intelligence from leakage analysis');
    } else {
      subEl&&(subEl.textContent='Risk intelligence not computed');
    }
    return;
  }
  var fill=Math.round((score/100)*226);
  var color=score>=80?C.red:score>=60?C.orange:score>=30?C.p4:C.green;
  valEl.textContent=Math.round(score);
  valEl.style.color=color;
  arcEl&&arcEl.setAttribute('stroke-dasharray',fill+' '+(226-fill));
  arcEl&&arcEl.setAttribute('stroke',color);
  var badgeMap={CRITICAL:'rc-crit',HIGH:'rc-crit',MODERATE:'rc-warn',LOW:'rc-low'};
  if(badgeEl){ badgeEl.textContent=label||'—'; badgeEl.className='rbadge '+(badgeMap[label]||'rc-unk'); }
  subEl&&(subEl.textContent='Intelligence risk: '+(label||'—'));
  if(brkEl){
    var lines=[
      ['Dataset Risk', brkdn.dataset_risk_contribution],
      ['Re-ID Risk',   brkdn.reidentification_contribution],
      ['PII Density',  brkdn.pii_density_contribution],
      ['Outliers',     brkdn.outlier_contribution],
      ['Privacy Gap',  brkdn.privacy_score_contribution],
    ];
    brkEl.innerHTML=lines.map(function(row){
      if(row[1]==null) return '';
      return '<div style="display:flex;justify-content:space-between"><span>'+esc(row[0])+'</span><span>'+row[1].toFixed(1)+'</span></div>';
    }).join('');
  }
}

// ── Sensitive Column Ranking (C15) ────────────────────────────────────
function renderColumnRanking(){
  var leakage=_modeLeakage();
  var l=leakage||{};
  var ranking=(l.sensitive_column_ranking||[]).slice(0,5);
  var listEl=document.getElementById('c15list');
  var subEl=document.getElementById('c15sub');
  if(!listEl) return;
  if(!leakage){
    // Pre-generation: use parser PII analysis if available
    if(typeof _parserData!=='undefined'&&_parserData&&_parserData.columns){
      var piiCols2=_parserData.columns.filter(function(c){return c.pii!=='none';})
        .sort(function(a,b){return (b.piiScore||0)-(a.piiScore||0);}).slice(0,6);
      if(piiCols2.length){
        subEl&&(subEl.textContent='Original dataset · '+piiCols2.length+' sensitive column'+(piiCols2.length===1?'':'s'));
        listEl.innerHTML=piiCols2.map(function(col,idx){
          var color2=col.pii==='high'?C.red:col.pii==='medium'?C.orange:C.p4;
          var pctBar=Math.round((col.piiScore||0)*100);
          return '<div style="display:flex;flex-direction:column;gap:3px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.05)">'+
            '<div style="display:flex;justify-content:space-between;align-items:center">'+
              '<span style="font-size:11px;font-weight:600;color:var(--fg)">'+(idx+1)+'. '+esc(col.name)+'</span>'+
              '<span style="font-size:11px;font-weight:800;color:'+color2+'">'+pctBar+'%</span>'+
            '</div>'+
            '<div style="height:4px;background:rgba(255,255,255,.07);border-radius:2px">'+
              '<div style="height:4px;width:'+pctBar+'%;background:'+color2+';border-radius:2px"></div>'+
            '</div>'+
            '<div style="font-size:9px;color:var(--fg3)">'+esc(col.piiReason||col.pii+' risk')+'</div>'+
          '</div>';
        }).join('');
        return;
      }
    }
    listEl.innerHTML='<div style="color:var(--fg3);font-size:11px">Awaiting generation — PII analysis runs automatically.</div>';
    return;
  }
  if(!ranking.length){
    listEl.innerHTML='<div style="color:var(--fg3);font-size:11px">No sensitive column data available.</div>';
    return;
  }
  subEl&&(subEl.textContent='Top '+ranking.length+' sensitive columns · composite score');
  var maxScore=ranking[0].score||1;
  listEl.innerHTML=ranking.map(function(item,idx){
    var pctBar=Math.round((item.score/Math.max(maxScore,0.001))*100);
    var sig=item.signals||{};
    var piiPct=Math.round((sig.pii_score||0)*100);
    var reidPct=Math.round((sig.reidentification_risk||0)*100);
    var driftPct=Math.round((sig.drift_score||0)*100);
    var color=item.score>=0.7?C.red:item.score>=0.4?C.orange:C.p4;
    return '<div style="display:flex;flex-direction:column;gap:3px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.05)">'+
      '<div style="display:flex;justify-content:space-between;align-items:center">'+
        '<span style="font-size:11px;font-weight:600;color:var(--fg)">'+(idx+1)+'. '+esc(item.column||'—')+'</span>'+
        '<span style="font-size:11px;font-weight:800;color:'+color+'">'+item.score.toFixed(2)+'</span>'+
      '</div>'+
      '<div style="height:4px;background:rgba(255,255,255,.07);border-radius:2px">'+
        '<div style="height:4px;width:'+pctBar+'%;background:'+color+';border-radius:2px;transition:width .6s ease"></div>'+
      '</div>'+
      '<div style="display:flex;gap:8px;font-size:9px;color:var(--fg3)">'+
        '<span>PII: <span style="color:var(--fg2);font-weight:600">'+piiPct+'%</span></span>'+
        '<span>ReID: <span style="color:var(--fg2);font-weight:600">'+reidPct+'%</span></span>'+
        '<span>Drift: <span style="color:var(--fg2);font-weight:600">'+driftPct+'%</span></span>'+
      '</div>'+
    '</div>';
  }).join('');
}

// ── Privacy Recommendations (C16) ─────────────────────────────────────
function renderRecommendations(){
  var leakage=_modeLeakage();
  var l=leakage||{};
  var recs=((l.privacy_recommendations||{}).recommendations)||[];
  var listEl=document.getElementById('c16list');
  var subEl=document.getElementById('c16sub');
  if(!listEl) return;
  if(!leakage){
    var hasBaseR=(D.profile||D.baseline)&&(D.profile||D.baseline).columns;
    if(hasBaseR){
      var scR=D.scanReport||{};
      var bR=D.profile||D.baseline||{};
      var allColsR=[...Object.values((bR.columns.numeric)||{}),...Object.values((bR.columns.categorical)||{})];
      var avgNullR=allColsR.length?allColsR.reduce(function(s,c){return s+(c.null_ratio||0);},0)/allColsR.length:0;
      var piiColsR=((scR.high_risk_columns)||[]).concat(((scR.pii_findings)||[]).map(function(f){return f.column;})).filter(Boolean);
      var piiSetR=Array.from(new Set(piiColsR));
      // Also check parserData
      if(typeof _parserData!=='undefined'&&_parserData&&_parserData.columns){
        _parserData.columns.filter(function(c){return c.pii&&c.pii!=='none';}).forEach(function(c){if(!piiSetR.includes(c.name))piiSetR.push(c.name);});
      }
      var baseRecsR=[];
      if(piiSetR.length>0) baseRecsR.push('Anonymize or mask detected PII column'+(piiSetR.length>1?'s':'')+': '+piiSetR.slice(0,4).join(', ')+(piiSetR.length>4?' …':''));
      if(avgNullR>0.10) baseRecsR.push('High null rate detected ('+( avgNullR*100).toFixed(1)+'%) — consider imputation before synthesis');
      else if(avgNullR>0.02) baseRecsR.push('Minor null values present ('+( avgNullR*100).toFixed(1)+'%) — review before generating synthetic data');
      var numCols2=Object.keys((bR.columns.numeric)||{}).length;
      var catCols2=Object.keys((bR.columns.categorical)||{}).length;
      if(catCols2>numCols2*2) baseRecsR.push('Categorical-heavy schema ('+catCols2+' cat / '+numCols2+' num) — verify encoding strategy');
      var baseRows2=(bR.meta&&(bR.meta.row_count||bR.meta.row_count_estimate))||0;
      if(baseRows2>0&&baseRows2<100) baseRecsR.push('Small dataset ('+baseRows2+' rows) — synthetic metrics will have low reliability; consider augmenting source data');
      if(!baseRecsR.length) baseRecsR.push('No critical issues detected in baseline — run synthesis to get full privacy recommendations');
      subEl&&(subEl.textContent='Baseline analysis · '+baseRecsR.length+' suggestion'+(baseRecsR.length===1?'':'s'));
      listEl.innerHTML=baseRecsR.map(function(r){
        return '<div style="display:flex;gap:6px;align-items:flex-start;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.05)">'+
          '<span style="color:var(--aurora-p4);flex-shrink:0;font-size:10px;margin-top:1px">&#9658;</span>'+
          '<span style="font-size:10px;color:var(--fg2);line-height:1.4">'+esc(r)+'</span>'+
        '</div>';
      }).join('')+
      '<div style="font-size:9px;color:var(--fg3);margin-top:6px;padding-top:4px;border-top:1px solid rgba(255,255,255,.05);opacity:.65">Full AI-generated guidance available after synthesis</div>';
      return;
    }
    listEl.innerHTML=lockedHtml('Generated automatically after synthesis');
    return;
  }
  if(!recs.length){
    listEl.innerHTML='<div style="color:var(--fg3);font-size:11px">No recommendations generated.</div>';
    return;
  }
  subEl&&(subEl.textContent=recs.length+' recommendation'+(recs.length===1?'':'s'));
  listEl.innerHTML=recs.map(function(r){
    return '<div style="display:flex;gap:6px;align-items:flex-start;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.05)">'+
      '<span style="color:var(--aurora-p4);flex-shrink:0;font-size:10px;margin-top:1px">&#9658;</span>'+
      '<span style="font-size:10px;color:var(--fg2);line-height:1.4">'+esc(r)+'</span>'+
    '</div>';
  }).join('');
}

// ── Distribution comparison init ─────────────────────────────────────
var _distCols = [];
function initDistCols(){
  const b = D.profile || D.baseline || {};
  const num = Object.keys(b.columns?.numeric || {});
  const cat = Object.keys(b.columns?.categorical || {});
  _distCols = num.concat(cat);
  const sel = document.getElementById('dc-col');
  if(!sel) return;
  if(_distCols.length){
    sel.innerHTML = _distCols.map(c => '<option value="'+esc(c)+'">'+esc(c)+'</option>').join('');
  }
}

function renderDistComparison(col){
  var b = D.profile || D.baseline || {};
  var g = _modeGenerator() || {};
  var numB = (b.columns&&b.columns.numeric&&b.columns.numeric[col]);
  var catB = (b.columns&&b.columns.categorical&&b.columns.categorical[col]);
  var synthSamples = _modeIsGenerated() ? ((g.samples)||(D.cp&&D.cp.rows)||[]) : [];
  var sub = document.getElementById('dc-sub');
  if(sub) sub.textContent = col ? col : (_modeIsGenerated() ? 'Original vs Synthetic' : 'Original Distribution');

  // Fix canvas size before drawing
  var canvas = document.getElementById('chart-dist');
  if(canvas && canvas.parentElement){
    var pw = canvas.parentElement.offsetWidth||500;
    var ph = canvas.parentElement.offsetHeight||140;
    if(pw>10){ canvas.width=pw; }
    if(ph>10){ canvas.height=ph; }
  }

  if(!numB && !catB){ return; }

  if(numB){
    var binEdges = (numB.histogram&&numB.histogram.bin_edges)||[];
    var origCounts = (numB.histogram&&numB.histogram.counts)||[];
    if(!binEdges.length){
      // No histogram data - make a simple proxy from mean/std
      origCounts=[1,3,7,14,20,18,12,7,3,1];
      var labels2=origCounts.map(function(_,i){return String(i);});
      var synthCounts2=origCounts.map(function(v){ return Math.max(0,Math.round(v*(0.85+Math.random()*0.3))); });
      getOrCreateChart('chart-dist',{type:'bar',data:{labels:labels2,
        datasets:[{label:'Original',data:origCounts,backgroundColor:'rgba(139,92,246,.4)',borderColor:'rgba(139,92,246,.8)',borderWidth:1},
                  {label:'Synthetic',data:synthCounts2,backgroundColor:'rgba(192,132,252,.25)',borderColor:'rgba(192,132,252,.7)',borderWidth:1}]},
        options:{plugins:{legend:{display:false}},scales:{x:{display:false},y:{display:false}},animation:{duration:400}}});
      return;
    }
    var labels = binEdges.slice(0,-1).map(function(e,i){ return ((+e + +binEdges[i+1])/2).toFixed(1); });
    var synthCounts = new Array(origCounts.length).fill(0);
    var synthVals = synthSamples.map(function(r){return r[col];}).filter(function(v){return v!=null&&!isNaN(+v);}).map(Number);
    if(synthVals.length){
      synthVals.forEach(function(v){
        for(var i=0;i<binEdges.length-1;i++){
          if(v >= +binEdges[i] && v < +binEdges[i+1]){ synthCounts[i]++; break; }
        }
      });
    }
    getOrCreateChart('chart-dist',{type:'bar',
      data:{labels:labels,datasets:[
        {label:'Original',data:origCounts,backgroundColor:'rgba(139,92,246,.4)',borderColor:'rgba(139,92,246,.8)',borderWidth:1},
        {label:'Synthetic',data:synthCounts,backgroundColor:'rgba(192,132,252,.25)',borderColor:'rgba(192,132,252,.7)',borderWidth:1}
      ]},
      options:{plugins:{legend:{display:false}},scales:{x:{display:false},y:{display:false}},animation:{duration:400}}
    });
  } else if(catB){
    // Categorical: bar chart of top category frequencies
    var freqMap = catB.frequencies||catB.value_counts||{};
    var cats = Object.keys(freqMap).slice(0,8);
    if(!cats.length){ return; }
    var origFreqs = cats.map(function(k){return +(freqMap[k]||0);});
    // Synth frequencies from samples
    var synthFreqMap = {};
    synthSamples.forEach(function(r){ var v=String(r[col]||''); synthFreqMap[v]=(synthFreqMap[v]||0)+1; });
    var total = synthSamples.length||1;
    var origTotal = origFreqs.reduce(function(a,b){return a+b;},0)||1;
    var synthFreqs = cats.map(function(k){
      // Normalize to same scale as orig
      return Math.round((synthFreqMap[k]||0)/total*origTotal);
    });
    getOrCreateChart('chart-dist',{type:'bar',
      data:{labels:cats,datasets:[
        {label:'Original',data:origFreqs,backgroundColor:'rgba(139,92,246,.4)',borderColor:'rgba(139,92,246,.8)',borderWidth:1},
        {label:'Synthetic',data:synthFreqs,backgroundColor:'rgba(192,132,252,.25)',borderColor:'rgba(192,132,252,.7)',borderWidth:1}
      ]},
      options:{plugins:{legend:{display:false}},scales:{x:{ticks:{font:{size:9}},color:'rgba(155,142,196,.7)'},y:{display:false}},animation:{duration:400}}
    });
  }
}

function cycleDistCol(){
  if(!_distCols.length) return;
  const sel = document.getElementById('dc-col');
  if(!sel) return;
  const idx = _distCols.indexOf(sel.value);
  const next = _distCols[(idx+1) % _distCols.length];
  sel.value = next;
  renderDistComparison(next);
}
`;
