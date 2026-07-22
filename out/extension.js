"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const cp = __importStar(require("child_process"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const monitorPanel_1 = require("./webview/monitorPanel");
const realtime_scanner_1 = require("./security/realtime_scanner");
const prompt_scanner_1 = require("./security/prompt_scanner");
const openrouter_client_1 = require("./ai/openrouter_client");
const alert_store_1 = require("./security/alert_store");
/*
  AutoMate Aurora — Privacy Dashboard Extension
  Pipeline: parse.py → baseline.py → generator.py → leakage_bridge.py
  Dashboard: src/webview/monitorPanel.ts
*/
// ─────────────────────────────────────────────────────────────────────────────
// Python resolver
// ─────────────────────────────────────────────────────────────────────────────
let _cachedPyCmd = null;
function resolvePythonCommand() {
    const config = vscode.workspace.getConfiguration('idelense');
    const userPath = config.get('pythonPath');
    if (userPath && userPath.trim()) {
        return userPath.trim();
    }
    if (_cachedPyCmd) {
        return _cachedPyCmd;
    }
    if (process.platform === 'win32') {
        try {
            cp.execSync('python --version', { stdio: 'ignore' });
            _cachedPyCmd = 'python';
        }
        catch {
            try {
                cp.execSync('py --version', { stdio: 'ignore' });
                _cachedPyCmd = 'py';
            }
            catch {
                _cachedPyCmd = 'python';
            }
        }
        return _cachedPyCmd;
    }
    _cachedPyCmd = 'python3';
    return _cachedPyCmd;
}
function getPipelineDir() {
    const config = vscode.workspace.getConfiguration('idelense');
    return config.get('pipelinePath') ?? '';
}
function _normaliseLeakageForDocx(lk) {
    if (!lk) {
        return {};
    }
    return {
        privacy_score: lk.privacy_score ?? null,
        risk_level: lk.risk_level ?? null,
        mi_auc: lk.mi_auc ?? lk.membership_inference_auc ?? null,
        drift_level: lk.drift_level ?? lk.statistical_drift ?? null,
        drift_scores: lk.drift_scores ?? lk.column_drift ?? {},
        pii_columns: lk.pii_columns ?? [],
        detected_threats: lk.detected_threats ?? lk.top_threats ?? lk.threat_details ?? [],
    };
}
// ─────────────────────────────────────────────────────────────────────────────
// Extension activation
// ─────────────────────────────────────────────────────────────────────────────
// ── Global LLM client (shared across commands) ──────────────────────────────
let llmClient;
// ─────────────────────────────────────────────────────────────────────────────
// Agentic ToolExecutor — bridges LLM tool calls to real system operations
// ─────────────────────────────────────────────────────────────────────────────
function createToolExecutor(_context, panel, getState, setState, getUserMessage) {
    // ── Pending row buffer (Arch Flaw 1 / Bug 2 fix) ─────────────────────────────
    // generate_rows stores rows here; merge_and_update reads from here.
    // The LLM only sees a count — never the raw row data (avoids 30KB+ LLM relay).
    // Backward compat: merge_and_update still accepts args.new_rows as a fallback.
    let _pendingRows = [];
    // ── Pending report artifact ───────────────────────────────────────────────
    // stat_summary / generate_report tools write here after building the DOCX.
    // The agentChat handler reads and attaches it to agentResponse so the UI
    // can render the Export button without triggering auto-export mid-session.
    let _pendingReportArtifact = null;
    const executor = async (name, args) => {
        const { context: ctx, baseline, filePath } = getState();
        switch (name) {
            // ── Tool 1: get_dataset_state ──────────────────────────────────────
            case 'get_dataset_state': {
                if (!ctx || (!ctx.baseline && !ctx.result && !ctx.leakage)) {
                    return JSON.stringify({
                        error: 'No dataset loaded. The user must run the pipeline first.',
                        has_data: false,
                    });
                }
                const snap = {
                    has_data: true,
                    row_count: (ctx.result?.row_count)
                        ?? (ctx.baseline?.meta?.row_count)
                        ?? null,
                    columns: {
                        numeric: Object.keys(ctx.baseline?.columns?.numeric ?? {}),
                        categorical: Object.keys(ctx.baseline?.columns?.categorical ?? {}),
                    },
                    privacy_score: ctx.leakage?.privacy_score != null
                        ? Math.round(ctx.leakage.privacy_score * 100)
                        : null,
                    risk_level: ctx.leakage?.risk_level ?? null,
                    generator: ctx.result?.generator_used
                        ?? ctx.live_stats?.generatorUsed
                        ?? null,
                    sample_rows: (ctx.result?.samples ?? []).slice(0, 5),
                    // F-GDS fix: per-column baseline stats so LLM can answer column questions
                    // without needing to call analyze_dataset for every query.
                    // Required after fullCtx was removed from agentChat system prompt (F6).
                    column_stats: Object.fromEntries(Object.entries(ctx.baseline?.columns?.numeric ?? {}).map(([col, stats]) => [
                        col,
                        {
                            mean: stats.mean != null ? parseFloat(stats.mean.toFixed(4)) : null,
                            std: stats.std != null ? parseFloat(stats.std.toFixed(4)) : null,
                            min: stats.min ?? null,
                            max: stats.max ?? null,
                            median: stats.median ?? null,
                        },
                    ])),
                    pii_columns: ctx.leakage?.pii_columns ?? [],
                };
                return JSON.stringify(snap);
            }
            // ── Tool 2: generate_rows ──────────────────────────────────────────
            case 'generate_rows': {
                if (!filePath || !baseline) {
                    return JSON.stringify({ error: 'No dataset loaded. Run the pipeline first.' });
                }
                const count = typeof args.count === 'number'
                    ? Math.max(1, Math.round(args.count))
                    : 100;
                const tmpBase = path.join(os.tmpdir(), `aurora_gen_${Date.now()}.json`);
                try {
                    fs.writeFileSync(tmpBase, JSON.stringify(baseline));
                    const result = await runGenerator(_context, filePath, tmpBase, count);
                    try {
                        fs.unlinkSync(tmpBase);
                    }
                    catch { }
                    // F3 fix: store rows server-side, return count only.
                    // The LLM never sees raw row data — avoids 30KB+ relay through context window.
                    _pendingRows = result?.samples ?? [];
                    _pendingReportArtifact = {
                        type: 'csv',
                        samples: _pendingRows,
                        row_count: _pendingRows.length,
                    };
                    // ── ONLY mode: return rows as standalone preview, block merge ──
                    if (args.only === true) {
                        const onlyRows = _pendingRows.slice();
                        _pendingRows = []; // clear so merge_and_update cannot consume them
                        panel.webview.postMessage({
                            type: 'generatedRowsOnly',
                            samples: onlyRows,
                            count: onlyRows.length,
                        });
                        return JSON.stringify({
                            status: 'rows_only',
                            count_generated: onlyRows.length,
                            generator_used: result?.generator_used ?? args.generator ?? null,
                            note: 'Rows returned as standalone preview — not merged into dataset.',
                        });
                    }
                    return JSON.stringify({
                        status: 'rows_ready',
                        count_generated: _pendingRows.length,
                        generator_used: result?.generator_used ?? args.generator ?? null,
                        // new_rows intentionally omitted — stored server-side
                    });
                }
                catch (e) {
                    try {
                        fs.unlinkSync(tmpBase);
                    }
                    catch { }
                    return JSON.stringify({ error: String(e) });
                }
            }
            // ── Tool 3: merge_and_update ───────────────────────────────────────
            case 'merge_and_update': {
                // F4 fix: read from pending buffer (Arch Flaw 1 fix).
                // Primary path: rows stored by generate_rows — LLM never relays the data.
                // Fallback: args.new_rows for backward compat with in-flight tool calls.
                const newRows = _pendingRows.length > 0
                    ? _pendingRows
                    : (Array.isArray(args.new_rows) ? args.new_rows : []);
                _pendingRows = []; // clear after use regardless of source
                if (newRows.length === 0) {
                    return JSON.stringify({ error: 'No pending rows. Call generate_rows first.' });
                }
                const { context: current } = getState();
                const existing = current.result?.samples ?? [];
                const merged = [...existing, ...newRows];
                setState({
                    result: {
                        ...(current.result ?? {}),
                        samples: merged,
                        row_count: merged.length,
                    },
                });
                _pendingReportArtifact = {
                    type: 'csv',
                    samples: merged,
                    row_count: merged.length,
                };
                panel.webview.postMessage({
                    type: 'datasetUpdated',
                    row_count: merged.length,
                    new_samples: merged,
                });
                return JSON.stringify({
                    success: true,
                    total_rows: merged.length,
                    added: newRows.length,
                });
            }
            // ── Tool: edit_dataset ──────────────────────────────────────────────
            case 'edit_dataset': {
                const { context: current } = getState();
                let samples = [...(current.result?.samples ?? [])];
                if (samples.length === 0 && current.baseline?.preview_rows) {
                    samples = [...current.baseline.preview_rows];
                }
                const action = args.action ?? 'delete_rows';
                const colName = args.column_name ?? '';
                if (action === 'delete_column' && colName) {
                    samples = samples.map(row => {
                        const copy = { ...row };
                        delete copy[colName];
                        return copy;
                    });
                }
                else if (action === 'add_column' && colName) {
                    const defaultVal = args.default_value ?? null;
                    samples = samples.map(row => ({
                        ...row,
                        [colName]: defaultVal,
                    }));
                }
                else if (action === 'delete_rows' && Array.isArray(args.row_indices)) {
                    const removeSet = new Set(args.row_indices);
                    samples = samples.filter((_, idx) => !removeSet.has(idx));
                }
                else if (action === 'filter_rows' && Array.isArray(args.row_indices)) {
                    const keepSet = new Set(args.row_indices);
                    samples = samples.filter((_, idx) => keepSet.has(idx));
                }
                else if (action === 'delete_rows' && args.condition) {
                    try {
                        const parts = args.condition.split(/\s+/);
                        const col = parts[0];
                        const op = parts[1];
                        const valStr = parts.slice(2).join(' ').replace(/['"]/g, '');
                        samples = samples.filter(row => {
                            const val = row[col];
                            if (op === '==' || op === '=')
                                return String(val) !== valStr;
                            if (op === '!=')
                                return String(val) === valStr;
                            return true;
                        });
                    }
                    catch { }
                }
                setState({
                    result: {
                        ...(current.result ?? {}),
                        samples: samples,
                        row_count: samples.length,
                    },
                });
                _pendingReportArtifact = {
                    type: 'csv',
                    samples: samples,
                    row_count: samples.length,
                };
                panel.webview.postMessage({
                    type: 'datasetUpdated',
                    row_count: samples.length,
                    new_samples: samples,
                });
                return JSON.stringify({
                    success: true,
                    action: action,
                    total_rows: samples.length,
                    columns: samples.length > 0 ? Object.keys(samples[0]) : [],
                });
            }
            // ── Tool 4: analyze_dataset ────────────────────────────────────────
            case 'analyze_dataset': {
                const { context: cur } = getState();
                const focus = args.focus ?? 'full';
                const cols = cur.baseline?.columns ?? {};
                const numericCols = Object.keys(cols.numeric ?? {});
                const categoricalCols = Object.keys(cols.categorical ?? {});
                const allRows = cur.result?.samples ?? [];
                // F14 fix (Arch Flaw 2): when no live samples exist, use pre-computed
                // baseline column stats so analysis works even without re-running the generator.
                if (allRows.length === 0 && (focus === 'statistical' || focus === 'full')) {
                    // rawFocus: string escapes TS narrowing so we can check 'privacy'/'drift'/'full'
                    // inside the 'statistical'|'full' guarded block without TS2367 errors.
                    const rawFocus = focus;
                    const baselineStats = {};
                    for (const [col, stats] of Object.entries(cols.numeric ?? {})) {
                        baselineStats[col] = {
                            min: stats.min ?? null,
                            max: stats.max ?? null,
                            mean: stats.mean != null ? parseFloat(stats.mean.toFixed(4)) : null,
                            std: stats.std != null ? parseFloat(stats.std.toFixed(4)) : null,
                            median: stats.median ?? null,
                            count: stats.count ?? cur.baseline?.meta?.row_count ?? 0,
                        };
                    }
                    if (Object.keys(baselineStats).length > 0) {
                        const privacyFallback = (rawFocus === 'privacy' || rawFocus === 'full') ? {
                            privacy_score: cur.leakage?.privacy_score ?? null,
                            risk_level: cur.leakage?.risk_level ?? null,
                            pii_columns: cur.leakage?.pii_columns ?? [],
                            attack_report: cur.attackReport ?? null,
                        } : null;
                        const driftFallback = (rawFocus === 'drift' || rawFocus === 'full') ? {
                            drift_scores: cur.leakage?.drift_scores ?? cur.leakage?.column_drift ?? null,
                            baseline_rows: cur.baseline?.meta?.row_count ?? null,
                            synthetic_rows: cur.result?.row_count ?? null,
                        } : null;
                        return JSON.stringify({
                            focus,
                            row_count: cur.baseline?.meta?.row_count ?? 0,
                            numeric_cols: numericCols,
                            categorical_cols: categoricalCols,
                            statistical: baselineStats,
                            privacy: privacyFallback,
                            drift: driftFallback,
                            source: 'baseline_cache',
                        });
                    }
                }
                const statisticalAnalysis = {};
                if (focus === 'statistical' || focus === 'full') {
                    for (const col of numericCols) {
                        const vals = allRows
                            .map((r) => Number(r[col]))
                            .filter((v) => !isNaN(v));
                        if (vals.length > 0) {
                            const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
                            const sorted = [...vals].sort((a, b) => a - b);
                            const variance = vals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / vals.length;
                            statisticalAnalysis[col] = {
                                min: sorted[0],
                                max: sorted[sorted.length - 1],
                                mean: parseFloat(mean.toFixed(4)),
                                std: parseFloat(Math.sqrt(variance).toFixed(4)),
                                median: sorted[Math.floor(sorted.length / 2)],
                                count: vals.length,
                            };
                        }
                    }
                }
                const privacyAnalysis = (focus === 'privacy' || focus === 'full')
                    ? {
                        privacy_score: cur.leakage?.privacy_score ?? null,
                        risk_level: cur.leakage?.risk_level ?? null,
                        pii_columns: cur.leakage?.pii_columns ?? [],
                        attack_report: cur.attackReport ?? null,
                    }
                    : null;
                const driftAnalysis = (focus === 'drift' || focus === 'full')
                    ? {
                        drift_scores: cur.leakage?.drift_scores ?? cur.leakage?.column_drift ?? null,
                        baseline_rows: cur.baseline?.meta?.row_count ?? null,
                        synthetic_rows: cur.result?.row_count ?? null,
                    }
                    : null;
                return JSON.stringify({
                    focus,
                    // ── Comparison structure (baseline vs synthetic) ───────────
                    baseline: {
                        row_count: cur.baseline?.meta?.row_count ?? null,
                        statistical: (() => {
                            const bs = {};
                            for (const [col, st] of Object.entries(cols.numeric ?? {})) {
                                bs[col] = {
                                    min: st.min ?? null,
                                    max: st.max ?? null,
                                    mean: st.mean != null ? parseFloat(st.mean.toFixed(4)) : null,
                                    std: st.std != null ? parseFloat(st.std.toFixed(4)) : null,
                                    median: st.median ?? null,
                                    count: st.count ?? cur.baseline?.meta?.row_count ?? 0,
                                };
                            }
                            return bs;
                        })(),
                    },
                    synthetic: {
                        row_count: allRows.length,
                        statistical: statisticalAnalysis,
                    },
                    // ── Backward-compat flat fields ───────────────────────────
                    row_count: cur.result?.row_count ?? cur.baseline?.meta?.row_count ?? 0,
                    numeric_cols: numericCols,
                    categorical_cols: categoricalCols,
                    statistical: statisticalAnalysis,
                    privacy: privacyAnalysis,
                    drift: driftAnalysis,
                    source: 'live_samples',
                });
            }
            // ── Tool 5b: stat_summary ─────────────────────────────────────────────
            // Builds the report PROGRAMMATICALLY — zero LLM calls.
            // All stats are computed from ctx.baseline + ctx.result.samples directly.
            // DOCX conversion is the only async work → fast response.
            case 'stat_summary': {
                // Detect scope from the actual user message — more reliable than trusting the LLM arg.
                const userMsg = getUserMessage().toLowerCase();
                const msgBaseline = /\b(original|baseline|real|actual|source|raw)\b/.test(userMsg);
                const msgSynthetic = /\b(synthetic|generated|fake|artificial|sampled)\b/.test(userMsg);
                const msgCompare = /\b(compar|both|vs|versus|side.by.side)\b/.test(userMsg);
                // If user was explicit, honour it. Otherwise fall back to LLM arg, then 'comparison'.
                let scope = msgBaseline ? 'baseline' :
                    msgSynthetic ? 'synthetic' :
                        msgCompare ? 'comparison' :
                            args.scope ?? 'comparison';
                // Auto-fallback: if no synthetic data exists, always use baseline scope.
                const hasSynthetic = (lastPipelineContext.result?.samples?.length ?? 0) > 0
                    || (lastPipelineContext.result?.row_count ?? 0) > 0;
                if (!hasSynthetic && (scope === 'comparison' || scope === 'synthetic')) {
                    scope = 'baseline';
                }
                try {
                    // FIX-ROWS: merge lastBaseline as fallback so row_count is always available
                    // even when the full pipeline hasn't run (lastPipelineContext.baseline may be {}).
                    const contextForReport = {
                        ...lastPipelineContext,
                        baseline: lastPipelineContext.baseline ?? lastBaseline,
                    };
                    // Build full report without any LLM call
                    const content = (0, openrouter_client_1._buildStatReport)(contextForReport, scope);
                    // Build JSON payload for aurora_stat_docx.py
                    const b_cols = lastBaseline?.columns?.numeric ?? {};
                    const samples = lastPipelineContext.result?.samples ?? [];
                    // Compute synthetic stats (max 1000 rows)
                    const synStats = {};
                    const slice = samples.slice(0, 1000);
                    if (slice.length > 0) {
                        for (const col of Object.keys(b_cols)) {
                            const vals = slice.map((r) => Number(r[col])).filter((v) => !isNaN(v));
                            if (vals.length === 0) {
                                continue;
                            }
                            const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
                            const sorted = [...vals].sort((a, b) => a - b);
                            const std = Math.sqrt(vals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / vals.length);
                            synStats[col] = { mean: parseFloat(mean.toFixed(4)), std: parseFloat(std.toFixed(4)), min: sorted[0], max: sorted[sorted.length - 1], median: sorted[Math.floor(sorted.length / 2)] };
                        }
                    }
                    const docxPayload = {
                        scope,
                        dataset_name: lastFilePath ? path.basename(lastFilePath) : 'dataset',
                        generated_at: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
                        baseline: { row_count: lastBaseline?.meta?.row_count ?? null, columns: b_cols },
                        synthetic: { row_count: samples.length || lastPipelineContext.result?.row_count || null, stats: synStats },
                        leakage: _normaliseLeakageForDocx(lastPipelineContext.leakage),
                    };
                    // Convert to DOCX — saved to TEMP until user clicks Export
                    let docxPath = null;
                    try {
                        const tmpOut = path.join(os.tmpdir(), `aurora_report_${scope}_${Date.now()}.docx`);
                        const jsonTmp = path.join(os.tmpdir(), `stat_data_${Date.now()}.json`);
                        fs.writeFileSync(jsonTmp, JSON.stringify(docxPayload), 'utf8');
                        await runStatDocx(_context, jsonTmp, tmpOut);
                        try {
                            fs.unlinkSync(jsonTmp);
                        }
                        catch { }
                        docxPath = fs.existsSync(tmpOut) ? tmpOut : null;
                    }
                    catch (e) {
                        console.error('[Aurora] aurora_stat_docx.py failed:', e);
                        try {
                            const mdTmp = path.join(os.tmpdir(), `stat_${Date.now()}.md`);
                            const tmpOut2 = path.join(os.tmpdir(), `aurora_report_${scope}_no-charts_${Date.now()}.docx`);
                            fs.writeFileSync(mdTmp, content, 'utf8');
                            await runMdToDocx(_context, mdTmp, tmpOut2);
                            try {
                                fs.unlinkSync(mdTmp);
                            }
                            catch { }
                            docxPath = fs.existsSync(tmpOut2) ? tmpOut2 : null;
                        }
                        catch (e2) {
                            console.error('[Aurora] fallback DOCX also failed:', e2);
                        }
                    }
                    // Store artifact for agentChat handler to attach to agentResponse.
                    // The UI renders the Export button from there — no auto-export.
                    // FIX-VISUAL: for baseline-only scope, also attach a baseline_chart so
                    // the user sees a visual even when no synthetic data has been generated yet.
                    const baselineChartArtifact = (scope === 'baseline')
                        ? (0, openrouter_client_1._buildBaselineChartArtifact)(contextForReport.baseline ?? lastBaseline)
                        : null;
                    _pendingReportArtifact = {
                        type: 'report',
                        content,
                        filePath: docxPath,
                        reportType: 'statistical',
                        ...(baselineChartArtifact ? { chart: baselineChartArtifact } : {}),
                    };
                    // Include a condensed summary so the LLM can relay real numbers
                    // instead of hallucinating from context.
                    const text_summary = content.slice(0, 1200).replace(/#+\s*/g, '').trim();
                    return JSON.stringify({
                        success: true,
                        scope,
                        file_path: docxPath,
                        char_count: content.length,
                        text_summary,
                    });
                }
                catch (e) {
                    return JSON.stringify({ error: String(e) });
                }
            }
            // ── Tool 5: generate_report ────────────────────────────────────────
            case 'generate_report': {
                const { context: cur } = getState();
                const reportType = args.type ?? 'full';
                try {
                    let fullContent = '';
                    if (filePath && baseline) {
                        const leakTmp = path.join(os.tmpdir(), `rpt_leak_${Date.now()}.json`);
                        const baseTmp = path.join(os.tmpdir(), `rpt_base_${Date.now()}.json`);
                        const mdTmp = path.join(os.tmpdir(), `rpt_out_${Date.now()}.md`);
                        fs.writeFileSync(leakTmp, JSON.stringify(cur.leakage ?? {}));
                        fs.writeFileSync(baseTmp, JSON.stringify(baseline));
                        await runDocGenerator(_context, baseTmp, leakTmp, undefined, undefined, mdTmp);
                        try {
                            fs.unlinkSync(leakTmp);
                            fs.unlinkSync(baseTmp);
                        }
                        catch { }
                        if (fs.existsSync(mdTmp)) {
                            fullContent = fs.readFileSync(mdTmp, 'utf-8');
                            try {
                                fs.unlinkSync(mdTmp);
                            }
                            catch { }
                        }
                    }
                    // Convert to DOCX in temp — no webview.postMessage here.
                    // Export button surfaces only when user explicitly requests export.
                    let tmpDocxPath = null;
                    if (fullContent) {
                        try {
                            const mdTmp2 = path.join(os.tmpdir(), `rpt_docx_src_${Date.now()}.md`);
                            const tmpDocx = path.join(os.tmpdir(), `aurora_report_${reportType}_${Date.now()}.docx`);
                            fs.writeFileSync(mdTmp2, fullContent, 'utf8');
                            await runMdToDocx(_context, mdTmp2, tmpDocx);
                            try {
                                fs.unlinkSync(mdTmp2);
                            }
                            catch { }
                            tmpDocxPath = fs.existsSync(tmpDocx) ? tmpDocx : null;
                        }
                        catch (e) {
                            console.error('[Aurora] generate_report DOCX failed:', e);
                        }
                    }
                    // Store artifact for agentChat handler — no auto-export.
                    _pendingReportArtifact = { type: 'report', content: fullContent, filePath: tmpDocxPath, reportType: 'governance' };
                    return JSON.stringify({
                        success: !!fullContent,
                        file_path: tmpDocxPath ?? 'pending export',
                        char_count: fullContent.length,
                        report_type: reportType,
                    });
                }
                catch (e) {
                    return JSON.stringify({ error: String(e) });
                }
            }
            // ── Tool 6: export_csv ─────────────────────────────────────────────
            case 'export_csv': {
                const { context: cur } = getState();
                const rows = cur.result?.samples ?? [];
                if (rows.length === 0) {
                    return JSON.stringify({
                        error: 'No synthetic data in memory. Run the generator first.',
                    });
                }
                const filename = args.filename || 'aurora_dataset.csv';
                // Save to TEMP only — user must click Export CSV to save to workspace
                const tmpCsvFile = path.join(os.tmpdir(), `aurora_export_${Date.now()}_${filename}`);
                try {
                    const csvCols = Object.keys(rows[0]);
                    const csv = [
                        csvCols.join(','),
                        ...rows.map((r) => csvCols.map((c) => {
                            const v = r[c] != null ? String(r[c]) : '';
                            return v.includes(',') || v.includes('"') || v.includes('\n')
                                ? `"${v.replace(/"/g, '""')}"`
                                : v;
                        }).join(',')),
                    ].join('\n');
                    fs.writeFileSync(tmpCsvFile, csv, 'utf-8');
                    const workspaceDir = filePath
                        ? path.dirname(filePath)
                        : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir());
                    panel.webview.postMessage({
                        type: 'csvExported',
                        file_path: tmpCsvFile,
                        workspace_dir: workspaceDir, // UI uses this on "Save" click
                        row_count: rows.length,
                    });
                    return JSON.stringify({
                        success: true,
                        file_path: tmpCsvFile,
                        rows: rows.length,
                    });
                }
                catch (e) {
                    return JSON.stringify({ error: String(e) });
                }
            }
            // ── Tool 7: combine_datasets ───────────────────────────────────────
            case 'combine_datasets': {
                const { context: cur } = getState();
                const syntheticRows = cur.result?.samples ?? [];
                if (syntheticRows.length === 0) {
                    return JSON.stringify({ error: 'No synthetic data available. Run the generator first.' });
                }
                if (!filePath) {
                    return JSON.stringify({ error: 'No original dataset file path found.' });
                }
                try {
                    // Read original CSV rows
                    const rawCsv = fs.readFileSync(filePath, 'utf-8');
                    const csvLines = rawCsv.trim().split('\n');
                    const headers = csvLines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
                    const originalRows = csvLines.slice(1).map((line) => {
                        const vals = line.split(',');
                        const row = {};
                        headers.forEach((h, i) => {
                            const v = (vals[i] ?? '').trim().replace(/^"|"$/g, '');
                            row[h] = isNaN(Number(v)) || v === '' ? v : Number(v);
                        });
                        return row;
                    });
                    // Tag rows by source so user can distinguish them
                    const taggedOriginal = originalRows.map((r) => ({ ...r, _source: 'original' }));
                    const taggedSynthetic = syntheticRows.map((r) => ({ ...r, _source: 'synthetic' }));
                    const combined = [...taggedOriginal, ...taggedSynthetic];
                    setState({
                        result: {
                            ...(cur.result ?? {}),
                            samples: combined,
                            row_count: combined.length,
                        },
                    });
                    panel.webview.postMessage({
                        type: 'datasetUpdated',
                        row_count: combined.length,
                        new_samples: combined,
                    });
                    return JSON.stringify({
                        success: true,
                        total_rows: combined.length,
                        original_rows: originalRows.length,
                        synthetic_rows: syntheticRows.length,
                    });
                }
                catch (e) {
                    return JSON.stringify({ error: String(e) });
                }
            }
            default:
                return JSON.stringify({ error: `Unknown tool: "${name}"` });
        }
    };
    return { executor, getReportArtifact: () => _pendingReportArtifact };
}
function activate(context) {
    llmClient = new openrouter_client_1.OpenRouterClient();
    // ── PART 6: Restore API key from SecretStorage (never from settings.json) ──
    // Keys are stored with context.secrets.store() which encrypts them at rest.
    // workspaceState is kept only for backward-compat migration of old keys.
    const savedProviders = ['openrouter', 'openai', 'anthropic', 'groq', 'together', 'mistral'];
    // Async init — read SecretStorage then inject into the live client.
    (async () => {
        let restoredAny = false;
        // Primary: SecretStorage (encrypted, per-user)
        for (const prov of savedProviders) {
            try {
                const pk = await context.secrets.get(`automate.apiKey.${prov}`);
                if (pk && pk !== 'PASTE_API_KEY_HERE') {
                    llmClient.setKey(pk, prov);
                    restoredAny = true;
                    console.log(`[AutoMate] API key restored from SecretStorage (provider: ${prov})`);
                    break;
                }
            }
            catch { /* SecretStorage unavailable — fall through */ }
        }
        if (!restoredAny) {
            // Migration: lift old workspaceState keys into SecretStorage once, then clear them.
            for (const prov of savedProviders) {
                const legacyKey = context.workspaceState.get(`automate.apiKey.${prov}`, '');
                if (legacyKey && legacyKey !== 'PASTE_API_KEY_HERE') {
                    await context.secrets.store(`automate.apiKey.${prov}`, legacyKey);
                    await context.workspaceState.update(`automate.apiKey.${prov}`, '');
                    llmClient.setKey(legacyKey, prov);
                    restoredAny = true;
                    console.log(`[AutoMate] Migrated API key from workspaceState → SecretStorage (provider: ${prov})`);
                    break;
                }
            }
        }
        if (!restoredAny) {
            // Final fallback: legacy openrouterApiKey workspaceState entry
            const legacyOld = context.workspaceState.get('automate.openrouterApiKey', '');
            if (legacyOld && legacyOld !== 'PASTE_API_KEY_HERE') {
                await context.secrets.store('automate.apiKey.openrouter', legacyOld);
                await context.workspaceState.update('automate.openrouterApiKey', '');
                llmClient.setKey(legacyOld, 'openrouter');
                console.log('[AutoMate] Migrated legacy openrouterApiKey → SecretStorage');
            }
        }
    })();
    const provider = new DataImportCodeLensProvider();
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: "file" }, provider));
    // ── Real-time security scanner ───────────────────────────────────────
    (0, realtime_scanner_1.activateRealtimeScanner)(context);
    // ── Live alert forwarding to open dashboard panels ───────────────────
    // Panels register themselves here when they open (see showCheckpointMonitor)
    const _activePanels = new Set();
    global.__automatePanels = _activePanels;
    const unsubAlert = (0, alert_store_1.onAlert)((alert) => {
        _activePanels.forEach(p => {
            try {
                p.webview.postMessage({ type: 'liveSecurityAlert', alert });
            }
            catch { /* panel disposed */ }
        });
    });
    // ── Existing: Parse Dataset command ──────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand("idelense.parseDataset", async (lineText) => {
        const fileName = extractPathFromImport(lineText);
        const editor = vscode.window.activeTextEditor;
        if (!editor || !fileName) {
            vscode.window.showErrorMessage("Could not resolve dataset path.");
            return;
        }
        const workspaceDir = vscode.workspace.workspaceFolders?.[0].uri.fsPath || "";
        const filePath = path.isAbsolute(fileName) ? fileName : path.join(workspaceDir, fileName);
        try {
            const kind = detectKind(filePath);
            const ast = await runPythonParser(context, filePath);
            const baseline = await runBaseline(context, filePath, kind);
            // Store for dashboard "Run Generator" button
            lastFilePath = filePath;
            lastBaseline = baseline;
            lastAst = ast;
            // Open main Aurora UI directly on Parser tab (skips old Parse+Baseline panel)
            showCheckpointMonitor(context, { checkpoint_path: '', generator_used: '', row_count: 0, samples: [] }, null, ast, baseline, null, null, null, null);
        }
        catch (err) {
            vscode.window.showErrorMessage("Parser Error: " + err);
        }
    }));
    // ── Existing: Generate Synthetic ─────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('idelense.generateSynthetic', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('Aurora: Open a Python file that imports a dataset first.');
            return;
        }
        vscode.window.showInformationMessage('Aurora: Click the "Aurora Extension" lens above your dataset import line.');
    }));
    // ── NEW: Scan Dataset for PII ────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('automate.scanDataset', async () => {
        const fileUri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectMany: false,
            filters: { 'Datasets': ['csv', 'json', 'xlsx', 'parquet'] },
            title: 'Select dataset to scan for PII'
        });
        if (!fileUri || !fileUri[0]) {
            return;
        }
        const filePath = fileUri[0].fsPath;
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Aurora: Scanning for PII & secrets…',
            cancellable: false
        }, async () => {
            try {
                const report = await runPIIScan(context, filePath);
                showScanReport(context, report, filePath);
            }
            catch (err) {
                vscode.window.showErrorMessage('Scan failed: ' + err);
            }
        });
    }));
    // ── NEW: Anonymize Dataset ───────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('automate.anonymizeDataset', async () => {
        const fileUri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectMany: false,
            filters: { 'Datasets': ['csv', 'json', 'xlsx'] },
            title: 'Select dataset to anonymize'
        });
        if (!fileUri || !fileUri[0]) {
            return;
        }
        const filePath = fileUri[0].fsPath;
        const ext = path.extname(filePath);
        const outputPath = filePath.replace(ext, `_anonymized${ext}`);
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Aurora: Anonymizing dataset…',
            cancellable: false
        }, async () => {
            try {
                const result = await runAnonymizer(context, filePath, outputPath);
                vscode.window.showInformationMessage(`Anonymized: ${result.cells_anonymized} cells in ${result.anonymized_columns?.length || 0} columns. Saved to ${outputPath}`);
            }
            catch (err) {
                vscode.window.showErrorMessage('Anonymization failed: ' + err);
            }
        });
    }));
    // ── NEW: Run Attack Simulation ───────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('automate.runAttackSimulation', async () => {
        const origUri = await vscode.window.showOpenDialog({
            canSelectFiles: true, canSelectMany: false,
            filters: { 'Datasets': ['csv', 'json', 'xlsx', 'parquet'] },
            title: 'Select ORIGINAL dataset'
        });
        if (!origUri?.[0]) {
            return;
        }
        const synthUri = await vscode.window.showOpenDialog({
            canSelectFiles: true, canSelectMany: false,
            filters: { 'Datasets': ['csv', 'json', 'xlsx', 'parquet'] },
            title: 'Select SYNTHETIC dataset'
        });
        if (!synthUri?.[0]) {
            return;
        }
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Aurora: Running attack simulations…',
            cancellable: false
        }, async () => {
            try {
                const report = await runAttackSim(context, origUri[0].fsPath, synthUri[0].fsPath);
                showAttackReport(context, report);
            }
            catch (err) {
                vscode.window.showErrorMessage('Attack simulation failed: ' + err);
            }
        });
    }));
    // ── NEW: Generate Dataset Card ───────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('automate.generateDatasetCard', async () => {
        vscode.window.showInformationMessage('Aurora: Dataset cards are auto-generated when you run the full pipeline from Aurora Extension.');
    }));
    // ── NEW: Scan Prompt for Leakage ─────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('automate.scanPrompt', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('Select text first.');
            return;
        }
        const selection = editor.document.getText(editor.selection);
        const textToScan = selection || editor.document.getText();
        const result = (0, prompt_scanner_1.scanPrompt)(textToScan);
        if (result.isClean) {
            vscode.window.showInformationMessage('✅ Prompt is clean — no sensitive data detected.');
        }
        else {
            const action = await vscode.window.showWarningMessage(`⚠ ${result.summary}`, 'Show Anonymized Version', 'Dismiss');
            if (action === 'Show Anonymized Version') {
                const doc = await vscode.workspace.openTextDocument({ content: result.anonymizedPrompt, language: 'text' });
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            }
        }
    }));
    // ── NEW: Ask AI about Data ───────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('automate.askAI', async () => {
        if (!llmClient.isConfigured()) {
            const action = await vscode.window.showWarningMessage('Aurora AI requires an API key. Open the AI Insights tab in the dashboard and paste your key.', 'Open Dashboard');
            if (action === 'Open Dashboard') {
                vscode.commands.executeCommand('automate.openDashboard');
            }
            return;
        }
        const question = await vscode.window.showInputBox({
            prompt: 'Ask the AI about your dataset, privacy analysis, or synthetic data…',
            placeHolder: 'e.g., What are the top privacy risks in this dataset?'
        });
        if (!question) {
            return;
        }
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Aurora AI is thinking…',
            cancellable: false
        }, async () => {
            const response = await llmClient.askAboutData(question, lastPipelineContext);
            if (response.error) {
                vscode.window.showErrorMessage('AI Error: ' + response.error);
            }
            else {
                const doc = await vscode.workspace.openTextDocument({ content: response.content, language: 'markdown' });
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            }
        });
    }));
    // ── Phase 5: Agent Commands ───────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('automate.explainDataset', async () => {
        if (!llmClient.isConfigured()) {
            vscode.window.showWarningMessage('Aurora AI requires an API key. Open the AI Insights tab and paste your key.');
            return;
        }
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Aurora: Explaining dataset…', cancellable: false }, async () => {
            const response = await llmClient.explainDataset(lastPipelineContext);
            if (response.error) {
                vscode.window.showErrorMessage('AI Error: ' + response.error);
                return;
            }
            const doc = await vscode.workspace.openTextDocument({ content: response.content, language: 'markdown' });
            vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('automate.detectAnomalies', async () => {
        if (!llmClient.isConfigured()) {
            vscode.window.showWarningMessage('OpenRouter API key required.');
            return;
        }
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Aurora: Detecting anomalies…', cancellable: false }, async () => {
            const response = await llmClient.detectAnomalies(lastPipelineContext);
            if (response.error) {
                vscode.window.showErrorMessage('AI Error: ' + response.error);
                return;
            }
            const doc = await vscode.workspace.openTextDocument({ content: response.content, language: 'markdown' });
            vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('automate.suggestCleaning', async () => {
        if (!llmClient.isConfigured()) {
            vscode.window.showWarningMessage('OpenRouter API key required.');
            return;
        }
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Aurora: Generating cleaning suggestions…', cancellable: false }, async () => {
            const response = await llmClient.suggestCleaning(lastPipelineContext);
            if (response.error) {
                vscode.window.showErrorMessage('AI Error: ' + response.error);
                return;
            }
            const doc = await vscode.workspace.openTextDocument({ content: response.content, language: 'markdown' });
            vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('automate.generateSQL', async () => {
        if (!llmClient.isConfigured()) {
            vscode.window.showWarningMessage('OpenRouter API key required.');
            return;
        }
        const question = await vscode.window.showInputBox({
            prompt: 'Describe the SQL query you need (e.g., "Find users with income > 100k")',
            placeHolder: 'e.g., Find all records where age > 18 and email is not null'
        });
        if (!question) {
            return;
        }
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Aurora: Generating SQL…', cancellable: false }, async () => {
            const response = await llmClient.generateSQL(question, lastPipelineContext);
            if (response.error) {
                vscode.window.showErrorMessage('AI Error: ' + response.error);
                return;
            }
            const doc = await vscode.workspace.openTextDocument({ content: response.content, language: 'sql' });
            vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('automate.recommendGovernance', async () => {
        if (!llmClient.isConfigured()) {
            vscode.window.showWarningMessage('OpenRouter API key required.');
            return;
        }
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Aurora: Building governance plan…', cancellable: false }, async () => {
            const response = await llmClient.recommendGovernance(lastPipelineContext);
            if (response.error) {
                vscode.window.showErrorMessage('AI Error: ' + response.error);
                return;
            }
            const doc = await vscode.workspace.openTextDocument({ content: response.content, language: 'markdown' });
            vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        });
    }));
    // ── Open Aurora Dashboard directly (standalone, without prior generate) ─
    context.subscriptions.push(vscode.commands.registerCommand('automate.openDashboard', () => {
        const chartUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'chart.min.js');
        const emptyData = {
            result: null, leakage: null, ast: null, baseline: null,
            cp: null, checkpoint: null,
            chartUri: '', scanReport: null, attackReport: null,
            knowledgeGraph: null, lineage: null,
        };
        showCheckpointMonitor(context, { checkpoint_path: '', generator_used: '', row_count: 0, samples: [] }, null, null, null, null, null, null, null);
    }));
}
function deactivate() {
    (0, realtime_scanner_1.deactivateRealtimeScanner)();
}
// ─────────────────────────────────────────────────────────────────────────────
// CodeLens provider
// ─────────────────────────────────────────────────────────────────────────────
class DataImportCodeLensProvider {
    provideCodeLenses(document) {
        const ranges = detectDataImports(document);
        return ranges.map(range => new vscode.CodeLens(range, {
            title: "Aurora Extension",
            command: "idelense.parseDataset",
            arguments: [document.lineAt(range.start.line).text]
        }));
    }
}
function detectDataImports(document) {
    const regex = /(read_csv|read_excel|read_json|read_parquet|spark\.read)/g;
    const ranges = [];
    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i);
        if (regex.test(line.text)) {
            ranges.push(line.range);
        }
        regex.lastIndex = 0;
    }
    return ranges;
}
function extractPathFromImport(line) {
    const match = line.match(/['"]([^'"]+\.(csv|xlsx|json|parquet|jsonl))['"]/);
    return match ? match[1] : null;
}
function detectKind(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".csv") {
        return "csv";
    }
    if (ext === ".xlsx") {
        return "excel";
    }
    if (ext === ".json" || ext === ".jsonl") {
        return "json";
    }
    if (ext === ".parquet") {
        return "parquet";
    }
    throw new Error(`Unsupported file type: ${ext}`);
}
// ─────────────────────────────────────────────────────────────────────────────
// Python process helpers
// ─────────────────────────────────────────────────────────────────────────────
function spawnPython(py, args, extraEnv) {
    return cp.spawn(py, args, {
        env: { ...process.env, PYTHONUNBUFFERED: "1", ...(extraEnv ?? {}) },
    });
}
function collectOutput(proc) {
    return new Promise(resolve => {
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => stdout += d.toString());
        proc.stderr.on("data", (d) => stderr += d.toString());
        proc.on("close", (code) => resolve({ stdout, stderr, code }));
    });
}
function runPythonParser(context, filePath) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, "src", "utils", "parse.py");
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, [scriptPath, filePath]));
        if (code !== 0) {
            reject(stderr || `parse.py exited ${code}`);
            return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
            reject('Empty output from parse.py');
            return;
        }
        try {
            resolve(JSON.parse(trimmed));
        }
        catch {
            reject("Invalid JSON from parse.py");
        }
    });
}
function runBaseline(context, filePath, kind) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, "src", "utils", "baseline.py");
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, [scriptPath, filePath, "--kind", kind]));
        if (code !== 0) {
            reject(stderr || `baseline.py exited ${code}`);
            return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
            reject('Empty output from baseline.py');
            return;
        }
        try {
            resolve(JSON.parse(trimmed));
        }
        catch {
            reject("Invalid JSON from baseline.py");
        }
    });
}
// E1: forceEngine allows the caller to override automatic engine selection.
// Defaults to 'auto' which preserves existing behaviour.
function runGenerator(context, filePath, baselinePath, n, forceEngine = 'auto') {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, "src", "utils", "generator.py");
        const workspaceDir = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? os.tmpdir();
        const cacheDir = path.join(workspaceDir, '.idelense', 'cache');
        fs.mkdirSync(cacheDir, { recursive: true });
        const proc = spawnPython(py, [
            scriptPath, filePath, baselinePath, "--n", String(n), "--cache-dir", cacheDir, "--engine", forceEngine
        ]);
        const timeout = setTimeout(() => {
            proc.kill();
            reject(new Error('generator.py timed out after 120s'));
        }, 120000);
        const { stdout, stderr, code } = await collectOutput(proc);
        clearTimeout(timeout);
        if (code === 2) {
            // Exit code 2 = PipelineHardFail — structured enforcement error
            let enforcementErr = { error_type: 'PipelineHardFail', message: stderr };
            try {
                enforcementErr = JSON.parse(stderr.trim());
            }
            catch { /* use raw */ }
            reject(new Error(`[${enforcementErr.error_type || 'EnforcementFail'}] ` +
                `Stage: ${enforcementErr.stage || 'unknown'} — ` +
                `${enforcementErr.message || stderr}`));
            return;
        }
        if (code !== 0) {
            reject(new Error(stderr || `generator.py exited ${code}`));
            return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
            reject(new Error('Empty output from generator.py'));
            return;
        }
        try {
            resolve(JSON.parse(trimmed));
        }
        catch {
            reject(new Error("Invalid JSON from generator.py"));
        }
    });
}
/**
 * runLeakageAnalysis — always resolves (never rejects).
 * Returns the full LeakageResult contract with all required fields.
 */
function runLeakageAnalysis(context, originalFilePath, generatorResult) {
    return new Promise(async (resolve) => {
        const errorResult = (msg) => ({
            risk_level: null,
            privacy_score: null,
            privacy_score_reliable: false,
            statistical_drift: null,
            duplicates_rate: null,
            membership_inference_auc: null,
            top_threats: [],
            threat_details: [],
            column_drift: {},
            has_uncertainty: true,
            uncertainty_notes: [msg],
            error: msg,
            _mode: "error",
            privacy_components: { duplicates_risk: 0, mi_attack_risk: 0, distance_similarity_risk: 0, distribution_drift_risk: 0 },
        });
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, "src", "utils", "leakage_bridge.py");
        const n = generatorResult?.row_count ?? 500;
        const pipelineDir = getPipelineDir();
        const args = [scriptPath, "--original", originalFilePath, "--n", String(n)];
        if (pipelineDir) {
            args.push("--pipeline-dir", pipelineDir);
        }
        // Write the exact synthetic samples shown to the user so leakage
        // metrics run on the same data — not a freshly re-generated batch.
        let synthTmpPath = null;
        if (generatorResult?.samples && generatorResult.samples.length > 0) {
            try {
                const cols = Object.keys(generatorResult.samples[0]);
                const csvLines = [
                    cols.join(','),
                    ...generatorResult.samples.map((row) => cols.map(c => {
                        const v = String(row[c] ?? '');
                        return v.includes(',') || v.includes('"') || v.includes('\n')
                            ? `"${v.replace(/"/g, '""')}"` : v;
                    }).join(','))
                ].join('\n');
                synthTmpPath = path.join(os.tmpdir(), `idelense_leaksynth_${Date.now()}.csv`);
                fs.writeFileSync(synthTmpPath, csvLines);
                args.push('--synthetic', synthTmpPath);
            }
            catch {
                synthTmpPath = null;
            }
        }
        let proc;
        try {
            proc = spawnPython(py, args);
        }
        catch (spawnErr) {
            resolve(errorResult(`Could not start leakage_bridge.py: ${spawnErr.message}`));
            return;
        }
        const { stdout, stderr } = await collectOutput(proc);
        if (synthTmpPath) {
            try {
                fs.unlinkSync(synthTmpPath);
            }
            catch { }
        }
        // leakage_bridge.py always emits exactly one JSON object line.
        // Imported modules or fallback paths can emit extra lines before it;
        // scan in reverse for the last line that starts with '{' so stray
        // prints never contaminate the parse.
        const jsonLine = stdout
            .split("\n")
            .map(l => l.trim())
            .filter(l => l.startsWith("{"))
            .pop();
        if (jsonLine) {
            try {
                const parsed = JSON.parse(jsonLine);
                // Ensure privacy_components always exists
                if (!parsed.privacy_components) {
                    const auc = parsed.membership_inference_auc;
                    parsed.privacy_components = {
                        duplicates_risk: parsed.duplicates_rate ?? 0,
                        mi_attack_risk: Math.max(0, ((auc ?? 0.5) - 0.5) * 2),
                        distance_similarity_risk: Math.max(0, (0.5 - (auc ?? 0.5)) * 2),
                        distribution_drift_risk: Object.keys(parsed.column_drift ?? {}).length
                            ? Object.values(parsed.column_drift ?? {}).reduce((a, b) => a + b, 0) / Object.values(parsed.column_drift ?? {}).length
                            : 0,
                    };
                }
                resolve(parsed);
                return;
            }
            catch {
                resolve(errorResult(`Invalid JSON from leakage_bridge.py: ${jsonLine.slice(0, 120)}`));
                return;
            }
        }
        resolve(errorResult(stderr.trim() || "leakage_bridge.py exited with no output"));
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Pipeline context for LLM (updated after each full run)
// ─────────────────────────────────────────────────────────────────────────────
let lastPipelineContext = {};
// ─────────────────────────────────────────────────────────────────────────────
// Last parsed file state — enables dashboard "Run Generator" to re-run pipeline
// ─────────────────────────────────────────────────────────────────────────────
let lastFilePath = '';
let lastBaseline = null;
let lastAst = null;
// Persists the most recent stat_summary / generate_report artifact across messages
// so the Export button stays visible even when the model doesn't call a report tool.
let lastReportArtifact = null;
// ─────────────────────────────────────────────────────────────────────────────
// New Python process runners
// ─────────────────────────────────────────────────────────────────────────────
function runPIIScan(context, filePath) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'security', 'data_scanner.py');
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, [scriptPath, filePath]));
        if (code !== 0) {
            reject(stderr || `data_scanner.py exited ${code}`);
            return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
            reject('Empty output from data_scanner.py');
            return;
        }
        try {
            resolve(JSON.parse(trimmed));
        }
        catch {
            reject('Invalid JSON from data_scanner.py');
        }
    });
}
function runAnonymizer(context, filePath, outputPath) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'security', 'anonymizer.py');
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, [
            scriptPath, filePath, '--output', outputPath
        ]));
        if (code !== 0) {
            reject(stderr || `anonymizer.py exited ${code}`);
            return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
            reject('Empty output from anonymizer.py');
            return;
        }
        try {
            resolve(JSON.parse(trimmed));
        }
        catch {
            reject('Invalid JSON from anonymizer.py');
        }
    });
}
function runAttackSim(context, originalPath, syntheticPath) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'privacy', 'attack_simulator.py');
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, [
            scriptPath, '--original', originalPath, '--synthetic', syntheticPath
        ]));
        if (code !== 0) {
            reject(stderr || `attack_simulator.py exited ${code}`);
            return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
            reject('Empty output from attack_simulator.py');
            return;
        }
        try {
            resolve(JSON.parse(trimmed));
        }
        catch {
            reject('Invalid JSON from attack_simulator.py');
        }
    });
}
function runKnowledgeGraph(context, baselinePath) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'ai', 'knowledge_graph.py');
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, [
            scriptPath, '--baseline', baselinePath
        ]));
        if (code !== 0) {
            reject(stderr || `knowledge_graph.py exited ${code}`);
            return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
            reject('Empty output from knowledge_graph.py');
            return;
        }
        try {
            resolve(JSON.parse(trimmed));
        }
        catch {
            reject('Invalid JSON from knowledge_graph.py');
        }
    });
}
function runDocGenerator(context, baselinePath, leakagePath, scanPath, attackPath, outputPath) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'ai', 'doc_generator.py');
        const args = [scriptPath, '--baseline', baselinePath];
        if (leakagePath) {
            args.push('--leakage', leakagePath);
        }
        if (scanPath) {
            args.push('--scan', scanPath);
        }
        if (attackPath) {
            args.push('--attack', attackPath);
        }
        if (outputPath) {
            args.push('--output', outputPath);
        }
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, args));
        if (code !== 0) {
            reject(stderr || `doc_generator.py exited ${code}`);
            return;
        }
        resolve(stdout);
    });
}
function runMdToDocx(context, mdPath, docxPath) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'ai', 'md_to_docx.py');
        const { stderr, code } = await collectOutput(spawnPython(py, [scriptPath, '--input', mdPath, '--output', docxPath]));
        if (code !== 0) {
            reject(stderr || `md_to_docx.py exited ${code}`);
            return;
        }
        resolve();
    });
}
function runStatDocx(context, dataJsonPath, docxPath) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'ai', 'aurora_stat_docx.py');
        const { stderr, code } = await collectOutput(spawnPython(py, [scriptPath, dataJsonPath, docxPath]));
        // On Windows, matplotlib/python-docx can exit via signal (code = null) even after
        // successfully writing the file. Treat any non-zero / null exit as success if the
        // output file was actually created — only reject when the file is truly absent.
        if (fs.existsSync(docxPath)) {
            resolve();
            return;
        }
        if (code !== 0) {
            reject(new Error(stderr || `aurora_stat_docx.py exited ${code}`));
            return;
        }
        resolve();
    });
}
function runLineageBuilder(context, sourcePath, baselinePath, leakagePath) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'ai', 'lineage.py');
        const args = [scriptPath, '--source', sourcePath];
        if (baselinePath) {
            args.push('--baseline', baselinePath);
        }
        if (leakagePath) {
            args.push('--leakage', leakagePath);
        }
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, args));
        if (code !== 0) {
            reject(stderr || `lineage.py exited ${code}`);
            return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
            reject('Empty output from lineage.py');
            return;
        }
        try {
            resolve(JSON.parse(trimmed));
        }
        catch {
            reject('Invalid JSON from lineage.py');
        }
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Show PII scan report in a new panel
// ─────────────────────────────────────────────────────────────────────────────
function showScanReport(context, report, filePath) {
    const panel = vscode.window.createWebviewPanel('automateScanReport', 'Aurora — PII Scan Report', vscode.ViewColumn.Beside, { enableScripts: true });
    const n_pii = report.pii_findings?.length || 0;
    const n_sec = report.secrets?.length || 0;
    const n_sen = report.sensitive_content?.length || 0;
    const riskColor = report.risk_score > 70 ? '#ef4444' : report.risk_score > 30 ? '#f59e0b' : '#10b981';
    const findingsHtml = [...(report.pii_findings || []), ...(report.secrets || []), ...(report.sensitive_content || [])]
        .slice(0, 50)
        .map((f) => `<tr><td>${esc(f.type)}</td><td>${esc(f.category)}</td><td>${esc(f.column)}</td><td>${esc(f.severity)}</td><td>${esc(f.value_preview || '—')}</td></tr>`)
        .join('');
    panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:var(--vscode-font-family,sans-serif);font-size:13px;color:#ede5f8;background:#0f0f17;padding:20px}
.card{background:#171723;border:1px solid #2a2a3b;border-radius:10px;padding:16px;margin-bottom:14px}
h2{font-size:15px;margin-bottom:12px;font-weight:600;color:#c084fc}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}
.stat-box label{font-size:10px;text-transform:uppercase;color:#9080b0;display:block;margin-bottom:2px}
.stat-box span{font-size:18px;font-weight:700}
table{width:100%;border-collapse:collapse;font-size:11px;margin-top:8px}
th{text-align:left;padding:5px 8px;background:#1a1a2e;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#9080b0}
td{padding:5px 8px;border-bottom:1px solid rgba(139,92,246,.08)}
</style></head><body>
<div class="card"><h2>🛡️ PII & Security Scan Report</h2><p style="font-size:11px;color:#9080b0">${esc(path.basename(filePath))}</p></div>
<div class="card"><div class="stat-grid">
<div class="stat-box"><label>PII Findings</label><span style="color:#f59e0b">${n_pii}</span></div>
<div class="stat-box"><label>Secrets</label><span style="color:#ef4444">${n_sec}</span></div>
<div class="stat-box"><label>Sensitive</label><span style="color:#8b5cf6">${n_sen}</span></div>
<div class="stat-box"><label>Risk Score</label><span style="color:${riskColor}">${Math.round(report.risk_score)}/100</span></div>
<div class="stat-box"><label>Cells Scanned</label><span style="color:#c084fc">${report.total_cells_scanned?.toLocaleString() || '—'}</span></div>
<div class="stat-box"><label>Columns</label><span style="color:#c084fc">${report.columns_scanned || '—'}</span></div>
</div></div>
${report.high_risk_columns?.length ? `<div class="card"><h2>⚠ High-Risk Columns</h2><p style="font-size:12px;color:#f59e0b">${report.high_risk_columns.join(', ')}</p></div>` : ''}
<div class="card"><h2>📋 Findings (top 50)</h2>
<table><thead><tr><th>Type</th><th>Category</th><th>Column</th><th>Severity</th><th>Preview</th></tr></thead>
<tbody>${findingsHtml || '<tr><td colspan="5" style="text-align:center;padding:12px;color:#9080b0">✅ No findings — dataset appears clean.</td></tr>'}</tbody></table>
</div>
<div class="card" style="font-size:11px;color:#9080b0">${esc(report.summary || '')}</div>
</body></html>`;
}
// Show attack simulation report
function showAttackReport(context, report) {
    const panel = vscode.window.createWebviewPanel('automateAttackReport', 'Aurora — Attack Simulation', vscode.ViewColumn.Beside, { enableScripts: true });
    const vulnColor = report.overall_vulnerability === 'safe' ? '#10b981' :
        report.overall_vulnerability === 'moderate' ? '#f59e0b' : '#ef4444';
    const resultsHtml = (report.results || []).map((r) => {
        const icon = r.success ? '❌' : '✅';
        const sevColor = r.severity === 'critical' ? '#ef4444' : r.severity === 'high' ? '#f59e0b' : '#10b981';
        return `<div style="background:#1a1a2e;border-radius:8px;padding:12px;margin-bottom:8px;border-left:3px solid ${sevColor}">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <span style="font-weight:600;color:#ede5f8">${icon} ${esc(r.attack_name)}</span>
                <span style="font-size:10px;color:${sevColor};text-transform:uppercase">${esc(r.severity)}</span>
            </div>
            <p style="font-size:11px;color:#9080b0;margin-top:4px">${esc(r.description)}</p>
            <p style="font-size:10px;color:#7c6fa0;margin-top:2px">Success rate: ${(r.success_rate * 100).toFixed(1)}%</p>
        </div>`;
    }).join('');
    const recsHtml = (report.recommendations || []).map((r) => `<li style="font-size:11px;color:#9080b0;margin-bottom:4px">💡 ${esc(r)}</li>`).join('');
    panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:var(--vscode-font-family,sans-serif);color:#ede5f8;background:#0f0f17;padding:20px}
.card{background:#171723;border:1px solid #2a2a3b;border-radius:10px;padding:16px;margin-bottom:14px}
h2{font-size:15px;margin-bottom:12px;font-weight:600;color:#c084fc}
</style></head><body>
<div class="card"><h2>⚔️ Attack Simulation Report</h2>
<p style="font-size:12px;margin-bottom:8px">Vulnerability: <span style="color:${vulnColor};font-weight:700;text-transform:uppercase">${esc(report.overall_vulnerability)}</span></p>
<p style="font-size:11px;color:#9080b0">${esc(report.summary)}</p></div>
<div class="card"><h2>Results</h2>${resultsHtml}</div>
${recsHtml ? `<div class="card"><h2>💡 Recommendations</h2><ul style="padding-left:16px">${recsHtml}</ul></div>` : ''}
</body></html>`;
}
// Simple HTML escape helper for report panels
function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// ─────────────────────────────────────────────────────────────────────────────
// Parse + Baseline panel (before generation)
// ─────────────────────────────────────────────────────────────────────────────
function showCombinedResult(context, ast, baseline, filePath) {
    const panel = vscode.window.createWebviewPanel("idelenseCombined", "Aurora — Parse + Baseline", vscode.ViewColumn.Beside, {
        enableScripts: true,
        localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'media'),
        ],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'logo.png');
    const logoUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'logo.png')).toString();
    const astDs = ast?.dataset ?? ast ?? {};
    const schemaFields = astDs?.schema?.fields ?? [];
    const profile = astDs?.profile ?? {};
    const blNumCols = Object.keys(baseline?.columns?.numeric ?? {});
    const blCatCols = Object.keys(baseline?.columns?.categorical ?? {});
    const colRows = schemaFields.map((f) => {
        const isNum = blNumCols.includes(f.name);
        const isCat = blCatCols.includes(f.name);
        const tag = isNum ? 'numeric' : isCat ? 'categorical' : f.dtype ?? '—';
        const miss = profile.missingness?.[f.name];
        const misSt = miss != null ? Math.round(miss * 100) + '%' : '—';
        return `<tr>
          <td><b>${f.name}</b></td>
          <td><span style="font-size:10px;padding:1px 6px;border-radius:8px;
            background:${isNum ? 'rgba(139,92,246,.15)' : 'rgba(168,85,247,.1)'};
            color:${isNum ? '#a78bfa' : '#c084fc'}">${tag}</span></td>
          <td style="text-align:right">${f.nullable ? '✓' : '—'}</td>
          <td style="text-align:right">${misSt}</td>
        </tr>`;
    }).join('');
    panel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family,sans-serif);font-size:13px;color:#ede5f8;background:#0f0f17;padding:0}
h2{font-size:15px;margin-bottom:12px;font-weight:600;color:#c084fc}
.card{background:#171723;border:1px solid #2a2a3b;border-radius:10px;padding:16px;margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:5px 8px;background:#1a1a2e;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#9080b0}
td{padding:6px 8px;border-bottom:1px solid rgba(139,92,246,.08)}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px}
.stat-box label{font-size:10px;text-transform:uppercase;color:#9080b0;display:block;margin-bottom:2px}
.stat-box span{font-size:16px;font-weight:700;color:#c084fc}
.gen-row{display:flex;align-items:center;gap:10px;margin-bottom:12px}
input[type=number]{background:#1e1e2e;border:1px solid #2a2a3b;color:#ede5f8;border-radius:6px;padding:5px 8px;font-size:13px;width:90px}
button{background:linear-gradient(135deg,#7c3aed,#9333ea);color:#fff;border:none;border-radius:6px;padding:6px 16px;font-size:13px;cursor:pointer;font-weight:500}
button:hover{opacity:.85}
#status{font-size:12px;color:#9080b0;margin-top:8px}
.parse-hdr{display:flex;align-items:center;gap:10px;padding:12px 20px;border-bottom:1px solid #2a2a3b;background:#0f0f17;margin-bottom:20px}
.parse-hdr-text .title{font-size:14px;font-weight:700;letter-spacing:-.02em;color:#ede5f8}
.parse-hdr-text .sub{font-size:10px;color:#9080b0;margin-top:1px}
.content-wrap{padding:20px}
</style></head><body>
<div class="parse-hdr">
  <img src="${logoUri}" width="32" height="32" style="border-radius:7px;display:block;flex-shrink:0;" alt="Aurora"/>
  <div class="parse-hdr-text">
    <div class="title">Aurora — Parse + Baseline</div>
    <div class="sub">Schema analysis and baseline statistics</div>
  </div>
</div>
<div class="content-wrap">
<div class="card">
  <h2>📄 Dataset Overview</h2>
  <div class="stat-grid">
    <div class="stat-box"><label>Rows</label><span>${profile.row_count_estimate ?? baseline?.meta?.row_count ?? '—'}</span></div>
    <div class="stat-box"><label>Columns</label><span>${schemaFields.length || (blNumCols.length + blCatCols.length)}</span></div>
    <div class="stat-box"><label>Numeric</label><span>${blNumCols.length}</span></div>
    <div class="stat-box"><label>Categorical</label><span>${blCatCols.length}</span></div>
  </div>
</div>
<div class="card">
  <h2>🗂 Column Schema</h2>
  <table>
    <thead><tr><th>Column</th><th>Type</th><th>Nullable</th><th>Missing (sample)</th></tr></thead>
    <tbody>${colRows || '<tr><td colspan="4" style="text-align:center;padding:12px;color:#9080b0">No schema data</td></tr>'}</tbody>
  </table>
</div>
<div class="card">
  <h2>⚙️ Generate Synthetic Data</h2>
  <p style="font-size:12px;color:#9080b0;margin-bottom:12px">
    After generation completes, the Aurora UI will open automatically.
  </p>
  <div class="gen-row">
    <label style="font-size:12px;color:#9080b0">Rows:</label>
    <input id="n" type="number" value="500" min="1"/>
    <button onclick="generate()">▶ Generate + Analyse</button>
  </div>
  <div id="status"></div>
</div>
<script>
  const vscode = acquireVsCodeApi();
  function generate() {
    const n = parseInt(document.getElementById('n').value, 10);
    document.getElementById('status').textContent = '⏳ Running generation pipeline…';
    vscode.postMessage({ command: 'generate', n });
  }
  window.addEventListener('message', e => {
    document.getElementById('status').textContent = e.data.text;
  });
</script>
</div>
</body></html>`;
    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.command !== "generate") {
            return;
        }
        const tmpPath = path.join(os.tmpdir(), `idelense_baseline_${Date.now()}.json`);
        fs.writeFileSync(tmpPath, JSON.stringify(baseline));
        try {
            const result = await runGenerator(context, filePath, tmpPath, msg.n);
            panel.webview.postMessage({ text: '🔍 Running leakage analysis…' });
            const leakageResult = await runLeakageAnalysis(context, filePath, result);
            // ── Run extended analytics pipeline ──────────────────────────
            let scanReport = null;
            let attackReport = null;
            let knowledgeGraph = null;
            let lineageData = null;
            try {
                panel.webview.postMessage({ text: '🛡️ Running PII scan…' });
                scanReport = await runPIIScan(context, filePath);
            }
            catch { /* non-critical */ }
            // Auto-run attack simulation using the generated synthetic rows
            try {
                if (result.samples && result.samples.length > 0) {
                    panel.webview.postMessage({ text: '⚔️ Running attack simulation…' });
                    // Write synthetic samples to a temp CSV for the attack simulator
                    const synthCsvPath = path.join(os.tmpdir(), `idelense_synth_${Date.now()}.csv`);
                    const cols = Object.keys(result.samples[0]);
                    const csvLines = [
                        cols.join(','),
                        ...result.samples.map((row) => cols.map(c => {
                            const v = row[c] ?? '';
                            const s = String(v);
                            return s.includes(',') || s.includes('"') || s.includes('\n')
                                ? '"' + s.replace(/"/g, '""') + '"'
                                : s;
                        }).join(','))
                    ].join('\n');
                    fs.writeFileSync(synthCsvPath, csvLines);
                    try {
                        attackReport = await runAttackSim(context, filePath, synthCsvPath);
                    }
                    finally {
                        try {
                            fs.unlinkSync(synthCsvPath);
                        }
                        catch { }
                    }
                }
            }
            catch { /* non-critical */ }
            try {
                panel.webview.postMessage({ text: '🕸️ Building knowledge graph…' });
                knowledgeGraph = await runKnowledgeGraph(context, tmpPath);
            }
            catch { /* non-critical */ }
            try {
                panel.webview.postMessage({ text: '📊 Tracking lineage…' });
                lineageData = await runLineageBuilder(context, filePath, tmpPath);
            }
            catch { /* non-critical */ }
            // Update global pipeline context for LLM
            lastPipelineContext = {
                baseline, leakage: leakageResult, result, ast,
                scanReport, attackReport, graph: knowledgeGraph, lineage: lineageData
            };
            // Keep last-file globals in sync so dashboard can re-run
            lastFilePath = filePath;
            lastBaseline = baseline;
            lastAst = ast;
            // Generate dataset card in workspace
            try {
                const wsDir = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? os.tmpdir();
                const cardDir = path.join(wsDir, '.idelense');
                fs.mkdirSync(cardDir, { recursive: true });
                const cardPath = path.join(cardDir, 'dataset_card.md');
                const leakTmp = path.join(os.tmpdir(), `idelense_leak_${Date.now()}.json`);
                fs.writeFileSync(leakTmp, JSON.stringify(leakageResult));
                await runDocGenerator(context, tmpPath, leakTmp, undefined, undefined, cardPath);
                try {
                    fs.unlinkSync(leakTmp);
                }
                catch { }
            }
            catch { /* non-critical */ }
            // If a dashboard is already open, update it in-place. Otherwise open a new one.
            const existingPanels = global.__automatePanels ?? new Set();
            if (existingPanels.size > 0) {
                const existingPanel = existingPanels.values().next().value;
                existingPanel.reveal(vscode.ViewColumn.Beside, true);
                const chartUri = existingPanel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chart.min.js')).toString();
                const payload = {
                    type: 'pipelineComplete',
                    data: {
                        result, leakage: leakageResult ?? null,
                        ast: ast ?? null, baseline: baseline ?? null,
                        scanReport: scanReport ?? null, attackReport: attackReport ?? null,
                        knowledgeGraph: knowledgeGraph ?? null, lineage: lineageData ?? null,
                        chartUri,
                    }
                };
                // Small delay to ensure the panel is revealed and its webview is active
                setTimeout(() => {
                    // Emit only the normalised pipelineResult — avoids double render
                    existingPanel.webview.postMessage({
                        type: 'pipelineResult',
                        profile: baseline ?? null,
                        generator: result,
                        leakage: leakageResult ?? null,
                        intelligence: {},
                        scanReport: scanReport ?? null,
                        ast: ast ?? null,
                        attackReport: attackReport ?? null,
                        knowledgeGraph: knowledgeGraph ?? null,
                        lineage: lineageData ?? null,
                        data: {
                            profile: baseline ?? null,
                            baseline: baseline ?? null,
                            generator: result,
                            result,
                            leakage: leakageResult ?? null,
                            intelligence: {},
                            scanReport: scanReport ?? null,
                            ast: ast ?? null,
                            attackReport: attackReport ?? null,
                            knowledgeGraph: knowledgeGraph ?? null,
                            lineage: lineageData ?? null,
                        }
                    });
                    console.log('[AutoMate] pipelineResult sent to existing panel — rows:', result?.row_count);
                }, 300);
            }
            else {
                showCheckpointMonitor(context, result, leakageResult, ast, baseline, scanReport, attackReport, knowledgeGraph, lineageData);
            }
            panel.webview.postMessage({ text: `✓ Done — ${result.row_count} rows (${result.generator_used})` });
        }
        catch (err) {
            panel.webview.postMessage({ text: `⚠ Error: ${err}` });
            vscode.window.showErrorMessage("Generator error: " + err);
        }
        finally {
            if (tmpPath) {
                try {
                    fs.unlinkSync(tmpPath);
                }
                catch { }
            }
        }
    }, undefined, context.subscriptions);
}
// ─────────────────────────────────────────────────────────────────────────────
// Privacy Dashboard panel
// ─────────────────────────────────────────────────────────────────────────────
function showCheckpointMonitor(context, result, leakageResult, ast, baseline, scanReport, attackReport, knowledgeGraph, lineageData) {
    // Always create a fresh panel — reuse logic is handled at the call site
    const panel = vscode.window.createWebviewPanel('idelenseCheckpoint', 'Aurora UI', vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'media'),
        ],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'logo.png');
    const chartUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chart.min.js'));
    const logoUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'logo.png')).toString();
    const cpPath = result.checkpoint_path ?? '';
    function readCheckpoint() {
        try {
            return JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
        }
        catch {
            return null;
        }
    }
    // Build the full DashboardData object matching the UI contract
    const dashboardData = {
        result: result,
        leakage: leakageResult ?? null,
        ast: ast ?? null,
        baseline: baseline ?? null,
        cp: readCheckpoint(),
        chartUri: chartUri.toString(),
        logoUri: logoUri.toString(),
        checkpoint: readCheckpoint(), // alias for backward compat
        // Spec-field aliases — keeps D.generator and D.profile populated on first open
        generator: result, // D.generator holds .samples, .row_count, .generator_used
        profile: baseline ?? null, // D.profile holds .columns, .meta
        intelligence: {}, // reserved for future intelligence module
        scanReport: scanReport ?? null,
        attackReport: attackReport ?? null,
        knowledgeGraph: knowledgeGraph ?? null,
        lineage: lineageData ?? null,
        sourceKind: lastFilePath ? path.extname(lastFilePath).replace('.', '').toLowerCase() : 'csv',
    };
    panel.webview.html = (0, monitorPanel_1.buildMonitorHtml)(dashboardData);
    // Register panel for live alert forwarding
    const activePanels = global.__automatePanels ?? new Set();
    activePanels.add(panel);
    global.__automatePanels = activePanels;
    // Seed the panel with any alerts already in the store
    const existingAlerts = (0, alert_store_1.getRecentAlerts)(50);
    if (existingAlerts.length > 0) {
        setTimeout(() => {
            panel.webview.postMessage({ type: 'liveSecuritySeed', alerts: existingAlerts });
        }, 500);
    }
    panel.onDidDispose(() => {
        activePanels.delete(panel);
    }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage(async (msg) => {
        try {
            if (msg.command === 'runGenerator') {
                const n = (typeof msg.n === 'number' && msg.n > 0) ? msg.n : 500;
                let tmpPath = '';
                try {
                    // Step 1: ensure we have a parsed file
                    if (!lastFilePath || !lastBaseline) {
                        panel.webview.postMessage({ type: 'generatorStatus', text: '📂 Select a dataset file…' });
                        const fileUri = await vscode.window.showOpenDialog({
                            canSelectFiles: true,
                            canSelectMany: false,
                            filters: { 'Datasets': ['csv', 'json', 'jsonl', 'xlsx', 'parquet'] },
                            title: 'Aurora: Select dataset to analyse'
                        });
                        if (!fileUri || !fileUri[0]) {
                            panel.webview.postMessage({ type: 'generatorStatus', text: '⚠ No file selected.' });
                            panel.webview.postMessage({ type: 'resetGenBtn' });
                            return;
                        }
                        panel.webview.postMessage({ type: 'generatorStatus', text: '🔍 Parsing dataset…' });
                        const pickedPath = fileUri[0].fsPath;
                        const kind = detectKind(pickedPath);
                        const ast = await runPythonParser(context, pickedPath);
                        const baseline = await runBaseline(context, pickedPath, kind);
                        lastFilePath = pickedPath;
                        lastBaseline = baseline;
                        lastAst = ast;
                        panel.webview.postMessage({ type: 'generatorStatus', text: '✓ Parsed. Generating…' });
                    }
                    // Step 2: write baseline to tmp and run pipeline
                    tmpPath = path.join(os.tmpdir(), `idelense_baseline_${Date.now()}.json`);
                    fs.writeFileSync(tmpPath, JSON.stringify(lastBaseline));
                    panel.webview.postMessage({ type: 'generatorStatus', text: '⚙️ Generating synthetic data…' });
                    const result = await runGenerator(context, lastFilePath, tmpPath, n);
                    panel.webview.postMessage({ type: 'generatorStatus', text: '🔍 Running leakage analysis…' });
                    const leakageResult = await runLeakageAnalysis(context, lastFilePath, result);
                    let scanReport = null;
                    let attackReport = null;
                    let knowledgeGraph = null;
                    let lineageData = null;
                    try {
                        panel.webview.postMessage({ type: 'generatorStatus', text: '🛡️ Running PII scan…' });
                        scanReport = await runPIIScan(context, lastFilePath);
                    }
                    catch { /* non-critical */ }
                    try {
                        if (result.samples?.length > 0) {
                            panel.webview.postMessage({ type: 'generatorStatus', text: '⚔️ Running attack simulation…' });
                            const synthCsvPath = path.join(os.tmpdir(), `idelense_synth_${Date.now()}.csv`);
                            const cols = Object.keys(result.samples[0]);
                            const csvLines = [
                                cols.join(','),
                                ...result.samples.map((row) => cols.map(c => {
                                    const v = row[c] ?? '';
                                    const s = String(v);
                                    return s.includes(',') || s.includes('"') || s.includes('\n')
                                        ? '"' + s.replace(/"/g, '""') + '"' : s;
                                }).join(','))
                            ].join('\n');
                            fs.writeFileSync(synthCsvPath, csvLines);
                            try {
                                attackReport = await runAttackSim(context, lastFilePath, synthCsvPath);
                            }
                            finally {
                                try {
                                    fs.unlinkSync(synthCsvPath);
                                }
                                catch { }
                            }
                        }
                    }
                    catch { /* non-critical */ }
                    try {
                        panel.webview.postMessage({ type: 'generatorStatus', text: '🕸️ Building knowledge graph…' });
                        knowledgeGraph = await runKnowledgeGraph(context, tmpPath);
                    }
                    catch { /* non-critical */ }
                    try {
                        panel.webview.postMessage({ type: 'generatorStatus', text: '📊 Tracking lineage…' });
                        lineageData = await runLineageBuilder(context, lastFilePath, tmpPath);
                    }
                    catch { /* non-critical */ }
                    // Update global LLM context
                    lastPipelineContext = {
                        baseline: lastBaseline, leakage: leakageResult, result, ast: lastAst,
                        scanReport, attackReport, graph: knowledgeGraph, lineage: lineageData
                    };
                    // Push all fresh data to the dashboard
                    const chartUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chart.min.js')).toString();
                    panel.webview.postMessage({
                        type: 'pipelineComplete',
                        data: {
                            result, leakage: leakageResult,
                            ast: lastAst, baseline: lastBaseline,
                            scanReport, attackReport, knowledgeGraph,
                            lineage: lineageData, chartUri,
                        }
                    });
                    // Normalised alias with spec-compliant field names for monitorPanel
                    console.log('[AutoMate] sending pipelineResult', result);
                    panel.webview.postMessage({
                        type: 'pipelineResult',
                        profile: lastBaseline, // D.profile
                        generator: result, // D.generator (.samples inside)
                        leakage: leakageResult, // D.leakage
                        intelligence: {}, // D.intelligence (reserved for future module)
                        scanReport, // D.scanReport
                        ast: lastAst,
                        attackReport,
                        knowledgeGraph,
                        lineage: lineageData,
                        data: {
                            profile: lastBaseline, // D.profile
                            baseline: lastBaseline, // D.baseline (compat)
                            generator: result, // D.generator (.samples inside)
                            result, // D.result (compat)
                            leakage: leakageResult, // D.leakage
                            intelligence: {}, // D.intelligence (reserved for future module)
                            scanReport, // D.scanReport
                            ast: lastAst,
                            attackReport, knowledgeGraph,
                            lineage: lineageData,
                        }
                    });
                    console.log('[AutoMate] pipelineResult sent — rows:', result?.row_count, 'samples:', result?.samples?.length, 'scan:', !!scanReport, 'leakage:', !!leakageResult);
                    panel.webview.postMessage({
                        type: 'generatorStatus',
                        text: `✓ Done — ${result.row_count} rows (${result.generator_used})`
                    });
                }
                catch (err) {
                    panel.webview.postMessage({ type: 'generatorStatus', text: `⚠ Error: ${err}` });
                    panel.webview.postMessage({ type: 'resetGenBtn' });
                    vscode.window.showErrorMessage('Aurora generator error: ' + err);
                }
                finally {
                    if (tmpPath) {
                        try {
                            fs.unlinkSync(tmpPath);
                        }
                        catch { }
                    }
                }
            }
            if (msg.command === 'exportCSV') {
                const fmt = msg.format || 'csv';
                const defaultName = msg.filename ?? `synthetic_data.${fmt}`;
                const filterMap = {
                    json: { 'JSON': ['json'], 'All Files': ['*'] },
                    jsonl: { 'JSON Lines': ['jsonl'], 'All Files': ['*'] },
                    csv: { 'CSV': ['csv'], 'All Files': ['*'] },
                    tsv: { 'TSV': ['tsv'], 'All Files': ['*'] },
                    parquet: { 'Parquet': ['parquet'], 'All Files': ['*'] },
                };
                const filters = filterMap[fmt] ?? { 'CSV': ['csv'], 'All Files': ['*'] };
                const uri = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(), defaultName)),
                    filters,
                    saveLabel: 'Export Synthetic Data',
                });
                if (!uri) {
                    return;
                }
                fs.writeFileSync(uri.fsPath, msg.csv ?? '');
                const choice = await vscode.window.showInformationMessage(`Saved: ${uri.fsPath}`, 'Open in Editor');
                if (choice === 'Open in Editor') {
                    vscode.window.showTextDocument(uri);
                }
            }
            if (msg.command === 'exportReport') {
                const defaultName = msg.filename ?? 'report.json';
                const uri = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(), defaultName)),
                    filters: { 'JSON': ['json'], 'All Files': ['*'] },
                    saveLabel: 'Save Report',
                });
                if (!uri) {
                    return;
                }
                fs.writeFileSync(uri.fsPath, JSON.stringify(msg.report, null, 2));
                const choice = await vscode.window.showInformationMessage(`Saved: ${uri.fsPath}`, 'Open in Editor');
                if (choice === 'Open in Editor') {
                    vscode.window.showTextDocument(uri);
                }
            }
            if (msg.command === 'exportArtifact') {
                try {
                    const prebuiltPath = (msg.filePath && fs.existsSync(String(msg.filePath)))
                        ? String(msg.filePath) : null;
                    const defaultName = prebuiltPath
                        ? path.basename(prebuiltPath)
                        : (msg.filename ?? 'aurora_report.docx');
                    const wsDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
                    const uri = await vscode.window.showSaveDialog({
                        defaultUri: vscode.Uri.file(path.join(wsDir, defaultName)),
                        filters: { 'Word Document': ['docx'], 'All Files': ['*'] },
                        saveLabel: 'Export Report',
                    });
                    if (!uri) {
                        return;
                    }
                    if (prebuiltPath) {
                        fs.copyFileSync(prebuiltPath, uri.fsPath);
                    }
                    else {
                        const mdTmp = path.join(os.tmpdir(), `aurora_report_export_${Date.now()}.md`);
                        fs.writeFileSync(mdTmp, String(msg.content ?? ''), 'utf8');
                        await runMdToDocx(context, mdTmp, uri.fsPath);
                        try {
                            fs.unlinkSync(mdTmp);
                        }
                        catch { }
                    }
                    const choice = await vscode.window.showInformationMessage(`Report saved: ${uri.fsPath}`, 'Open in Editor');
                    if (choice === 'Open in Editor') {
                        vscode.window.showTextDocument(uri);
                    }
                }
                catch (err) {
                    vscode.window.showErrorMessage(`Export failed: ${err.message}`);
                }
            }
            if (msg.command === 'copyToClipboard') {
                vscode.env.clipboard.writeText(msg.text ?? '');
            }
            // ── NEW: LLM chat from dashboard ────────────────────────────────
            if (msg.command === 'askAI') {
                if (!llmClient.isConfigured()) {
                    panel.webview.postMessage({ type: 'aiResponse', error: 'API key not configured. Open the AI Insights tab and paste your key.' });
                    return;
                }
                try {
                    const response = await llmClient.askAboutData(msg.question, lastPipelineContext);
                    panel.webview.postMessage({ type: 'aiResponse', content: response.content, model: response.model, error: response.error });
                }
                catch (err) {
                    panel.webview.postMessage({ type: 'aiResponse', error: err.message });
                }
            }
            // ── API key status check (called when AI Insights tab opens) ─────
            if (msg.command === 'checkApiKey') {
                const configured = llmClient.isConfigured();
                const providerLabels = {
                    openrouter: 'OpenRouter', openai: 'OpenAI', anthropic: 'Anthropic',
                    groq: 'Groq', together: 'Together AI', mistral: 'Mistral',
                };
                const providerName = providerLabels[llmClient.getProvider()] || llmClient.getProvider();
                panel.webview.postMessage({ type: 'apiKeyStatus', configured, model: configured ? providerName : null });
                return;
            }
            // ── PART 6: Store API key via SecretStorage (encrypted, never settings.json) ─
            if (msg.command === 'setApiKey') {
                const key = (msg.apiKey || '').trim();
                const provider = (msg.provider || 'openrouter').trim();
                if (key && key !== 'PASTE_API_KEY_HERE') {
                    // PART 6: Persist to SecretStorage (encrypted at rest, never written to settings.json)
                    await context.secrets.store(`automate.apiKey.${provider}`, key);
                    // Inject into live client immediately
                    llmClient.setKey(key, provider);
                    console.log(`[AutoMate] API key stored in SecretStorage (provider: ${provider})`);
                    const providerLabels = {
                        openrouter: 'OpenRouter', openai: 'OpenAI', anthropic: 'Anthropic',
                        groq: 'Groq', together: 'Together AI', mistral: 'Mistral',
                    };
                    panel.webview.postMessage({ type: 'apiKeyStatus', configured: true, model: providerLabels[provider] || provider });
                }
                return;
            }
            // ── Open VS Code settings to a specific key ───────────────────────
            if (msg.command === 'openSettings') {
                vscode.commands.executeCommand('automate.openDashboard');
                return;
            }
            // ── Anonymize Dataset (triggered from webview Anonymize button) ──
            if (msg.command === 'anonymizeDataset') {
                vscode.commands.executeCommand('automate.anonymizeDataset');
                return;
            }
            // ── PART 6: Clear API key from SecretStorage ──────────────────────────
            if (msg.command === 'clearApiKey') {
                const allProviders = ['openrouter', 'openai', 'anthropic', 'groq', 'together', 'mistral'];
                for (const prov of allProviders) {
                    await context.secrets.delete(`automate.apiKey.${prov}`);
                }
                llmClient.setKey('');
                llmClient._keySetDirectly = false;
                llmClient.apiKey = '';
                console.log('[AutoMate] API key cleared from SecretStorage');
                panel.webview.postMessage({ type: 'apiKeyStatus', configured: false, model: null });
                return;
            }
            // ── Phase 5: Agent Chat (multi-turn with conversation history) ───
            if (msg.command === 'agentChat') {
                console.log('[Aurora] agentChat —', msg.message?.slice(0, 80));
                if (!llmClient.isConfigured()) {
                    panel.webview.postMessage({
                        type: 'agentResponse',
                        error: 'API key not configured. Paste your key in the AI Insights tab.',
                        msgId: msg.msgId,
                    });
                    return;
                }
                try {
                    // BUG-21 fix: Merge full live webview context into the effective context
                    const lc = msg.liveContext ?? {};
                    const effectiveContext = {
                        ...lastPipelineContext,
                        ...(lc.leakage ? { leakage: lc.leakage } : {}),
                        ...(lc.scanReport ? { scanReport: lc.scanReport } : {}),
                        ...(lc.profile ? { baseline: lc.profile,
                            datasetCtx: undefined } : {}),
                        ...(lc.cp ? { cp: lc.cp } : {}),
                        live_stats: lc,
                    };
                    // Build tool executor with live state accessors
                    const _currentUserMessage = msg.message ?? '';
                    const { executor: toolExecutor, getReportArtifact } = createToolExecutor(context, panel, () => ({
                        context: lastPipelineContext,
                        baseline: lastBaseline,
                        filePath: lastFilePath ?? null,
                    }), (patch) => {
                        lastPipelineContext = { ...lastPipelineContext, ...patch };
                    }, () => _currentUserMessage);
                    // Progress callback — fires before each tool execution
                    const onToolProgress = (toolName, args) => {
                        panel.webview.postMessage({
                            type: 'agentToolProgress',
                            toolName,
                            args,
                            msgId: msg.msgId,
                        });
                    };
                    // Wrap executor to capture analyze_dataset results for chart artifact
                    let _lastAnalysisResult = null;
                    const wrappedToolExecutor = async (name, args) => {
                        const result = await toolExecutor(name, args);
                        if (name === 'analyze_dataset') {
                            _lastAnalysisResult = result;
                        }
                        return result;
                    };
                    const response = await llmClient.agentChat(msg.history ?? [], msg.message, effectiveContext, wrappedToolExecutor, onToolProgress);
                    // Attach comparison chart artifact when analyze_dataset ran via native tool-calling
                    if (!response.artifact && _lastAnalysisResult) {
                        const chartArtifact = (0, openrouter_client_1._buildComparisonChartArtifact)(_lastAnalysisResult);
                        if (chartArtifact) {
                            response.artifact = chartArtifact;
                        }
                    }
                    // If the user asked to generate rows, ensure Export CSV artifact is set.
                    // This check runs BEFORE the report fallback so a generation request
                    // never gets the stale lastReportArtifact attached instead of a CSV card.
                    // Covers both the normal agentic path (toolsRun=true) and the degenerate
                    // case where the LLM replied in text only but rows were still produced.
                    const isStatOrReportRequest = /\b(summar|report|governance|statistical|stat\b)/i.test(msg.message ?? '');
                    const isGenRequest = !isStatOrReportRequest && ((/\b(generat|add|creat|mak|produc)\w*\b/i.test(msg.message ?? '') &&
                        /\b(rows?|records?|samples?)\b/i.test(msg.message ?? '')) || /\b(combin|merg)\w*\b/i.test(msg.message ?? ''));
                    if (isGenRequest) {
                        // Always stamp a CSV artifact for generation requests — even if the
                        // LLM didn't emit a tool call — so the Export CSV card is shown and
                        // a stale report artifact is never substituted in its place.
                        response.artifact = { type: 'csv', filePath: null };
                    }
                    // Attach pending report artifact (from stat_summary / generate_report tools).
                    // Update session-level cache so the Export button persists across messages
                    // even when the model doesn't call a report tool (e.g. after a model change).
                    // IMPORTANT: only fall back to the cached report when this is NOT a generation
                    // request — otherwise the stale report overwrites the CSV artifact above.
                    const pendingReport = getReportArtifact();
                    if (pendingReport) {
                        lastReportArtifact = pendingReport;
                    }
                    if (lastReportArtifact && !response.artifact) {
                        response.artifact = lastReportArtifact;
                    }
                    panel.webview.postMessage({
                        type: 'agentResponse',
                        content: response.content,
                        model: response.model,
                        error: response.error,
                        artifact: response.artifact ?? null,
                        msgId: msg.msgId,
                    });
                }
                catch (err) {
                    panel.webview.postMessage({ type: 'agentResponse', error: err.message, msgId: msg.msgId });
                }
            }
            // ── Phase 5: Agent quick-action commands from dashboard ──────────
            if (msg.command === 'agentAction') {
                if (!llmClient.isConfigured()) {
                    panel.webview.postMessage({ type: 'agentResponse', error: 'OpenRouter API key not configured.', msgId: msg.msgId });
                    return;
                }
                try {
                    let response;
                    switch (msg.action) {
                        case 'explainDataset':
                            response = await llmClient.explainDataset(lastPipelineContext);
                            break;
                        case 'detectAnomalies':
                            response = await llmClient.detectAnomalies(lastPipelineContext);
                            break;
                        case 'suggestCleaning':
                            response = await llmClient.suggestCleaning(lastPipelineContext);
                            break;
                        case 'generateSQL':
                            response = await llmClient.generateSQL(msg.sqlQuestion ?? 'Show all records', lastPipelineContext);
                            break;
                        case 'recommendGovernance':
                            response = await llmClient.recommendGovernance(lastPipelineContext);
                            break;
                        default: response = await llmClient.askAboutData(msg.action, lastPipelineContext);
                    }
                    panel.webview.postMessage({ type: 'agentResponse', content: response.content, model: response.model, error: response.error, msgId: msg.msgId });
                }
                catch (err) {
                    panel.webview.postMessage({ type: 'agentResponse', error: err.message, msgId: msg.msgId });
                }
            }
            // ── agentControl removed — superseded by generate_rows + merge_and_update tools ──
            // ── Aurora: Agent report generation ──────────────────────────────
            if (msg.command === 'agentReport') {
                try {
                    // Generate LLM report content — do NOT save to disk yet.
                    // The file is only written when the user clicks "Export Report".
                    const llmReport = llmClient.isConfigured()
                        ? await llmClient.agentReport(lastPipelineContext)
                        : null;
                    // Build full markdown in memory (merge doc_generator + LLM output)
                    let fullContent = llmReport?.content ?? '';
                    try {
                        if (lastFilePath && lastBaseline) {
                            const leakTmp = path.join(os.tmpdir(), `aurora_leak_${Date.now()}.json`);
                            const baseTmp = path.join(os.tmpdir(), `aurora_base_${Date.now()}.json`);
                            fs.writeFileSync(leakTmp, JSON.stringify(lastPipelineContext.leakage ?? {}));
                            fs.writeFileSync(baseTmp, JSON.stringify(lastBaseline));
                            const mdTmp = path.join(os.tmpdir(), `aurora_report_${Date.now()}.md`);
                            await runDocGenerator(context, baseTmp, leakTmp, undefined, undefined, mdTmp);
                            try {
                                fs.unlinkSync(leakTmp);
                                fs.unlinkSync(baseTmp);
                            }
                            catch { }
                            const baseCard = fs.existsSync(mdTmp) ? fs.readFileSync(mdTmp, 'utf-8') : '';
                            try {
                                fs.unlinkSync(mdTmp);
                            }
                            catch { }
                            if (baseCard) {
                                fullContent = baseCard + (fullContent ? '\n\n---\n\n## AI Governance Analysis\n\n' + fullContent : '');
                            }
                        }
                    }
                    catch { /* doc generator is non-critical */ }
                    panel.webview.postMessage({
                        type: 'agentReportResult',
                        content: fullContent || (llmReport?.content ?? null),
                        model: llmReport?.model ?? null,
                        error: llmReport?.error ?? null,
                        filePath: null, // no file written yet — saved on button press
                        msgId: msg.msgId,
                    });
                }
                catch (err) {
                    panel.webview.postMessage({ type: 'agentReportResult', error: String(err), msgId: msg.msgId });
                }
            }
            // ── Aurora: Statistical summary report generation ─────────────────
            if (msg.command === 'agentStatReport') {
                try {
                    // Deterministic path — no LLM call, no hallucination, charts included.
                    // Mirrors stat_summary tool exactly so both paths produce identical output.
                    const hasSynthetic = (lastPipelineContext.result?.samples ?? []).length > 0;
                    const scope = hasSynthetic ? 'comparison' : 'baseline';
                    const fullContent = (0, openrouter_client_1._buildStatReport)(lastPipelineContext, scope);
                    // Build docxPayload for aurora_stat_docx.py
                    const b_cols = lastBaseline?.columns?.numeric ?? {};
                    const samples = lastPipelineContext.result?.samples ?? [];
                    const synStats = {};
                    const slice = samples.slice(0, 1000);
                    if (slice.length > 0) {
                        for (const col of Object.keys(b_cols)) {
                            const vals = slice.map((r) => Number(r[col])).filter((v) => !isNaN(v));
                            if (vals.length === 0) {
                                continue;
                            }
                            const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
                            const sorted = [...vals].sort((a, b) => a - b);
                            const std = Math.sqrt(vals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / vals.length);
                            synStats[col] = { mean: parseFloat(mean.toFixed(4)), std: parseFloat(std.toFixed(4)), min: sorted[0], max: sorted[sorted.length - 1], median: sorted[Math.floor(sorted.length / 2)] };
                        }
                    }
                    const docxPayload = {
                        scope,
                        dataset_name: lastFilePath ? path.basename(lastFilePath) : 'dataset',
                        generated_at: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
                        baseline: { row_count: lastBaseline?.meta?.row_count ?? null, columns: b_cols },
                        synthetic: { row_count: samples.length || lastPipelineContext.result?.row_count || null, stats: synStats },
                        leakage: _normaliseLeakageForDocx(lastPipelineContext.leakage),
                    };
                    // Convert via aurora_stat_docx.py (includes charts) → temp
                    let filePath = null;
                    try {
                        const tmpOut = path.join(os.tmpdir(), `aurora_report_${scope}_${Date.now()}.docx`);
                        const jsonTmp = path.join(os.tmpdir(), `stat_data_${Date.now()}.json`);
                        fs.writeFileSync(jsonTmp, JSON.stringify(docxPayload), 'utf8');
                        await runStatDocx(context, jsonTmp, tmpOut);
                        try {
                            fs.unlinkSync(jsonTmp);
                        }
                        catch { }
                        filePath = fs.existsSync(tmpOut) ? tmpOut : null;
                    }
                    catch (e) {
                        console.error('[Aurora] agentStatReport runStatDocx failed:', e);
                        // Fallback: plain markdown → docx (no charts)
                        try {
                            const mdTmp = path.join(os.tmpdir(), `stat_${Date.now()}.md`);
                            const tmpOut2 = path.join(os.tmpdir(), `aurora_report_${scope}_no-charts_${Date.now()}.docx`);
                            fs.writeFileSync(mdTmp, fullContent, 'utf8');
                            await runMdToDocx(context, mdTmp, tmpOut2);
                            try {
                                fs.unlinkSync(mdTmp);
                            }
                            catch { }
                            filePath = fs.existsSync(tmpOut2) ? tmpOut2 : null;
                        }
                        catch (e2) {
                            console.error('[Aurora] agentStatReport fallback also failed:', e2);
                        }
                    }
                    panel.webview.postMessage({
                        type: 'agentReportResult',
                        content: fullContent || null,
                        error: null,
                        filePath,
                        reportType: 'statistical',
                        msgId: msg.msgId,
                    });
                }
                catch (err) {
                    panel.webview.postMessage({ type: 'agentReportResult', error: String(err), msgId: msg.msgId });
                }
            }
        }
        catch (err) {
            console.error('Webview message handler error:', err);
            // Report back to webview so the UI never silently freezes
            try {
                panel.webview.postMessage({ type: 'generatorStatus', text: `⚠ Internal error: ${err}` });
                const btn = 'gen-btn';
                panel.webview.postMessage({ type: 'resetGenBtn' });
            }
            catch { /* panel may be disposed */ }
        }
    }, undefined, context.subscriptions);
    // Incremental checkpoint updates — only push delta, no full re-render
    if (cpPath) {
        const timer = setInterval(() => {
            const cp = readCheckpoint();
            if (!cp) {
                return;
            }
            // Keep live cp available to the LLM context for agentChat
            lastPipelineContext = { ...lastPipelineContext, cp };
            panel.webview.postMessage({ type: 'checkpointUpdate', data: cp });
            if (cp.status !== 'in_progress') {
                clearInterval(timer);
            }
        }, 2000);
        panel.onDidDispose(() => clearInterval(timer), null, context.subscriptions);
    }
}
//# sourceMappingURL=extension.js.map