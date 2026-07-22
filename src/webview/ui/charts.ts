export const CHART_INLINE_FALLBACK_SCRIPT = String.raw`
if(typeof Chart==='undefined'){
(function(global){
  function Chart(canvas,cfg){
    this.canvas=canvas; this.cfg=cfg; this.destroyed=false;
    this._draw();
  }
  Chart.prototype.destroy=function(){ this.destroyed=true; };
  Chart.prototype.update=function(){ if(!this.destroyed) this._draw(); };
  Chart.prototype._draw=function(){
    var canvas=this.canvas, cfg=this.cfg;
    if(!canvas) return;
    var ctx=canvas.getContext('2d');
    if(!ctx) return;
    var W=canvas.offsetWidth||canvas.width||200;
    var H=canvas.offsetHeight||canvas.height||120;
    if(W<10)W=200; if(H<10)H=140;
    canvas.width=W; canvas.height=H;
    ctx.clearRect(0,0,W,H);
    var type=cfg.type||'bar';
    var ds=(cfg.data&&cfg.data.datasets)||[];
    var labels=(cfg.data&&cfg.data.labels)||[];
    if(type==='doughnut'||type==='pie'){
      var vals=ds[0]&&ds[0].data||[]; var colors=ds[0]&&ds[0].backgroundColor||[];
      var circ=cfg.data&&cfg.data.datasets[0].circumference;
      var rot=cfg.data&&cfg.data.datasets[0].rotation;
      var startAngle=(rot!=null?rot*Math.PI/180:0)-Math.PI/2;
      var totalAngle=(circ!=null?circ*Math.PI/180:2*Math.PI);
      var total=vals.reduce(function(a,b){return a+(+b||0);},0)||1;
      var cx=W/2, cy=H/2, r=Math.min(W,H)*0.42;
      var cutout=parseFloat(cfg.options&&cfg.options.cutout)||0;
      var ir=typeof cutout==='string'?r*(parseFloat(cutout)/100):cutout;
      var a=startAngle;
      vals.forEach(function(v,i){
        var sweep=(+v/total)*totalAngle;
        ctx.beginPath(); ctx.moveTo(cx,cy);
        ctx.arc(cx,cy,r,a,a+sweep); ctx.closePath();
        ctx.fillStyle=Array.isArray(colors)?colors[i]||'#8b5cf6':colors;
        ctx.fill();
        a+=sweep;
      });
      if(ir>0){
        ctx.beginPath(); ctx.arc(cx,cy,ir,0,2*Math.PI);
        ctx.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()||'#1e1e1e'; ctx.fill();
      }
  // ── Radar type ───────────────────────────────
    if(type==='radar'){
      var radarData=(cfg.data&&cfg.data.datasets&&cfg.data.datasets[0])||{};
      var radarLabels=(cfg.data&&cfg.data.labels)||[];
      var radarVals=(radarData.data||[]).map(function(v){return Math.max(0,Math.min(100,+v||0));});
      var N=radarLabels.length;
      if(N<3){ctx.fillStyle='rgba(139,92,246,.5)';ctx.font='11px sans-serif';ctx.textAlign='center';ctx.fillText('Risk Radar',W/2,H/2);return;}
      var cx2=W/2,cy2=H/2,R=Math.min(W,H)*0.35,maxV2=100;
      // Grid rings
      [0.25,0.5,0.75,1].forEach(function(f){
        ctx.beginPath();ctx.strokeStyle='rgba(255,255,255,.06)';ctx.lineWidth=0.8;
        for(var i2=0;i2<N;i2++){
          var a2=-Math.PI/2+(i2/N)*2*Math.PI;
          var rx=cx2+R*f*Math.cos(a2),ry=cy2+R*f*Math.sin(a2);
          i2===0?ctx.moveTo(rx,ry):ctx.lineTo(rx,ry);
        }
        ctx.closePath();ctx.stroke();
      });
      // Axes
      for(var ai=0;ai<N;ai++){
        var ang=-Math.PI/2+(ai/N)*2*Math.PI;
        ctx.beginPath();ctx.strokeStyle='rgba(255,255,255,.06)';ctx.lineWidth=0.5;
        ctx.moveTo(cx2,cy2);ctx.lineTo(cx2+R*Math.cos(ang),cy2+R*Math.sin(ang));ctx.stroke();
      }
      // Data polygon
      ctx.beginPath();
      radarVals.forEach(function(v,i3){
        var ang2=-Math.PI/2+(i3/N)*2*Math.PI;
        var rx2=cx2+(v/maxV2)*R*Math.cos(ang2),ry2=cy2+(v/maxV2)*R*Math.sin(ang2);
        i3===0?ctx.moveTo(rx2,ry2):ctx.lineTo(rx2,ry2);
      });
      ctx.closePath();
      ctx.fillStyle=radarData.backgroundColor||'rgba(139,92,246,.22)';ctx.fill();
      ctx.strokeStyle=radarData.borderColor||'rgba(139,92,246,.8)';ctx.lineWidth=radarData.borderWidth||2;ctx.stroke();
      // Points
      radarVals.forEach(function(v,i4){
        var ang3=-Math.PI/2+(i4/N)*2*Math.PI;
        var rx3=cx2+(v/maxV2)*R*Math.cos(ang3),ry3=cy2+(v/maxV2)*R*Math.sin(ang3);
        ctx.beginPath();ctx.arc(rx3,ry3,3,0,2*Math.PI);
        ctx.fillStyle='#a78bfa';ctx.fill();
      });
      // Labels
      ctx.fillStyle='rgba(139,133,180,.7)';ctx.font='8px sans-serif';ctx.textAlign='center';
      radarLabels.forEach(function(lbl,i5){
        var ang4=-Math.PI/2+(i5/N)*2*Math.PI;
        var lx=cx2+(R+14)*Math.cos(ang4),ly=cy2+(R+14)*Math.sin(ang4)+4;
        ctx.fillText(String(lbl),lx,ly);
      });
      return;
    }
    } else {
      var pad=28, bottom=H-pad, top=12;
      var allVals=[];
      ds.forEach(function(d){ (d.data||[]).forEach(function(v){ allVals.push(+v||0); }); });
      var maxV=Math.max.apply(null,allVals.concat([0]))||1;
      var minV=Math.min.apply(null,allVals.concat([0]));
      if(minV>0) minV=0;
      var range=maxV-minV||1;
      var n=Math.max(labels.length,ds[0]&&ds[0].data&&ds[0].data.length||0,1);
      var slotW=(W-pad)/n;
      var barW=slotW*0.5;
      ctx.strokeStyle='rgba(255,255,255,.06)'; ctx.lineWidth=0.5;
      for(var gi=0;gi<=4;gi++){
        var gy=top+(bottom-top)*(gi/4);
        ctx.beginPath(); ctx.moveTo(pad,gy); ctx.lineTo(W,gy); ctx.stroke();
      }
      ds.forEach(function(d,di){
        var dvals=d.data||[];
        var color=Array.isArray(d.backgroundColor)?d.backgroundColor[0]:d.backgroundColor||'rgba(139,92,246,.7)';
        var bcolor=d.borderColor||color;
        var isLine=(d.type==='line'||type==='line');
        if(isLine){
          ctx.beginPath(); ctx.strokeStyle=bcolor; ctx.lineWidth=d.borderWidth||1.5;
          dvals.forEach(function(v,i){
            var x=pad+i*slotW+slotW/2;
            var y=bottom-((+v-minV)/range)*(bottom-top);
            i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
          });
          ctx.stroke();
        } else {
          var bw=barW/(ds.filter(function(dd){return dd.type!=='line';}).length||1);
          dvals.forEach(function(v,i){
            var x=pad+i*slotW+(slotW-barW)/2+di*bw;
            var y=bottom-((+v-minV)/range)*(bottom-top);
            var h=bottom-y;
            if(h<0){y=bottom+Math.abs(h);h=Math.abs(h);}
            ctx.fillStyle=Array.isArray(d.backgroundColor)?d.backgroundColor[i]||color:color;
            ctx.beginPath();
            var rx=Math.min(3,bw/2);
            ctx.roundRect?ctx.roundRect(x,y,bw,h,rx):ctx.rect(x,y,bw,h);
            ctx.fill();
          });
        }
      });
      ctx.fillStyle='rgba(155,142,196,.6)'; ctx.font='9px sans-serif'; ctx.textAlign='center';
      labels.slice(0,n).forEach(function(lbl,i){
        var x=pad+i*slotW+slotW/2;
        ctx.fillText(String(lbl).substring(0,6),x,H-6);
      });
    }
  };
  global.Chart=Chart;
})(window);
}
`;

export const DASHBOARD_STYLES = String.raw`
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  /* VS Code surface variables — fall back gracefully if not in webview context */
  --vsc-bg:         var(--vscode-editor-background,         #1e1e1e);
  --vsc-bg2:        var(--vscode-sideBar-background,        #252526);
  --vsc-bg3:        var(--vscode-editorGroupHeader-tabsBackground, #2d2d2d);
  --vsc-fg:         var(--vscode-editor-foreground,         #d4d4d4);
  --vsc-fg2:        var(--vscode-descriptionForeground,     #8a8a8a);
  --vsc-fg3:        var(--vscode-disabledForeground,        #5a5a5a);
  --vsc-border:     var(--vscode-widget-border,             rgba(255,255,255,.10));
  --vsc-border2:    var(--vscode-focusBorder,               rgba(255,255,255,.18));
  --vsc-input:      var(--vscode-input-background,          #3c3c3c);
  --vsc-btn:        var(--vscode-button-background,         #0e639c);
  --vsc-btn-fg:     var(--vscode-button-foreground,         #ffffff);
  --vsc-sel:        var(--vscode-list-activeSelectionBackground, #094771);
  --vsc-hover:      var(--vscode-list-hoverBackground,      rgba(255,255,255,.05));

  /* Aurora accent — used ONLY for data viz, graphs, security indicators, LLM chat */
  --aurora-p0:#1e0057;--aurora-p1:#4c1d95;--aurora-p2:#6d28d9;--aurora-p3:#7c3aed;
  --aurora-p4:#8b5cf6;--aurora-p5:#a78bfa;--aurora-p6:#c084fc;--aurora-p7:#ddd6fe;
  --aurora-glow:rgba(139,92,246,.45);--aurora-glow2:rgba(139,92,246,.18);
  --aurora-grad:linear-gradient(135deg,#7c3aed,#9333ea,#a855f7,#c084fc);
  --aurora-green:#34d399;--aurora-red:#f87171;--aurora-orange:#fb923c;--aurora-yellow:#fbbf24;
  --aurora-border:rgba(139,92,246,.18);--aurora-border2:rgba(139,92,246,.38);

  /* Aliases used throughout components */
  --bg:  var(--vsc-bg);
  --bg2: var(--vsc-bg2);
  --bg3: var(--vsc-bg3);
  --card: var(--vsc-bg2);
  --card2:var(--vsc-bg3);
  --card3:rgba(255,255,255,.03);
  --fg:  var(--vsc-fg);
  --fg2: var(--vsc-fg2);
  --fg3: var(--vsc-fg3);
  --border: var(--vsc-border);
  --border2:var(--vsc-border2);
  --font:var(--vscode-font-family,-apple-system,'Segoe UI',Roboto,sans-serif);
  --r:10px;

  /* Keep Aurora shorthand for data-viz components */
  --p0:var(--aurora-p0);--p1:var(--aurora-p1);--p2:var(--aurora-p2);--p3:var(--aurora-p3);
  --p4:var(--aurora-p4);--p5:var(--aurora-p5);--p6:var(--aurora-p6);--p7:var(--aurora-p7);
  --green:var(--aurora-green);--red:var(--aurora-red);--orange:var(--aurora-orange);--yellow:var(--aurora-yellow);
  --grad:var(--aurora-grad);--glow:var(--aurora-glow);--glow2:var(--aurora-glow2);
}
html,body{min-height:100%;background:var(--bg);color:var(--fg);font-family:var(--font);font-size:13px;line-height:1.5;overflow-x:hidden}
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--aurora-p3);border-radius:3px}

/* ── Header ──────────────────────────────────────────────────────────── */
.hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 20px;border-bottom:1px solid var(--border);background:var(--bg2);position:sticky;top:0;z-index:100}
.logo{display:flex;align-items:center;gap:10px}
.logo-mark{width:32px;height:32px;border-radius:7px;background:transparent;display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden}
.logo-title{font-size:14px;font-weight:700;letter-spacing:-.02em;color:var(--fg)}
.logo-sub{font-size:10px;color:var(--fg3);margin-top:1px;letter-spacing:.01em}
.hdr-right{display:flex;gap:6px;align-items:center}
.hbtn{display:inline-flex;align-items:center;gap:4px;padding:5px 12px;border-radius:6px;font-size:11px;font-weight:500;cursor:pointer;border:none;transition:background .15s,color .15s}
.hbtn-g{background:transparent;color:var(--fg2);border:1px solid var(--border2)}
.hbtn-g:hover{background:var(--vsc-hover);color:var(--fg)}
.hbtn-p{background:var(--aurora-grad);color:#fff;box-shadow:0 2px 10px rgba(124,58,237,.35)}
.hbtn-p:hover{opacity:.88}
.data-mode-toggle{display:flex;align-items:center;background:var(--bg);border:1px solid var(--border2);border-radius:7px;padding:2px;gap:2px}
.dmt-btn{font-size:10px;font-weight:600;padding:3px 10px;border-radius:5px;border:none;cursor:pointer;background:transparent;color:var(--fg3);letter-spacing:.02em;transition:background .15s,color .15s}
.dmt-btn:hover{color:var(--fg)}
.dmt-btn.active{background:var(--aurora-p3);color:#fff;box-shadow:0 1px 6px rgba(109,40,217,.4)}

/* ── Status strip ──────────────────────────────────────────────────── */
.strip{display:flex;gap:6px;padding:7px 20px;border-bottom:1px solid var(--border);background:var(--bg);overflow-x:auto;flex-shrink:0}
.spill{display:flex;align-items:center;gap:10px;padding:4px 14px;background:var(--bg2);border:1px solid var(--border);border-radius:16px;white-space:nowrap;flex-shrink:0;transition:border-color .2s}
.spill:hover{border-color:var(--border2)}
.sl{font-size:9px;color:var(--fg3);text-transform:uppercase;letter-spacing:.07em}
.sv{font-size:12px;font-weight:700;margin-top:1px;color:var(--fg)}

/* ── Tabs ──────────────────────────────────────────────────────────── */
.tabs{display:flex;gap:1px;padding:0 20px;background:var(--bg2);border-bottom:1px solid var(--border);overflow-x:auto}
.tab{padding:8px 16px;font-size:11px;font-weight:500;cursor:pointer;border:none;background:transparent;color:var(--fg2);border-bottom:2px solid transparent;transition:color .15s;white-space:nowrap}
.tab.active{color:var(--fg);border-bottom-color:var(--aurora-p4)}
.tab:hover:not(.active){color:var(--fg);background:var(--vsc-hover)}
.tabpane{display:none}

/* ── Grid ──────────────────────────────────────────────────────────── */
.grid{display:grid;grid-template-columns:repeat(3,1fr);grid-auto-rows:minmax(210px,auto);gap:16px;padding:16px 20px 28px}
@media(max-width:1000px){.grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:600px) {.grid{grid-template-columns:1fr}}

/* ── Card ──────────────────────────────────────────────────────────── */
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:14px;display:flex;flex-direction:column;gap:8px;position:relative;overflow:hidden;transition:border-color .22s}
.card:hover{border-color:var(--border2)}
.card.span2{grid-column:span 2}
/* Subtle aurora inner glow on cards — just top-left radial, very faint */
.card::after{content:'';position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at 0% 0%,rgba(139,92,246,.04) 0%,transparent 60%)}
.ch{display:flex;align-items:flex-start;justify-content:space-between;gap:5px}
.ct{font-size:12px;font-weight:600;letter-spacing:-.01em;color:var(--fg)}
.cs{font-size:10px;color:var(--fg3);margin-top:2px;line-height:1.4}
.ib{background:transparent;border:1px solid var(--border);color:var(--fg3);cursor:pointer;width:22px;height:22px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:11px;transition:all .15s;flex-shrink:0}
.ib:hover{border-color:var(--aurora-p4);color:var(--aurora-p5)}

/* ── Buttons ──────────────────────────────────────────────────────── */
/* Primary — Aurora gradient for data-action buttons */
.abtn{padding:7px 14px;border:none;border-radius:7px;margin-top:auto;background:var(--aurora-grad);color:#fff;font-size:11px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(124,58,237,.3);transition:all .15s;width:100%}
.abtn:hover{opacity:.86;box-shadow:0 2px 14px rgba(124,58,237,.5)}
.abtn:disabled{opacity:.4;cursor:default;box-shadow:none}
/* Secondary — VS Code ghost button */
.agbtn{padding:6px;border:1px solid var(--border);border-radius:7px;background:transparent;color:var(--fg2);font-size:11px;font-weight:500;cursor:pointer;transition:all .15s;margin-top:auto;text-align:center;width:100%}
.agbtn:hover{background:var(--vsc-hover);color:var(--fg);border-color:var(--border2)}

/* ── Big number ──────────────────────────────────────────────────── */
/* Aurora accent only for the data highlight number */
.bnum{font-size:30px;font-weight:800;line-height:1;letter-spacing:-.04em;background:var(--aurora-grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.bsub{font-size:10px;color:var(--fg3);margin-top:3px}

/* ── Risk badges ─────────────────────────────────────────────────── */
.rbadge{display:inline-block;padding:2px 8px;border-radius:8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.rc-crit{background:rgba(248,113,113,.12);color:#f87171;border:1px solid rgba(248,113,113,.28)}
.rc-warn{background:rgba(251,146,60,.12);color:#fb923c;border:1px solid rgba(251,146,60,.28)}
.rc-low {background:rgba(52,211,153,.10);color:#34d399;border:1px solid rgba(52,211,153,.25)}
.rc-unk {background:rgba(139,92,246,.10);color:var(--aurora-p5);border:1px solid var(--aurora-border)}
.badge-warning{display:inline-block;padding:2px 8px;border-radius:8px;font-size:10px;font-weight:600;color:#f59e0b;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.28);cursor:default;margin-left:6px}
.metric-badge{margin-left:6px;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600}
.metric-subtext{font-size:11px;opacity:0.75;margin-top:4px;text-align:center}

/* ── Donut ──────────────────────────────────────────────────────── */
.dw{position:relative;width:120px;height:120px;margin:0 auto;flex-shrink:0}
.dc{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}
.dv{font-size:24px;font-weight:800;letter-spacing:-.03em;color:var(--fg)}
.dl{font-size:9px;color:var(--fg3);text-transform:uppercase;letter-spacing:.07em}
.dct{text-align:center;font-size:12px;font-weight:600}

/* ── Legend ─────────────────────────────────────────────────────── */
.leg{display:flex;flex-wrap:wrap;gap:7px;justify-content:center}
.li{display:flex;align-items:center;gap:4px;font-size:9px;color:var(--fg3)}
.ld{width:6px;height:6px;border-radius:50%;flex-shrink:0}

/* ── Mini bars — Aurora color for data ──────────────────────────── */
.mbars{display:flex;align-items:flex-end;gap:3px;flex:1;min-height:56px}
.mb{flex:1;border-radius:3px 3px 0 0;min-height:4px;background:linear-gradient(to top,var(--aurora-p2),var(--aurora-p4));transition:height .45s cubic-bezier(.34,1.5,.64,1)}
.mb.dim{background:var(--card2)}
.mb.hot{background:linear-gradient(to top,var(--aurora-red),#f43f5e)}
.mb.warm{background:linear-gradient(to top,var(--aurora-p2),var(--aurora-p4))}
.mb.cool{background:linear-gradient(to top,var(--aurora-p3),var(--aurora-p6))}

/* ── Skill bars — Aurora for data ──────────────────────────────── */
.skills{display:flex;flex-direction:column;gap:7px;flex:1}
.sk{display:flex;flex-direction:column;gap:3px}
.skl{display:flex;justify-content:space-between;font-size:10px;color:var(--fg3)}
.skt{height:5px;background:var(--card3);border-radius:3px;overflow:hidden}
.skf{height:100%;border-radius:3px;transition:width .65s cubic-bezier(.34,1.2,.64,1)}
.sk1{background:linear-gradient(90deg,var(--aurora-p2),var(--aurora-p5))}
.sk2{background:linear-gradient(90deg,var(--aurora-p1),var(--aurora-p4))}
.sk3{background:linear-gradient(90deg,var(--aurora-p3),var(--aurora-p6))}
.sk4{background:linear-gradient(90deg,#059669,#34d399)}

/* ── Metric row ─────────────────────────────────────────────────── */
.mvrow{display:flex;align-items:center;justify-content:space-between}
.mvl{font-size:10px;color:var(--fg3)}
.mvv{font-size:18px;font-weight:800;letter-spacing:-.02em;color:var(--fg)}

/* ── Canvas ─────────────────────────────────────────────────────── */
canvas{max-width:100%}
.cbox{flex:1;position:relative;min-height:72px;max-height:110px}

/* ── Heatmap ─────────────────────────────────────────────────────── */
.hmap{display:grid;gap:2px;flex:1}
.hc{border-radius:3px;aspect-ratio:1;cursor:pointer;transition:opacity .15s}
.hc:hover{opacity:.7}

/* ── Concentric rings ─────────────────────────────────────────────── */
.rw{position:relative;width:140px;height:140px;margin:2px auto;flex-shrink:0}
.rc{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}
.rv{font-size:24px;font-weight:800;letter-spacing:-.04em;color:var(--fg)}
.rl{font-size:9px;color:var(--fg3);text-transform:uppercase;letter-spacing:.07em}
.pchip{display:inline-block;padding:3px 10px;border-radius:10px;background:var(--card2);border:1px solid var(--border);font-size:9px;font-weight:500;color:var(--fg3)}

/* ── Pipeline timeline ─────────────────────────────────────────── */
.timeline{display:flex;flex-direction:column;gap:5px;flex:1}
.tl-step{display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:7px;border:1px solid var(--border);background:var(--card2);transition:border-color .2s}
.tl-step.done{border-color:rgba(52,211,153,.3)}
.tl-step.fail{border-color:rgba(248,113,113,.3)}
.tl-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--fg3)}
.tl-step.done .tl-dot{background:var(--aurora-green)}
.tl-step.fail .tl-dot{background:var(--aurora-red)}
.tl-step.active .tl-dot{background:var(--aurora-p4);box-shadow:0 0 7px var(--aurora-glow)}
.tl-name{font-size:11px;font-weight:600;flex:1;color:var(--fg)}
.tl-info{font-size:10px;color:var(--fg3)}

/* ── Status note ────────────────────────────────────────────────── */
.snote{padding:6px;text-align:center;font-size:10px;color:var(--fg3);border:1px solid var(--border);border-radius:7px;margin-top:auto}

/* ── Schema table ───────────────────────────────────────────────── */
.stab-grid{padding:14px 20px}
.stab-table{width:100%;border-collapse:collapse;font-size:12px}
.stab-table th{text-align:left;padding:6px 10px;background:var(--card2);font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--fg3);position:sticky;top:0}
.stab-table td{padding:6px 10px;border-bottom:1px solid var(--border)}
.stab-table tr:hover td{background:var(--vsc-hover)}

/* ── Synthetic preview table ────────────────────────────────────── */
.preview-wrap{overflow-x:auto;padding:14px 20px}
.preview-table{border-collapse:collapse;font-size:11px;white-space:nowrap}
.preview-table th{padding:5px 10px;background:var(--card2);font-size:10px;font-weight:600;color:var(--fg3);text-align:left;border-bottom:1px solid var(--border)}
.preview-table td{padding:4px 10px;border-bottom:1px solid var(--border);color:var(--fg2)}
.preview-table tr:hover td{background:var(--vsc-hover);color:var(--fg)}

/* ── Threats ────────────────────────────────────────────────────── */
.threats-wrap{padding:14px 20px;display:flex;flex-direction:column;gap:10px}
.threat-card{background:var(--card);border:1px solid var(--border);border-radius:9px;padding:12px;display:flex;flex-direction:column;gap:5px}
.threat-card.sev-high{border-color:rgba(248,113,113,.38)}
.threat-card.sev-medium{border-color:rgba(251,146,60,.38)}
.threat-card.sev-low{border-color:rgba(52,211,153,.28)}
.thr-name{font-size:13px;font-weight:600;color:var(--fg)}
.thr-desc{font-size:11px;color:var(--fg2);line-height:1.5}
.thr-cols{font-size:10px;color:var(--fg3)}

/* ── Diagnostics ────────────────────────────────────────────────── */
.diag-wrap{padding:14px 20px;display:flex;flex-direction:column;gap:8px}
.diag-row{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--card);border:1px solid var(--border);border-radius:7px}
.diag-key{font-size:11px;color:var(--fg3)}
.diag-val{font-size:12px;font-weight:600;color:var(--fg)}

/* ── Misc ───────────────────────────────────────────────────────── */
.btmrow{display:flex;align-items:center;justify-content:space-between;margin-top:auto}
.bpct{font-size:20px;font-weight:800;letter-spacing:-.03em}

/* ── PII column badge ───────────────────────────────────────────── */
.pii-col-badge{background:rgba(251,146,60,.12);border:1px solid rgba(251,146,60,.28);padding:1px 6px;border-radius:4px;font-size:9px;font-weight:600;color:#fb923c}

/* ── Distribution Comparison ────────────────────────────────────── */
.dist-sel{background:var(--vsc-input);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;outline:none;width:100%}
.dist-sel:focus{border-color:var(--aurora-p4)}
.dist-legend{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.dist-li{display:flex;align-items:center;gap:4px;font-size:9px;color:var(--fg3)}
.dist-dot{width:8px;height:2px;border-radius:1px;flex-shrink:0}

/* ── Correlation heatmap ────────────────────────────────────────── */
.corr-wrap{flex:1;overflow:auto;display:flex;align-items:flex-start;justify-content:center}
.corr-tbl{border-collapse:collapse;font-size:9px;table-layout:fixed}
.corr-tbl th{padding:3px 6px;color:var(--fg3);font-weight:500;text-align:center;white-space:nowrap;font-size:9px;max-width:60px;overflow:hidden;text-overflow:ellipsis}
.corr-tbl thead th:first-child{min-width:56px}
.corr-tbl tbody th{text-align:right;padding:2px 8px 2px 4px;color:var(--fg3);font-weight:500;white-space:nowrap;font-size:9px;min-width:56px}
.corr-tbl td{width:36px;height:36px;text-align:center;font-size:9px;font-weight:600;cursor:default;border-radius:4px;transition:opacity .15s;border:2px solid transparent}
.corr-tbl td:hover{opacity:.8;border-color:rgba(255,255,255,.18)}

/* ── Fingerprint card ───────────────────────────────────────────── */
.fp-row{display:flex;flex-direction:column;gap:4px;padding:7px 10px;background:var(--card2);border:1px solid var(--border);border-radius:7px}
.fp-lbl{font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--fg3)}
.fp-hash{font-family:monospace;font-size:11px;color:var(--aurora-p5);word-break:break-all;letter-spacing:.04em}
.fp-copy{margin-top:3px;padding:2px 8px;font-size:9px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--fg3);cursor:pointer;transition:all .15s;float:right}
.fp-copy:hover{background:var(--vsc-hover);color:var(--fg)}

/* ── Sanity warning banner ──────────────────────────────────────── */
.warn-banner{margin:10px 20px 0;padding:8px 14px;background:rgba(251,146,60,.08);border:1px solid rgba(251,146,60,.3);border-radius:8px;font-size:11px;display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap}
.warn-item{color:#fb923c;display:flex;align-items:center;gap:4px}
.crit-banner{background:rgba(248,113,113,.07);border-color:rgba(248,113,113,.28)}
.crit-banner .warn-item{color:#f87171}

/* ── Privacy risk breakdown ─────────────────────────────────────── */
.prisk-list{display:flex;flex-direction:column;gap:7px;flex:1}
.prisk-row{display:flex;flex-direction:column;gap:3px}
.prisk-lbl{display:flex;justify-content:space-between;font-size:10px;color:var(--fg3)}
.prisk-bar{height:5px;background:var(--card3);border-radius:3px;overflow:hidden}
.prisk-fill{height:100%;border-radius:3px;transition:width .65s cubic-bezier(.34,1.2,.64,1)}

/* ── Drift heatmap rows ─────────────────────────────────────────── */
.dh-row{display:flex;align-items:center;gap:6px;font-size:10px;padding:3px 0;border-bottom:1px solid var(--border)}
.dh-lbl{width:90px;color:var(--fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
.dh-bar-wrap{flex:1;height:7px;background:var(--card3);border-radius:4px;overflow:hidden}
.dh-bar-fill{height:100%;border-radius:4px;transition:width .55s ease}
.dh-val{width:40px;text-align:right;color:var(--fg3);font-size:9px}

/* ── Column explorer ────────────────────────────────────────────── */
.col-grid{display:grid;grid-template-columns:180px 1fr;gap:0;flex:1;overflow:hidden}
.col-list{overflow-y:auto;border-right:1px solid var(--border);padding:6px 0}
.col-item{padding:6px 14px;font-size:11px;cursor:pointer;border-left:2px solid transparent;transition:all .15s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--fg2)}
.col-item:hover{background:var(--vsc-hover);color:var(--fg)}
.col-item.selected{border-left-color:var(--aurora-p4);background:rgba(139,92,246,.07);color:var(--aurora-p5)}
.col-detail{padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
.col-stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.col-stat{background:var(--card2);border-radius:7px;padding:8px;text-align:center}
.col-stat-v{font-size:16px;font-weight:700;color:var(--aurora-p5)}
.col-stat-l{font-size:9px;color:var(--fg3);text-transform:uppercase;margin-top:2px}

/* ── Collapsible threat details ─────────────────────────────────── */
.thr-toggle{background:none;border:none;color:var(--fg3);font-size:10px;cursor:pointer;padding:0;text-align:left;margin-top:3px}
.thr-toggle:hover{color:var(--aurora-p5)}
.thr-body{display:none;margin-top:5px;padding:8px;background:var(--card2);border-radius:6px;font-size:11px;color:var(--fg2);line-height:1.6}
.thr-body.open{display:block}

/* ── Table sort ─────────────────────────────────────────────────── */
.preview-table th{cursor:pointer;user-select:none}
.preview-table th:hover{color:var(--aurora-p5)}
.sort-icon{margin-left:3px;opacity:.5;font-size:9px}
.copy-row-btn{padding:1px 6px;font-size:9px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--fg3);cursor:pointer;transition:all .15s}
.copy-row-btn:hover{background:var(--vsc-hover);color:var(--fg)}

/* ── Security scan tab ──────────────────────────────────────────── */
.sec-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:14px}
.sec-stat{background:var(--card2);border:1px solid var(--border);border-radius:9px;padding:12px;text-align:center}
.sec-stat-v{font-size:22px;font-weight:800;color:var(--fg)}
.sec-stat-l{font-size:9px;color:var(--fg3);text-transform:uppercase;margin-top:3px}
.sec-finding{padding:8px 12px;background:var(--card);border:1px solid var(--border);border-radius:7px;display:flex;align-items:center;gap:10px;margin-bottom:4px}
.sec-finding .sf-type{font-size:9px;text-transform:uppercase;font-weight:700;width:60px;flex-shrink:0;color:var(--aurora-p5)}
.sec-finding .sf-cat{font-size:11px;color:var(--fg2);flex:1}
.sec-finding .sf-sev{font-size:9px;padding:2px 8px;border-radius:7px}

/* ── Live Security tab ──────────────────────────────────────────── */
.lsec-wrap{padding:14px 20px}
.lsec-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.lsec-title{font-size:13px;font-weight:700;color:var(--fg)}
.lsec-badge{font-size:10px;padding:3px 10px;border-radius:10px;font-weight:700}
.lsec-badge.safe{background:rgba(52,211,153,.12);color:var(--aurora-green)}
.lsec-badge.active{background:rgba(248,113,113,.12);color:var(--aurora-red);animation:pulse-badge 2s infinite}
@keyframes pulse-badge{0%,100%{opacity:1}50%{opacity:.4}}
.lsec-controls{display:flex;gap:6px}
.lsec-btn{padding:4px 10px;font-size:10px;border:1px solid var(--border);border-radius:5px;background:transparent;color:var(--fg3);cursor:pointer;transition:all .15s}
.lsec-btn:hover{background:var(--vsc-hover);color:var(--fg)}
.lsec-stats{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:12px}
.lsec-stat-box{background:var(--card2);border:1px solid var(--border);border-radius:9px;padding:10px;text-align:center}
.lsec-stat-n{font-size:20px;font-weight:800;margin-bottom:2px;color:var(--fg)}
.lsec-stat-l{font-size:9px;color:var(--fg3);text-transform:uppercase}
.lsec-filter{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
.lsec-chip{padding:3px 10px;border-radius:10px;font-size:10px;border:1px solid var(--border);background:transparent;color:var(--fg3);cursor:pointer;transition:all .15s}
.lsec-chip.active{background:var(--aurora-p3);color:#fff;border-color:var(--aurora-p3)}
.lsec-chip:hover:not(.active){border-color:var(--border2);color:var(--fg)}
.lsec-table-wrap{overflow-x:auto}
.lsec-table{width:100%;border-collapse:collapse;font-size:11px}
.lsec-table th{text-align:left;padding:6px 10px;background:var(--card2);font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);border-bottom:1px solid var(--border);white-space:nowrap}
.lsec-table td{padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
.lsec-table tr:hover td{background:var(--vsc-hover)}
.lsec-sev{font-size:9px;padding:2px 8px;border-radius:7px;font-weight:700;text-transform:uppercase}
.lsec-sev.critical{background:rgba(248,113,113,.15);color:#f87171}
.lsec-sev.high{background:rgba(251,146,60,.15);color:#fb923c}
.lsec-sev.medium{background:rgba(251,191,36,.12);color:#fbbf24}
.lsec-sev.low{background:rgba(52,211,153,.10);color:var(--aurora-green)}
.lsec-policy{font-size:9px;padding:2px 7px;border-radius:7px}
.lsec-policy.blocked{background:rgba(248,113,113,.12);color:#f87171}
.lsec-policy.warned{background:rgba(251,191,36,.10);color:#fbbf24}
.lsec-policy.logged{background:rgba(139,92,246,.08);color:var(--aurora-p5)}
.lsec-snippet{font-family:monospace;font-size:10px;color:var(--fg3);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lsec-empty{text-align:center;padding:40px 20px;color:var(--fg3);font-size:12px}
.lsec-ticker{display:flex;align-items:center;gap:8px;padding:7px 12px;background:rgba(248,113,113,.05);border:1px solid rgba(248,113,113,.18);border-radius:7px;margin-bottom:12px;font-size:11px;color:var(--fg2)}
.lsec-ticker-dot{width:7px;height:7px;border-radius:50%;background:#f87171;animation:pulse-badge 1.5s infinite;flex-shrink:0}

/* ── AI Agent Chat ───────────────────────────────────────────────── */
.agent-layout{display:grid;grid-template-columns:210px 1fr;height:calc(100vh - 210px);min-height:420px;overflow:hidden}
.agent-sidebar{background:var(--bg2);border-right:1px solid var(--border);padding:10px 8px;display:flex;flex-direction:column;gap:5px;overflow-y:auto;flex-shrink:0}
.agent-sidebar-hdr{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--fg3);padding:2px 6px 6px;border-bottom:1px solid var(--border);margin-bottom:4px}
.aab{padding:7px 9px;border:1px solid var(--border);border-radius:7px;background:var(--card);color:var(--fg2);font-size:10px;cursor:pointer;text-align:left;transition:all .15s;display:flex;align-items:flex-start;gap:7px;line-height:1.3}
.aab:hover{background:var(--vsc-hover);color:var(--fg);border-color:var(--border2)}
.aab .aab-icon{font-size:13px;flex-shrink:0;margin-top:1px}
.aab .aab-label{font-weight:600;display:block;margin-bottom:1px}
.aab .aab-desc{font-size:9px;color:var(--fg3);display:block}
.agent-main{display:flex;flex-direction:column;overflow:hidden}
.agent-history{flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:8px}
.agent-msg{max-width:88%;display:flex;flex-direction:column;gap:3px}
.agent-msg.user{align-self:flex-end;align-items:flex-end}
.agent-msg.assistant{align-self:flex-start;align-items:flex-start}
.agent-bubble{padding:9px 13px;border-radius:12px;font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-word}
/* Aurora gradient for user chat bubbles — this IS a data/AI interaction surface */
.agent-msg.user .agent-bubble{background:var(--aurora-p3);color:#fff;border-bottom-right-radius:3px}
.agent-msg.assistant .agent-bubble{background:var(--card2);color:var(--fg);border:1px solid var(--border);border-bottom-left-radius:3px}
.agent-msg-meta{font-size:9px;color:var(--fg3)}
.agent-thinking{display:flex;gap:5px;padding:10px 14px;background:var(--card2);border:1px solid var(--border);border-radius:12px;border-bottom-left-radius:3px;align-self:flex-start}
.agent-thinking span{width:6px;height:6px;border-radius:50%;background:var(--aurora-p4);animation:agent-bounce 1.2s infinite}
.agent-thinking span:nth-child(2){animation-delay:.2s}
.agent-thinking span:nth-child(3){animation-delay:.4s}
@keyframes agent-bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}
.agent-input-area{padding:10px 12px;border-top:1px solid var(--border);background:var(--bg2);display:flex;gap:8px;align-items:flex-end;flex-shrink:0}
.agent-input{flex:1;background:var(--vsc-input);border:1px solid var(--border);color:var(--fg);border-radius:8px;padding:8px 12px;font-size:12px;font-family:var(--font);outline:none;resize:none;line-height:1.5;min-height:36px;max-height:120px;overflow-y:auto}
.agent-input:focus{border-color:var(--aurora-p4)}
/* Aurora gradient for send button — AI action element */
.agent-send-btn{padding:8px 14px;background:var(--aurora-grad);color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s;white-space:nowrap;flex-shrink:0}
.agent-send-btn:hover{opacity:.87}
.agent-send-btn:disabled{opacity:.4;cursor:default}
.agent-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;padding:30px;color:var(--fg3);text-align:center}
.agent-empty-icon{font-size:36px;margin-bottom:10px}
.agent-empty-title{font-size:13px;font-weight:600;color:var(--fg2);margin-bottom:6px}
.agent-empty-sub{font-size:11px;line-height:1.5}
.agent-sql{background:var(--card2);border:1px solid var(--aurora-border);border-radius:7px;padding:10px 14px;font-family:monospace;font-size:11px;color:var(--aurora-p7);margin:4px 0;position:relative}
.agent-sql-copy{position:absolute;top:6px;right:8px;font-size:9px;padding:2px 7px;border:1px solid var(--aurora-border);border-radius:4px;background:transparent;color:var(--aurora-p5);cursor:pointer;transition:background .15s}
.agent-sql-copy:hover{background:rgba(139,92,246,.15)}
.agent-artifact-card{display:flex;align-items:center;gap:10px;margin-top:8px;padding:9px 13px;background:rgba(108,76,255,.07);border:1px solid rgba(108,76,255,.22);border-radius:9px;font-size:11px;color:var(--fg2)}
.agent-artifact-card .artifact-icon{font-size:14px;flex-shrink:0}
.agent-artifact-card .artifact-label{flex:1;line-height:1.4}
.agent-artifact-card .artifact-export-btn{padding:5px 13px;background:var(--aurora-p3);border:none;border-radius:6px;color:#fff;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;transition:opacity .15s}
.agent-artifact-card .artifact-export-btn:hover{opacity:.86}
.agent-artifact-card .artifact-export-btn:disabled{opacity:.45;cursor:default}
/* Context bar */
.agent-ctx-bar{display:flex;align-items:center;gap:8px;padding:5px 16px;background:var(--bg2);border-bottom:1px solid var(--border);font-size:10px;color:var(--fg3);flex-shrink:0}
.agent-ctx-dot{width:7px;height:7px;border-radius:50%}
.agent-ctx-dot.ok{background:var(--aurora-green)}
.agent-ctx-dot.warn{background:var(--aurora-yellow)}
.agent-ctx-dot.none{background:var(--fg3)}
/* API key config strip */
.agent-config{display:flex;align-items:center;gap:8px;padding:8px 16px;background:rgba(251,146,60,.05);border-bottom:1px solid rgba(251,146,60,.2);flex-shrink:0;flex-wrap:wrap}
.agent-config label{font-size:10px;color:#fb923c;font-weight:600;white-space:nowrap}
.agent-config-select{background:var(--vsc-input);border:1px solid rgba(251,146,60,.35);border-radius:6px;color:var(--fg);font-size:11px;padding:5px 8px;outline:none;cursor:pointer;min-width:150px}
.agent-config-select:focus{border-color:#fb923c}
.agent-config-input{flex:1;min-width:180px;max-width:320px;background:var(--vsc-input);border:1px solid rgba(251,146,60,.35);border-radius:6px;color:var(--fg);font-size:11px;padding:5px 10px;outline:none}
.agent-config-input:focus{border-color:#fb923c}
.agent-config-btn{padding:5px 12px;background:rgba(251,146,60,.15);border:1px solid rgba(251,146,60,.4);border-radius:6px;color:#fb923c;font-size:11px;cursor:pointer;font-weight:600;white-space:nowrap}
.agent-config-btn:hover{background:rgba(251,146,60,.25)}
.agent-config-ok{font-size:10px;color:var(--aurora-green);margin-left:4px}

/* Confirm overlay */
.agent-confirm-overlay{position:absolute;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:120;border-radius:inherit}
#agent-root{position:relative}
.agent-confirm-box{background:var(--card);border:1px solid var(--aurora-border);border-radius:12px;padding:20px 22px;min-width:240px;max-width:340px;box-shadow:0 8px 32px rgba(0,0,0,.4);display:flex;flex-direction:column;gap:12px}
.agent-confirm-title{font-size:13px;font-weight:700;color:var(--fg)}
.agent-confirm-body{font-size:12px;color:var(--fg2);line-height:1.6;background:var(--bg2);border:1px solid var(--border);border-radius:7px;padding:8px 11px;white-space:pre-wrap}
.agent-confirm-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:2px}
.agent-confirm-yes{padding:7px 18px;background:var(--aurora-p3);border:none;border-radius:7px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s}
.agent-confirm-yes:hover{opacity:.86}
.agent-confirm-no{padding:7px 14px;background:transparent;border:1px solid var(--border);border-radius:7px;color:var(--fg2);font-size:12px;font-weight:500;cursor:pointer;transition:background .15s}
.agent-confirm-no:hover{background:var(--vsc-hover)}

/* Lineage */
.lineage-wrap{padding:14px 20px}
.lin-step{display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--card);border:1px solid var(--border);border-radius:9px;margin-bottom:6px;position:relative}
.lin-step::before{content:'';position:absolute;left:24px;top:100%;width:2px;height:6px;background:var(--border)}
.lin-step:last-child::before{display:none}
.lin-dot{width:11px;height:11px;border-radius:50%;flex-shrink:0;background:var(--aurora-p4);box-shadow:0 0 7px var(--aurora-glow)}
.lin-dot.fail{background:var(--aurora-red)}
.lin-name{font-size:12px;font-weight:600;flex:1;color:var(--fg)}
.lin-meta{font-size:10px;color:var(--fg3)}
.lin-hash{font-family:monospace;font-size:9px;color:var(--aurora-p5);letter-spacing:.04em}

/* Knowledge graph */
.kg-wrap{padding:14px 20px}
.kg-entity{display:inline-flex;align-items:center;gap:6px;padding:5px 13px;background:var(--card2);border:1px solid var(--border);border-radius:16px;margin:3px;font-size:11px;color:var(--aurora-p5);font-weight:500;cursor:default;transition:all .15s}
.kg-entity:hover{background:rgba(139,92,246,.1);border-color:var(--aurora-p4)}
.kg-edge{font-size:10px;color:var(--fg3);padding:4px 0;margin-left:20px}

/* Privacy Attack Gauges — Aurora color for security data viz */
.atk-gauges{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px}
.atk-gauge{flex:1;min-width:110px;background:var(--card2);border:1px solid var(--border);border-radius:9px;padding:12px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:6px}
.atk-gauge-ring{position:relative;width:72px;height:72px}
.atk-gauge-val{font-size:18px;font-weight:800;letter-spacing:-.03em;color:var(--fg)}
.atk-gauge-lbl{font-size:9px;color:var(--fg3);text-transform:uppercase;letter-spacing:.06em;text-align:center;line-height:1.3}

/* Dataset Reliability card */
.ris-bar{height:7px;background:var(--card3);border-radius:4px;overflow:hidden;margin:6px 0}
.ris-fill{height:100%;border-radius:4px;transition:width .7s cubic-bezier(.34,1.2,.64,1)}

/* Agent chat bubble styles */
.agent-chat{display:flex;flex-direction:column;height:calc(100vh - 260px);min-height:340px;padding:14px 20px;gap:0}
.agent-messages{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding-bottom:12px}
/* Aurora for user message — it IS the AI interaction surface */
.agent-user{background:var(--aurora-p3);color:#fff;padding:10px 14px;border-radius:14px 14px 4px 14px;font-size:12px;line-height:1.6;align-self:flex-end;max-width:75%;word-break:break-word;box-shadow:0 2px 10px rgba(108,76,255,.3)}
.agent-ai{background:var(--card2);color:var(--fg);border:1px solid var(--border);padding:10px 14px;border-radius:14px 14px 14px 4px;font-size:12px;line-height:1.65;align-self:flex-start;max-width:85%;word-break:break-word;white-space:pre-wrap}
.agent-ai.thinking{opacity:.6;font-style:italic}
.agent-approval-card{animation:agent-slide-in .18s ease-out}
@keyframes agent-slide-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.agent-input-row{display:flex;gap:8px;padding-top:10px;border-top:1px solid var(--border);flex-shrink:0}
.agent-text-input{flex:1;background:var(--vsc-input);border:1px solid var(--border);color:var(--fg);border-radius:8px;padding:9px 13px;font-size:12px;font-family:var(--font);outline:none}
.agent-text-input:focus{border-color:var(--aurora-p4)}
/* Aurora for LLM send button */
.agent-send-simple{padding:9px 18px;background:var(--aurora-grad);color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s;white-space:nowrap;flex-shrink:0}
.agent-send-simple:hover{opacity:.86}
.agent-send-simple:disabled{opacity:.4;cursor:default}

/* AI chat (legacy compat) */
.ai-wrap{padding:14px 20px;display:flex;flex-direction:column;gap:12px;min-height:300px}
.ai-input-row{display:flex;gap:8px}
.ai-input{flex:1;background:var(--vsc-input);border:1px solid var(--border);color:var(--fg);border-radius:7px;padding:8px 12px;font-size:12px;font-family:var(--font);outline:none}
.ai-input:focus{border-color:var(--aurora-p4)}
.ai-send{background:var(--aurora-grad);color:#fff;border:none;border-radius:7px;padding:8px 18px;font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s}
.ai-send:hover{opacity:.86}
.ai-response{background:var(--card);border:1px solid var(--border);border-radius:9px;padding:14px;font-size:12px;color:var(--fg2);line-height:1.7;white-space:pre-wrap;min-height:60px}
.ai-model{font-size:9px;color:var(--fg3);text-align:right;margin-top:4px}

/* ── Number input — custom modern spinner ─────────────────────────── */
input[type=number]{-moz-appearance:textfield;appearance:textfield}
input[type=number]::-webkit-outer-spin-button,
input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0}
.num-wrap{position:relative;display:inline-flex;align-items:center}
.num-wrap input[type=number]{padding-right:20px!important}
.num-wrap .num-arrows{position:absolute;right:4px;display:flex;flex-direction:column;gap:1px}
.num-wrap .num-arrows button{all:unset;width:14px;height:11px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--fg3);border-radius:3px;transition:color .12s,background .12s}
.num-wrap .num-arrows button:hover{color:var(--aurora-p5);background:rgba(139,92,246,.15)}
.num-wrap .num-arrows button svg{display:block}
`;

export const RISK_RADAR_SCRIPT = String.raw`
function renderRiskRadar(){
  const l = D.leakage || {};
  const rs = l.dataset_risk_score ?? 0;
  const ps = l.privacy_score != null ? l.privacy_score * 100 : 0;
  
  const reidInfo = l.reidentification_risk || {};
  const reidVals = Object.values(reidInfo);
  const maxReid = reidVals.length ? Math.max.apply(null, reidVals.map(Number)) * 100 : 0;
  
  const ds = l.avg_drift_score != null ? Math.min(l.avg_drift_score * 100, 100) : 0;

  getOrCreateChart('chart-radar', {
    type: 'radar',
    data: {
      labels: ['Privacy', 'Risk', 'Max ReID', 'Drift'],
      datasets: [{
        label: 'Risk Radar',
        data: [ps, rs, maxReid, ds],
        backgroundColor: 'rgba(139, 92, 246, 0.22)',
        borderColor: 'rgba(139, 92, 246, 0.8)',
        borderWidth: 2,
        pointBackgroundColor: 'var(--aurora-p4)',
        pointBorderColor: '#fff',
        pointHoverBackgroundColor: '#fff',
        pointHoverBorderColor: 'var(--aurora-p6)'
      }]
    },
    options: {
      elements: { line: { tension: 0.3 } },
      scales: { 
        r: { 
          angleLines: { color: 'rgba(255, 255, 255, 0.08)' }, 
          grid: { color: 'rgba(255, 255, 255, 0.08)' }, 
          pointLabels: { color: 'var(--fg2)', font: { size: 9, family: 'var(--font)' } }, 
          ticks: { display:false, min:0, max:100 } 
        } 
      },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      animation: { duration: 600 }
    }
  });
}
`;
