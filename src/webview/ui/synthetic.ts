export const SYNTHETIC_TAB_HTML = String.raw`
<!-- TAB: Synthetic Data -->
<div id="pane-synthetic" class="tabpane">
  <div id="synthetic-root">

  <!-- ML Fidelity Panel -->
  <div style="padding:14px 20px 8px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div>
        <span style="font-size:13px;font-weight:700;color:var(--fg)">ML Fidelity</span>
        <span style="font-size:11px;color:var(--fg3);margin-left:8px" id="mf-sub">Kolmogorov–Smirnov · Pairwise Explorer</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <div id="mf-score-badge" style="display:none;padding:3px 10px;border-radius:8px;font-size:10px;font-weight:700"></div>
        <button class="ib" onclick="refreshMLFidelity()" title="Refresh fidelity analysis">&#8635;</button>
      </div>
    </div>

    <!-- KS Statistics per column -->
    <div style="margin-bottom:12px">
      <div style="font-size:10px;font-weight:600;color:var(--fg3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">
        Kolmogorov–Smirnov Statistics · per column
      </div>
      <div id="mf-ks-list" style="display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto">
        <div style="color:var(--fg3);font-size:11px;padding:8px 0">Run the generator to see KS statistics.</div>
      </div>
    </div>

    <!-- Pairwise Relationship Explorer -->
    <div style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px">
      <div style="font-size:10px;font-weight:600;color:var(--fg3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">
        Pairwise Relationship Explorer
      </div>
      <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <select class="dist-sel" id="mf-col-x" onchange="renderPairwise()" style="flex:1;min-width:100px"><option>— select X —</option></select>
        <select class="dist-sel" id="mf-col-y" onchange="renderPairwise()" style="flex:1;min-width:100px"><option>— select Y —</option></select>
      </div>
      <div style="height:160px;width:100%;position:relative;margin-bottom:6px">
        <canvas id="chart-pairwise" width="500" height="160" style="width:100%;height:160px;display:block"></canvas>
      </div>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap" id="mf-pair-legend">
        <div class="dist-li"><div class="dist-dot" style="background:var(--aurora-p4);height:6px;border-radius:50%;width:6px"></div>Original</div>
        <div class="dist-li"><div class="dist-dot" style="background:var(--aurora-green);height:6px;border-radius:50%;width:6px"></div>Synthetic</div>
      </div>
      <div id="mf-pair-stats" style="margin-top:6px;font-size:9px;color:var(--fg3);text-align:center"></div>
    </div>
  </div>

  <!-- Data preview table -->
  <div style="padding:0 20px 8px;display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--border);margin-top:4px;padding-top:12px">
    <span style="font-size:12px;font-weight:600;color:var(--fg)">Generated Data Preview</span>
    <span style="font-size:10px;color:var(--fg3)">First 50 rows · click column header to sort</span>
  </div>
  <div class="preview-wrap">
    <table class="preview-table" id="preview-table">
      <thead id="preview-head"></thead>
      <tbody id="preview-body"><tr><td style="padding:20px;color:var(--fg3)">Run the generator to see results</td></tr></tbody>
    </table>
  </div>

  </div>
</div>
`;

export const SYNTHETIC_SCRIPT = String.raw`
// ── Synthetic Data tab — ML Fidelity + sortable preview ──────────────
let syntheticRendered=false, synthSortCol=null, synthSortAsc=true;
function _getSamples(){
  return (
    D.generator?.samples ||
    D.result?.samples ||
    D.cp?.rows ||
    []
  );
}

// ── KS statistic (two-sample Kolmogorov-Smirnov, pure JS) ────────────
function _ksStatistic(a, b){
  if(!a.length || !b.length) return null;
  var as=a.slice().sort(function(x,y){return x-y;});
  var bs=b.slice().sort(function(x,y){return x-y;});
  var n1=as.length, n2=bs.length;
  var i=0,j=0, maxD=0;
  while(i<n1 && j<n2){
    var ecdf1=(i+1)/n1, ecdf2=(j+1)/n2;
    var d=Math.abs(ecdf1-ecdf2);
    if(d>maxD) maxD=d;
    if(as[i]<=bs[j]) i++; else j++;
  }
  return maxD;
}

// ── Pairwise correlation (Pearson) ───────────────────────────────────
function _pearson(xs, ys){
  var n=xs.length; if(n<2) return null;
  var mx=xs.reduce(function(a,v){return a+v;},0)/n;
  var my=ys.reduce(function(a,v){return a+v;},0)/n;
  var num=0,dx=0,dy=0;
  for(var i=0;i<n;i++){
    var ex=xs[i]-mx, ey=ys[i]-my;
    num+=ex*ey; dx+=ex*ex; dy+=ey*ey;
  }
  var denom=Math.sqrt(dx*dy);
  return denom<1e-10?null:num/denom;
}

// ── Initialise column selectors ───────────────────────────────────────
var _mfNumCols=[], _mfCatCols=[], _mfAllCols=[];
function initMLFidelityCols(){
  var b=D.profile||D.baseline||{};
  _mfNumCols=Object.keys(b.columns?.numeric||{});
  _mfCatCols=Object.keys(b.columns?.categorical||{});
  _mfAllCols=_mfNumCols.concat(_mfCatCols);

  var sx=document.getElementById('mf-col-x');
  var sy=document.getElementById('mf-col-y');
  if(!sx||!sy) return;
  var opts=_mfAllCols.map(function(c){return '<option value="'+esc(c)+'">'+esc(c)+'</option>';}).join('');
  sx.innerHTML=opts;
  sy.innerHTML=opts;
  // default: first two different columns
  if(_mfAllCols.length>1){ sy.value=_mfAllCols[1]; }
}

// ── Render KS list ───────────────────────────────────────────────────
function renderKSList(){
  var el=document.getElementById('mf-ks-list');
  var sub=document.getElementById('mf-sub');
  var scoreBadge=document.getElementById('mf-score-badge');
  if(!el) return;

  var samples=_getSamples();
  var b=D.profile||D.baseline||{};
  if(!samples.length||!b.columns){
    el.innerHTML='<div style="color:var(--fg3);font-size:11px;padding:8px 0">Run the generator to see KS statistics.</div>';
    if(scoreBadge) scoreBadge.style.display='none';
    return;
  }

  var results=[];
  // Numeric columns KS
  _mfNumCols.forEach(function(col){
    var spec=(b.columns.numeric&&b.columns.numeric[col])||{};
    // Build original distribution from quantile anchors
    var origVals=[];
    var qkeys=['min','q01','q05','q25','q50','q75','q95','q99','max'];
    qkeys.forEach(function(k){if(spec[k]!=null) origVals.push(+spec[k]);});
    // Sample synthetic numeric values for this col
    var synthVals=samples.map(function(r){return r[col];})
      .filter(function(v){return v!=null&&!isNaN(+v);}).map(Number);
    if(!synthVals.length) return;
    // Use histogram counts if available for original distribution
    var histEdges=(spec.histogram&&spec.histogram.bin_edges)||[];
    var histCounts=(spec.histogram&&spec.histogram.counts)||[];
    var origSample=[];
    if(histEdges.length>1&&histCounts.length){
      // Reconstruct representative sample from histogram
      histCounts.forEach(function(cnt,i){
        var mid=((+histEdges[i])+(+histEdges[i+1]))/2;
        for(var k=0;k<Math.min(cnt,20);k++) origSample.push(mid);
      });
    } else if(origVals.length){
      origSample=origVals;
    }
    var ks=origSample.length?_ksStatistic(origSample,synthVals):null;
    results.push({col:col,ks:ks,type:'numeric'});
  });

  // Categorical KS (use frequency distribution overlap)
  _mfCatCols.forEach(function(col){
    var spec=(b.columns.categorical&&b.columns.categorical[col])||{};
    var origFreq=spec.top_value_ratios||spec.frequencies||{};
    var cats=Object.keys(origFreq);
    if(!cats.length) return;
    var synthFreqMap={};
    samples.forEach(function(r){var v=String(r[col]||'');synthFreqMap[v]=(synthFreqMap[v]||0)+1;});
    var total=samples.length||1;
    // Treat as discrete distributions; compute max abs deviation
    var maxDev=0;
    cats.forEach(function(k){
      var origP=+(origFreq[k]||0);
      var synthP=(synthFreqMap[k]||0)/total;
      var dev=Math.abs(origP-synthP);
      if(dev>maxDev) maxDev=dev;
    });
    results.push({col:col,ks:maxDev,type:'categorical'});
  });

  if(!results.length){
    el.innerHTML='<div style="color:var(--fg3);font-size:11px">No column data available.</div>';
    return;
  }

  // Sort by KS descending (worst first)
  results.sort(function(a,b){return (b.ks||0)-(a.ks||0);});

  // Compute overall fidelity score
  var validKS=results.filter(function(r){return r.ks!=null;});
  var avgKS=validKS.length?validKS.reduce(function(s,r){return s+(r.ks||0);},0)/validKS.length:null;
  var fidelityPct=avgKS!=null?Math.round((1-Math.min(1,avgKS*2))*100):null;

  if(scoreBadge && fidelityPct!=null){
    scoreBadge.style.display='';
    scoreBadge.textContent='Fidelity: '+fidelityPct+'%';
    scoreBadge.style.background=fidelityPct>=80?'rgba(52,211,153,.15)':fidelityPct>=60?'rgba(251,146,60,.15)':'rgba(248,113,113,.15)';
    scoreBadge.style.color=fidelityPct>=80?'var(--aurora-green)':fidelityPct>=60?'var(--aurora-orange)':'var(--aurora-red)';
    scoreBadge.style.border='1px solid '+(fidelityPct>=80?'rgba(52,211,153,.3)':fidelityPct>=60?'rgba(251,146,60,.3)':'rgba(248,113,113,.3)');
  }

  if(sub) sub.textContent=results.length+' columns · avg KS '+( avgKS!=null?avgKS.toFixed(3):'—');

  var maxKS=results[0]?results[0].ks||0:1;
  el.innerHTML=results.map(function(r){
    var ks=r.ks!=null?r.ks:null;
    var pct=ks!=null&&maxKS>0?Math.round((ks/maxKS)*100):0;
    var color=ks==null?'var(--fg3)':ks<0.05?'var(--aurora-green)':ks<0.15?'var(--aurora-orange)':'var(--aurora-red)';
    var label=ks==null?'—':ks<0.05?'PASS':ks<0.15?'WARN':'FAIL';
    var typeIcon=r.type==='numeric'?'#':'@';
    return '<div style="display:flex;align-items:center;gap:7px;padding:3px 0">'+
      '<span style="font-size:9px;color:var(--fg3);width:10px;text-align:center;flex-shrink:0">'+typeIcon+'</span>'+
      '<span style="font-size:10px;color:var(--fg2);width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0" title="'+esc(r.col)+'">'+esc(r.col)+'</span>'+
      '<div style="flex:1;height:6px;background:var(--card3);border-radius:3px;overflow:hidden">'+
        '<div style="height:6px;width:'+pct+'%;background:'+color+';border-radius:3px;transition:width .4s ease"></div>'+
      '</div>'+
      '<span style="font-size:9px;font-weight:700;color:'+color+';width:36px;text-align:right;flex-shrink:0">'+label+'</span>'+
      '<span style="font-size:9px;color:var(--fg3);width:40px;text-align:right;flex-shrink:0">'+(ks!=null?ks.toFixed(3):'—')+'</span>'+
    '</div>';
  }).join('');
}

// ── Render Pairwise scatter ───────────────────────────────────────────
function renderPairwise(){
  var selX=document.getElementById('mf-col-x');
  var selY=document.getElementById('mf-col-y');
  var statsEl=document.getElementById('mf-pair-stats');
  if(!selX||!selY) return;
  var colX=selX.value, colY=selY.value;
  if(!colX||!colY||colX===colY){
    if(statsEl) statsEl.textContent='Select two different columns to compare.';
    return;
  }

  var samples=_getSamples();
  var b=D.profile||D.baseline||{};
  var canvas=document.getElementById('chart-pairwise');
  if(!canvas) return;
  var ctx=canvas.getContext('2d');
  if(!ctx) return;

  var W=canvas.parentElement.offsetWidth||500;
  var H=160;
  canvas.width=W; canvas.height=H;
  ctx.clearRect(0,0,W,H);

  // Check if columns are numeric
  var xIsNum=!!(b.columns&&b.columns.numeric&&b.columns.numeric[colX]);
  var yIsNum=!!(b.columns&&b.columns.numeric&&b.columns.numeric[colY]);

  if(xIsNum && yIsNum){
    // Scatter plot: original points (from quantile anchors) vs synthetic
    var specX=(b.columns.numeric[colX])||{};
    var specY=(b.columns.numeric[colY])||{};
    var synthPts=samples.map(function(r){
      var x=+r[colX], y=+r[colY];
      return isNaN(x)||isNaN(y)?null:{x:x,y:y};
    }).filter(Boolean);

    if(!synthPts.length){
      ctx.fillStyle='rgba(139,92,246,.4)';ctx.font='11px sans-serif';
      ctx.textAlign='center';ctx.fillText('No synthetic data',W/2,H/2);
      return;
    }

    var allX=synthPts.map(function(p){return p.x;});
    var allY=synthPts.map(function(p){return p.y;});
    var xMin=specX.min!=null?+specX.min:Math.min.apply(null,allX);
    var xMax=specX.max!=null?+specX.max:Math.max.apply(null,allX);
    var yMin=specY.min!=null?+specY.min:Math.min.apply(null,allY);
    var yMax=specY.max!=null?+specY.max:Math.max.apply(null,allY);
    var pad=28;
    var xRange=xMax-xMin||1, yRange=yMax-yMin||1;

    function toCanvasX(v){return pad+(v-xMin)/xRange*(W-pad*2);}
    function toCanvasY(v){return H-pad-(v-yMin)/yRange*(H-pad*2);}

    // Grid
    ctx.strokeStyle='rgba(255,255,255,.05)';ctx.lineWidth=0.6;
    for(var gi=0;gi<=4;gi++){
      var gx=pad+gi*(W-pad*2)/4;
      var gy=pad+gi*(H-pad*2)/4;
      ctx.beginPath();ctx.moveTo(gx,pad);ctx.lineTo(gx,H-pad);ctx.stroke();
      ctx.beginPath();ctx.moveTo(pad,gy);ctx.lineTo(W-pad,gy);ctx.stroke();
    }

    // Synthetic scatter (subsample for performance)
    var step=Math.max(1,Math.floor(synthPts.length/200));
    ctx.fillStyle='rgba(52,211,153,.55)';
    for(var i=0;i<synthPts.length;i+=step){
      var p=synthPts[i];
      ctx.beginPath();ctx.arc(toCanvasX(p.x),toCanvasY(p.y),2.5,0,6.28);ctx.fill();
    }

    // Original range box (IQR rectangle)
    var ox1=specX.q25!=null?+specX.q25:xMin, ox2=specX.q75!=null?+specX.q75:xMax;
    var oy1=specY.q25!=null?+specY.q25:yMin, oy2=specY.q75!=null?+specY.q75:yMax;
    ctx.strokeStyle='rgba(139,92,246,.7)';ctx.lineWidth=1.5;
    ctx.strokeRect(toCanvasX(ox1),toCanvasY(oy2),toCanvasX(ox2)-toCanvasX(ox1),toCanvasY(oy1)-toCanvasY(oy2));

    // Axis labels
    ctx.fillStyle='rgba(155,142,196,.6)';ctx.font='9px sans-serif';ctx.textAlign='center';
    ctx.fillText(esc(colX).substring(0,14),W/2,H-4);
    ctx.save();ctx.translate(10,H/2);ctx.rotate(-Math.PI/2);
    ctx.textAlign='center';ctx.fillText(esc(colY).substring(0,14),0,0);ctx.restore();

    // Stats
    var pearsonR=_pearson(allX,allY);
    if(statsEl) statsEl.textContent=
      'Synthetic r='+( pearsonR!=null?pearsonR.toFixed(3):'n/a')+
      ' · n='+synthPts.length+
      ' · IQR box=original';

  } else {
    // Categorical or mixed: grouped bar comparison
    var specCat=xIsNum?null:(b.columns&&b.columns.categorical&&b.columns.categorical[colX]);
    var useCol=xIsNum?colY:colX;
    var specUse=b.columns&&(b.columns.categorical&&b.columns.categorical[useCol]);
    if(!specUse){
      ctx.fillStyle='rgba(139,92,246,.4)';ctx.font='11px sans-serif';
      ctx.textAlign='center';ctx.fillText('Select two numeric or two categorical columns',W/2,H/2);
      if(statsEl) statsEl.textContent='';
      return;
    }
    var origFreq=specUse.top_value_ratios||{};
    var cats=Object.keys(origFreq).slice(0,8);
    if(!cats.length){
      ctx.fillStyle='rgba(139,92,246,.4)';ctx.font='11px sans-serif';
      ctx.textAlign='center';ctx.fillText('No category data',W/2,H/2);
      return;
    }
    var synthFreqMap={};
    samples.forEach(function(r){var v=String(r[useCol]||'');synthFreqMap[v]=(synthFreqMap[v]||0)+1;});
    var total=samples.length||1;
    var origVals=cats.map(function(k){return +(origFreq[k]||0);});
    var synthVals2=cats.map(function(k){return (synthFreqMap[k]||0)/total;});
    var maxV=Math.max.apply(null,origVals.concat(synthVals2).concat([0.001]));
    var pad2=28, bottom=H-pad2, top2=10;
    var n=cats.length, slotW=(W-pad2)/n, barW=slotW*0.35;

    ctx.strokeStyle='rgba(255,255,255,.05)';ctx.lineWidth=0.6;
    for(var gi2=0;gi2<=4;gi2++){
      var gy2=top2+(bottom-top2)*gi2/4;
      ctx.beginPath();ctx.moveTo(pad2,gy2);ctx.lineTo(W,gy2);ctx.stroke();
    }
    cats.forEach(function(cat,i){
      var x0=pad2+i*slotW+(slotW-barW*2)/2;
      var v1=origVals[i], v2=synthVals2[i];
      var h1=(v1/maxV)*(bottom-top2);
      var h2=(v2/maxV)*(bottom-top2);
      ctx.fillStyle='rgba(139,92,246,.65)';
      ctx.beginPath();if(ctx.roundRect)ctx.roundRect(x0,bottom-h1,barW,h1,2);else ctx.rect(x0,bottom-h1,barW,h1);ctx.fill();
      ctx.fillStyle='rgba(52,211,153,.65)';
      ctx.beginPath();if(ctx.roundRect)ctx.roundRect(x0+barW+1,bottom-h2,barW,h2,2);else ctx.rect(x0+barW+1,bottom-h2,barW,h2);ctx.fill();
      ctx.fillStyle='rgba(155,142,196,.6)';ctx.font='8px sans-serif';ctx.textAlign='center';
      ctx.fillText(String(cat).substring(0,5),x0+barW,H-4);
    });
    if(statsEl) statsEl.textContent=cats.length+' categories shown · purple=original · green=synthetic';
  }
}

// ── Main fidelity refresh ────────────────────────────────────────────
function refreshMLFidelity(){
  initMLFidelityCols();
  renderKSList();
  renderPairwise();
}

function renderSynthetic(forceRender){
  if(syntheticRendered&&!forceRender)return;
  const root=document.getElementById('synthetic-root');
  if(!root) return;
  const pb=document.getElementById('preview-body');
  const ph=document.getElementById('preview-head');
  if(!pb) return;
  syntheticRendered=true;

  // Re-render ML fidelity panel
  setTimeout(function(){ try{ refreshMLFidelity(); }catch(e){} }, 150);

  if(!D.generator && !D.result && !D.cp){
    pb.innerHTML='<tr><td style="padding:20px;color:var(--fg3)">Run the generator to see results</td></tr>';
    return;
  }
  const allSamples=_getSamples();
  let rows=allSamples.slice(0,50);
  if(!rows.length){
    pb.innerHTML='<tr><td style="padding:20px;color:var(--fg3)">Run the generator to see results</td></tr>';
    return;
  }
  if(synthSortCol&&rows[0]&&synthSortCol in rows[0]){
    const sc=synthSortCol, asc=synthSortAsc;
    rows=rows.slice().sort((a,b)=>{
      const va=a[sc]??'', vb=b[sc]??'';
      return asc?(typeof va==='number'?va-vb:String(va).localeCompare(String(vb)))
               :(typeof vb==='number'?vb-va:String(vb).localeCompare(String(va)));
    });
  }
  const cols=Object.keys(rows[0]||{}).filter(function(c){return c!=='_origin';});
  if(ph) ph.innerHTML='<tr>'+
    cols.map(c=>{
      const ic=synthSortCol===c?(synthSortAsc?' ▲':' ▼'):'';
      return '<th data-sortcol="'+esc(c)+'" onclick="synthSort(this.dataset.sortcol)" title="Sort by '+esc(c)+'">'+esc(c)+'<span class="sort-icon">'+ic+'</span></th>';
    }).join('')+'<th></th></tr>';
  pb.innerHTML=rows.map((r,i)=>{
    const cells=cols.map(c=>'<td>'+esc(String(r[c]??''))+'</td>').join('');
    return '<tr>'+cells+'<td><button class="copy-row-btn" data-idx="'+i+'" onclick="copyRow(+this.dataset.idx)">Copy</button></td></tr>';
  }).join('');
}

function synthSort(col){
  if(synthSortCol===col){ synthSortAsc=!synthSortAsc; }
  else { synthSortCol=col; synthSortAsc=true; }
  syntheticRendered=false;
  renderSynthetic(true);
}

function copyRow(idx){
  const rows=_getSamples();
  if(!rows[idx]) return;
  const text=JSON.stringify(rows[idx],null,2);
  navigator.clipboard?.writeText(text).catch(()=>{});
}
`;
