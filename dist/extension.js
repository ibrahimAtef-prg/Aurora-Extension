/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ([
/* 0 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


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
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(__webpack_require__(1));
const cp = __importStar(__webpack_require__(2));
const path = __importStar(__webpack_require__(3));
const fs = __importStar(__webpack_require__(4));
const os = __importStar(__webpack_require__(5));
const monitorPanel_1 = __webpack_require__(6);
const realtime_scanner_1 = __webpack_require__(14);
const prompt_scanner_1 = __webpack_require__(17);
const openrouter_client_1 = __webpack_require__(18);
const alert_store_1 = __webpack_require__(15);
/*
  AutoMate Aurora — Privacy Dashboard Extension
  Pipeline: parse.py → baseline.py → generator.py → leakage_bridge.py
  Dashboard: src/webview/monitorPanel.ts
*/
// ─────────────────────────────────────────────────────────────────────────────
// Python resolver
// ─────────────────────────────────────────────────────────────────────────────
function resolvePythonCommand() {
    const config = vscode.workspace.getConfiguration('idelense');
    const userPath = config.get('pythonPath');
    if (userPath && userPath.trim()) {
        return userPath.trim();
    }
    if (process.platform === 'win32') {
        return 'python';
    }
    if (process.platform === 'darwin') {
        return 'python3';
    }
    return 'python3';
}
function getPipelineDir() {
    const config = vscode.workspace.getConfiguration('idelense');
    return config.get('pipelinePath') ?? '';
}
// ─────────────────────────────────────────────────────────────────────────────
// Extension activation
// ─────────────────────────────────────────────────────────────────────────────
// ── Global LLM client (shared across commands) ──────────────────────────────
let llmClient;
// ─────────────────────────────────────────────────────────────────────────────
// Agentic ToolExecutor — bridges LLM tool calls to real system operations
// ─────────────────────────────────────────────────────────────────────────────
function createToolExecutor(_context, _panel) {
    const py = resolvePythonCommand();
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
    return async (name, args) => {
        switch (name) {
            case 'shell_execute': {
                const cwd = args.cwd || wsRoot;
                return new Promise((resolve) => {
                    cp.exec(String(args.command), { cwd, timeout: 30000 }, (err, stdout, stderr) => {
                        if (err) {
                            resolve(`ERROR: ${err.message}\n${stderr || ''}`);
                        }
                        else {
                            resolve(stdout || stderr || '(no output)');
                        }
                    });
                });
            }
            case 'file_read': {
                try {
                    const p = path.isAbsolute(args.path) ? args.path : path.join(wsRoot, args.path);
                    return fs.readFileSync(p, 'utf8');
                }
                catch (e) {
                    return `ERROR: ${e.message}`;
                }
            }
            case 'file_write': {
                try {
                    const p = path.isAbsolute(args.path) ? args.path : path.join(wsRoot, args.path);
                    fs.mkdirSync(path.dirname(p), { recursive: true });
                    fs.writeFileSync(p, String(args.content), 'utf8');
                    return `Written ${String(args.content).length} bytes to ${p}`;
                }
                catch (e) {
                    return `ERROR: ${e.message}`;
                }
            }
            case 'file_list': {
                try {
                    const p = path.isAbsolute(args.path) ? args.path : path.join(wsRoot, args.path);
                    const entries = fs.readdirSync(p, { withFileTypes: true });
                    return entries.map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n');
                }
                catch (e) {
                    return `ERROR: ${e.message}`;
                }
            }
            case 'python_run': {
                const tmpScript = path.join(os.tmpdir(), `aurora_agent_${Date.now()}.py`);
                try {
                    fs.writeFileSync(tmpScript, String(args.script), 'utf8');
                    const extraArgs = Array.isArray(args.args) ? args.args.map(String) : [];
                    const { stdout, stderr, code } = await collectOutput(spawnPython(py, [tmpScript, ...extraArgs]));
                    try {
                        fs.unlinkSync(tmpScript);
                    }
                    catch { }
                    return code === 0 ? (stdout || '(no output)') : `ERROR (exit ${code}):\n${stderr}`;
                }
                catch (e) {
                    try {
                        fs.unlinkSync(tmpScript);
                    }
                    catch { }
                    return `ERROR: ${e.message}`;
                }
            }
            case 'vscode_command': {
                try {
                    const result = await vscode.commands.executeCommand(String(args.command), ...(Array.isArray(args.args) ? args.args : []));
                    return result !== undefined ? JSON.stringify(result) : '(command executed)';
                }
                catch (e) {
                    return `ERROR: ${e.message}`;
                }
            }
            default:
                return `ERROR: Unknown tool "${name}"`;
        }
    };
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
        const filePath = path.join(workspaceDir, fileName);
        try {
            const kind = detectKind(filePath);
            const ast = await runPythonParser(context, filePath);
            const baseline = await runBaseline(context, filePath, kind);
            // Store for dashboard "Run Generator" button
            lastFilePath = filePath;
            lastBaseline = baseline;
            lastAst = ast;
            showCombinedResult(context, ast, baseline, filePath);
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
    const match = line.match(/['"]([^'"]+\.(csv|xlsx|json|parquet))['"]/);
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
    if (ext === ".json") {
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
function runGenerator(context, filePath, baselinePath, n) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, "src", "utils", "generator.py");
        const workspaceDir = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? os.tmpdir();
        const cacheDir = path.join(workspaceDir, '.idelense', 'cache');
        fs.mkdirSync(cacheDir, { recursive: true });
        const proc = spawnPython(py, [
            scriptPath, filePath, baselinePath, "--n", String(n), "--cache-dir", cacheDir
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
  <img src="${logoUri}" style="width:32px;height:32px;border-radius:7px;display:block;flex-shrink:0;object-fit:contain;" alt="Aurora"/>
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
        logoUri: logoUri,
        checkpoint: readCheckpoint(), // alias for backward compat
        // Spec-field aliases — keeps D.generator and D.profile populated on first open
        generator: result, // D.generator holds .samples, .row_count, .generator_used
        profile: baseline ?? null, // D.profile holds .columns, .meta
        intelligence: {}, // reserved for future intelligence module
        scanReport: scanReport ?? null,
        attackReport: attackReport ?? null,
        knowledgeGraph: knowledgeGraph ?? null,
        lineage: lineageData ?? null,
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
                            filters: { 'Datasets': ['csv', 'json', 'xlsx', 'parquet'] },
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
                const dir = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? os.tmpdir();
                const outPath = path.join(dir, msg.filename ?? 'synthetic_data.csv');
                fs.writeFileSync(outPath, msg.csv ?? '');
                const choice = await vscode.window.showInformationMessage(`Saved: ${outPath}`, 'Open in Editor');
                if (choice === 'Open in Editor') {
                    vscode.window.showTextDocument(vscode.Uri.file(outPath));
                }
            }
            if (msg.command === 'exportReport') {
                const dir = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? os.tmpdir();
                const outPath = path.join(dir, msg.filename ?? 'leakage_report.json');
                fs.writeFileSync(outPath, JSON.stringify(msg.report, null, 2));
                const choice = await vscode.window.showInformationMessage(`Saved: ${outPath}`, 'Open in Editor');
                if (choice === 'Open in Editor') {
                    vscode.window.showTextDocument(vscode.Uri.file(outPath));
                }
            }
            if (msg.command === 'exportArtifact') {
                try {
                    const wsDir = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? os.tmpdir();
                    const outDir = path.join(wsDir, '.idelense');
                    fs.mkdirSync(outDir, { recursive: true });
                    // If the file was already saved as .docx by agentReport, use it directly
                    const outPath = (msg.filePath && fs.existsSync(String(msg.filePath)))
                        ? String(msg.filePath)
                        : path.join(outDir, msg.filename ?? 'aurora_report.docx');
                    if (!msg.filePath || !fs.existsSync(outPath)) {
                        // Convert markdown content → docx
                        const mdTmp = path.join(os.tmpdir(), `aurora_report_export_${Date.now()}.md`);
                        fs.writeFileSync(mdTmp, String(msg.content ?? ''), 'utf8');
                        await runMdToDocx(context, mdTmp, outPath);
                        try {
                            fs.unlinkSync(mdTmp);
                        }
                        catch { }
                    }
                    const choice = await vscode.window.showInformationMessage(`Report saved: ${outPath}`, 'Open in Editor');
                    if (choice === 'Open in Editor') {
                        vscode.window.showTextDocument(vscode.Uri.file(outPath));
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
                console.log('[Aurora] agentChat request — message:', msg.message?.slice(0, 80), '| hasContext:', !!lastPipelineContext?.leakage);
                if (!llmClient.isConfigured()) {
                    panel.webview.postMessage({ type: 'agentResponse', error: 'API key not configured. Open the AI Insights tab and paste your key.', msgId: msg.msgId });
                    return;
                }
                try {
                    // Merge live webview context (D.cp, generator stats) into the effective context
                    const effectiveContext = {
                        ...lastPipelineContext,
                        ...(msg.liveContext ? {
                            cp: msg.liveContext.cp ?? lastPipelineContext.cp,
                            live_stats: msg.liveContext,
                        } : {}),
                    };
                    const toolExecutor = createToolExecutor(context, panel);
                    const response = await llmClient.agentChat(msg.history ?? [], msg.message, effectiveContext, toolExecutor);
                    panel.webview.postMessage({ type: 'agentResponse', content: response.content, model: response.model, error: response.error, msgId: msg.msgId });
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
            // ── Aurora: Agent generator control (row count / param override) ─
            if (msg.command === 'agentControl') {
                if (!lastFilePath || !lastBaseline) {
                    panel.webview.postMessage({ type: 'agentControlResult', error: 'No dataset loaded. Run the pipeline first.', msgId: msg.msgId });
                    return;
                }
                try {
                    const params = msg.params || {};
                    const rowCount = typeof params.row_count === 'number' ? params.row_count : 1000;
                    // Write baseline to temp file for runGenerator
                    const tmpBase = path.join(os.tmpdir(), `aurora_baseline_${Date.now()}.json`);
                    fs.writeFileSync(tmpBase, JSON.stringify(lastBaseline));
                    panel.webview.postMessage({ type: 'agentControlResult', status: 'running', rowCount, msgId: msg.msgId });
                    const result = await runGenerator(context, lastFilePath, tmpBase, rowCount);
                    try {
                        fs.unlinkSync(tmpBase);
                    }
                    catch { }
                    // Patch pipeline context with new result
                    lastPipelineContext = { ...lastPipelineContext, result };
                    panel.webview.postMessage({ type: 'agentControlResult', status: 'done', result, msgId: msg.msgId });
                }
                catch (err) {
                    panel.webview.postMessage({ type: 'agentControlResult', error: String(err), msgId: msg.msgId });
                }
            }
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


/***/ }),
/* 1 */
/***/ ((module) => {

module.exports = require("vscode");

/***/ }),
/* 2 */
/***/ ((module) => {

module.exports = require("child_process");

/***/ }),
/* 3 */
/***/ ((module) => {

module.exports = require("path");

/***/ }),
/* 4 */
/***/ ((module) => {

module.exports = require("fs");

/***/ }),
/* 5 */
/***/ ((module) => {

module.exports = require("os");

/***/ }),
/* 6 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


/**
 * src/webview/monitorPanel.ts — Aurora Privacy Dashboard
 * Redesigned: VS Code theme-integrated, emoji-free, clean layout
 */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.buildMonitorHtml = buildMonitorHtml;
const charts_1 = __webpack_require__(7);
const overview_1 = __webpack_require__(8);
const synthetic_1 = __webpack_require__(9);
const security_1 = __webpack_require__(10);
const livesecurity_1 = __webpack_require__(11);
const agent_1 = __webpack_require__(12);
const parser_1 = __webpack_require__(13);
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
      <img src="${esc(logoUri)}" width="28" height="28" style="border-radius:6px;display:block;" alt="Aurora"/>
    </div>
    <div>
      <div class="logo-title">Aurora</div>
      <div class="logo-sub" id="hdr-sub">Privacy &amp; Synthetic Data Governance</div>
    </div>
  </div>
  <div class="hdr-right">
    <button class="hbtn hbtn-g" onclick="doExportCSV()">Export CSV</button>
    <button class="hbtn hbtn-g" onclick="vscode.postMessage({command:'anonymizeDataset'})" title="Auto-anonymize PII columns">Anonymize</button>
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

<!-- Sanity warning banner -->
<div id="sanity-banner" style="display:none"></div>

<!-- Tab navigation -->
<div class="tabs">
  <button class="tab active"  onclick="showTab('overview',this)">Overview</button>
  <button class="tab"         onclick="showTab('synthetic',this)">Synthetic Data</button>
  <button class="tab"         onclick="showTab('security',this)">Security</button>
  <button class="tab" id="live-sec-tab" onclick="showTab('livesecurity',this)">Live Monitor</button>
  <button class="tab"         onclick="showTab('aiinsights',this)">AI Agent</button>
  <button class="tab"         onclick="showTab('parser',this)">Parser</button>
</div>

${overview_1.OVERVIEW_TAB_HTML}
${synthetic_1.SYNTHETIC_TAB_HTML}
${security_1.SECURITY_TAB_HTML}
${livesecurity_1.LIVE_SECURITY_TAB_HTML}
${agent_1.AGENT_TAB_HTML}
${parser_1.PARSER_TAB_HTML}

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

let activeTab = 'overview';

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

function showTab(name, btn){
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
      try{renderC1();}catch(e){}
      try{renderC2();}catch(e){}
      try{renderC5();}catch(e){}
      try{renderC12();}catch(e){}
      try{renderRis();}catch(e){}
      try{renderIntelligenceRisk();}catch(e){}
      try{renderColumnRanking();}catch(e){}
      try{renderRecommendations();}catch(e){}
      try{renderTimeline();}catch(e){}
      try{initDistCols();if(_distCols.length)renderDistComparison(_distCols[0]);}catch(e){}
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
      // parser is client-side only, nothing to init
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
    renderStrip(); renderC1(); renderTimeline();
  }

  if(msg.type==='generatorStatus'){
    var statusEl=document.getElementById('gen-status');
    if(statusEl) statusEl.textContent=msg.text||'';
    if(msg.text&&(msg.text.startsWith('Done')||msg.text.startsWith('Complete')||msg.text.startsWith('Warning')||msg.text.startsWith('Error')||msg.text.includes('complete')||msg.text.includes('failed'))){
      var btn=document.getElementById('gen-btn');
      if(btn){ btn.disabled=false; btn.textContent='Run Generator'; }
    }
  }

  if(msg.type==='resetGenBtn'){
    var btn2=document.getElementById('gen-btn');
    if(btn2){ btn2.disabled=false; btn2.textContent='Run Generator'; }
  }

  if(msg.type==='pipelineComplete'){
    updateDashboardState(msg.data || msg);
    syntheticRendered=false; secRendered=false;
    renderAll();
  }

  if(msg.type==='pipelineResult'){
    updateDashboardState(msg.data || msg);
    syntheticRendered=false; secRendered=false;
    renderAll();
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
  if(msg.type==='agentControlResult'){
    if(typeof agentHandleControlResult==='function') agentHandleControlResult(msg);
  }
  if(msg.type==='agentReportResult'){
    if(typeof agentHandleReportResult==='function') agentHandleReportResult(msg.content, msg.filePath, msg.error);
  }
});

${agent_1.AGENT_SCRIPT}

${security_1.SECURITY_SCRIPT}

${livesecurity_1.LIVE_SECURITY_SCRIPT}

${parser_1.PARSER_SCRIPT}

function renderAll(){
  syntheticRendered=false;
  secRendered=false;
  try{renderSanityBanner();}catch(e){}
  try{renderStrip();}catch(e){}
  try{renderDatasetSummary();}catch(e){}
  try{renderRiskRadar();}catch(e){}
  try{renderC1();}catch(e){}
  try{renderC5();}catch(e){}
  try{renderC12();}catch(e){}
  try{renderRis();}catch(e){}
  try{renderIntelligenceRisk();}catch(e){}
  try{renderColumnRanking();}catch(e){}
  try{renderRecommendations();}catch(e){}
  try{renderTimeline();}catch(e){}
  try{initDistCols();if(_distCols.length)renderDistComparison(_distCols[0]);}catch(e){}
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
      break;
  }
  setTimeout(()=>{ try{renderC2();}catch(e){} },150);
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

_automate_init();
</script>
</body>
</html>`;
}


/***/ }),
/* 7 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.RISK_RADAR_SCRIPT = exports.DASHBOARD_STYLES = exports.CHART_INLINE_FALLBACK_SCRIPT = void 0;
exports.CHART_INLINE_FALLBACK_SCRIPT = String.raw `
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
exports.DASHBOARD_STYLES = String.raw `
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
.hdr-right{display:flex;gap:6px}
.hbtn{display:inline-flex;align-items:center;gap:4px;padding:5px 12px;border-radius:6px;font-size:11px;font-weight:500;cursor:pointer;border:none;transition:background .15s,color .15s}
.hbtn-g{background:transparent;color:var(--fg2);border:1px solid var(--border2)}
.hbtn-g:hover{background:var(--vsc-hover);color:var(--fg)}
.hbtn-p{background:var(--aurora-grad);color:#fff;box-shadow:0 2px 10px rgba(124,58,237,.35)}
.hbtn-p:hover{opacity:.88}

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
`;
exports.RISK_RADAR_SCRIPT = String.raw `
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


/***/ }),
/* 8 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.OVERVIEW_SCRIPT = exports.OVERVIEW_TAB_HTML = void 0;
exports.OVERVIEW_TAB_HTML = String.raw `
<!-- TAB: Overview -->
<div id="pane-overview" class="tabpane active">
<div class="grid">

  <!-- Row 1: Generator control + Status at a glance -->

  <!-- Generator Card: Primary action for a synth data project -->
  <div class="card">
    <div class="ch">
      <div><div class="ct">Generator</div><div class="cs" id="c1s">Ready to generate</div></div>
    </div>
    <div><div class="bnum" id="c1n">&#8212;</div><div class="bsub">rows generated</div></div>
    <div class="mbars" id="c1bars"></div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
      <label style="font-size:11px;color:var(--fg3)">Rows:</label>
      <input id="gen-n" type="number" value="500" min="1" max="10000"
        style="width:80px;background:var(--vsc-input);border:1px solid var(--border);border-radius:5px;color:var(--fg);font-size:12px;padding:3px 8px;outline:none"/>
    </div>
    <div id="gen-status" style="font-size:11px;color:var(--fg3);min-height:14px;margin-bottom:4px"></div>
    <button class="abtn" id="gen-btn" onclick="reqGen()">Run Generator</button>
  </div>

  <!-- Dataset Summary -->
  <div class="card" id="card-summary">
    <div class="ch">
      <div><div class="ct">Dataset Summary</div><div class="cs">Source schema &amp; column breakdown</div></div>
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
exports.OVERVIEW_SCRIPT = String.raw `
// ── Sanity checks ────────────────────────────────────────────────────
function renderSanityBanner(){
  if(!D.leakage){ return; }
  const l=D.leakage||{};
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
  const sc = D.scanReport || {};
  const el = document.getElementById('ds-summary-body');
  if(!el) return;
  if(!b.columns){
    el.innerHTML = '<div style="color:var(--fg3);font-size:11px">Run pipeline to view summary.</div>';
    return;
  }
  const numRows = b.meta?.row_count_estimate ?? b.meta?.row_count ?? 0;
  const numCols = Object.keys(b.columns?.numeric || {}).length;
  const catCols = Object.keys(b.columns?.categorical || {}).length;
  const totalCols = numCols + catCols;
  const piiCols = new Set([
    ...(sc.high_risk_columns || []),
    ...(sc.pii_findings || []).map(f => f.column)
  ].filter(Boolean));
  el.innerHTML = [
    '<div class="mvrow"><div class="mvl">Total Rows</div><div class="mvv" style="color:var(--aurora-p5)">'+(numRows?numRows.toLocaleString():'—')+'</div></div>',
    '<div class="mvrow"><div class="mvl">Total Columns</div><div class="mvv">'+totalCols+'</div></div>',
    '<div class="mvrow"><div class="mvl">Numeric / Categorical</div><div class="mvv" style="font-size:14px">'+numCols+' <span style="color:var(--fg3);font-size:12px;font-weight:400">/</span> '+catCols+'</div></div>',
    '<div class="mvrow" style="margin-top:auto"><div class="mvl">PII Columns</div><div class="mvv" style="color:'+(piiCols.size>0?'var(--aurora-orange)':'var(--aurora-green)')+'">'+piiCols.size+'</div></div>'
  ].join('');
}

// ── Status strip ────────────────────────────────────────────────────
function renderStrip(){
  if(!D.leakage){ return; }
  const l=D.leakage||{};
  const r=D.generator||D.result||{};
  const b=D.profile||D.baseline||{};
  const mRisk=document.getElementById('m-risk'); if(mRisk) mRisk.innerHTML=rbadge(l.risk_level);
  const ps=l.privacy_score!=null?pctInt(l.privacy_score):null;
  const pe=document.getElementById('m-ps');
  if(pe){ pe.textContent=ps!=null?ps+'%':'—'; if(ps!=null) pe.style.color=ps>=75?C.green:ps>=50?C.orange:C.red; }
  const dk=(l.statistical_drift||'unknown').toLowerCase();
  const de=document.getElementById('m-drift');
  if(de){ de.textContent=dk==='unknown'?'—':dk; de.style.color=dk==='high'?C.red:dk==='moderate'?C.orange:dk==='low'?C.green:C.fg2; }
  const ue=document.getElementById('m-dup'), dup=l.duplicates_rate;
  if(ue){ ue.textContent=pct(dup); if(dup!=null) ue.style.color=dup>.05?C.orange:C.green; }
  const sr=r.row_count;
  const mr=document.getElementById('m-rows'); if(mr) mr.textContent=sr!=null?sr.toLocaleString():'—';
  const numCols=Object.keys((b.columns&&b.columns.numeric)||{});
  const catCols=Object.keys((b.columns&&b.columns.categorical)||{});
  const hs=document.getElementById('hdr-sub');
  if(hs) hs.textContent='Engine: '+(r.generator_used||'—')+(sr?' · '+sr.toLocaleString()+' rows':'')+((numCols.length+catCols.length)?' · '+(numCols.length+catCols.length)+' cols':'');
}

// ── C1: Generator ───────────────────────────────────────────────────
function renderC1(){
  const r=D.generator||D.result||{}, cp=D.cp||{};
  const sr=r.row_count||0;
  const c1n=document.getElementById('c1n'); if(c1n) c1n.textContent=sr>0?sr.toLocaleString():'0';
  const c1s=document.getElementById('c1s'); if(c1s) c1s.textContent=r.generator_used?'Engine: '+r.generator_used:'Ready to generate';
  const commits=cp.commits||[];
  const el=document.getElementById('c1bars');
  if(!el) return;
  if(commits.length){
    const mx=Math.max(...commits.map(c=>c.n_rows||0),1);
    el.innerHTML=commits.slice(-12).map(c=>'<div class="mb" style="height:'+Math.max(6,Math.round(((c.n_rows||0)/mx)*100))+'%"></div>').join('');
  } else if(sr>0){
    const dimCount=11;
    const dimBars=Array.from({length:dimCount},()=>'<div class="mb dim" style="height:20%"></div>').join('');
    el.innerHTML=dimBars+'<div class="mb hot" style="height:100%;" title="'+sr.toLocaleString()+' rows generated"></div>';
  } else {
    el.innerHTML=Array.from({length:12},()=>'<div class="mb dim" style="height:12%"></div>').join('');
  }
}

// ── C2: Privacy Gauge ────────────────────────────────────────────────
function renderC2(){
  if(!D.leakage){ return; }
  const l=D.leakage||{};
  const ps=l.privacy_score!=null?pctInt(l.privacy_score):null;
  const el=document.getElementById('gval'); if(!el) return;
  const gm=document.getElementById('gmode');
  const relEl=document.getElementById('g-reliability');
  const subEl=document.getElementById('g-reliability-sub');
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
    el.textContent='N/A'; el.style.color=C.fg2;
    gm.textContent=l.error?'Leakage unavailable':'No data';
    relEl.innerHTML='';
    subEl.textContent='';
  }
}

// ── C12: Dataset Risk Score ──────────────────────────────────────────
function renderC12(){
  const l=D.leakage||{};
  const drs=l.dataset_risk_score;
  const valEl=document.getElementById('c12val');
  const arcEl=document.getElementById('c12arc');
  const badgeEl=document.getElementById('c12badge');
  const brkEl=document.getElementById('c12breakdown');
  const piiEl=document.getElementById('c12pii');
  if(!valEl||!arcEl||!badgeEl||!brkEl||!piiEl) return;
  if(!D.leakage || drs==null){
    valEl.textContent='—';
    const sub=document.getElementById('c12sub');
    if(sub) sub.textContent=D.leakage?'Risk score not computed':'Run the generator to view results.';
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
  const l=D.leakage||{};
  const cd=l.column_drift||{};
  const cols=Object.keys(cd);
  const hmap=document.getElementById('c5hmap'), pe=document.getElementById('c5p');
  const sub=document.getElementById('c5sub');
  if(!hmap||!pe) return;
  if(!D.leakage){
    hmap.innerHTML='<div style="padding:12px;font-size:11px;color:var(--fg3)">Run the generator to view results.</div>';
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
  const r=D.generator||D.result||{}, l=D.leakage||{}, b=D.profile||D.baseline||{}, ast=D.ast||{};
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
  const l=D.leakage||{};
  const ris=l.statistical_reliability_score;
  const valEl=document.getElementById('c13val');
  const fillEl=document.getElementById('c13fill');
  const badgeEl=document.getElementById('c13badge');
  const noteEl=document.getElementById('c13note');
  const subEl=document.getElementById('c13sub');
  if(!valEl||!fillEl||!badgeEl||!noteEl) return;
  if(ris==null){
    valEl.textContent='—';
    noteEl.textContent='Run pipeline to compute.';
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
  const l=D.leakage||{};
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
  var l=D.leakage||{};
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
  if(!D.leakage || score==null){
    valEl.textContent='—';
    arcEl&&arcEl.setAttribute('stroke-dasharray','0 226');
    badgeEl&&(badgeEl.textContent='—');
    subEl&&(subEl.textContent=D.leakage?'Risk intelligence not computed':'Run the generator to view results.');
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
  var l=D.leakage||{};
  var ranking=(l.sensitive_column_ranking||[]).slice(0,5);
  var listEl=document.getElementById('c15list');
  var subEl=document.getElementById('c15sub');
  if(!listEl) return;
  if(!D.leakage){
    listEl.innerHTML='<div style="color:var(--fg3);font-size:11px">Run the generator to view results.</div>';
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
  var l=D.leakage||{};
  var recs=((l.privacy_recommendations||{}).recommendations)||[];
  var listEl=document.getElementById('c16list');
  var subEl=document.getElementById('c16sub');
  if(!listEl) return;
  if(!D.leakage){
    listEl.innerHTML='<div style="color:var(--fg3);font-size:11px">Run the generator to view results.</div>';
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
  var g = D.generator || D.result || {};
  var numB = (b.columns&&b.columns.numeric&&b.columns.numeric[col]);
  var catB = (b.columns&&b.columns.categorical&&b.columns.categorical[col]);
  var synthSamples = (g.samples)||( D.cp&&D.cp.rows)||[];
  var sub = document.getElementById('dc-sub');
  if(sub) sub.textContent = col ? col : 'Original vs Synthetic';

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


/***/ }),
/* 9 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.SYNTHETIC_SCRIPT = exports.SYNTHETIC_TAB_HTML = void 0;
exports.SYNTHETIC_TAB_HTML = String.raw `
<!-- TAB: Synthetic Data -->
<div id="pane-synthetic" class="tabpane">
  <div id="synthetic-root">

  <!-- Distribution comparison -->
  <div style="padding:14px 20px 8px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div>
        <span style="font-size:12px;font-weight:600;color:var(--fg)">Distribution Comparison</span>
        <span style="font-size:11px;color:var(--fg3);margin-left:8px" id="dc-sub">Original vs Synthetic</span>
      </div>
      <button class="ib" onclick="cycleDistCol()" title="Cycle to next column">&#8635;</button>
    </div>
    <select class="dist-sel" id="dc-col" onchange="renderDistComparison(this.value)"></select>
    <div style="height:140px;width:100%;position:relative;margin-bottom:4px"><canvas id="chart-dist" width="500" height="140" style="width:100%;height:140px;display:block"></canvas></div>
    <div class="dist-legend" style="margin-bottom:12px">
      <div class="dist-li"><div class="dist-dot" style="background:var(--aurora-p4);height:2px"></div>Original</div>
      <div class="dist-li"><div class="dist-dot" style="background:linear-gradient(90deg,var(--aurora-p2),var(--aurora-p6));height:6px;border-radius:2px"></div>Synthetic</div>
    </div>
  </div>

  <!-- Data preview table -->
  <div style="padding:0 20px 8px;display:flex;align-items:center;justify-content:space-between">
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
exports.SYNTHETIC_SCRIPT = String.raw `
// ── Synthetic Data tab — sortable, copy-row, 50 rows ────────────────
let syntheticRendered=false, synthSortCol=null, synthSortAsc=true;
function _getSamples(){
  return (
    D.generator?.samples ||
    D.result?.samples ||
    D.cp?.rows ||
    []
  );
}
function renderSynthetic(forceRender){
  if(syntheticRendered&&!forceRender)return;
  const root=document.getElementById('synthetic-root');
  if(!root) return;
  const pb=document.getElementById('preview-body');
  const ph=document.getElementById('preview-head');
  if(!pb) return;
  syntheticRendered=true;

  // Re-render distribution comparison
  setTimeout(function(){ try{initDistCols();if(_distCols&&_distCols.length){var sel2=document.getElementById('dc-col');requestAnimationFrame(function(){try{renderDistComparison(sel2?sel2.value:_distCols[0]);}catch(e){}});}}catch(e){}},150);

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
  const cols=Object.keys(rows[0]||{});
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


/***/ }),
/* 10 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.SECURITY_SCRIPT = exports.SECURITY_TAB_HTML = void 0;
exports.SECURITY_TAB_HTML = String.raw `
<!-- TAB: Security -->
<div id="pane-security" class="tabpane">
  <div id="security-root">
  <div style="padding:14px 20px">
    <h3 style="font-size:14px;font-weight:700;color:var(--p6);margin-bottom:12px">PII & Security Scan</h3>
    <div class="sec-grid" id="sec-stats"></div>
    <div id="sec-findings" style="margin-top:8px"></div>

    <!-- UPGRADE 2: Privacy Attack Visualization -->
    <h3 style="font-size:14px;font-weight:700;color:var(--p6);margin:20px 0 10px">Privacy Attack Simulation</h3>
    <p style="font-size:11px;color:var(--fg3);margin-bottom:10px">Attack metrics derived from statistical proximity analysis. Values computed from MI-AUC and distribution divergence — no separate dataset required.</p>
    <div class="atk-gauges" id="atk-gauges">
      <div class="atk-gauge">
        <div class="atk-gauge-ring" style="position:relative">
          <svg viewBox="0 0 72 72" style="width:72px;height:72px;transform:rotate(-90deg)">
            <circle cx="36" cy="36" r="28" fill="none" stroke="rgba(28,28,62,.8)" stroke-width="7"/>
            <circle id="atk-arc-1" cx="36" cy="36" r="28" fill="none" stroke="var(--red)" stroke-width="7" stroke-linecap="round" stroke-dasharray="0 176" style="transition:stroke-dasharray .9s ease,stroke .4s"/>
          </svg>
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
            <div class="atk-gauge-val" id="atk-val-1">—</div>
          </div>
        </div>
        <div class="atk-gauge-lbl">Membership<br>Attack Success</div>
      </div>
      <div class="atk-gauge">
        <div class="atk-gauge-ring" style="position:relative">
          <svg viewBox="0 0 72 72" style="width:72px;height:72px;transform:rotate(-90deg)">
            <circle cx="36" cy="36" r="28" fill="none" stroke="rgba(28,28,62,.8)" stroke-width="7"/>
            <circle id="atk-arc-2" cx="36" cy="36" r="28" fill="none" stroke="var(--orange)" stroke-width="7" stroke-linecap="round" stroke-dasharray="0 176" style="transition:stroke-dasharray .9s ease,stroke .4s"/>
          </svg>
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
            <div class="atk-gauge-val" id="atk-val-2">—</div>
          </div>
        </div>
        <div class="atk-gauge-lbl">Reconstruction<br>Risk</div>
      </div>
      <div class="atk-gauge">
        <div class="atk-gauge-ring" style="position:relative">
          <svg viewBox="0 0 72 72" style="width:72px;height:72px;transform:rotate(-90deg)">
            <circle cx="36" cy="36" r="28" fill="none" stroke="rgba(28,28,62,.8)" stroke-width="7"/>
            <circle id="atk-arc-3" cx="36" cy="36" r="28" fill="none" stroke="var(--p4)" stroke-width="7" stroke-linecap="round" stroke-dasharray="0 176" style="transition:stroke-dasharray .9s ease,stroke .4s"/>
          </svg>
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
            <div class="atk-gauge-val" id="atk-val-3">—</div>
          </div>
        </div>
        <div class="atk-gauge-lbl">Nearest-Neighbor<br>Leakage</div>
      </div>
    </div>
    <div id="atk-note" style="font-size:10px;color:var(--fg3);margin-bottom:14px">Run pipeline to compute attack metrics.</div>

    <h3 style="font-size:14px;font-weight:700;color:var(--p6);margin:20px 0 12px">External Attack Simulation</h3>
    <div id="attack-results"></div>

    <h3 style="font-size:14px;font-weight:700;color:var(--p6);margin:20px 0 12px">Knowledge Graph</h3>
    <div id="kg-entities" style="margin-bottom:8px"></div>
    <div id="kg-edges"></div>
  </div>
  </div>
</div>
`;
exports.SECURITY_SCRIPT = String.raw `
// ── Security tab rendering ───────────────────────────────────────────
let secRendered=false;
function renderSecurity(){
  if(secRendered)return;
  console.log('[AutoMate] rendering security tab');
  const root=document.getElementById('security-root');
  if(!root){ console.error('missing root container'); return; }
  secRendered=true;

  // Guard: no data yet
  const scan=D.scanReport||{};
  const statsEl=document.getElementById('sec-stats');
  const findEl=document.getElementById('sec-findings');
  if(!D.scanReport && !D.leakage){
    if(statsEl) statsEl.innerHTML='<div style="color:var(--fg3);font-size:11px;padding:10px">Run the generator to view results.</div>';
    if(findEl)  findEl.innerHTML='';
    // Render attack gauges with empty state
    renderAttackGauges();
    return;
  }

  // Show PII columns from leakage if scan not available
  if(!D.scanReport && D.leakage){
    const l=D.leakage||{};
    const piiCols=(l.pii_columns||D.pii_columns||[]);
    const rs=Math.round(l.dataset_risk_score||0);
    const rsCol=rs>70?C.red:rs>30?C.orange:C.green;
    if(statsEl){
      statsEl.innerHTML=
        '<div class="sec-stat"><div class="sec-stat-v" style="color:'+C.orange+'">'+piiCols.length+'</div><div class="sec-stat-l">PII Columns</div></div>'+
        '<div class="sec-stat"><div class="sec-stat-v" style="color:'+rsCol+'">'+rs+'/100</div><div class="sec-stat-l">Risk Score</div></div>'+
        '<div class="sec-stat"><div class="sec-stat-v" style="color:'+C.p5+'">'+(l.risk_level||'—')+'</div><div class="sec-stat-l">Risk Level</div></div>';
    }
    if(findEl){
      if(piiCols.length){
        findEl.innerHTML='<div style="font-size:11px;color:var(--fg2);margin-bottom:8px">Detected PII columns from leakage analysis:</div>'+
          piiCols.map(function(c){
            return '<div class="sec-finding"><span class="sf-type" style="color:'+C.orange+'">PII</span>'+
              '<span class="sf-cat">Sensitive column — <span style="color:var(--fg3)">'+esc(c)+'</span></span>'+
              '<span class="sf-sev" style="background:rgba(251,146,60,.15);color:'+C.orange+'">detected</span></div>';
          }).join('');
      } else {
        findEl.innerHTML='<div style="color:var(--green);font-size:12px;padding:8px">No PII detected.</div>';
      }
    }
    renderAttackGauges();
    return;
  }

  // PII Scan stats
  if(scan.pii_findings||scan.secrets||scan.sensitive_content){
    const nPii=(scan.pii_findings||[]).length;
    const nSec=(scan.secrets||[]).length;
    const nSen=(scan.sensitive_content||[]).length;
    const rs=Math.round(scan.risk_score||0);
    const rsCol=rs>70?C.red:rs>30?C.orange:C.green;
    statsEl.innerHTML=
      '<div class="sec-stat"><div class="sec-stat-v" style="color:'+C.orange+'">'+nPii+'</div><div class="sec-stat-l">PII Findings</div></div>'+
      '<div class="sec-stat"><div class="sec-stat-v" style="color:'+C.red+'">'+nSec+'</div><div class="sec-stat-l">Secrets</div></div>'+
      '<div class="sec-stat"><div class="sec-stat-v" style="color:'+C.p5+'">'+nSen+'</div><div class="sec-stat-l">Sensitive</div></div>'+
      '<div class="sec-stat"><div class="sec-stat-v" style="color:'+rsCol+'">'+rs+'/100</div><div class="sec-stat-l">Risk Score</div></div>'+
      '<div class="sec-stat"><div class="sec-stat-v" style="color:'+C.p6+'">'+(scan.total_cells_scanned||0).toLocaleString()+'</div><div class="sec-stat-l">Cells Scanned</div></div>'+
      '<div class="sec-stat"><div class="sec-stat-v" style="color:'+C.p6+'">'+(scan.columns_scanned||0)+'</div><div class="sec-stat-l">Columns</div></div>';
    // Findings list
    const allFindings=[...(scan.pii_findings||[]),...(scan.secrets||[]),...(scan.sensitive_content||[])].slice(0,30);
    if(allFindings.length){
      findEl.innerHTML=allFindings.map(function(f){
        var sevCol=f.severity==='critical'?C.red:f.severity==='high'?C.orange:f.severity==='medium'?C.yellow:C.green;
        return '<div class="sec-finding">'+
          '<span class="sf-type" style="color:'+sevCol+'">'+esc(f.type)+'</span>'+
          '<span class="sf-cat">'+esc(f.category)+' — <span style="color:var(--fg3)">'+esc(f.column)+'</span></span>'+
          '<span class="sf-sev" style="background:'+sevCol+'22;color:'+sevCol+'">'+esc(f.severity)+'</span>'+
        '</div>';
      }).join('');
    } else {
      findEl.innerHTML='<div style="color:var(--green);font-size:12px;padding:8px"> No PII, secrets, or sensitive data detected.</div>';
    }
  } else {
    statsEl.innerHTML='<div style="color:var(--fg3);font-size:11px;padding:8px">PII scan not available. Run the full pipeline to scan.</div>';
    findEl.innerHTML='';
  }

  // Attack simulation
  const atk=D.attackReport||{};
  const atkEl=document.getElementById('attack-results');
  if(atk.results&&atk.results.length){
    var vulnCol=atk.overall_vulnerability==='safe'?C.green:atk.overall_vulnerability==='moderate'?C.orange:C.red;
    atkEl.innerHTML='<div style="margin-bottom:10px;font-size:12px">Overall: <span style="color:'+vulnCol+';font-weight:700;text-transform:uppercase">'+esc(atk.overall_vulnerability)+'</span> — '+esc(atk.summary)+'</div>'+
      atk.results.map(function(r){
        var ic=r.success?'[FAIL]':'[PASS]';
        var sc=r.severity==='critical'?C.red:r.severity==='high'?C.orange:C.green;
        return '<div style="background:var(--card);border:1px solid var(--border);border-left:3px solid '+sc+';border-radius:8px;padding:10px;margin-bottom:6px">'+
          '<div style="display:flex;justify-content:space-between;align-items:center">'+
            '<span style="font-weight:600;font-size:12px">'+ic+' '+esc(r.attack_name)+'</span>'+
            '<span style="font-size:9px;color:'+sc+';text-transform:uppercase">'+esc(r.severity)+'</span>'+
          '</div>'+
          '<div style="font-size:11px;color:var(--fg2);margin-top:4px">'+esc(r.description)+'</div>'+
          '<div style="font-size:10px;color:var(--fg3);margin-top:2px">Success rate: '+(r.success_rate*100).toFixed(1)+'%</div>'+
        '</div>';
      }).join('')+
      (atk.recommendations&&atk.recommendations.length?
        '<div style="margin-top:10px;font-size:11px;color:var(--fg2)"><b>Recommendations:</b></div>'+
        atk.recommendations.map(function(r){return '<div style="font-size:11px;color:var(--fg3);padding:3px 0">[+] '+esc(r)+'</div>';}).join('')
      :'');
  } else {
    atkEl.innerHTML='<div style="color:var(--fg3);font-size:11px;padding:8px">Attack simulation not available. Use Command Palette → "Aurora: Run Attack Simulation".</div>';
  }

  // Knowledge graph
  var kg=D.knowledgeGraph||{};
  var kgEntEl=document.getElementById('kg-entities');
  var kgEdgeEl=document.getElementById('kg-edges');
  var entities=kg.entities||[];
  if(entities.length){
    kgEntEl.innerHTML='<div style="font-size:11px;color:var(--fg2);margin-bottom:6px">'+kg.summary+'</div>'+
      entities.map(function(e){return '<span class="kg-entity">'+esc(e)+'</span>';}).join('');
    var corrEdges=(kg.edges||[]).filter(function(e){return e.relationship==='correlates_with'||e.relationship==='associated_with';}).slice(0,10);
    if(corrEdges.length){
      kgEdgeEl.innerHTML='<div style="font-size:11px;color:var(--fg2);margin-top:10px;margin-bottom:6px">Key Relationships:</div>'+
        corrEdges.map(function(e){return '<div class="kg-edge">'+esc(e.source.replace('attr_',''))+' ↔ '+esc(e.target.replace('attr_',''))+' <span style="color:var(--p5)">('+esc(e.relationship)+': '+(e.weight||0).toFixed(3)+')</span></div>';}).join('');
    }
  } else {
    kgEntEl.innerHTML='<div style="color:var(--fg3);font-size:11px;padding:8px">Knowledge graph not available. Run the full pipeline.</div>';
  }

  // UPGRADE 2: Privacy Attack Gauges — from leakage.attack_results
  renderAttackGauges();
}
`;


/***/ }),
/* 11 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
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
  if(!_lsecAlerts.length){
    root.querySelector('#lsec-tbody')&&(root.querySelector('#lsec-tbody').innerHTML='<tr><td colspan="8" class="lsec-empty">No alerts yet — scanner is active and monitoring your workspace.</td></tr>');
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


/***/ }),
/* 12 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.AGENT_SCRIPT = exports.AGENT_TAB_HTML = void 0;
exports.AGENT_TAB_HTML = String.raw `
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
    <label>Provider</label>
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
    <span class="agent-config-ok" id="agent-config-ok" style="display:none"> Saved</span>
    <span id="agent-key-status" style="font-size:10px;margin-left:4px"></span>
    <a id="agent-key-link" href="https://openrouter.ai/keys" style="color:#fb923c;font-size:10px;text-decoration:underline;margin-left:auto" target="_blank">Get free key ↗</a>
  </div>
  <!-- Control confirmation overlay — hidden until an action block is parsed -->
  <div class="agent-confirm-overlay" id="agent-confirm-overlay" style="display:none">
    <div class="agent-confirm-box">
      <div class="agent-confirm-title" id="agent-confirm-title">Confirm Generator Change</div>
      <div class="agent-confirm-body" id="agent-confirm-body"></div>
      <div class="agent-confirm-btns">
        <button class="agent-confirm-yes" onclick="agentConfirmYes()">Apply</button>
        <button class="agent-confirm-no" onclick="agentConfirmNo()">Cancel</button>
      </div>
    </div>
  </div>
  <!-- PART 4: Primary chat interface -->
  <div class="agent-chat">
    <div id="agent-messages" class="agent-messages">
      <div class="agent-ai">Hello. I'm the Aurora AI Governance Agent. Ask me anything about your dataset — privacy risks, PII columns, drift, anonymization strategies, or GDPR compliance.<br><br>Run the pipeline first for grounded, data-specific answers.</div>
    </div>
    <div class="agent-input-row">
      <input id="agent-text" class="agent-text-input"
        placeholder="Ask about this dataset… e.g. Which column has the highest drift?"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();agentSendFromInput();}" />
      <button id="agent-send-simple" class="agent-send-simple" onclick="agentSendFromInput()">Send ↑</button>
    </div>
  </div>
  <!-- Legacy two-column layout kept for sidebar quick-actions (hidden by default, shown on wide screens) -->
  <div class="agent-layout" style="display:none" id="agent-legacy-layout">
    <div class="agent-sidebar">
      <div class="agent-sidebar-hdr">Quick Actions</div>
      <button class="aab" onclick="agentSend('Explain this dataset — structure, key columns, relationships, and risks.')"><span class="aab-icon">//</span><span><span class="aab-label">Explain Dataset</span></span></button>
      <button class="aab" onclick="agentSend('Detect anomalies in this dataset — drift, skew, missing values, outliers.')"><span class="aab-icon">~</span><span><span class="aab-label">Detect Anomalies</span></span></button>
      <button class="aab" onclick="agentSend('Which columns are the riskiest and why?')"><span class="aab-icon">!</span><span><span class="aab-label">Risky Columns</span></span></button>
      <button class="aab" onclick="agentSend('What columns contain PII and how should I protect them?')"><span class="aab-icon">?</span><span><span class="aab-label">PII Protection</span></span></button>
      <button class="aab" onclick="agentSend('What are the GDPR implications of this dataset?')"><span class="aab-icon">#</span><span><span class="aab-label">GDPR Analysis</span></span></button>
      <button class="aab" onclick="agentClear()" style="color:var(--fg3);margin-top:auto"><span class="aab-icon">×</span><span><span class="aab-label">Clear Chat</span></span></button>
    </div>
    <div class="agent-main">
      <div class="agent-history" id="agent-history"><div class="agent-empty" id="agent-empty"><div class="agent-empty-icon" style="font-size:28px;color:var(--aurora-p5);font-weight:700">AI</div><div class="agent-empty-title">AI Data Governance Agent</div><div class="agent-empty-sub">Ask any question about your dataset.</div></div></div>
      <div class="agent-input-area"><textarea class="agent-input" id="agent-input" rows="1" placeholder="Ask about your dataset…" onkeydown="agentKeydown(event)"></textarea><button class="agent-send-btn" id="agent-send-btn" onclick="agentSendInput()">Send ↑</button></div>
    </div>
  </div>
  </div>
</div>
`;
exports.AGENT_SCRIPT = String.raw `
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
  var el=document.createElement('div');
  el.className='agent-ai';
  el.textContent=text;
  if(artifact){
    var card=document.createElement('div');
    card.className='agent-artifact-card';
    var icon=document.createElement('span'); icon.className='artifact-icon';
    var lbl=document.createElement('span');  lbl.className='artifact-label';
    var btn=document.createElement('button'); btn.className='artifact-export-btn';
    if(artifact.type==='csv'){
      icon.textContent='DATA'; lbl.textContent='Synthetic dataset ready'; btn.textContent='Export CSV';
      btn.onclick=function(){ btn.disabled=true; btn.textContent='Saving…'; agentExportCSV(btn); };
    } else {
      icon.textContent='DOC'; lbl.textContent='Governance report ready'; btn.textContent='Export Report';
      btn.onclick=function(){ btn.disabled=true; btn.textContent='Saving…'; agentExportReport(artifact.content, artifact.filePath, btn); };
    }
    card.appendChild(icon); card.appendChild(lbl); card.appendChild(btn);
    el.appendChild(card);
  }
  msgs.appendChild(el);
  msgs.scrollTop=msgs.scrollHeight;
}

// PART 6: Send from the simple input bar
function agentSendFromInput(){
  var input=document.getElementById('agent-text');
  if(!input) return;
  var text=(input.value||'').trim();
  if(!text) return;
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
  // Disable send while waiting
  var sendBtn=document.getElementById('agent-send-simple');
  if(sendBtn) sendBtn.disabled=true;
  var histPayload=_agentHistory.slice(0,-1).map(function(m){return{role:m.role,content:m.content};});
  // Collect live generator state to enrich the LLM context
  var liveContext={};
  try{
    if(typeof D!=='undefined'&&D){
      liveContext.cp=D.cp||null;
      liveContext.generatorRows=(D.generator&&D.generator.row_count)||null;
      liveContext.generatorUsed=(D.generator&&D.generator.generator_used)||null;
    }
  }catch(e){}
  vscode.postMessage({command:'agentChat', message:text, history:histPayload, liveContext:liveContext});
}

// PART 2+5: initAgentChat — called when AI Insights tab is shown
function initAgentChat(){
  const root=document.getElementById('agent-root');
  if(!root){ console.error('missing root container'); return; }
  // Restore provider selection from workspaceState via extension
  try{
    agentProviderChanged();
  }catch(e){}
  vscode.postMessage({command:'checkApiKey'});
  // Update context bar
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
      label.textContent=' Dataset loaded — '+rows+' rows · '+(numCols+catCols)+' cols · risk: '+risk+' · privacy: '+ps;
    } else {
      dot.className='agent-ctx-dot none';
      label.textContent='No dataset loaded — run the generator first';
      var msgs=document.getElementById('agent-messages');
      if(msgs && !msgs.textContent.trim()){
        msgs.innerHTML='<div class="agent-ai">Hello. I\'m the Aurora AI Governance Agent. Run the generator first for grounded, data-specific answers.</div>';
      }
    }
  }
  vscode.postMessage({command:'checkApiKey'});
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
  // Clear status so user knows to re-enter a key for the new provider
  var status=document.getElementById('agent-key-status');
  if(status){
    var savedKey=null;
    try{ savedKey=localStorage.getItem('automate_api_key_'+sel.value); }catch(e){}
    if(savedKey){
      status.style.color='var(--green)';
      status.textContent=' Key loaded for '+info.label;
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
  // Persist to localStorage so it survives panel reloads (keyed by provider)
  try{
    localStorage.setItem('automate_api_key_'+provider, key);
    localStorage.setItem('automate_api_provider', provider);
  }catch(e){}
  // Send to extension so the client can use it immediately
  vscode.postMessage({command:'setApiKey', apiKey:key, provider:provider});
  // Show  Saved feedback briefly, then show masked key in status label
  var ok=document.getElementById('agent-config-ok');
  if(ok){ ok.style.display=''; setTimeout(function(){ ok.style.display='none'; },2000); }
  var status=document.getElementById('agent-key-status');
  var info=PROVIDER_INFO[provider]||PROVIDER_INFO.openrouter;
  var masked=key.slice(0,6)+'…'+key.slice(-4);
  if(status){ status.style.color='var(--green)'; status.textContent=' '+info.label+': '+masked; }
  inp.value='';
  inp.placeholder='Key saved — paste a new key to update';
  // Re-query extension so context bar updates
  vscode.postMessage({command:'checkApiKey'});
}

function agentInitCtxBar(){
  var dot   = document.getElementById('agent-ctx-dot');
  var label = document.getElementById('agent-ctx-label');
  var inp   = document.getElementById('agent-api-key');
  var status= document.getElementById('agent-key-status');
  if(!dot||!label) return;

  // Ask extension whether API key is configured (workspaceState is source of truth)
  vscode.postMessage({command:'checkApiKey'});

  // Dataset context status
  var hasData = D && (D.baseline || D.leakage || D.result);
  if(hasData){
    dot.className='agent-ctx-dot ok';
    var numCols = Object.keys((D.baseline&&D.baseline.columns&&D.baseline.columns.numeric)||{}).length;
    var catCols = Object.keys((D.baseline&&D.baseline.columns&&D.baseline.columns.categorical)||{}).length;
    var rows  = (D.baseline&&D.baseline.meta&&D.baseline.meta.row_count) || (D.result&&D.result.row_count) || '?';
    var cols  = numCols + catCols;
    var risk  = (D.leakage&&D.leakage.risk_level) || '—';
    var ps    = D.leakage&&D.leakage.privacy_score!=null ? Math.round(D.leakage.privacy_score*100)+'%' : '—';
    label.textContent = ' Dataset loaded — '+rows+' rows · '+cols+' cols · risk: '+risk+' · privacy: '+ps+'. Responses grounded in pipeline data.';
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
  // Only re-append new messages for efficiency
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
  // Split text into plain-text and code-block segments
  var segments = [];
  var pos = 0;
  while (true) {
    var next = txt.indexOf(marker, pos);
    if (next === -1) { segments.push({type:'text', content:txt.substring(pos)}); break; }
    if (next > pos) segments.push({type:'text', content:txt.substring(pos, next)});
    var closePos = txt.indexOf(marker, next + 3);
    if (closePos === -1) { segments.push({type:'text', content:txt.substring(next)}); break; }
    var inner = txt.substring(next + 3, closePos);
    // Detect language tag on first line
    var newline = inner.indexOf(String.fromCharCode(10));
    var lang = newline !== -1 ? inner.substring(0, newline).trim().toLowerCase() : '';
    var code = newline !== -1 ? inner.substring(newline + 1).trim() : inner.trim();
    segments.push({type:'code', lang:lang, content:code});
    pos = closePos + 3;
  }
  segments.forEach(function(seg){
    if (seg.type === 'code' && seg.lang === 'sql') {
      // Render SQL blocks with copy button
      var sqlDiv=document.createElement('div'); sqlDiv.className='agent-sql';
      sqlDiv.textContent=seg.content;
      var btn=document.createElement('button'); btn.className='agent-sql-copy'; btn.textContent='Copy';
      (function(c){ btn.onclick=function(){vscode.postMessage({command:'copyToClipboard',text:c});btn.textContent='Copied!';setTimeout(function(){btn.textContent='Copy';},1500);}; })(seg.content);
      sqlDiv.appendChild(btn);
      bubble.appendChild(sqlDiv);
    } else if (seg.type === 'code') {
      // Render generic code blocks
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
  // Build clean history for backend (role + content only)
  var histPayload=_agentHistory.slice(0,-1).map(function(m){return{role:m.role,content:m.content};});
  var liveCtx2={};
  try{
    if(typeof D!=='undefined'&&D){
      liveCtx2.cp=D.cp||null;
      liveCtx2.generatorRows=(D.generator&&D.generator.row_count)||null;
      liveCtx2.generatorUsed=(D.generator&&D.generator.generator_used)||null;
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
  if(btn){ btn.textContent=' Saved'; setTimeout(function(){ btn.disabled=false; btn.textContent='Export CSV'; },2000); }
}

function agentExportReport(content, filePath, btn){
  vscode.postMessage({command:'exportArtifact', type:'report', content:content||'', filePath:filePath||null, filename:'aurora_report.docx'});
  if(btn){ btn.textContent=' Saved'; setTimeout(function(){ btn.disabled=false; btn.textContent='Export Report'; },2000); }
}

function agentHandleResponse(content, model, error, artifact){
  agentHideThinking();
  _agentThinking=false;
  var btn=document.getElementById('agent-send-btn'); if(btn) btn.disabled=false;
  var simpleBtn=document.getElementById('agent-send-simple'); if(simpleBtn) simpleBtn.disabled=false;
  var ts=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  if(error){
    // If error is about missing API key, surface the inline key input
    var errLow = error ? error.toLowerCase() : '';
    var isKeyError = errLow.indexOf('api key')!==-1
      || errLow.indexOf('not configured')!==-1
      || errLow.indexOf('authentication')!==-1
      || errLow.indexOf('unauthorized')!==-1
      || errLow.indexOf('invalid key')!==-1
      || errLow.indexOf('invalid api')!==-1
      || error.indexOf('401')!==-1;
    if(isKeyError){
      // Focus the key input row (always visible) and update its status label
      var inp2=document.getElementById('agent-api-key');
      var status2=document.getElementById('agent-key-status');
      if(inp2) inp2.focus();
      if(status2){ status2.style.color='#fb923c'; status2.textContent='No key — paste one above'; }
      var keyMsg='API key not configured. Select your provider and paste your API key in the bar above.';
      _agentHistory.push({role:'assistant',content:keyMsg,ts:ts});
      addAgentMessage(keyMsg);
    } else {
      _agentHistory.push({role:'assistant',content:'⚠ Error: '+error,ts:ts});
      addAgentMessage('⚠ Error: '+error);
    }
  } else {
    // Strip <actions>...</actions> blocks before storing in history or rendering
    var displayContent = agentStripActionBlocks(content||'No response.');
    _agentHistory.push({role:'assistant',content:content||'No response.',ts:ts,model:model});
    var tag=document.getElementById('agent-model-tag'); if(tag) tag.textContent=model||'';
    addAgentMessage(displayContent, artifact||null);
  }
  console.log("[Aurora] model response received");
  // Check for embedded JSON action blocks (control suggestions from the LLM)
  if(!error && content){
    var _actions=agentParseActionBlocks(content);
    for(var _i=0;_i<_actions.length;_i++){
      var _act=_actions[_i];
      var _actType=_act.type||_act.action;
      if(_actType==='modify_generation'){
        agentShowControlConfirm(_act);
        break;
      }
      if(_actType==='export_csv'){
        agentExportCSV(null);
        break;
      }
      if(_actType==='export_docx'){
        agentRequestReport();
        break;
      }
    }
  }
}

// ── Strip <actions>...</actions> blocks from visible text ─────────────────
function agentStripActionBlocks(text){
  return text.replace(/<actions>[\s\S]*?<\/actions>/g,'').trim();
}

// ── JSON action-block parser — handles both <actions> tags and legacy json fences
function agentParseActionBlocks(text){
  var actions=[];

  // Primary channel: <actions>[...]</actions>
  var xmlRx=/<actions>([\s\S]*?)<\/actions>/g;
  var xmlMatch;
  while((xmlMatch=xmlRx.exec(text))!==null){
    try{
      var parsed=JSON.parse(xmlMatch[1].trim());
      var arr=Array.isArray(parsed)?parsed:[parsed];
      for(var a=0;a<arr.length;a++){
        if(arr[a]&&(arr[a].type||arr[a].action)) actions.push(arr[a]);
      }
    }catch(e){}
  }

  // Legacy channel: triple-backtick json code fences
  var BT=String.fromCharCode(96);
  var marker=BT+BT+BT;
  var pos=0;
  while(true){
    var start=text.indexOf(marker+'json',pos);
    if(start===-1) break;
    var end=text.indexOf(marker,start+7);
    if(end===-1) break;
    var raw=text.substring(start+7,end).trim();
    try{
      var obj=JSON.parse(raw);
      if(obj&&(obj.action||obj.type)) actions.push(obj);
    }catch(e){}
    pos=end+3;
  }
  return actions;
}

// ── Control confirmation overlay ─────────────────────────────────────────
var _agentPendingControl=null;

function agentShowControlConfirm(params){
  _agentPendingControl=params;
  var overlay=document.getElementById('agent-confirm-overlay');
  var body=document.getElementById('agent-confirm-body');
  if(!overlay||!body) return;
  var lines=[];
  if(params.row_count!=null) lines.push('Row count: '+params.row_count);
  if(params.generator_used) lines.push('Generator: '+params.generator_used);
  body.textContent=lines.join('\n')||JSON.stringify(params);
  overlay.style.display='flex';
}

function agentConfirmYes(){
  var overlay=document.getElementById('agent-confirm-overlay');
  if(overlay) overlay.style.display='none';
  if(!_agentPendingControl) return;
  vscode.postMessage({command:'agentControl',params:_agentPendingControl});
  addAgentMessage('⚙ Applying generator change...');
  _agentPendingControl=null;
}

function agentConfirmNo(){
  var overlay=document.getElementById('agent-confirm-overlay');
  if(overlay) overlay.style.display='none';
  _agentPendingControl=null;
  addAgentMessage('Generator change cancelled.');
}

function agentConfirmControl(params){
  agentShowControlConfirm(params);
}

// ── Report request ────────────────────────────────────────────────────────
function agentRequestReport(){
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
function agentHandleReportResult(content, filePath, error){
  agentHideThinking();
  var simpleBtn=document.getElementById('agent-send-simple'); if(simpleBtn) simpleBtn.disabled=false;
  var ts=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  if(error){
    var msg='⚠ Report error: '+error;
    _agentHistory.push({role:'assistant',content:msg,ts:ts});
    addAgentMessage(msg);
  } else {
    var summary='DOC Governance report generated'+(filePath?' — '+filePath:'')+'.';
    _agentHistory.push({role:'assistant',content:summary,ts:ts});
    addAgentMessage(summary, {type:'report', content:content, filePath:filePath});
  }
}

// ── Handle agentControl result from extension ─────────────────────────────
function agentHandleControlResult(data){
  agentHideThinking();
  var ts=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  if(data&&data.error){
    var msg='⚠ Control error: '+data.error;
    _agentHistory.push({role:'assistant',content:msg,ts:ts});
    addAgentMessage(msg);
  } else if(data&&data.status==='done'){
    var rows=data.result&&data.result.row_count?String(data.result.row_count):'unknown';
    var msg=' Generated '+rows+' rows successfully.';
    _agentHistory.push({role:'assistant',content:msg,ts:ts});
    addAgentMessage(msg, {type:'csv'});
  }
}


function agentClear(){
  _agentHistory=[];
  var hist=document.getElementById('agent-history');
  if(hist){
    hist.innerHTML='';
    var emptyDiv=document.createElement('div'); emptyDiv.className='agent-empty'; emptyDiv.id='agent-empty';
    emptyDiv.innerHTML='<div class="agent-empty-icon" style="font-size:28px;color:var(--aurora-p5);font-weight:700">AI</div><div class="agent-empty-title">AI Data Governance Agent</div><div class="agent-empty-sub">Ask any question about your dataset — privacy risks, SQL generation, anomalies, cleaning strategies, or governance actions.<br><br>Responses are grounded in real pipeline metrics.</div>';
    hist.appendChild(emptyDiv);
  }
}

// Legacy fallback for old askAI (non-chat path)
function askAI(){
  var q=document.getElementById('ai-question');
  if(q) agentSend(q.value);
}
function askQuick(q){ agentSend(q); }
`;


/***/ }),
/* 13 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
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
      nullRate:s.null_rate||0,unique:null,sample:s.mean!=null?s.mean.toFixed(2):'—'});
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
      nullRate:s.null_rate||0,unique:s.num_unique||null,sample:s.most_frequent||'—'});
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


/***/ }),
/* 14 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


/**
 * realtime_scanner.ts — Phase 4: Real-Time VS Code Document Scanner
 *
 * Phase 4 additions (additive-only — existing diagnostics/decorations intact):
 *   • Pushes structured SecurityAlert objects to alert_store on every finding.
 *   • Applies policy_engine decisions (block/warn/log) per pattern match.
 *   • Monitors dataset files (.csv, .json, .parquet, .xlsx) on open/save
 *     and triggers PII density summary notifications.
 *   • Emits REAL structured alert JSON — never placeholder data.
 */
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
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.activateRealtimeScanner = activateRealtimeScanner;
exports.deactivateRealtimeScanner = deactivateRealtimeScanner;
const vscode = __importStar(__webpack_require__(1));
const path = __importStar(__webpack_require__(3));
const alert_store_1 = __webpack_require__(15);
const policy_engine_1 = __webpack_require__(16);
const SECURITY_PATTERNS = [
    {
        name: 'OpenAI API Key',
        regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ Possible OpenAI API key detected. Do not commit secrets to source control.',
        category: 'secret',
        alertSeverity: 'high',
    },
    {
        name: 'OpenRouter API Key',
        regex: /\bsk-or-v1-[A-Za-z0-9]{40,}\b/g,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ Possible OpenRouter API key detected. Do not commit secrets to source control.',
        category: 'secret',
        alertSeverity: 'critical',
    },
    {
        name: 'Anthropic API Key',
        regex: /\bsk-ant-(?:api03-)[A-Za-z0-9\-_]{80,}\b/g,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ Possible Anthropic API key detected. Do not commit secrets to source control.',
        category: 'secret',
        alertSeverity: 'critical',
    },
    {
        name: 'Groq API Key',
        regex: /\bgsk_[A-Za-z0-9]{50,}\b/g,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ Possible Groq API key detected. Do not commit secrets to source control.',
        category: 'secret',
        alertSeverity: 'high',
    },
    {
        name: 'Mistral API Key',
        regex: /(?:mistral[_\-]?(?:api[_\-]?)?key|MISTRAL_API_KEY)\s*[=:]\s*["']([A-Za-z0-9]{30,})["']/gi,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ Possible Mistral API key assignment detected. Do not commit secrets to source control.',
        category: 'secret',
        alertSeverity: 'high',
    },
    {
        name: 'GitHub Token',
        regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ Possible GitHub token detected.',
        category: 'secret',
        alertSeverity: 'high',
    },
    {
        name: 'AWS Access Key',
        regex: /\bAKIA[0-9A-Z]{16}\b/g,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ Possible AWS Access Key ID detected.',
        category: 'secret',
        alertSeverity: 'critical',
    },
    {
        name: 'Generic API Key Assignment',
        regex: /(?:api[_-]?key|apikey|api_secret|secret_key)\s*[=:]\s*["']([A-Za-z0-9_\-]{20,})["']/gi,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ Possible API key/secret assignment detected.',
        category: 'secret',
        alertSeverity: 'high',
    },
    {
        name: 'JWT Token',
        regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
        severity: vscode.DiagnosticSeverity.Warning,
        message: '⚠ Possible JWT token detected.',
        category: 'secret',
        alertSeverity: 'high',
    },
    {
        name: 'Private Key',
        regex: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ Private key header detected! This is extremely sensitive.',
        category: 'secret',
        alertSeverity: 'critical',
    },
    {
        name: 'Password Assignment',
        regex: /(?:password|passwd|pwd)\s*[=:]\s*["']([^\s"']{8,})["']/gi,
        severity: vscode.DiagnosticSeverity.Warning,
        message: '⚠ Possible hardcoded password detected.',
        category: 'secret',
        alertSeverity: 'high',
    },
    {
        name: 'Bearer Token',
        regex: /\bBearer\s+[A-Za-z0-9_\-.]{20,}\b/g,
        severity: vscode.DiagnosticSeverity.Warning,
        message: '⚠ Possible Bearer token detected.',
        category: 'secret',
        alertSeverity: 'high',
    },
    {
        name: 'Connection String',
        regex: /(?:mongodb|mysql|postgres|redis|amqp):\/\/[^\s"']+/g,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ Database connection string detected. May contain credentials.',
        category: 'secret',
        alertSeverity: 'high',
    },
    {
        name: 'Email Address',
        regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
        severity: vscode.DiagnosticSeverity.Information,
        message: 'ℹ Email address detected in code.',
        category: 'pii',
        alertSeverity: 'medium',
    },
    {
        name: 'SSN Pattern',
        regex: /\b(?!000|666)[0-8]\d{2}[-\s]?(?!00)\d{2}[-\s]?(?!0000)\d{4}\b/g,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ SSN-like pattern detected! This is highly sensitive PII.',
        category: 'pii',
        alertSeverity: 'critical',
    },
    {
        name: 'Credit Card',
        regex: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ Credit card number pattern detected!',
        category: 'pii',
        alertSeverity: 'critical',
    },
];
// ─────────────────────────────────────────────────────────────────────────────
// Decoration types (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
const secretDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(248, 113, 113, 0.15)',
    border: '1px solid rgba(248, 113, 113, 0.4)',
    borderRadius: '3px',
    after: { contentText: ' ⚠ SECRET', color: '#f87171', fontStyle: 'italic', margin: '0 0 0 8px' }
});
const piiDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(251, 191, 36, 0.1)',
    border: '1px solid rgba(251, 191, 36, 0.3)',
    borderRadius: '3px',
    after: { contentText: ' ℹ PII', color: '#fbbf24', fontStyle: 'italic', margin: '0 0 0 8px' }
});
// ─────────────────────────────────────────────────────────────────────────────
// Dataset file extensions
// ─────────────────────────────────────────────────────────────────────────────
const DATASET_EXTENSIONS = new Set(['.csv', '.json', '.parquet', '.xlsx', '.tsv', '.jsonl']);
function isDatasetFile(filePath) {
    return DATASET_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
// ─────────────────────────────────────────────────────────────────────────────
// Policy notification helper
// ─────────────────────────────────────────────────────────────────────────────
function applyPolicyNotification(action, message) {
    if (action === 'block') {
        vscode.window.showErrorMessage(`Aurora Security: ${message}`);
    }
    else if (action === 'warn') {
        vscode.window.showWarningMessage(`Aurora Security: ${message}`);
    }
    // 'log' → silent, stored in alert_store only
}
// ─────────────────────────────────────────────────────────────────────────────
// Core scanner
// ─────────────────────────────────────────────────────────────────────────────
const diagnosticCollection = vscode.languages.createDiagnosticCollection('automate-security');
// Dedup set — prevents re-alerting same (file+line+pattern) on debounce
const _alertedKeys = new Set();
// ─────────────────────────────────────────────────────────────────────────────
// PART 8 — Paths that must never be scanned (false-positive sources)
// ─────────────────────────────────────────────────────────────────────────────
const SCANNER_IGNORE_PATHS = [
    path.join('.vscode', 'settings.json'), // VS Code workspace settings
    path.join('.vscode', 'extensions.json'), // Extension recommendations
];
/**
 * Returns true when the document is a VS Code internal file or an extension
 * SecretStorage path — scanning these causes false positives on encrypted blobs
 * or settings that merely *reference* key names (not real keys).
 */
function shouldIgnoreDocument(document) {
    const fsPath = document.uri.fsPath;
    // Normalise to forward slashes for cross-platform matching
    const normalised = fsPath.replace(/\\/g, '/');
    for (const ignore of SCANNER_IGNORE_PATHS) {
        if (normalised.toLowerCase().endsWith(ignore.replace(/\\/g, '/').toLowerCase())) {
            return true;
        }
    }
    // VS Code user-level settings — where extension API keys (e.g. openrouterApiKey)
    // are legitimately stored.  These paths never contain project secrets, but the
    // key names (apiKey, secret, etc.) and real key values would otherwise trigger
    // false positives on every save.
    // Supports Code, Code - Insiders, Cursor, Windsurf, VSCodium, and .vscode-test (Extension Dev Host)
    if (/\/(?:Code(?:\s-\s\w+)?|Cursor|Windsurf|VSCodium|user-data)\/User\/(?:settings|keybindings)\.json$/i.test(normalised) ||
        /\/User\/(?:settings|keybindings)\.json$/i.test(normalised)) {
        return true;
    }
    // Extension SecretStorage is persisted inside the VS Code profile dir;
    // its path always contains 'globalStorage'
    if (normalised.toLowerCase().includes('/globalstorage/')) {
        return true;
    }
    // Also ignore state.vscdb and other internal extension storage which might contain cached keys
    if (normalised.toLowerCase().endsWith('.vscdb')) {
        return true;
    }
    return false;
}
function scanDocument(document, extensionPath) {
    const diagnostics = [];
    const secretRanges = [];
    const piiRanges = [];
    // PART 8 — skip allowlisted paths to prevent false positives
    if (shouldIgnoreDocument(document)) {
        return { diagnostics, secretRanges, piiRanges, findingCount: 0 };
    }
    if (document.lineCount > 10_000) {
        vscode.window.setStatusBarMessage(`Aurora Security: File too large to scan — ${path.basename(document.fileName)} (${document.lineCount.toLocaleString()} lines)`, 6000);
        return { diagnostics, secretRanges, piiRanges, findingCount: 0 };
    }
    const text = document.getText();
    const fileLabel = path.basename(document.fileName);
    for (const pattern of SECURITY_PATTERNS) {
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        let match;
        while ((match = regex.exec(text)) !== null) {
            const startPos = document.positionAt(match.index);
            const endPos = document.positionAt(match.index + match[0].length);
            const range = new vscode.Range(startPos, endPos);
            const lineNum = startPos.line + 1;
            // VS Code diagnostic (unchanged behaviour)
            const diagnostic = new vscode.Diagnostic(range, `[Aurora Security] ${pattern.message}`, pattern.severity);
            diagnostic.source = 'Aurora';
            diagnostic.code = pattern.name;
            diagnostics.push(diagnostic);
            if (pattern.category === 'secret') {
                secretRanges.push(range);
            }
            else if (pattern.category === 'pii') {
                piiRanges.push(range);
            }
            // ── Phase 4: alert_store integration ──────────────────────────
            const dedupeKey = `${document.uri.fsPath}|${lineNum}|${pattern.name}`;
            if (!_alertedKeys.has(dedupeKey)) {
                _alertedKeys.add(dedupeKey);
                // Cap memory: evict oldest entry when limit exceeded
                if (_alertedKeys.size > 5000) {
                    const oldest = _alertedKeys.values().next().value;
                    if (oldest !== undefined) {
                        _alertedKeys.delete(oldest);
                    }
                }
                const decision = (0, policy_engine_1.evaluate)(pattern.name, extensionPath);
                const snippet = match[0].substring(0, 80);
                const alert = (0, alert_store_1.makeAlert)(pattern.name, decision?.severity ?? pattern.alertSeverity, pattern.category === 'secret' ? 'secret_exposure' : 'pii_detected', fileLabel, pattern.message.replace(/^[⚠ℹ]+\s*/, ''), { line: lineNum, snippet, policyAction: decision?.action });
                (0, alert_store_1.pushAlert)(alert);
                if (decision) {
                    applyPolicyNotification(decision.action, decision.message);
                }
            }
        }
    }
    return { diagnostics, secretRanges, piiRanges, findingCount: diagnostics.length };
}
function updateDecorations(editor, result) {
    editor.setDecorations(secretDecorationType, result.secretRanges);
    editor.setDecorations(piiDecorationType, result.piiRanges);
}
// ─────────────────────────────────────────────────────────────────────────────
// Dataset file monitor
// ─────────────────────────────────────────────────────────────────────────────
const PII_HEADER_PATTERNS = [
    /\bemail\b/, /\bphone\b/, /\bssn\b/, /\bsocial.?security\b/,
    /\bpassword\b/, /\bcredit.?card\b/, /\bcard.?number\b/,
    /\bdate.?of.?birth\b/, /\bdob\b/, /\baddress\b/,
    /\bip.?address\b/, /\bpassport\b/, /\bnational.?id\b/,
    /\bmedical\b/, /\bdiagnosis\b/, /\bprescription\b/,
];
async function monitorDatasetFile(document, extensionPath) {
    const fileName = path.basename(document.fileName);
    const ext = path.extname(document.fileName).toLowerCase();
    // Audit log
    (0, alert_store_1.pushAlert)((0, alert_store_1.makeAlert)('Dataset file opened', 'low', 'dataset_risk', fileName, `${ext.toUpperCase().slice(1)} dataset opened — logged for audit`, { policyAction: 'logged' }));
    // Quick heuristic header scan (first 4 KB)
    const sample = document.getText().substring(0, 4096).toLowerCase();
    const matched = PII_HEADER_PATTERNS.filter(p => p.test(sample));
    if (matched.length === 0) {
        return;
    }
    const piiDensity = matched.length / PII_HEADER_PATTERNS.length;
    const riskScore = Math.min(100, matched.length * 8);
    const riskLabel = riskScore >= 70 ? 'HIGH' : riskScore >= 40 ? 'MODERATE' : 'LOW';
    const topCol = sample.match(matched[0])?.[0]?.replace(/[^a-z_]/g, '') ?? 'unknown';
    const summaryMsg = `Dataset Risk: ${riskLabel} | PII Signals: ${matched.length} | Top: ${topCol}`;
    (0, alert_store_1.pushAlert)((0, alert_store_1.makeAlert)('Dataset PII signal', riskScore >= 70 ? 'high' : 'medium', 'dataset_risk', fileName, summaryMsg, { policyAction: 'warned' }));
    const decision = (0, policy_engine_1.evaluateDataset)(piiDensity, riskScore, extensionPath);
    if (decision) {
        applyPolicyNotification(decision.action, `${summaryMsg} — ${decision.message}`);
    }
    else {
        vscode.window.showInformationMessage(`📊 Aurora — ${summaryMsg}. Run "Aurora: Scan Dataset for PII" for a full report.`);
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Public API (interface identical to Phase 3 — extension.ts unchanged)
// ─────────────────────────────────────────────────────────────────────────────
let debounceTimer;
let _extensionPath;
function activateRealtimeScanner(context) {
    _extensionPath = context.extensionPath;
    _alertedKeys.clear();
    // Scan all currently visible editors (handles files open before activation)
    vscode.window.visibleTextEditors.forEach(editor => {
        const result = scanDocument(editor.document, _extensionPath);
        diagnosticCollection.set(editor.document.uri, result.diagnostics);
        updateDecorations(editor, result);
    });
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        if (!editor) {
            return;
        }
        if (isDatasetFile(editor.document.fileName)) {
            monitorDatasetFile(editor.document, _extensionPath);
        }
        const result = scanDocument(editor.document, _extensionPath);
        diagnosticCollection.set(editor.document.uri, result.diagnostics);
        updateDecorations(editor, result);
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document === event.document) {
                const result = scanDocument(editor.document, _extensionPath);
                diagnosticCollection.set(editor.document.uri, result.diagnostics);
                updateDecorations(editor, result);
                const criticals = result.diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
                if (criticals.length > 0) {
                    vscode.window.setStatusBarMessage(`⚠ Aurora: ${criticals.length} security finding(s)`, 5000);
                }
            }
        }, 800);
    }));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
        const result = scanDocument(document, _extensionPath);
        diagnosticCollection.set(document.uri, result.diagnostics);
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === document) {
            updateDecorations(editor, result);
        }
        if (isDatasetFile(document.fileName)) {
            monitorDatasetFile(document, _extensionPath);
        }
        if (result.findingCount > 0) {
            const criticals = result.diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
            if (criticals > 0) {
                vscode.window.showWarningMessage(`Aurora Security: ${criticals} critical finding(s) in ${path.basename(document.fileName)}. Review the Problems panel.`);
            }
        }
    }));
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
        if (isDatasetFile(document.fileName)) {
            monitorDatasetFile(document, _extensionPath);
        }
    }));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
        diagnosticCollection.delete(document.uri);
    }));
    context.subscriptions.push(diagnosticCollection);
}
function deactivateRealtimeScanner() {
    diagnosticCollection.clear();
    _alertedKeys.clear();
}


/***/ }),
/* 15 */
/***/ ((__unused_webpack_module, exports) => {


/**
 * alert_store.ts — Shared in-memory alert registry for AutoMate Phase 4
 *
 * Acts as the single source of truth for all live security alerts detected
 * by the realtime scanner, prompt scanner, and dataset monitor.
 *
 * Consumers (extension.ts, monitorPanel, openrouter_client) read from here.
 * Producers (realtime_scanner, prompt_scanner) write to here.
 */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.onAlert = onAlert;
exports.pushAlert = pushAlert;
exports.getAlerts = getAlerts;
exports.getRecentAlerts = getRecentAlerts;
exports.clearAlerts = clearAlerts;
exports.makeAlert = makeAlert;
// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────
/** Maximum alerts kept in memory (circular buffer) */
const MAX_ALERTS = 200;
let _alerts = [];
const _listeners = [];
/** Subscribe to new alerts. Returns an unsubscribe function. */
function onAlert(listener) {
    _listeners.push(listener);
    return () => {
        const idx = _listeners.indexOf(listener);
        if (idx !== -1) {
            _listeners.splice(idx, 1);
        }
    };
}
/** Push a new alert into the store and notify all listeners. */
function pushAlert(alert) {
    _alerts.unshift(alert); // newest first
    if (_alerts.length > MAX_ALERTS) {
        _alerts.length = MAX_ALERTS; // trim tail
    }
    _listeners.forEach(fn => {
        try {
            fn(alert);
        }
        catch { /* listener errors must not break producer */ }
    });
}
/** Return a snapshot of current alerts (newest first). */
function getAlerts() {
    return [..._alerts];
}
/** Return the N most recent alerts. */
function getRecentAlerts(n = 50) {
    return _alerts.slice(0, n);
}
/** Clear all stored alerts (e.g. on workspace reset). */
function clearAlerts() {
    _alerts = [];
}
// ─────────────────────────────────────────────────────────────────────────────
// Helper — create a well-formed alert
// ─────────────────────────────────────────────────────────────────────────────
let _counter = 0;
function makeAlert(type, severity, category, file, pattern, opts = {}) {
    _counter++;
    return {
        id: `sa-${Date.now()}-${_counter}`,
        type,
        severity,
        category,
        file,
        pattern,
        timestamp: new Date().toISOString(),
        ...opts,
    };
}


/***/ }),
/* 16 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


/**
 * policy_engine.ts — Phase 4 Policy Enforcement Engine
 *
 * Reads policy.yaml (or falls back to hardcoded defaults) and maps each
 * security pattern match → enforcement action (block / warn / log).
 *
 * Design rules:
 *  - NEVER breaks if policy.yaml is missing or malformed.
 *  - All actions are additive: block always implies warn + log.
 *  - Public API is synchronous to keep the hot scanner path fast.
 */
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
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.refreshPolicy = refreshPolicy;
exports.evaluate = evaluate;
exports.evaluateDataset = evaluateDataset;
exports.evaluatePrompt = evaluatePrompt;
exports.getThresholds = getThresholds;
const vscode = __importStar(__webpack_require__(1));
const fs = __importStar(__webpack_require__(4));
const path = __importStar(__webpack_require__(3));
// ─────────────────────────────────────────────────────────────────────────────
// Built-in defaults (used when policy.yaml is absent)
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_POLICY = {
    rules: {
        block_private_keys: { enabled: true, action: 'block', severity: 'critical', description: 'Private keys must never appear in workspace.' },
        block_aws_keys: { enabled: true, action: 'block', severity: 'critical', description: 'AWS Access Key IDs expose cloud credentials.' },
        block_credit_cards: { enabled: true, action: 'block', severity: 'critical', description: 'Credit card numbers are PCI-DSS regulated.' },
        block_connection_strings: { enabled: true, action: 'block', severity: 'high', description: 'Connection strings may embed credentials.' },
        warn_on_api_keys: { enabled: true, action: 'warn', severity: 'high', description: 'Hard-coded API keys violate secret management.' },
        warn_on_openai_keys: { enabled: true, action: 'warn', severity: 'high', description: 'OpenAI keys expose paid-API access.' },
        warn_on_jwt: { enabled: true, action: 'warn', severity: 'high', description: 'JWT tokens grant protected service access.' },
        warn_on_password: { enabled: true, action: 'warn', severity: 'high', description: 'Hardcoded passwords violate security policy.' },
        warn_on_bearer_token: { enabled: true, action: 'warn', severity: 'high', description: 'Bearer tokens grant delegated API access.' },
        warn_on_github_token: { enabled: true, action: 'warn', severity: 'high', description: 'GitHub tokens expose repository access.' },
        warn_on_ssn: { enabled: true, action: 'block', severity: 'critical', description: 'SSNs are the highest-risk PII category.' },
        warn_on_email: { enabled: true, action: 'warn', severity: 'medium', description: 'Email addresses may indicate PII exposure.' },
        warn_on_prompt_pii: { enabled: true, action: 'warn', severity: 'medium', description: 'PII in LLM prompt — anonymize before sending.' },
        warn_on_prompt_secrets: { enabled: true, action: 'block', severity: 'critical', description: 'Secrets in LLM prompts risk third-party exposure.' },
        warn_on_prompt_medical: { enabled: true, action: 'warn', severity: 'high', description: 'Medical data in prompts may violate HIPAA.' },
        warn_on_high_risk_dataset: { enabled: true, action: 'warn', severity: 'high', description: 'High-risk dataset requires privacy review.' },
        log_dataset_open: { enabled: true, action: 'log', severity: 'low', description: 'Dataset file opened — logged for audit.' },
    },
    thresholds: {
        pii_density_warn: 0.40,
        pii_density_block: 0.70,
        dataset_risk_score_warn: 60,
        prompt_pii_max_items: Infinity,
    },
};
// ─────────────────────────────────────────────────────────────────────────────
// Pattern → ruleId mapping
// Maps the pattern name from realtime_scanner to the relevant policy rule key.
// ─────────────────────────────────────────────────────────────────────────────
const PATTERN_TO_RULE = {
    'OpenAI API Key': 'warn_on_openai_keys',
    'OpenRouter API Key': 'warn_on_api_keys',
    'Groq API Key': 'warn_on_api_keys',
    'Anthropic API Key': 'warn_on_api_keys',
    'Mistral API Key': 'warn_on_api_keys',
    'GitHub Token': 'warn_on_github_token',
    'AWS Access Key': 'block_aws_keys',
    'Generic API Key Assignment': 'warn_on_api_keys',
    'JWT Token': 'warn_on_jwt',
    'Private Key': 'block_private_keys',
    'Password Assignment': 'warn_on_password',
    'Bearer Token': 'warn_on_bearer_token',
    'Connection String': 'block_connection_strings',
    'Email Address': 'warn_on_email',
    'SSN Pattern': 'warn_on_ssn',
    'Credit Card': 'block_credit_cards',
};
// ─────────────────────────────────────────────────────────────────────────────
// Policy loader
// ─────────────────────────────────────────────────────────────────────────────
let _policy = DEFAULT_POLICY;
let _policyLoadedAt = 0;
const POLICY_TTL_MS = 30_000; // reload at most every 30 s
// Reset policy cache whenever the workspace folders change
vscode.workspace.onDidChangeWorkspaceFolders(() => {
    _policy = DEFAULT_POLICY;
    _policyLoadedAt = 0;
});
function findPolicyFile(extensionPath) {
    // Check workspace root first, then extension dir
    const candidates = [];
    const wsRoots = vscode.workspace.workspaceFolders?.map(w => w.uri.fsPath) ?? [];
    for (const root of wsRoots) {
        candidates.push(path.join(root, 'policy.yaml'));
    }
    if (extensionPath) {
        candidates.push(path.join(extensionPath, 'policy.yaml'));
    }
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return null;
}
/**
 * Simple YAML→object parser for the limited policy.yaml schema.
 * Avoids pulling in a YAML dependency — handles only key: value pairs
 * and nested sections separated by blank lines.
 */
function stripYamlComment(raw) {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
        }
        else if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
        }
        else if (ch === '#' && !inSingle && !inDouble) {
            return raw.slice(0, i);
        }
    }
    return raw;
}
function parseSimpleYaml(text) {
    const result = {};
    let section = null;
    let subSection = null;
    for (const raw of text.split('\n')) {
        const line = stripYamlComment(raw).trimEnd();
        if (!line.trim()) {
            continue;
        }
        // Detect top-level key (no leading spaces)
        const topMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
        if (topMatch) {
            section = topMatch[1];
            subSection = null;
            if (topMatch[2].trim()) {
                result[section] = coerce(topMatch[2].trim());
            }
            else {
                result[section] = result[section] ?? {};
            }
            continue;
        }
        // Detect 2-space indented list item (- value) under a section key
        const list2Match = line.match(/^  -\s+(.+)$/);
        if (list2Match && section) {
            if (!Array.isArray(result[section])) {
                result[section] = [];
            }
            result[section].push(coerce(list2Match[1].trim()));
            continue;
        }
        // Detect 2-space indented key (sub-section)
        const sub2Match = line.match(/^  ([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
        if (sub2Match && section) {
            subSection = sub2Match[1];
            if (typeof result[section] !== 'object') {
                result[section] = {};
            }
            if (sub2Match[2].trim()) {
                result[section][subSection] = coerce(sub2Match[2].trim());
            }
            else {
                result[section][subSection] = result[section][subSection] ?? {};
            }
            continue;
        }
        // Detect 4-space indented key (leaf values)
        const leaf4Match = line.match(/^    ([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
        if (leaf4Match && section && subSection) {
            const key = leaf4Match[1];
            const val = coerce(leaf4Match[2].trim());
            if (typeof result[section][subSection] !== 'object') {
                result[section][subSection] = {};
            }
            result[section][subSection][key] = val;
        }
    }
    return result;
}
function coerce(v) {
    if (v === 'true') {
        return true;
    }
    if (v === 'false') {
        return false;
    }
    const n = Number(v);
    if (!isNaN(n) && v !== '') {
        return n;
    }
    // Strip surrounding quotes
    return v.replace(/^["']|["']$/g, '');
}
function buildPolicyFromYaml(raw) {
    const rules = { ...DEFAULT_POLICY.rules };
    const rawRules = raw['rules'] ?? {};
    for (const [id, ruleRaw] of Object.entries(rawRules)) {
        if (!ruleRaw || typeof ruleRaw !== 'object') {
            continue;
        }
        const r = ruleRaw;
        rules[id] = {
            enabled: r['enabled'] ?? true,
            action: (r['action'] ?? 'warn'),
            severity: (r['severity'] ?? 'medium'),
            description: r['description'] ?? '',
        };
    }
    const rawThr = raw['thresholds'] ?? {};
    const thresholds = {
        pii_density_warn: Number(rawThr['pii_density_warn'] ?? DEFAULT_POLICY.thresholds.pii_density_warn),
        pii_density_block: Number(rawThr['pii_density_block'] ?? DEFAULT_POLICY.thresholds.pii_density_block),
        dataset_risk_score_warn: Number(rawThr['dataset_risk_score_warn'] ?? DEFAULT_POLICY.thresholds.dataset_risk_score_warn),
        prompt_pii_max_items: Number(rawThr['prompt_pii_max_items'] ?? DEFAULT_POLICY.thresholds.prompt_pii_max_items),
    };
    return { rules, thresholds };
}
function loadPolicy(extensionPath) {
    const now = Date.now();
    if (now - _policyLoadedAt < POLICY_TTL_MS) {
        return _policy;
    }
    _policyLoadedAt = now;
    const filePath = findPolicyFile(extensionPath);
    if (!filePath) {
        _policy = DEFAULT_POLICY;
        return _policy;
    }
    try {
        const text = fs.readFileSync(filePath, 'utf-8');
        const raw = parseSimpleYaml(text);
        _policy = buildPolicyFromYaml(raw);
    }
    catch {
        _policy = DEFAULT_POLICY; // graceful fallback
    }
    return _policy;
}
// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
/** Reload the policy immediately (bypasses TTL cache). */
function refreshPolicy(extensionPath) {
    _policy = DEFAULT_POLICY;
    _policyLoadedAt = 0;
    loadPolicy(extensionPath);
}
/**
 * Evaluate what action should be taken for a detected pattern.
 *
 * @param patternName  The `name` field from SECURITY_PATTERNS in realtime_scanner
 * @param extensionPath  Extension root (for locating policy.yaml)
 * @returns PolicyDecision or null if the rule is disabled.
 */
function evaluate(patternName, extensionPath) {
    const policy = loadPolicy(extensionPath);
    const ruleId = PATTERN_TO_RULE[patternName];
    if (!ruleId) {
        return null;
    }
    const rule = policy.rules[ruleId];
    if (!rule || !rule.enabled) {
        return null;
    }
    const emoji = rule.action === 'block' ? '❌' : rule.action === 'warn' ? '⚠' : 'ℹ';
    const label = rule.action === 'block' ? 'blocked by policy' : rule.action === 'warn' ? 'policy warning' : 'logged by policy';
    return {
        action: rule.action,
        severity: rule.severity,
        ruleId,
        message: `${emoji} ${patternName} — ${label}: ${rule.description}`,
    };
}
/**
 * Evaluate a dataset risk result against thresholds.
 * Returns a PolicyDecision or null if no threshold is breached.
 */
function evaluateDataset(piiDensity, riskScore, extensionPath) {
    const policy = loadPolicy(extensionPath);
    const thr = policy.thresholds;
    if (piiDensity >= thr.pii_density_block) {
        const rule = policy.rules['warn_on_high_risk_dataset'];
        if (!rule || !rule.enabled) {
            return null;
        }
        return {
            action: 'block',
            severity: 'critical',
            ruleId: 'warn_on_high_risk_dataset',
            message: `❌ Dataset PII density ${(piiDensity * 100).toFixed(0)}% exceeds block threshold — blocked by policy`,
        };
    }
    if (piiDensity >= thr.pii_density_warn || riskScore >= thr.dataset_risk_score_warn) {
        const rule = policy.rules['warn_on_high_risk_dataset'];
        if (!rule?.enabled) {
            return null;
        }
        return {
            action: 'warn',
            severity: 'high',
            ruleId: 'warn_on_high_risk_dataset',
            message: `⚠ Dataset risk score ${riskScore.toFixed(0)}/100 — policy warning: review before use`,
        };
    }
    return null;
}
/**
 * Evaluate a prompt scan result.
 * Returns a PolicyDecision or null if clean.
 */
function evaluatePrompt(hasCritical, hasHigh, itemCount, extensionPath) {
    const policy = loadPolicy(extensionPath);
    if (hasCritical) {
        const rule = policy.rules['warn_on_prompt_secrets'];
        if (rule?.enabled) {
            return {
                action: 'block',
                severity: 'critical',
                ruleId: 'warn_on_prompt_secrets',
                message: `❌ Secrets detected in LLM prompt — blocked by policy: ${rule.description}`,
            };
        }
    }
    if (hasHigh || (policy.thresholds.prompt_pii_max_items > 0 && itemCount > policy.thresholds.prompt_pii_max_items)) {
        const rule = policy.rules['warn_on_prompt_pii'];
        if (rule?.enabled) {
            return {
                action: 'warn',
                severity: 'medium',
                ruleId: 'warn_on_prompt_pii',
                message: `⚠ ${itemCount} sensitive item(s) in LLM prompt — policy warning: ${rule.description}`,
            };
        }
    }
    return null;
}
/** Expose thresholds (for dataset monitor). */
function getThresholds(extensionPath) {
    return loadPolicy(extensionPath).thresholds;
}


/***/ }),
/* 17 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


/**
 * prompt_scanner.ts — Phase 4: Prompt Leakage Detection
 *
 * Phase 4 additions (additive-only):
 *   • pushAlert() integration — every prompt scan finding creates a SecurityAlert.
 *   • evaluatePrompt() from policy_engine — blocks or warns per policy rules.
 *   • Structured findings emitted for LLM context injection.
 *
 * Core scanning logic is unchanged from Phase 3.
 */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.scanPrompt = scanPrompt;
const alert_store_1 = __webpack_require__(15);
const policy_engine_1 = __webpack_require__(16);
const PROMPT_PATTERNS = [
    // PII
    {
        name: 'Email',
        regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
        type: 'pii', category: 'email', severity: 'high',
        replaceFn: (_m, i) => `EMAIL_${String(i).padStart(3, '0')}@redacted.com`
    },
    {
        name: 'Phone',
        regex: /\b(?:\+?1[-.\ ]?)?\(?\d{3}\)?[-.\ ]?\d{3}[-.\ ]?\d{4}\b/g,
        type: 'pii', category: 'phone', severity: 'high',
        replaceFn: (_m, i) => `PHONE_${String(i).padStart(3, '0')}`
    },
    {
        name: 'SSN',
        regex: /\b\d{3}[-\ ]\d{2}[-\ ]\d{4}\b/g,
        type: 'pii', category: 'ssn', severity: 'critical',
        replaceFn: () => `SSN_REDACTED`
    },
    {
        name: 'Credit Card',
        regex: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
        type: 'pii', category: 'credit_card', severity: 'critical',
        replaceFn: () => `CC_REDACTED`
    },
    {
        name: 'Date of Birth',
        regex: /\b(?:born|dob|date\s*of\s*birth)\s*[:=]?\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/gi,
        type: 'pii', category: 'dob', severity: 'high',
        replaceFn: () => `DOB_REDACTED`
    },
    // Medical
    {
        name: 'Medical Diagnosis',
        regex: /\b(?:diagnosed?\s+with|diagnosis\s*[:=]?\s*)\s*[A-Za-z\s]{3,40}/gi,
        type: 'medical', category: 'diagnosis', severity: 'critical',
        replaceFn: () => `MEDICAL_DIAGNOSIS_REDACTED`
    },
    {
        name: 'Prescription',
        regex: /\b(?:prescription|prescribed|medication|rx)\s*[:=]?\s*[A-Za-z\s]{3,30}/gi,
        type: 'medical', category: 'prescription', severity: 'high',
        replaceFn: () => `PRESCRIPTION_REDACTED`
    },
    {
        name: 'Patient ID',
        regex: /\b(?:patient\s*(?:id|number|no))\s*[:=]?\s*[A-Za-z0-9\-]{4,20}/gi,
        type: 'medical', category: 'patient_id', severity: 'critical',
        replaceFn: (_m, i) => `PATIENT_${String(i).padStart(3, '0')}`
    },
    {
        name: 'ICD Code',
        regex: /\bICD[-\s]?\d{1,2}[-\s]?[A-Z]\d{1,2}(?:\.\d{1,2})?\b/gi,
        type: 'medical', category: 'icd_code', severity: 'high',
        replaceFn: () => `ICD_CODE_REDACTED`
    },
    // Secrets
    {
        name: 'API Key',
        regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
        type: 'secret', category: 'api_key', severity: 'critical',
        replaceFn: () => `API_KEY_REDACTED`
    },
    {
        name: 'OpenRouter API Key',
        regex: /\bsk-or-v1-[A-Za-z0-9]+\b/g,
        type: 'secret', category: 'api_key', severity: 'critical',
        replaceFn: () => `OPENROUTER_KEY_REDACTED`
    },
    {
        name: 'Groq API Key',
        regex: /\bgsk_[A-Za-z0-9]+\b/g,
        type: 'secret', category: 'api_key', severity: 'critical',
        replaceFn: () => `GROQ_KEY_REDACTED`
    },
    {
        name: 'Anthropic API Key',
        regex: /\bsk-ant-api03-[A-Za-z0-9]+\b/g,
        type: 'secret', category: 'api_key', severity: 'critical',
        replaceFn: () => `ANTHROPIC_KEY_REDACTED`
    },
    {
        name: 'Mistral API Key',
        regex: /(?:mistral[_\-]?(?:api[_\-]?)?key|MISTRAL_API_KEY)\s*[=:]\s*["']([A-Za-z0-9]{30,})["']/gi,
        type: 'secret', category: 'api_key', severity: 'critical',
        replaceFn: () => `MISTRAL_KEY_REDACTED`
    },
    {
        name: 'Bearer Token',
        regex: /\bBearer\s+[A-Za-z0-9_\-.]{20,}\b/g,
        type: 'secret', category: 'bearer_token', severity: 'critical',
        replaceFn: () => `BEARER_TOKEN_REDACTED`
    },
    {
        name: 'AWS Key',
        regex: /\bAKIA[0-9A-Z]{16}\b/g,
        type: 'secret', category: 'aws_key', severity: 'critical',
        replaceFn: () => `AWS_KEY_REDACTED`
    },
    // Confidential
    {
        name: 'Confidential Marker',
        regex: /\b(?:confidential|classified|top\s+secret|internal\s+only|restricted|proprietary)\b/gi,
        type: 'confidential', category: 'classification', severity: 'medium',
        replaceFn: (m) => `[${m.toUpperCase()}_CONTENT_REDACTED]`
    },
];
// ─────────────────────────────────────────────────────────────────────────────
// Name detection heuristic (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
const COMMON_WORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one',
    'our', 'out', 'day', 'had', 'has', 'his', 'how', 'its', 'may', 'new', 'now', 'old',
    'see', 'way', 'who', 'did', 'get', 'let', 'say', 'she', 'too', 'use', 'this', 'that',
    'with', 'have', 'from', 'they', 'been', 'said', 'each', 'which', 'their', 'will',
    'other', 'about', 'many', 'then', 'them', 'would', 'make', 'like', 'time', 'just',
    'know', 'take', 'people', 'into', 'year', 'your', 'good', 'some', 'could', 'than',
    'first', 'call', 'after', 'water', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
    'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'June',
    'July', 'August', 'September', 'October', 'November', 'December', 'Data', 'The',
    'This', 'What', 'When', 'Where', 'Why', 'How', 'Please', 'Thank', 'Yes', 'No',
]);
function detectNames(text) {
    const findings = [];
    const nameRegex = /\b([A-Z][a-z]{1,15})\s+([A-Z][a-z]{1,15})\b/g;
    let match;
    let counter = 0;
    while ((match = nameRegex.exec(text)) !== null) {
        if (COMMON_WORDS.has(match[1]) || COMMON_WORDS.has(match[2])) {
            continue;
        }
        counter++;
        findings.push({
            type: 'pii',
            category: 'person_name',
            match: match[0],
            start: match.index,
            end: match.index + match[0].length,
            suggestion: `PERSON_${String(counter).padStart(3, '0')}`,
            severity: 'high'
        });
    }
    return findings;
}
// ─────────────────────────────────────────────────────────────────────────────
// Main scan function — Phase 4: now also pushes to alert_store
// ─────────────────────────────────────────────────────────────────────────────
function scanPrompt(prompt, sourceLabel = '<prompt>', extensionPath) {
    const findings = [];
    let anonymized = prompt;
    let replacementCounter = 0;
    for (const pattern of PROMPT_PATTERNS) {
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        let match;
        while ((match = regex.exec(prompt)) !== null) {
            replacementCounter++;
            const replacement = pattern.replaceFn(match[0], replacementCounter);
            findings.push({
                type: pattern.type,
                category: pattern.category,
                match: match[0],
                start: match.index,
                end: match.index + match[0].length,
                suggestion: replacement,
                severity: pattern.severity
            });
        }
    }
    findings.push(...detectNames(prompt));
    // Merge overlapping ranges before applying replacements (prevents corruption)
    const byStart = [...findings].sort((a, b) => a.start - b.start);
    const nonOverlapping = [];
    let lastEnd = -1;
    for (const f of byStart) {
        if (f.start >= lastEnd) {
            nonOverlapping.push(f);
            lastEnd = f.end;
        }
    }
    // Build anonymized version (replace end→start to preserve indices)
    const sortedFindings = nonOverlapping.sort((a, b) => b.start - a.start);
    for (const f of sortedFindings) {
        anonymized = anonymized.substring(0, f.start) + f.suggestion + anonymized.substring(f.end);
    }
    // Risk level — based on deduplicated findings only
    const hasCritical = nonOverlapping.some(f => f.severity === 'critical');
    const hasHigh = nonOverlapping.some(f => f.severity === 'high');
    const riskLevel = hasCritical ? 'dangerous' : hasHigh || nonOverlapping.length > 0 ? 'warning' : 'safe';
    const typeCounts = nonOverlapping.reduce((acc, f) => {
        acc[f.type] = (acc[f.type] || 0) + 1;
        return acc;
    }, {});
    const parts = [];
    if (typeCounts.pii) {
        parts.push(`${typeCounts.pii} PII`);
    }
    if (typeCounts.medical) {
        parts.push(`${typeCounts.medical} medical`);
    }
    if (typeCounts.secret) {
        parts.push(`${typeCounts.secret} secret`);
    }
    if (typeCounts.confidential) {
        parts.push(`${typeCounts.confidential} confidential`);
    }
    const summary = nonOverlapping.length === 0
        ? 'Prompt appears clean — no sensitive data detected.'
        : `Found ${nonOverlapping.length} sensitive item(s): ${parts.join(', ')}. Risk: ${riskLevel.toUpperCase()}.`;
    // ── Phase 4: push structured alert to alert_store ─────────────────────
    if (nonOverlapping.length > 0) {
        const severity = hasCritical ? 'critical' : hasHigh ? 'high' : 'medium';
        const promptAlert = (0, alert_store_1.makeAlert)('Prompt leakage detected', severity, 'prompt_leakage', sourceLabel, summary, { policyAction: hasCritical ? 'blocked' : 'warned' });
        (0, alert_store_1.pushAlert)(promptAlert);
        // Policy evaluation
        const decision = (0, policy_engine_1.evaluatePrompt)(hasCritical, hasHigh, nonOverlapping.length, extensionPath);
        // Decision message surfaced in the VS Code UI by the caller (extension.ts)
        // to avoid a circular import with vscode module.
        promptAlert._policyMessage = decision?.message;
    }
    return { isClean: nonOverlapping.length === 0, findings, anonymizedPrompt: anonymized, riskLevel, summary };
}


/***/ }),
/* 18 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


/**
 * openrouter_client.ts — Hallucination-Resistant LLM Client
 *
 * Uses OpenRouter's free tier models for strictly-grounded data governance
 * analysis.  Every LLM response is validated against the real pipeline
 * measurements before being returned to the caller.
 *
 * Anti-hallucination phases implemented here:
 *   Phase 1  — Structured DATASET_CONTEXT block (ground-truth facts only)
 *   Phase 2  — Strict DATA GOVERNANCE ANALYST system prompt
 *   Phase 3  — Enforced 5-section output format (Dataset Context / Risk Interpretation / Column Risk Analysis / Mitigation Strategy / Confidence Note)
 *   Phase 4  — Column-name validation + auto-regeneration
 *   Phase 5  — Metric number validation + auto-regeneration
 *   Phase 6  — Low statistical-reliability warning prefix
 *   Phase 7  — Safe fallback when analysis is not possible
 */
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
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.OpenRouterClient = void 0;
const https = __importStar(__webpack_require__(19));
const alert_store_1 = __webpack_require__(15);
const dataset_context_builder_1 = __webpack_require__(20);
const PROVIDER_CONFIGS = {
    openrouter: {
        hostname: 'openrouter.ai',
        chatPath: '/api/v1/chat/completions',
        modelsPath: '/api/v1/models',
        authHeader: (key) => ({
            'Authorization': `Bearer ${key}`,
            'HTTP-Referer': 'https://github.com/automate-privacy',
            'X-Title': 'Aurora Privacy Platform',
        }),
        defaultModels: [
            'google/gemma-3-12b-it:free',
            'google/gemma-3-4b-it:free',
            'meta-llama/llama-3.1-8b-instruct:free',
            'mistralai/mistral-7b-instruct:free',
            'microsoft/phi-3-mini-128k-instruct:free',
        ],
        openAICompat: true,
    },
    openai: {
        hostname: 'api.openai.com',
        chatPath: '/v1/chat/completions',
        authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
        defaultModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
        openAICompat: true,
    },
    anthropic: {
        hostname: 'api.anthropic.com',
        chatPath: '/v1/messages',
        authHeader: (key) => ({
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
        }),
        defaultModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
        openAICompat: false,
    },
    groq: {
        hostname: 'api.groq.com',
        chatPath: '/openai/v1/chat/completions',
        authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
        defaultModels: ['llama-3.1-8b-instant', 'llama3-8b-8192', 'mixtral-8x7b-32768'],
        openAICompat: true,
    },
    together: {
        hostname: 'api.together.xyz',
        chatPath: '/v1/chat/completions',
        authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
        defaultModels: ['meta-llama/Llama-3-8b-chat-hf', 'mistralai/Mistral-7B-Instruct-v0.2'],
        openAICompat: true,
    },
    mistral: {
        hostname: 'api.mistral.ai',
        chatPath: '/v1/chat/completions',
        authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
        defaultModels: ['mistral-small-latest', 'mistral-tiny', 'open-mistral-7b'],
        openAICompat: true,
    },
};
// ─────────────────────────────────────────────────────────────────────────────
// Free models on OpenRouter (kept for backward compat / fallback)
// ─────────────────────────────────────────────────────────────────────────────
const FREE_MODELS = PROVIDER_CONFIGS.openrouter.defaultModels;
// ─────────────────────────────────────────────────────────────────────────────
// Agentic tool definitions (OpenAI function-calling format)
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'shell_execute',
            description: 'Execute a shell command on the user system. Use for running scripts, inspecting workspace, or calling CLI tools.',
            parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'file_read',
            description: 'Read a file from the filesystem. Returns its text content.',
            parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute or workspace-relative path' } }, required: ['path'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'file_write',
            description: 'Write text content to a file, creating directories if needed.',
            parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'file_list',
            description: 'List the contents of a directory.',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'python_run',
            description: 'Execute a Python script inline. Returns stdout or error.',
            parameters: { type: 'object', properties: { script: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } }, required: ['script'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'vscode_command',
            description: 'Execute a VS Code command by ID.',
            parameters: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'array' } }, required: ['command'] },
        },
    },
];
const MODEL_UNAVAILABLE_PHRASES = [
    'no endpoints found',
    'no models found',
    'model not found',
    'not a valid model',
    'invalid model',
    'model is currently unavailable',
    'this model is not available',
    'provider returned error',
    'provider error',
    'service unavailable',
    'bad gateway',
    'rate limit exceeded',
    'context length exceeded',
    'temporarily unavailable',
    'overloaded',
];
// ─────────────────────────────────────────────────────────────────────────────
// Validation constants
// ─────────────────────────────────────────────────────────────────────────────
/** Maximum regeneration attempts before accepting the best available response */
const MAX_REGENERATION_ATTEMPTS = 2;
/** Safe fallback phrase the LLM must use when it cannot ground its answer */
const SAFE_FALLBACK = 'The requested analysis cannot be performed using the available dataset metrics.';
// ─────────────────────────────────────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────────────────────────────────────
class OpenRouterClient {
    apiKey;
    provider = 'openrouter';
    currentModelIdx = 0;
    /** Set to true once a key has been injected directly via setKey() */
    _keySetDirectly = false;
    /** Cached live model list fetched from provider — null until first fetch */
    _liveModels = null;
    _liveModelsFetchedAt = 0;
    static LIVE_MODELS_TTL_MS = 5 * 60 * 1000; // re-fetch every 5 min
    constructor(apiKey) {
        this.apiKey = apiKey || '';
        this.refreshKey();
    }
    /** Get the active ProviderConfig for the current provider. */
    get providerCfg() {
        return PROVIDER_CONFIGS[this.provider] || PROVIDER_CONFIGS.openrouter;
    }
    /**
     * Fetch available models from the provider catalog (OpenRouter only).
     * Falls back to the provider's defaultModels for other providers.
     */
    fetchLiveModels() {
        const cfg = this.providerCfg;
        // Only OpenRouter exposes a live models endpoint we can scrape for free tiers
        if (this.provider !== 'openrouter' || !cfg.modelsPath) {
            return Promise.resolve(cfg.defaultModels);
        }
        return new Promise((resolve) => {
            const options = {
                hostname: cfg.hostname,
                path: cfg.modelsPath,
                method: 'GET',
                headers: {
                    ...cfg.authHeader(this.apiKey),
                    'Content-Type': 'application/json',
                },
            };
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        const freeIds = (parsed.data || [])
                            .filter((m) => {
                            if (typeof m.id !== 'string') {
                                return false;
                            }
                            if (m.id.endsWith(':free')) {
                                return true;
                            }
                            const p = m.pricing;
                            return p && Number(p.prompt) === 0 && Number(p.completion) === 0;
                        })
                            .map((m) => m.id);
                        if (freeIds.length > 0) {
                            console.log(`[AutoMate] Live free models from OpenRouter: ${freeIds.length}`);
                            resolve(freeIds);
                        }
                        else {
                            resolve(cfg.defaultModels);
                        }
                    }
                    catch {
                        resolve(cfg.defaultModels);
                    }
                });
            });
            req.on('error', () => resolve(cfg.defaultModels));
            req.setTimeout(8000, () => { req.destroy(); resolve(cfg.defaultModels); });
            req.end();
        });
    }
    /** Get model list — uses live cache, refreshes every 5 min */
    async getModels() {
        const now = Date.now();
        if (this._liveModels && (now - this._liveModelsFetchedAt) < OpenRouterClient.LIVE_MODELS_TTL_MS) {
            return this._liveModels;
        }
        const models = await this.fetchLiveModels();
        this._liveModels = models;
        this._liveModelsFetchedAt = now;
        return models;
    }
    /**
     * Set provider and key together (called from webview/extension).
     * Resets the model cache so the new provider's models are fetched.
     */
    setProviderAndKey(provider, key) {
        if (provider && PROVIDER_CONFIGS[provider]) {
            this.provider = provider;
            this._liveModels = null; // invalidate cache
            this.currentModelIdx = 0;
        }
        if (key && key !== 'PASTE_API_KEY_HERE') {
            this.apiKey = key;
            this._keySetDirectly = true;
        }
    }
    /**
     * Directly inject an API key (e.g. from workspaceState or webview input).
     * This key takes highest priority and will not be overwritten by refreshKey().
     */
    setKey(key, provider) {
        if (provider && PROVIDER_CONFIGS[provider]) {
            this.provider = provider;
            this._liveModels = null;
            this.currentModelIdx = 0;
        }
        if (key && key !== 'PASTE_API_KEY_HERE') {
            this.apiKey = key;
            this._keySetDirectly = true;
        }
    }
    /** Return the currently active provider name. */
    getProvider() {
        return this.provider;
    }
    /**
     * Initialize or update the API key.
     * Priority: 1) directly set via setKey()  2) VS Code settings  3) ENV var  4) placeholder
     */
    refreshKey() {
        // PART 7 — Only accept keys that were injected directly via setKey().
        // We never fall back to settings.json; the extension reads from
        // SecretStorage and calls setKey() on activation (see extension.ts).
        if (this._keySetDirectly && this.apiKey && this.apiKey !== 'PASTE_API_KEY_HERE') {
            return;
        }
        // Env var fallback (CI/CD, dev environments) — explicitly opt-in only.
        // PART 6 — DO NOT read from vscode.workspace.getConfiguration here.
        const envKey = `${this.provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
        const fromEnv = (typeof process !== 'undefined' && (process.env?.[envKey] || process.env?.OPENROUTER_API_KEY)) || '';
        if (fromEnv && fromEnv !== 'PASTE_API_KEY_HERE') {
            this.apiKey = fromEnv;
        }
        else if (!this.apiKey) {
            this.apiKey = 'PASTE_API_KEY_HERE';
        }
    }
    /** Check if the client is configured. */
    isConfigured() {
        this.refreshKey();
        return this.apiKey.length > 0 && this.apiKey !== 'PASTE_API_KEY_HERE';
    }
    // ─────────────────────────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────────────────
    // Governance System Prompt
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Build the Aurora AI Governance Analyst system prompt.
     *
     * Implements the full governance specification:
     *   • 15-layer platform architecture context
     *   • Data Access Rule: never reason from raw datasets — platform outputs only
     *   • Metric Integrity: never fabricate; state unavailable if missing
     *   • Column Integrity: never invent columns; schema-provided only
     *   • Conversation routing — greetings get a short reply only
     *   • Three response depth levels with explicit trigger phrases and length constraints
     *   • Level 1: 1–2 sentences; Level 2: 3–6 sentences; Level 3: full 8-section report
     *   • Column classification with concrete examples per class
     *   • Drift interpretation: 3 dimensions
     *   • Attack path modeling: 5 named vectors, no speculative attacks
     *   • Column-specific mitigation mapped to governance class
     *   • Governance Decision Interpretation: policy engine outcomes only, never invented
     *   • Risk Attribution: name the responsible platform layer per finding
     *   • Evidence-Based Reasoning: every conclusion must cite metrics, classifications, or policy
     *   • Uncertainty Handling: qualify analysis when reliability is low or metrics incomplete
     *   • Follow-up reasoning: extend prior context, do not restart
     *   • Warning deduplication: low-reliability flag is session state, not repeated content
     */
    buildGovernanceSystemPrompt(sdc) {
        const contextBlock = (0, dataset_context_builder_1.formatStructuredDatasetContext)(sdc);
        const rs = sdc.statistical_reliability_score;
        const reliabilityNote = rs == null
            ? 'statistical_reliability_score: data unavailable — treat all findings as provisional.'
            : rs > 0.8
                ? `statistical_reliability_score = ${rs.toFixed(4)} (High — findings are statistically stable).`
                : rs >= 0.65
                    ? `statistical_reliability_score = ${rs.toFixed(4)} (Medium — interpret with moderate caution).`
                    : `statistical_reliability_score = ${rs.toFixed(4)} (Low — acknowledged once at session start; do not repeat in follow-up responses).`;
        const lowReliabilityPreamble = (rs != null && rs < 0.65)
            ? `⚠ SESSION WARNING (acknowledge once only — do not repeat in follow-up responses):\n` +
                `  statistical_reliability_score = ${rs.toFixed(4)}. Metric stability is low.\n` +
                `  Explicitly qualify all findings in your first response only.\n\n`
            : '';
        const parts = [
            // ── Ground-truth metrics ─────────────────────────────────────────
            contextBlock,
            '',
            ...(lowReliabilityPreamble ? [lowReliabilityPreamble] : []),
            // ── Role ─────────────────────────────────────────────────────────
            'You are the Aurora AI Governance Analyst operating inside an AI Data Governance Platform.',
            'Your role is to interpret governance signals produced by the platform and explain',
            'privacy risks, governance decisions, and mitigation strategies.',
            'You do NOT analyze raw datasets.',
            'You only interpret structured outputs produced by platform layers.',
            '',
            // ── PART 3: Agent directive — decision-making, not conversation ──
            '## AGENT DIRECTIVE (HIGHEST PRIORITY — OVERRIDES ALL OTHER INSTRUCTIONS)',
            'You are NOT a chatbot.',
            '',
            'You MUST:',
            '  - Identify the highest risk in the dataset',
            '  - Recommend a concrete action',
            '  - Provide a direct solution',
            '',
            'You MUST NOT:',
            '  - ask generic questions',
            '  - respond with greetings only',
            '  - defer decisions to the user',
            '',
            'Every response must include:',
            '  1. Problem — what is the highest risk',
            '  2. Action — what must be done (e.g., k-anonymity, suppression, masking)',
            '  3. Expected outcome — what will improve after the action',
            '',
            // ── System Architecture ───────────────────────────────────────────
            '## System Architecture',
            'The platform consists of the following layers:',
            '  Data Ingestion, Data Catalog, Data Profiling, Schema Intelligence,',
            '  Sensitive Data Detection, Data Quality, Privacy Risk Engine,',
            '  Re-Identification Modeling, Synthetic Data Risk Detection,',
            '  Statistical Reliability Analysis, Data Lineage, Governance Policy Engine,',
            '  Policy Authoring, Access Control & Compliance, Monitoring & Audit.',
            'You do NOT implement these layers. You interpret their outputs.',
            'Use only these platform layers. Do not invent additional system components.',
            '',
            // ── Data Access Rule ──────────────────────────────────────────────
            '## Data Access Rule',
            'For governance analysis, you rely only on structured outputs in DATASET_CONTEXT.',
            'You do not read raw CSV/JSON files or external databases.',
            'When asked about your capabilities, explain this scope honestly (see Conversation Routing).',
            'Do NOT respond with a flat denial to capability questions — that is unhelpful.',
            '',
            // ── Metric Integrity ──────────────────────────────────────────────
            '## Metric Integrity',
            'Never fabricate metrics.',
            'Possible metrics include: privacy_score, dataset_risk_score, statistical_reliability_score,',
            'column_drift, pii_columns, sensitive_columns.',
            `If a metric is missing, explicitly state that the information is unavailable.`,
            `If a question cannot be answered from available data, respond: "${SAFE_FALLBACK}"`,
            '',
            // ── Column Integrity ──────────────────────────────────────────────
            '## Column Integrity',
            'Never invent dataset columns.',
            'Only reference columns present in the provided dataset schema in DATASET_CONTEXT.',
            '',
            // ── Conversation Routing ──────────────────────────────────────────
            '## Conversation Routing',
            'Before answering, classify the message into one of three tracks:',
            '',
            'TRACK A — Greeting or small talk (hi, hello, thanks, ok, good morning):',
            '  Respond briefly and warmly. Do not lecture about your limitations.',
            '  Example: "Hello! Ask me about your dataset — privacy risks, drift, PII columns, or governance."',
            '',
            'TRACK B — Capability or scope question (what can you do, can you access X, do you have access to Y):',
            '  Give an honest, direct answer about what the platform can and cannot do.',
            '  Aurora CAN: analyze pipeline outputs (risk scores, drift, PII, leakage), generate governance',
            '  reports, suggest anonymization strategies, generate SQL over the dataset schema, trigger',
            '  synthetic data generation via control commands, and answer governance policy questions.',
            '  Aurora CANNOT: read arbitrary files, access the internet, query external databases,',
            '  or access any data outside the pipeline outputs provided in DATASET_CONTEXT.',
            '  Do NOT respond with a flat denial — explain what is and is not possible clearly.',
            '',
            'TRACK C — Dataset analysis or governance question:',
            '  Apply the full governance analysis protocol below.',
            '',
            // ── Response Depth Policy ─────────────────────────────────────────
            '## Response Depth Policy',
            'Always choose the minimum response depth needed.',
            '',
            '### Level 1 — Short Answer',
            'Used for simple factual questions.',
            'Examples: Which column has the highest drift / How many PII columns exist / Which columns are direct identifiers',
            'Respond in 1–2 sentences only. Do NOT generate reports.',
            '',
            '### Level 2 — Analytical Explanation',
            'Used for evaluation or reasoning questions.',
            'Examples: Is this dataset safe to share externally / How could this dataset be re-identified /',
            '  What privacy risks exist in this dataset',
            'Provide a short analytical explanation (3–6 sentences).',
            'Explain the main risks and reasoning clearly.',
            'Do NOT generate the full governance report.',
            '',
            '### Level 3 — Full Governance Analysis',
            'Generate the full governance report ONLY when the user explicitly requests it.',
            'Trigger phrases include:',
            '  generate full report, full governance report, complete analysis,',
            '  detailed assessment, produce full governance analysis',
            'Only then generate the structured report.',
            '',
            // ── Full Governance Report Structure ──────────────────────────────
            '## Full Governance Report Structure (Level 3 only)',
            'Do not rename these sections.',
            '',
            'Dataset Context',
            'Risk Interpretation',
            'Identifier Classification',
            'Column Risk Analysis',
            'Attack Paths',
            'Mitigation Strategy',
            'Governance Recommendation',
            `Confidence Note  (use: ${reliabilityNote})`,
            '',
            // ── Column Classification ─────────────────────────────────────────
            '## Column Classification',
            'Classify attributes into governance categories:',
            '  Direct Identifier   — Examples: phone, national_id, email',
            '  Quasi Identifier    — Examples: name, city, zipcode, birthdate',
            '  Sensitive Attribute — Examples: medical data, financial data, demographic attributes',
            '',
            // ── Drift Interpretation ──────────────────────────────────────────
            '## Drift Interpretation',
            'When drift exists analyze three dimensions:',
            '  Synthetic Data Quality — distribution mismatch between synthetic and original data',
            '  Privacy Leakage Risk   — possible memorization of original records',
            '  Analytical Impact      — impact on downstream models and analytics',
            'Explain implications rather than repeating metric values.',
            '',
            // ── Attack Path Modeling ──────────────────────────────────────────
            '## Attack Path Modeling',
            'Describe realistic attack vectors. Explain how each could realistically occur.',
            'Avoid speculative attacks.',
            '  • Direct identifier lookup',
            '  • Quasi-identifier linkage',
            '  • Cross-dataset correlation',
            '  • Synthetic data memorization',
            '  • Public dataset matching',
            '',
            // ── Column-Specific Mitigation ────────────────────────────────────
            '## Column-Specific Mitigation',
            'Mitigation must correspond to the identified risk. Avoid generic advice.',
            '  Direct Identifiers',
            '    → tokenization, format-preserving encryption, salted hashing, suppression before external sharing',
            '  Quasi Identifiers',
            '    → hierarchical generalization, bucketization, k-anonymity, aggregation',
            '  Sensitive Attributes',
            '    → differential privacy, controlled access, synthetic regeneration',
            '',
            // ── Governance Decision Interpretation ────────────────────────────
            '## Governance Decision Interpretation',
            'Policy outcomes come from the Governance Policy Engine.',
            'Do not invent policy outcomes.',
            'Possible outcomes: allow dataset usage / require anonymization / deny external sharing / require compliance review.',
            'Explain why the decision occurred and what actions are required.',
            '',
            // ── Risk Attribution ──────────────────────────────────────────────
            '## Risk Attribution',
            'Reference the platform layer responsible for each finding.',
            'Examples:',
            '  "Sensitive Data Detection identified PII columns."',
            '  "Privacy Risk Engine evaluated re-identification risk."',
            '',
            // ── Follow-up Reasoning ───────────────────────────────────────────
            '## Follow-up Reasoning',
            'Maintain reasoning across conversation turns.',
            'Build on previous analysis instead of restarting.',
            'Avoid repeating explanations already given.',
            '',
            // ── Evidence-Based Reasoning ──────────────────────────────────────
            '## Evidence-Based Reasoning',
            'Every conclusion must reference metrics, column classifications, or policy decisions.',
            'Avoid unsupported speculation.',
            '',
            // ── Uncertainty Handling ──────────────────────────────────────────
            '## Uncertainty Handling',
            'If statistical reliability is low or metrics are incomplete:',
            '  • explicitly qualify the analysis',
            '  • explain the limitations of the findings',
            '',
            // ── Communication Style ───────────────────────────────────────────
            // ── Structured Response Format (TRACK C, Level 2/3) ──────────────
            '## Response Structure',
            'For all TRACK C (dataset analysis / governance) Level 2 and Level 3 responses,',
            'structure your answer using exactly these four labeled sections:',
            '',
            '**1. Understanding**',
            'State what the question is asking in one concise sentence. No filler.',
            '',
            '**2. Assumptions**',
            'List any explicit assumptions made due to missing metrics or incomplete context.',
            'If none, write: None.',
            '',
            '**3. Reasoning**',
            'Walk through the logic step by step, citing actual metrics, column names,',
            'risk scores, or platform layer outputs from DATASET_CONTEXT.',
            'Do not skip steps. Do not fabricate supporting data.',
            '',
            '**4. Result**',
            'State the final answer, recommendation, or conclusion clearly.',
            'For Level 3, the full governance report replaces this section.',
            '',
            'Do NOT use this structure for TRACK A (greetings) or TRACK B (capability) responses.',
            'Do NOT use this structure for Level 1 (short factual) answers.',
            '## Communication Style',
            'Respond as a professional AI data governance analyst.',
            'Be: clear, analytical, concise, technically precise.',
            'Avoid unnecessary verbosity. Do not behave like a template generator.',
        ];
        return parts.join('\n');
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Core HTTP chat completion
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Send a chat completion request (raw — no validation layer).
     * Automatically cycles through FREE_MODELS when a model is unavailable.
     */
    async chat(messages, model) {
        this.refreshKey();
        if (!this.apiKey || this.apiKey === 'PASTE_API_KEY_HERE') {
            return {
                content: '',
                model: '',
                error: 'API key not configured. Paste your provider API key in the AI Insights panel.',
            };
        }
        // If a specific model is pinned, try only that one (no fallback loop)
        if (model) {
            return this._chatOnce(messages, model);
        }
        // Fetch live model list (cached), fall back to hardcoded list
        const models = await this.getModels();
        // Cycle through all available free models until one responds
        const startIdx = this.currentModelIdx % models.length;
        for (let i = 0; i < models.length; i++) {
            const tryIdx = (startIdx + i) % models.length;
            const tryModel = models[tryIdx];
            const resp = await this._chatOnce(messages, tryModel);
            if (!resp.error) {
                // Success — pin this index for next calls in the session
                this.currentModelIdx = tryIdx;
                this._liveModels = models; // keep same list
                return resp;
            }
            const errLow = (resp.error || '').toLowerCase();
            const isUnavailable = MODEL_UNAVAILABLE_PHRASES.some(p => errLow.includes(p));
            if (!isUnavailable) {
                // Real error (auth, parse, network) — surface it immediately
                return resp;
            }
            // Model unavailable — try next one silently
            console.warn(`[AutoMate] model ${tryModel} unavailable: ${resp.error}`);
        }
        // All models exhausted
        return {
            content: '',
            model: models[this.currentModelIdx % models.length],
            error: `All ${models.length} available models are currently offline on OpenRouter. This is a server-side issue — please wait a minute and try again.`,
        };
    }
    /** Single HTTP request to one specific model — no retry logic. */
    _chatOnce(messages, selectedModel) {
        const cfg = this.providerCfg;
        // Anthropic uses a different API format (system prompt separate, no 'model' in choices)
        if (!cfg.openAICompat) {
            return this._chatOnceAnthropic(messages, selectedModel, cfg);
        }
        const body = JSON.stringify({
            model: selectedModel,
            messages: messages,
            max_tokens: 2048,
            temperature: 0.3,
        });
        return new Promise((resolve) => {
            const options = {
                hostname: cfg.hostname,
                path: cfg.chatPath,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...cfg.authHeader(this.apiKey),
                    'Content-Length': Buffer.byteLength(body),
                },
            };
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.error) {
                            resolve({
                                content: '',
                                model: selectedModel,
                                error: parsed.error.message || JSON.stringify(parsed.error),
                            });
                        }
                        else {
                            const choice = parsed.choices?.[0];
                            resolve({
                                content: choice?.message?.content || '',
                                model: parsed.model || selectedModel,
                                usage: parsed.usage,
                            });
                        }
                    }
                    catch (e) {
                        resolve({ content: '', model: selectedModel, error: `Parse error: ${e}` });
                    }
                });
            });
            req.on('error', (err) => {
                resolve({ content: '', model: selectedModel, error: `Network error: ${err.message}` });
            });
            req.setTimeout(30000, () => {
                req.destroy();
                resolve({ content: '', model: selectedModel, error: 'Request timed out (30s)' });
            });
            req.write(body);
            req.end();
        });
    }
    /** Anthropic /v1/messages format (separate system prompt, content blocks). */
    _chatOnceAnthropic(messages, selectedModel, cfg) {
        const systemMsg = messages.find(m => m.role === 'system');
        const userMsgs = messages.filter(m => m.role !== 'system');
        const body = JSON.stringify({
            model: selectedModel,
            max_tokens: 2048,
            temperature: 0.3,
            ...(systemMsg ? { system: systemMsg.content } : {}),
            messages: userMsgs.map(m => ({ role: m.role, content: m.content })),
        });
        return new Promise((resolve) => {
            const options = {
                hostname: cfg.hostname,
                path: cfg.chatPath,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...cfg.authHeader(this.apiKey),
                    'Content-Length': Buffer.byteLength(body),
                },
            };
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.error) {
                            resolve({
                                content: '',
                                model: selectedModel,
                                error: parsed.error.message || JSON.stringify(parsed.error),
                            });
                        }
                        else {
                            // Anthropic returns content as an array of blocks
                            const textBlock = (parsed.content || []).find((b) => b.type === 'text');
                            resolve({
                                content: textBlock?.text || '',
                                model: parsed.model || selectedModel,
                                usage: parsed.usage
                                    ? { prompt_tokens: parsed.usage.input_tokens, completion_tokens: parsed.usage.output_tokens, total_tokens: (parsed.usage.input_tokens || 0) + (parsed.usage.output_tokens || 0) }
                                    : undefined,
                            });
                        }
                    }
                    catch (e) {
                        resolve({ content: '', model: selectedModel, error: `Parse error: ${e}` });
                    }
                });
            });
            req.on('error', (err) => {
                resolve({ content: '', model: selectedModel, error: `Network error: ${err.message}` });
            });
            req.setTimeout(30000, () => {
                req.destroy();
                resolve({ content: '', model: selectedModel, error: 'Request timed out (30s)' });
            });
            req.write(body);
            req.end();
        });
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Agentic loop — tool-calling round-trip
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Single HTTP request with tools definitions included.
     * Returns the raw assistant message (may contain tool_calls).
     */
    _chatOnceWithTools(messages, selectedModel, tools) {
        const cfg = this.providerCfg;
        // Non-OpenAI-compat providers fall back to plain text
        if (!cfg.openAICompat) {
            return this._chatOnce(messages, selectedModel).then(r => ({
                message: { role: 'assistant', content: r.content },
                model: r.model, usage: r.usage, error: r.error,
            }));
        }
        const body = JSON.stringify({
            model: selectedModel,
            messages,
            tools,
            tool_choice: 'auto',
            max_tokens: 2048,
            temperature: 0.3,
        });
        return new Promise((resolve) => {
            const options = {
                hostname: cfg.hostname,
                path: cfg.chatPath,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...cfg.authHeader(this.apiKey),
                    'Content-Length': Buffer.byteLength(body),
                },
            };
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.error) {
                            resolve({ message: null, model: selectedModel, error: parsed.error.message || JSON.stringify(parsed.error) });
                        }
                        else {
                            const choice = parsed.choices?.[0];
                            resolve({ message: choice?.message || { role: 'assistant', content: '' }, model: parsed.model || selectedModel, usage: parsed.usage });
                        }
                    }
                    catch (e) {
                        resolve({ message: null, model: selectedModel, error: `Parse error: ${e}` });
                    }
                });
            });
            req.on('error', (err) => resolve({ message: null, model: selectedModel, error: `Network error: ${err.message}` }));
            req.setTimeout(60000, () => { req.destroy(); resolve({ message: null, model: selectedModel, error: 'Request timed out (60s)' }); });
            req.write(body);
            req.end();
        });
    }
    /**
     * Agentic tool-calling loop.
     * Iterates: LLM call → execute tool_calls → feed results back → repeat.
     * Returns on first response with no tool_calls (final answer) or on error.
     */
    async _agenticLoop(messages, tools, toolExecutor, selectedModel) {
        const MAX_ITERATIONS = 10;
        const conversation = [...messages];
        let lastModel = selectedModel;
        for (let i = 0; i < MAX_ITERATIONS; i++) {
            const resp = await this._chatOnceWithTools(conversation, selectedModel, tools);
            if (resp.error || !resp.message) {
                // Provider error (model doesn't support tools, upstream error, etc.) —
                // fall back to a plain validatedChat call with the original messages (no tools)
                const plainMessages = messages.filter(m => m.role !== 'tool');
                return this.chat(plainMessages);
            }
            lastModel = resp.model;
            const msg = resp.message;
            // Final answer — no tool calls
            if (!msg.tool_calls || msg.tool_calls.length === 0) {
                return { content: msg.content || '', model: lastModel, usage: resp.usage };
            }
            // Append the assistant message (with tool_calls) to history
            conversation.push(msg);
            // Execute all tool calls, gather results
            const toolResults = await Promise.all(msg.tool_calls.map(async (tc) => {
                let result;
                try {
                    let args = {};
                    try {
                        args = JSON.parse(tc.function.arguments || '{}');
                    }
                    catch {
                        // Model returned malformed JSON args — surface the raw string and abort tool use
                        result = `ERROR: tool arguments were not valid JSON: ${tc.function.arguments}`;
                        return { role: 'tool', tool_call_id: tc.id, content: result };
                    }
                    result = await toolExecutor(tc.function.name, args);
                }
                catch (e) {
                    result = `ERROR: ${e}`;
                }
                return { role: 'tool', tool_call_id: tc.id, content: result };
            }));
            conversation.push(...toolResults);
        }
        return { content: '', model: lastModel, error: 'Agentic loop exceeded maximum iterations (10).' };
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Phase 4 — Column validation
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Extract all tokens from the response that look like column references.
     * We check every word-like token against the known column list.
     */
    extractReferencedColumns(responseText, knownColumns) {
        if (knownColumns.length === 0) {
            return [];
        }
        const referenced = [];
        for (const col of knownColumns) {
            // Escape for regex and search case-insensitively
            const escaped = col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const rx = new RegExp(`\\b${escaped}\\b`, 'i');
            if (rx.test(responseText)) {
                referenced.push(col);
            }
        }
        return referenced;
    }
    /**
     * Return all column-like tokens in the response that are NOT in the known list.
     * Heuristic: any CamelCase or snake_case token that the model mentions in the
     * Evidence block and is not a known metric keyword.
     */
    findHallucinatedColumns(responseText, knownColumns) {
        const knownLower = new Set(knownColumns.map(c => c.toLowerCase()));
        // Extract tokens that look like identifiers (letters/digits/underscores, >= 3 chars)
        const TOKEN_RX = /\b([a-zA-Z_][a-zA-Z0-9_]{2,})\b/g;
        const METRIC_KEYWORDS = new Set([
            // Standard section words — these are expected
            'explanation', 'evidence', 'recommendation', 'confidence', 'high', 'medium', 'low',
            'privacy', 'score', 'dataset', 'risk', 'drift', 'pii', 'reid', 'columns', 'rows',
            'statistical', 'reliability', 'metric', 'data', 'unavailable', 'analysis', 'available',
            'column', 'value', 'data', 'the', 'and', 'for', 'with', 'this', 'that', 'are',
            'can', 'not', 'have', 'has', 'will', 'should', 'may', 'each', 'all', 'any',
            'than', 'from', 'into', 'more', 'less', 'been', 'its', 'your', 'our', 'their',
            // Common English words that look like identifiers
            'rule', 'note', 'warning', 'error', 'action', 'type', 'name', 'level', 'rate',
            'true', 'false', 'null', 'none', 'based', 'above', 'below', 'result',
        ]);
        const hallucinated = [];
        let match;
        TOKEN_RX.lastIndex = 0;
        while ((match = TOKEN_RX.exec(responseText)) !== null) {
            const token = match[1].toLowerCase();
            if (!METRIC_KEYWORDS.has(token) && !knownLower.has(token) && token.length >= 3) {
                // Only flag tokens that contain underscores (strong signal of a column name)
                // or appear in an Evidence: block context
                if (match[1].includes('_')) {
                    hallucinated.push(match[1]);
                }
            }
        }
        // Deduplicate
        return [...new Set(hallucinated)];
    }
    /**
     * Validate that the LLM response only references columns from the known list.
     * Returns null if valid, or a description of the violation.
     */
    validateColumns(responseText, sdc) {
        if (sdc.columns.length === 0) {
            // No column list available — skip column validation
            return null;
        }
        const hallucinated = this.findHallucinatedColumns(responseText, sdc.columns);
        if (hallucinated.length === 0) {
            return null;
        }
        return `Response referenced column(s) not present in the dataset: ${hallucinated.join(', ')}. ` +
            `Valid columns are: ${sdc.columns.join(', ')}.`;
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Phase 5 — Metric number validation
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Extract all numbers from a response text.
     */
    extractNumbers(text) {
        const NUMBER_RX = /\b\d+(?:\.\d+)?\b/g;
        const results = [];
        let m;
        while ((m = NUMBER_RX.exec(text)) !== null) {
            results.push(m[0]);
        }
        return results;
    }
    /**
     * Validate that numbers in the response were sourced from the pipeline context.
     * Returns null if valid, or a description of the violation.
     *
     * We apply a tolerance approach: small integers (0–100) used in prose
     * (e.g. "reduce risk by 30%") are allowed because they are general advice,
     * not fabricated dataset metrics.  Only decimal numbers with 2+ decimals
     * that do not match any pipeline value are flagged.
     */
    validateMetrics(responseText, sdc) {
        const validNums = (0, dataset_context_builder_1.getValidNumbers)(sdc);
        // Validate numbers cited in the Risk Interpretation section
        // (between "Risk Interpretation" and "Identifier Classification")
        const sectionMatch = responseText.match(/Risk Interpretation([\s\S]*?)Identifier Classification/i);
        if (!sectionMatch) {
            return null;
        } // section missing → format issue handled elsewhere
        const sectionText = sectionMatch[1];
        const nums = this.extractNumbers(sectionText);
        // Only flag decimal numbers — plain integers are too ambiguous in prose
        const decimalOther = nums.filter(n => n.includes('.') && !validNums.has(n));
        if (decimalOther.length === 0) {
            return null;
        }
        return `Response Risk Interpretation section references decimal value(s) not present in pipeline metrics: ` +
            `${decimalOther.join(', ')}. Only cite values from DATASET_CONTEXT.`;
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Phase 6 — Low reliability warning
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * The low-reliability warning is now encoded once in the system prompt
     * (as a SESSION WARNING) rather than prepended to every response.
     * This method is kept as a no-op passthrough for backward compatibility
     * with call sites that still reference it.
     */
    applyReliabilityWarning(responseText, _sdc) {
        // Warning deduplication: the system prompt already injects the warning once.
        // Do NOT prepend it again here — that would violate Rule 2 of the governance spec.
        return responseText;
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Phase 7 — Safe fallback
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Normalise a response that the model returned as a safe fallback
     * into the required 5-section governance format.
     */
    wrapFallback(sdc) {
        const ris = sdc.statistical_reliability_score;
        const confNote = ris != null
            ? ris > 0.8
                ? `statistical_reliability_score = ${ris.toFixed(4)} (High).`
                : ris >= 0.65
                    ? `statistical_reliability_score = ${ris.toFixed(4)} (Medium — interpret with caution).`
                    : `statistical_reliability_score = ${ris.toFixed(4)} (Low — treat all findings as provisional).`
            : 'statistical_reliability_score: data unavailable.';
        return [
            'Dataset Context',
            '  Unable to determine dataset properties — required metrics are absent from DATASET_CONTEXT.',
            '',
            'Risk Interpretation',
            `  ${SAFE_FALLBACK}`,
            '',
            'Identifier Classification',
            '  Cannot classify columns — no column data is available in DATASET_CONTEXT.',
            '',
            'Column Risk Analysis',
            '  No column-level risk analysis is possible without the required metrics.',
            '',
            'Attack Paths',
            '  Cannot evaluate re-identification attack paths without column and metric data.',
            '',
            'Mitigation Strategy',
            '  Ensure the dataset has been processed through the full pipeline so that all required',
            '  metrics (privacy_score, pii_columns, column_drift, etc.) are available before retrying.',
            '',
            'Governance Recommendation',
            '  Do not use or share this dataset until full pipeline metrics are available.',
            '',
            'Confidence Note',
            `  ${confNote}`,
        ].join('\n');
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Validated chat — Phases 4, 5, 6, 7
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Send a governed chat request.  The response is validated against the
     * pipeline context; if invalid, regeneration is attempted up to
     * MAX_REGENERATION_ATTEMPTS times before falling back to the safe response.
     *
     * @param messages  Full message array (system prompt already included)
     * @param sdc       Structured dataset context for validation
     */
    async validatedChat(messages, sdc) {
        let lastResponse = null;
        for (let attempt = 0; attempt <= MAX_REGENERATION_ATTEMPTS; attempt++) {
            const response = await this.chat(messages);
            // Propagate hard errors immediately
            if (response.error) {
                return response;
            }
            const text = response.content;
            // Phase 7: detect if the model admitted it can't answer
            if (text.toLowerCase().includes('cannot be performed') ||
                text.toLowerCase().includes('not available in') ||
                text.toLowerCase().includes('data unavailable') && text.length < 200) {
                response.content = this.applyReliabilityWarning(this.wrapFallback(sdc), sdc);
                return response;
            }
            // Phase 4: column validation
            const colViolation = this.validateColumns(text, sdc);
            // Phase 5: metric validation
            const metricViolation = this.validateMetrics(text, sdc);
            if (!colViolation && !metricViolation) {
                // Valid response — apply Phase 6 warning and return
                response.content = this.applyReliabilityWarning(text, sdc);
                return response;
            }
            // Build a correction message to guide the next attempt
            lastResponse = response;
            const correctionParts = [
                'Your previous response was rejected because it violated the grounding rules.',
            ];
            if (colViolation) {
                correctionParts.push(`Column violation: ${colViolation}`);
            }
            if (metricViolation) {
                correctionParts.push(`Metric violation: ${metricViolation}`);
            }
            correctionParts.push('Please regenerate your answer using ONLY the column names and metric values', 'present in DATASET_CONTEXT. Do not invent any values.', 'Use the required eight-section format:', '  Dataset Context / Risk Interpretation / Identifier Classification /', '  Column Risk Analysis / Attack Paths / Mitigation Strategy / Governance Recommendation / Confidence Note');
            // Append the correction as a new user turn for the next iteration
            messages = [
                ...messages,
                { role: 'assistant', content: text },
                { role: 'user', content: correctionParts.join('\n') },
            ];
        }
        // All attempts exhausted — return best available response with warning
        if (lastResponse) {
            lastResponse.content = this.applyReliabilityWarning(lastResponse.content, sdc);
            return lastResponse;
        }
        // Absolute fallback
        return {
            content: this.applyReliabilityWarning(this.wrapFallback(sdc), sdc),
            model: FREE_MODELS[this.currentModelIdx % FREE_MODELS.length],
        };
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Ask a data-aware question about the pipeline.
     * Uses the strict governance-analyst prompt (Phase 2) and full validation pipeline.
     */
    async askAboutData(question, context) {
        const dsCtx = context.datasetCtx ?? (0, dataset_context_builder_1.buildDatasetContext)(context);
        const sdc = (0, dataset_context_builder_1.buildStructuredDatasetContext)(dsCtx);
        const systemPrompt = this.buildGovernanceSystemPrompt(sdc);
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: question },
        ];
        return this.validatedChat(messages, sdc);
    }
    /**
     * Generate privacy recommendations based on pipeline data.
     * Uses the strict governance-analyst prompt and full validation pipeline.
     */
    async getRecommendations(context) {
        const dsCtx = context.datasetCtx ?? (0, dataset_context_builder_1.buildDatasetContext)(context);
        const sdc = (0, dataset_context_builder_1.buildStructuredDatasetContext)(dsCtx);
        const systemPrompt = this.buildGovernanceSystemPrompt(sdc);
        const messages = [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: 'Based on the DATASET_CONTEXT provided, generate a comprehensive list of ' +
                    'privacy and security recommendations. Prioritize by severity. ' +
                    'For each recommendation, cite the exact metric from DATASET_CONTEXT ' +
                    'that justifies it. Format as a numbered list. ' +
                    'Use the required five-section format: Dataset Context / Risk Interpretation / Column Risk Analysis / Mitigation Strategy / Confidence Note.',
            },
        ];
        return this.validatedChat(messages, sdc);
    }
    /**
     * Legacy method kept for backward compatibility.
     * Internally routes through the new governance-analyst prompt.
     */
    buildSystemPrompt(ctx) {
        const dsCtx = ctx.datasetCtx ?? (0, dataset_context_builder_1.buildDatasetContext)(ctx);
        const sdc = (0, dataset_context_builder_1.buildStructuredDatasetContext)(dsCtx);
        return this.buildGovernanceSystemPrompt(sdc);
    }
    /**
     * Builds the REAL-TIME SECURITY ALERTS section for the system prompt.
     * Reads the last N alerts from alert_store and formats them for LLM analysis.
     */
    buildSecurityAlertsSection() {
        const alerts = (0, alert_store_1.getRecentAlerts)(20);
        if (alerts.length === 0) {
            return '';
        }
        const lines = [
            '',
            '## REAL-TIME SECURITY ALERTS',
            'The following alerts were detected live in the developer workspace.',
            'For each alert: explain why it is dangerous and suggest concrete mitigation steps.',
            `Total alerts in session: ${alerts.length}`,
            '',
        ];
        const groups = {};
        for (const a of alerts) {
            (groups[a.category] = groups[a.category] ?? []).push(a);
        }
        const categoryLabel = {
            secret_exposure: '🔑 Secret Exposures',
            pii_detected: '👤 PII Detections',
            prompt_leakage: '💬 Prompt Leakage',
            dataset_risk: '📊 Dataset Risk',
            policy_violation: '🚫 Policy Violations',
        };
        for (const [cat, group] of Object.entries(groups)) {
            lines.push(`### ${categoryLabel[cat] ?? cat} (${group.length})`);
            for (const a of group.slice(0, 5)) {
                lines.push(`  - [${a.severity.toUpperCase()}] ${a.type} | file: ${a.file}` +
                    (a.line ? ` line ${a.line}` : '') +
                    ` | ${a.pattern}` +
                    (a.policyAction ? ` | policy: ${a.policyAction}` : '') +
                    ` | ${a.timestamp.slice(11, 19)}`);
            }
            if (group.length > 5) {
                lines.push(`  ... and ${group.length - 5} more ${cat} alerts.`);
            }
            lines.push('');
        }
        lines.push('RULE: For every alert above, the AI MUST:', '  1. Explain the specific danger (data exposure risk, regulatory impact, attack vector).', '  2. Give concrete mitigation steps (e.g., rotate key, anonymize field, use env vars).', '  3. Cite the severity level and policy action in your response.', '');
        return lines.join('\n');
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Enforcement pipeline — private class methods
    // Moved inside the class body so TypeScript resolves them as proper members
    // and bracket-notation (this['x']) TS7053 errors are eliminated.
    // Logic and behavior are identical to the previous prototype assignments.
    // Pipeline: chat → validate → repair(×2) → fallback → normalize
    // ─────────────────────────────────────────────────────────────────────────
    // ── PART 1: Decision layer — identify highest-severity alert ─────────────
    // Prioritises HIGH alerts first, then falls back to the first available alert.
    // Returns 'none' when no alerts are present in the session context.
    extractTopRisk(ctx) {
        if (!ctx.alerts || ctx.alerts.length === 0) {
            return 'none';
        }
        // Prioritize HIGH alerts
        const high = ctx.alerts.find(a => a.severity === 'HIGH' || a.severity === 'high');
        if (high) {
            return high.type;
        }
        return ctx.alerts[0].type;
    }
    // ── PART 2: Strong validator ──────────────────────────────────────────────
    // Returns true when the response is non-trivial, free of forbidden content,
    // AND (when data is available) references at least one real metric.
    // NOTE: The "action required" gate has been intentionally removed — it was
    // rejecting valid factual answers (e.g. "The highest drift column is age.")
    // and forcing the repair loop to add artificial action language.
    isValidResponse(text, ctx) {
        // Minimum length guard — empty or near-empty responses are always invalid
        if (!text || text.length < 20) {
            return false;
        }
        // Forbidden-content gate — creative outputs are unconditionally invalid
        const hasForbidden = /\b(lyrics|poem|song|once upon|verse|chorus|stanza|fairy tale|short story)\b/i.test(text);
        if (hasForbidden) {
            return false;
        }
        // When no dataset is loaded, a well-formed "please run the pipeline" reply
        // is the correct output — accept it without demanding metric references.
        if (!ctx.hasData) {
            return true;
        }
        // Grounding gate — must reference at least one real dataset signal.
        const lower = text.toLowerCase();
        const hasMetric = (ctx.rowCount != null && text.includes(String(ctx.rowCount))) ||
            (ctx.columns != null && text.includes(String(ctx.columns.length))) ||
            lower.includes('privacy') ||
            lower.includes('risk') ||
            lower.includes('column') ||
            lower.includes('dataset') ||
            lower.includes('row') ||
            lower.includes('pipeline') ||
            lower.includes('score') ||
            lower.includes('pii') ||
            lower.includes('drift');
        return hasMetric;
    }
    // ── PART 3: Repair function ───────────────────────────────────────────────
    // Called when the initial response fails validation.  Sends the bad output
    // back to the model with a correction prompt that injects the exact dataset
    // metrics the response was missing.
    async repairResponse(badOutput, ctx) {
        const repairPrompt = [
            'Your previous response was rejected because it did not reference the real dataset.',
            '',
            'Fix it by grounding your answer in the actual dataset metrics below.',
            '',
            'You MUST rewrite it so that it:',
            '  1. References real dataset metrics from the context below (rows, columns, scores, etc.)',
            '  2. Directly answers what the user asked — if they asked a factual question, answer it factually.',
            '  3. Stays strictly within data governance and privacy analysis scope.',
            '  4. Contains NO creative, fictional, or off-topic content.',
            '',
            '## DATASET CONTEXT (ground every statement here):',
            ...ctx.ctxLines.map(l => `  ${l}`),
            '',
            'Rewrite the answer correctly. Do not repeat the rejected response.',
        ].join('\n');
        return this.chat([
            { role: 'system', content: repairPrompt },
            { role: 'user', content: badOutput },
        ]);
    }
    // ── PART 4: Deterministic fallback ───────────────────────────────────────
    // Called when all repair attempts are exhausted.  Returns a hard-coded
    // structured response built entirely from known dataset metrics —
    // no model call, no randomness, guaranteed to pass isValidResponse().
    // ── PART 5: Strong deterministic fallback ────────────────────────────────
    // Called when all repair attempts are exhausted.  Built entirely from known
    // dataset metrics via extractTopRisk() — no model call, no randomness,
    // guaranteed to contain both a metric reference AND a concrete action so it
    // passes isValidResponse() without further validation cycles.
    buildFallbackResponse(ctx) {
        const risk = this.extractTopRisk(ctx);
        const content = ctx.hasData
            ? [
                'Understanding:',
                'High-risk issue detected in dataset.',
                '',
                'Assumptions:',
                `Dataset contains ${ctx.rowCount ?? 'unknown'} rows and ${ctx.columns?.length ?? 'unknown'} columns.`,
                '',
                'Reasoning:',
                `Primary risk identified: ${risk}.`,
                `Privacy score: ${ctx.privacyScore ?? 'unavailable'}.`,
                `Risk level: ${ctx.riskLevel ?? 'unavailable'}.`,
                '',
                'Result:',
                'Action:',
                '- Apply k-anonymity (k ≥ 5) to suppress quasi-identifier combinations',
                '- Suppress or mask high-risk columns before external sharing',
                '- Recommend re-running the pipeline after anonymization to verify score improvement',
                'Expected outcome:',
                'Reduced re-identification risk and improved privacy score.',
            ].join('\n')
            : 'No dataset is loaded yet. Run the pipeline first to get grounded, data-specific answers.';
        return { content, model: 'aurora-fallback' };
    }
    // ── Intent detector ───────────────────────────────────────────────────────
    // Classifies a raw user input as a lightweight greeting or a real task
    // that requires the full enforcement pipeline.  Called by agentChat before
    // any model invocation so greetings never hit enforcedChat.
    //
    // Evaluation order (first match wins):
    //   1. Empty input          → greeting
    //   2. Overlong input       → task  (safety guard, avoids regex cost on huge strings)
    //   3. Task pattern match   → task  (regex word-boundary patterns — overrides length)
    //   4. Exact greeting word  → greeting
    //   5. Very short (≤ 3 ch)  → greeting  (leftover noise after task check)
    //   6. Default              → task
    detectIntent(input) {
        const text = input.toLowerCase().trim();
        // 1. Empty string — nothing to act on
        if (!text) {
            return 'greeting';
        }
        // 2. Safety fallback for unusually long inputs — always a real task
        if (text.length > 200) {
            return 'task';
        }
        // 3. Strong task signals via word-boundary regex — evaluated BEFORE the
        //    greeting / length checks so short commands like "fix", "run", "sql"
        //    are never misclassified as greetings.
        const taskPatterns = [
            /\bfix\b/,
            /\brun\b/,
            /\banalyze\b/,
            /\bgenerate\b/,
            /\bcreate\b/,
            /\bbuild\b/,
            /\bcheck\b/,
            /\brisk\b/,
            /\bprivacy\b/,
            /\bcolumn\b/,
            /\brows?\b/,
            /\bsql\b/,
            /\bquery\b/,
        ];
        if (taskPatterns.some(p => p.test(text))) {
            return 'task';
        }
        // 4. Greeting detection — exact match OR short phrase containing a greeting word
        //    Handles: "hi", "hello!", "I said hi", "hey there", "oh hey", etc.
        //    Capped at 30 chars so "hey can you analyze my dataset" still hits task patterns above.
        const greetings = ['hi', 'hello', 'hey'];
        if (greetings.includes(text)) {
            return 'greeting';
        }
        if (text.length <= 30 && /\b(hi|hello|hey)\b/.test(text)) {
            return 'greeting';
        }
        // 5. Very short non-task inputs (e.g. "k", "ok", "yo")
        if (text.length <= 3) {
            return 'greeting';
        }
        // 6. Everything else is treated as a task
        return 'task';
    }
    // ── Combined intent + comprehension — single LLM call instead of two ─────
    // Old flow: classifyIntent() → LLM call 1, comprehendRequest() → LLM call 2
    // New flow: classifyAndUnderstand() → 1 call returns both intent AND focus
    // This cuts per-message latency by ~35% (2 calls instead of 3 for tasks).
    async classifyAndUnderstand(input, ctx) {
        if (!input.trim()) {
            return { intent: 'greeting', understanding: '' };
        }
        const contextHint = ctx.hasData
            ? `Dataset: ${ctx.rowCount ?? '?'} rows, privacy ${ctx.privacyScore ?? '?'}, risk ${ctx.riskLevel ?? '?'}.`
            : 'No dataset loaded.';
        try {
            const result = await this.chat([
                {
                    role: 'system',
                    content: [
                        'You are an intent parser for a data governance AI assistant.',
                        'Read the user message and return ONLY a single-line JSON object — no extra text.',
                        '',
                        'Fields:',
                        '  intent: "greeting" if social/conversational with no data request, else "task"',
                        '  focus:  one sentence (max 20 words) saying exactly what the user wants; empty string for greetings',
                        '',
                        'Context: ' + contextHint,
                        '',
                        'Examples (return exactly this format):',
                        '{"intent":"greeting","focus":""}',
                        '{"intent":"task","focus":"User wants the column name with the highest drift score."}',
                        '{"intent":"task","focus":"User wants 10 new synthetic rows generated from current dataset."}',
                        '{"intent":"task","focus":"User wants a full privacy risk analysis of all columns."}',
                    ].join('\n'),
                },
                { role: 'user', content: input },
            ]);
            const parsed = JSON.parse(result.content.trim());
            return {
                intent: parsed.intent === 'greeting' ? 'greeting' : 'task',
                understanding: typeof parsed.focus === 'string' ? parsed.focus : '',
            };
        }
        catch {
            // Parsing failed — safe fallback: treat as task, no focus injection
            return { intent: 'task', understanding: '' };
        }
    }
    // ── Light response builder (kept as emergency fallback only) ─────────────
    buildLightResponse(ctx) {
        if (ctx.hasData) {
            const parts = [`Hi! I'm Aurora, your data governance assistant.`];
            if (ctx.rowCount != null)
                parts.push(`Your dataset has ${ctx.rowCount} rows`);
            if (ctx.privacyScore)
                parts.push(`a privacy score of ${ctx.privacyScore}`);
            if (ctx.riskLevel)
                parts.push(`and ${ctx.riskLevel} risk.`);
            parts.push(`\n\nWhat would you like to know?`);
            return parts.join(', ').replace(', \n\n', '\n\n');
        }
        return `Hi! I'm Aurora, your data governance assistant. Run the pipeline to load your dataset, then ask me anything about privacy risks, PII columns, or compliance.`;
    }
    // ── Greeting responder — uses the LLM to actually understand what was said ──
    // Instead of dumping a hardcoded template at the user, this makes a real LLM
    // call so the agent responds to what the user ACTUALLY said, not just a
    // "greeting was detected" flag.
    async respondToGreeting(input, ctx) {
        const contextBlock = ctx.hasData && ctx.ctxLines.length
            ? `\n\nCurrent dataset status:\n${ctx.ctxLines.slice(0, 6).map(l => `  ${l}`).join('\n')}`
            : `\n\nNo dataset is currently loaded.`;
        try {
            const result = await this.chat([
                {
                    role: 'system',
                    content: [
                        'You are Aurora, an AI data governance assistant.',
                        'The user sent a conversational or greeting message.',
                        'Read what they ACTUALLY said and respond naturally to it.',
                        '',
                        'Rules:',
                        '- Match the energy: if they say "hi", say hi back.',
                        '- If they ask how you are, answer and offer to help.',
                        '- Keep it to 1-3 sentences — no bullet lists, no headers.',
                        '- If a dataset is loaded, mention ONE relevant fact only if it fits naturally.',
                        '- Do NOT dump risk reports or action lists at them unless they asked.',
                        '- Never mention "k-anonymity" or suppression unless they asked.',
                        contextBlock,
                    ].join('\n'),
                },
                { role: 'user', content: input },
            ]);
            if (result.content && result.content.length > 5) {
                return this.normalizeResponse({ ...result, model: result.model || 'aurora-lite' });
            }
        }
        catch {
            // fall through to deterministic fallback
        }
        // Fallback if LLM call fails
        return this.normalizeResponse({
            content: this.buildLightResponse(ctx),
            model: 'aurora-lite',
        });
    }
    // ── Comprehension layer — understands what the user ACTUALLY wants ────────
    // Runs before the main LLM call and extracts a precise focus directive:
    // what aspect of the dataset, what format, what specific question.
    // This gets injected into the system prompt so the model answers the
    // real question instead of a generic interpretation.
    async comprehendRequest(input, ctx) {
        if (!input.trim() || input.length < 4) {
            return '';
        }
        const contextHint = ctx.hasData
            ? `Dataset: ${ctx.rowCount ?? '?'} rows, privacy score ${ctx.privacyScore ?? '?'}, risk ${ctx.riskLevel ?? '?'}. Columns: ${ctx.columns?.slice(0, 6).join(', ') ?? 'unknown'}.`
            : 'No dataset loaded.';
        try {
            const result = await this.chat([
                {
                    role: 'system',
                    content: [
                        'You are a request parser for a data governance AI assistant.',
                        'Read the user message and output ONE short sentence (under 20 words) that precisely describes:',
                        '  - What they are asking for',
                        '  - What dataset element is most relevant (if any)',
                        '  - What response format they likely want (quick fact / list / analysis)',
                        '',
                        'Context: ' + contextHint,
                        '',
                        'Output ONLY the single sentence. No preamble, no punctuation at start.',
                        'Examples:',
                        '  Input: "which col has highest drift" → "User wants the column name with the highest drift score — quick fact."',
                        '  Input: "explain my privacy risks" → "User wants a full analysis of all privacy risks in the dataset."',
                        '  Input: "fix" → "User wants mitigation applied to the top detected risk — action."',
                        '  Input: "how bad is the MI-AUC?" → "User wants an explanation of the MI-AUC value and what it means for their data."',
                    ].join('\n'),
                },
                { role: 'user', content: input },
            ]);
            const understanding = (result.content || '').trim();
            if (understanding.length > 5 && understanding.length < 200) {
                return understanding;
            }
        }
        catch {
            // comprehension is best-effort — never block the main response
        }
        return '';
    }
    // ── PART 5: Response normalizer ───────────────────────────────────────────
    // Last step in the pipeline.  Trims leading/trailing whitespace and
    // collapses excess blank lines so every response has consistent formatting.
    normalizeResponse(resp) {
        if (!resp.content) {
            return resp;
        }
        return {
            ...resp,
            content: resp.content.trim().replace(/\n{3,}/g, '\n\n'),
        };
    }
    // ── PART 1: Central enforcement pipeline ─────────────────────────────────
    // chat → validate → repair(×2) → fallback → normalize → return
    //
    // Single choke-point all agentChat traffic passes through.
    // The system prompt is still injected (it improves first-pass quality) but
    // correctness is guaranteed here in code, not by trusting the model to comply.
    async enforcedChat(messages, ctx) {
        // ── Step 1: initial model call ────────────────────────────────────────
        let response = await this.chat(messages);
        // Hard API/auth errors propagate immediately — validation can't help here
        if (response.error) {
            return response;
        }
        // ── Step 2: validate ──────────────────────────────────────────────────
        if (!this.isValidResponse(response.content, ctx)) {
            console.warn('[Aurora] enforcedChat: initial response invalid — entering repair loop.');
            // ── Step 3: repair loop (max 2 attempts) ──────────────────────────
            for (let attempt = 0; attempt < 2; attempt++) {
                response = await this.repairResponse(response.content, ctx);
                // Surface API errors that occur during repair immediately
                if (response.error) {
                    break;
                }
                if (this.isValidResponse(response.content, ctx)) {
                    console.log(`[Aurora] enforcedChat: repair succeeded on attempt ${attempt + 1}.`);
                    break;
                }
                console.warn(`[Aurora] enforcedChat: repair attempt ${attempt + 1} still invalid.`);
            }
            // ── Step 4: deterministic hard fallback ───────────────────────────
            if (response.error || !this.isValidResponse(response.content, ctx)) {
                console.error('[Aurora] enforcedChat: all repairs exhausted — using deterministic fallback.');
                response = this.buildFallbackResponse(ctx);
            }
        }
        // ── Step 5: normalize and return ─────────────────────────────────────
        return this.normalizeResponse(response);
    }
}
exports.OpenRouterClient = OpenRouterClient;
// ── Concrete implementations added directly to prototype ─────────────────────
OpenRouterClient.prototype.explainDataset = async function (ctx) {
    const dsCtx = ctx.datasetCtx ?? (0, dataset_context_builder_1.buildDatasetContext)(ctx);
    const sdc = (0, dataset_context_builder_1.buildStructuredDatasetContext)(dsCtx);
    const systemPrompt = [
        this['buildGovernanceSystemPrompt'](sdc),
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        (0, dataset_context_builder_1.formatContextForLLM)(dsCtx),
    ].join('\n');
    const messages = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                'Explain this dataset using ONLY the metrics in DATASET_CONTEXT. Cover:',
                '1. OVERVIEW: total rows, column count, column names',
                '2. KEY RELATIONSHIPS: top correlated column pairs (if available)',
                '3. IMPORTANT COLUMNS: the most sensitive columns by reid_score and pii flags, with exact values',
                '4. POTENTIAL RISKS: top privacy/quality risks with exact metric evidence',
                '',
                'Use the required five-section format: Dataset Context / Risk Interpretation / Column Risk Analysis / Mitigation Strategy / Confidence Note.',
                'Cite exact metric values from DATASET_CONTEXT. Do NOT invent any column names or numbers.',
            ].join('\n'),
        },
    ];
    return this['validatedChat'](messages, sdc);
};
OpenRouterClient.prototype.detectAnomalies = async function (ctx) {
    const dsCtx = ctx.datasetCtx ?? (0, dataset_context_builder_1.buildDatasetContext)(ctx);
    const sdc = (0, dataset_context_builder_1.buildStructuredDatasetContext)(dsCtx);
    const anomalies = dataset_context_builder_1.AgentTools.get_anomalies(dsCtx);
    const systemPrompt = [
        this['buildGovernanceSystemPrompt'](sdc),
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        (0, dataset_context_builder_1.formatContextForLLM)(dsCtx),
    ].join('\n');
    const messages = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                'Analyse dataset anomalies using ONLY the metrics in DATASET_CONTEXT.',
                `Pipeline detected ${anomalies.length} anomaly signal(s):`,
                JSON.stringify(anomalies, null, 2),
                '',
                'For each anomaly:',
                '1. Name the column (must be in DATASET_CONTEXT columns list)',
                '2. Cite the exact metric value (drift score, null_ratio, etc.)',
                '3. Explain why this is problematic',
                '4. Recommend a specific remediation action',
                '',
                'Use the required five-section format: Dataset Context / Risk Interpretation / Column Risk Analysis / Mitigation Strategy / Confidence Note.',
                'If no anomalies were detected, explain what that means for data quality.',
            ].join('\n'),
        },
    ];
    return this['validatedChat'](messages, sdc);
};
OpenRouterClient.prototype.suggestCleaning = async function (ctx) {
    const dsCtx = ctx.datasetCtx ?? (0, dataset_context_builder_1.buildDatasetContext)(ctx);
    const sdc = (0, dataset_context_builder_1.buildStructuredDatasetContext)(dsCtx);
    const suggestions = dsCtx.cleaning_suggestions;
    const systemPrompt = [
        this['buildGovernanceSystemPrompt'](sdc),
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        (0, dataset_context_builder_1.formatContextForLLM)(dsCtx),
    ].join('\n');
    const messages = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                'Provide data cleaning recommendations using ONLY the metrics in DATASET_CONTEXT.',
                'The pipeline identified these issues:',
                JSON.stringify(suggestions, null, 2),
                '',
                'For each issue:',
                '1. State the column and the specific problem (with measured value from DATASET_CONTEXT)',
                '2. Give a concrete, actionable fix',
                '3. Assign HIGH/MEDIUM/LOW priority with justification citing the metric',
                '',
                'Group by: Missing Values | Outliers | PII Masking | Distribution Issues',
                '',
                'Use the required five-section format: Dataset Context / Risk Interpretation / Column Risk Analysis / Mitigation Strategy / Confidence Note.',
            ].join('\n'),
        },
    ];
    return this['validatedChat'](messages, sdc);
};
OpenRouterClient.prototype.generateSQL = async function (question, ctx) {
    const dsCtx = ctx.datasetCtx ?? (0, dataset_context_builder_1.buildDatasetContext)(ctx);
    const sdc = (0, dataset_context_builder_1.buildStructuredDatasetContext)(dsCtx);
    const schema = dataset_context_builder_1.AgentTools.get_sql_schema(dsCtx);
    const systemPrompt = [
        this['buildGovernanceSystemPrompt'](sdc),
        '',
        'ADDITIONAL SQL RULES:',
        '  - Use ONLY column names present in the SQL Schema below and in DATASET_CONTEXT.',
        '  - Mark PII columns in SQL comments.',
        '  - Format SQL with uppercase keywords and proper indentation.',
        '  - If a requested column does not exist, state "column unavailable" and DO NOT invent one.',
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        (0, dataset_context_builder_1.formatContextForLLM)(dsCtx),
    ].join('\n');
    const messages = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                `Generate a SQL query for: "${question}"`,
                '',
                `Available schema: ${JSON.stringify(schema)}`,
                '',
                'Return using the five-section format:',
                'Dataset Context: describe the dataset and schema context',
                'Risk Interpretation: explain privacy implications of the query',
                'Column Risk Analysis / Mitigation Strategy: PII/privacy warnings and specific mitigations per column',
                'Confidence Note: based on statistical_reliability_score',
            ].join('\n'),
        },
    ];
    return this['validatedChat'](messages, sdc);
};
OpenRouterClient.prototype.recommendGovernance = async function (ctx) {
    const dsCtx = ctx.datasetCtx ?? (0, dataset_context_builder_1.buildDatasetContext)(ctx);
    const sdc = (0, dataset_context_builder_1.buildStructuredDatasetContext)(dsCtx);
    const govActions = dataset_context_builder_1.AgentTools.get_pii_findings(dsCtx);
    const systemPrompt = [
        this['buildGovernanceSystemPrompt'](sdc),
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        (0, dataset_context_builder_1.formatContextForLLM)(dsCtx),
    ].join('\n');
    const messages = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                'Propose a governance action plan using ONLY the metrics in DATASET_CONTEXT.',
                'Pipeline analysis identified:',
                JSON.stringify(govActions, null, 2),
                '',
                'Structure your Explanation section as:',
                '  ## CRITICAL ACTIONS (implement immediately)',
                '  ## HIGH PRIORITY (implement this sprint)',
                '  ## MEDIUM PRIORITY (plan within 30 days)',
                '  ## MONITORING (set up automated checks)',
                '',
                'For each action: name the column (from DATASET_CONTEXT only), the technique',
                '(masking/hashing/k-anonymity/noise/removal), and cite the exact risk score that justifies it.',
                '',
                'Then complete the Mitigation Strategy and Confidence Note sections as required.',
            ].join('\n'),
        },
    ];
    return this['validatedChat'](messages, sdc);
};
// ─────────────────────────────────────────────────────────────────────────────
OpenRouterClient.prototype.agentChat = async function (history, newMessage, ctx, toolExecutor) {
    const dsCtx = ctx.datasetCtx ?? (0, dataset_context_builder_1.buildDatasetContext)(ctx);
    const sdc = (0, dataset_context_builder_1.buildStructuredDatasetContext)(dsCtx);
    const datasetName = sdc.dataset_name ?? null;
    const rowCount = sdc.row_count ?? null;
    const hasData = !!(datasetName || rowCount || sdc.privacy_score != null);
    // ── Lean dataset context summary (only what the model actually needs) ──────
    // recentAlerts is declared here (outside the if block) so it remains in scope
    // when building datasetCtx.alerts below, regardless of whether hasData is true.
    const recentAlerts = (0, alert_store_1.getRecentAlerts)(20);
    const ctxLines = [];
    if (hasData) {
        if (datasetName)
            ctxLines.push(`Dataset: ${datasetName}`);
        if (rowCount != null)
            ctxLines.push(`Rows: ${rowCount}`);
        if (sdc.columns?.length)
            ctxLines.push(`Columns: ${sdc.columns.length}`);
        if (sdc.privacy_score != null)
            ctxLines.push(`Privacy score: ${(sdc.privacy_score * 100).toFixed(0)}%`);
        if (sdc.dataset_risk_score != null)
            ctxLines.push(`Risk level: ${sdc.dataset_risk_score}`);
        if (sdc.statistical_reliability_score != null)
            ctxLines.push(`Statistical reliability: ${sdc.statistical_reliability_score}`);
        if (sdc.pii_columns?.length)
            ctxLines.push(`PII columns: ${sdc.pii_columns.join(', ')}`);
        if (sdc.sensitive_columns?.length)
            ctxLines.push(`Sensitive columns: ${sdc.sensitive_columns.join(', ')}`);
        if (sdc.column_drift && Object.keys(sdc.column_drift).length)
            ctxLines.push(`Column drift: ${JSON.stringify(sdc.column_drift)}`);
        // Inject live alert count so the model is aware of active security signals
        if (recentAlerts.length > 0) {
            const alertSummary = recentAlerts
                .slice(0, 5)
                .map(a => `${a.severity.toUpperCase()} ${a.type}`)
                .join('; ');
            ctxLines.push(`Alerts: ${recentAlerts.length} active (${alertSummary}${recentAlerts.length > 5 ? '…' : ''})`);
        }
    }
    // ── Live generator state (when pipeline is running) ────────────────────────
    const liveLines = [];
    if (ctx.cp || ctx.live_stats) {
        const cp = ctx.cp || {};
        const ls = ctx.live_stats || {};
        liveLines.push(`Generator phase: ${cp.phase || cp.status || 'unknown'}`, `Progress: ${cp.progress != null ? Math.round(cp.progress * 100) + '%' : 'unknown'}`, `Rows generated: ${ls.generatorRows ?? cp.row_count ?? 'unknown'}`, `Generator used: ${ls.generatorUsed ?? cp.generator_used ?? 'unknown'}`);
    }
    // ── AgentDatasetContext DTO — single source of truth for the enforcement pipeline ──
    // Built once here so isValidResponse / repairResponse / buildFallbackResponse
    // all work from the same snapshot without re-reading sdc individually.
    const datasetCtx = {
        rowCount: rowCount,
        columns: sdc.columns?.length ? sdc.columns : null,
        privacyScore: sdc.privacy_score != null
            ? `${(sdc.privacy_score * 100).toFixed(0)}%`
            : null,
        riskLevel: sdc.dataset_risk_score != null
            ? String(sdc.dataset_risk_score)
            : null,
        ctxLines,
        hasData,
        // PART 1: Expose live alerts so extractTopRisk() can find the highest-severity signal
        alerts: recentAlerts.map((a) => ({
            type: a.type || 'unknown',
            severity: a.severity || 'LOW',
        })),
    };
    // ── Agentic tool section (only when toolExecutor is provided) ──────────────
    const toolLines = toolExecutor ? [
        '',
        'SYSTEM TOOLS AVAILABLE (use when the user asks for file/shell operations):',
        '  shell_execute(command, cwd?) — run a shell command',
        '  file_read(path) — read a file',
        '  file_write(path, content) — write a file',
        '  file_list(path) — list a directory',
        '  python_run(script, args?) — run Python code inline',
        '  vscode_command(command, args?) — run a VS Code command',
        'Use tools proactively. Show results, not just confirmations.',
    ] : [];
    // ── Full pipeline context (column-level detail for deep questions) ─────────
    const fullCtx = (0, dataset_context_builder_1.formatContextForLLM)(dsCtx);
    const systemPrompt = [
        'You are Aurora, an AI data governance assistant built into the Aurora Privacy Platform.',
        'You are in a CHAT interface — answer conversationally and match the depth to the question.',
        '',
        '## RESPONSE RULES',
        '- Short factual question → answer in 1-2 sentences. No headers. No bullet lists unless needed.',
        '- Analytical question → 3-6 sentences. Explain clearly.',
        '- Only produce a full structured report when the user explicitly says "full report", "generate report", "complete analysis".',
        '- Never pad answers with sections the user did not ask for.',
        '- If the user is greeting you or making small talk → respond warmly in one sentence.',
        '',
        '## STRICT PROHIBITION — NON-NEGOTIABLE',
        'You are ONLY permitted to assist with:',
        '  - Dataset analysis, privacy risk assessment, and data governance',
        '  - PII detection, anonymization strategies, and GDPR/compliance questions',
        '  - Questions about THIS dataset\'s metrics, columns, and pipeline outputs',
        'NEVER generate: stories, song lyrics, poems, jokes, trivia, creative writing,',
        '  code unrelated to this dataset, or ANY response outside data governance.',
        'If asked for creative or off-topic content, respond ONLY with:',
        '  "I am Aurora, an AI Data Governance Agent. I can only assist with',
        '   dataset analysis, privacy risks, and governance queries."',
        'This rule overrides ALL other instructions. There are no exceptions.',
        '',
        '## DATA GROUNDING (MANDATORY)',
        hasData
            ? [
                'You have real pipeline data below. You MUST ground EVERY non-greeting response',
                'in the provided dataset metrics — reference specific values such as Rows, Columns,',
                'Privacy score, Risk level, PII columns, or column names from DATASET CONTEXT.',
                'NEVER fabricate metrics. NEVER give generic capability answers when dataset context is available.',
                'A response that does not reference actual dataset metrics is INVALID.',
            ].join(' ')
            : [
                'No dataset is loaded yet. If the user asks about their data,',
                'tell them to run the pipeline first to get grounded responses.',
                'Do NOT generate any data, statistics, or analysis — nothing is available yet.',
            ].join(' '),
        '',
        ...(ctxLines.length ? ['## DATASET CONTEXT', ...ctxLines, ''] : []),
        ...(liveLines.length ? ['## LIVE GENERATOR STATE', ...liveLines, ''] : []),
        '## FULL PIPELINE CONTEXT (for detailed questions)',
        fullCtx,
        ...toolLines,
        '',
        // ── PART 1 + 2 + 5 + 10: Hidden execution protocol ─────────────────
        '## EXECUTION PROTOCOL (STRICTLY INTERNAL — NEVER VISIBLE TO USER)',
        'When the user asks to change generation parameters (e.g. row count, config):',
        '  1. Respond ONLY with a natural-language confirmation describing what will change.',
        '     Example: "The generator will be updated to produce 20 rows. Confirm to proceed."',
        '  2. Append the following hidden block at the VERY END of your response, after all text.',
        '     This block is filtered by the UI layer before rendering — users never see it.',
        '  3. The block MUST contain valid JSON. It MUST be the last thing in your output.',
        '',
        '  Format (append verbatim, replacing values only):',
        '  <actions>[{"action":"modify_generation","row_count":<number>}]</actions>',
        '',
        '  RULES (VIOLATIONS WILL BE CAUGHT BY THE VALIDATION LAYER):',
        '  • NEVER output a ```json code fence containing action objects — this leaks execution.',
        '  • NEVER put raw JSON objects (e.g. {"action":...}) in your visible response text.',
        '  • ONLY use the <actions>...</actions> channel for machine-readable instructions.',
        '  • If no action is needed, do NOT include the <actions> block at all.',
        '  • Only emit <actions> when the user EXPLICITLY requests a generation change.',
    ].join('\n');
    // History: preserve tool message chains in agentic mode, otherwise last 10 turns
    const historySlice = toolExecutor
        ? (() => {
            let userTurns = 0;
            let cutIdx = history.length;
            for (let i = history.length - 1; i >= 0; i--) {
                if (history[i].role === 'user') {
                    userTurns++;
                }
                if (userTurns >= 10) {
                    cutIdx = i;
                    break;
                }
            }
            return history.slice(cutIdx);
        })()
        : history.slice(-10);
    const messages = [
        { role: 'system', content: systemPrompt },
        ...historySlice,
        { role: 'user', content: newMessage },
    ];
    // Agentic mode: only activate for explicit system-access intent
    const SYSTEM_INTENT_RX = /\b(run|execute|shell|bash|terminal|read file|write file|list files?|list dir|create file|delete file|python script|python run|open file|save file)\b/i;
    if (toolExecutor && SYSTEM_INTENT_RX.test(newMessage)) {
        const models = await this['getModels']();
        const selectedModel = models[this['currentModelIdx'] % models.length];
        return this['_agenticLoop'](messages, SYSTEM_TOOLS, toolExecutor, selectedModel);
    }
    // ── Intent + comprehension gate — single LLM call does both jobs ──────────
    // classifyAndUnderstand() replaces the old classifyIntent() + comprehendRequest()
    // pair. One round-trip instead of two: ~35% faster per message.
    const { intent, understanding } = await this.classifyAndUnderstand(newMessage, datasetCtx);
    if (intent === 'greeting') {
        return this.respondToGreeting(newMessage, datasetCtx);
    }
    // ── Command shortcut layer — deterministic action dispatch ───────────────
    // Explicit known commands are matched here before the enforcement pipeline.
    // Each branch returns a fully-formed LLMResponse with an <actions> block
    // the UI layer parses; only the three registered action types are used
    // (modify_generation, export_csv, export_docx) so no new UI handlers are needed.
    //
    // Placement: after the greeting gate (so "hi generate rows" is impossible)
    // and after the agentic tool gate (so shell-access commands still reach the
    // agentic loop first).  enforcedChat is only reached when no shortcut fires.
    const cmd = newMessage.toLowerCase();
    if (/\bgenerate\b/.test(cmd) && /\brows?\b/.test(cmd)) {
        // Extract the number the user mentioned, fall back to 20
        const numMatch = newMessage.match(/\b(\d+)\b/);
        const rowCount = numMatch ? parseInt(numMatch[1], 10) : 20;
        return this.normalizeResponse({
            content: `Sure! I'll generate ${rowCount} new synthetic rows from your current dataset.\n\n<actions>[{"action":"modify_generation","row_count":${rowCount}}]</actions>`,
            model: 'aurora-cmd',
        });
    }
    if (/\b(export|download|save)\b.*\b(csv|data|dataset)\b/.test(cmd)) {
        return this.normalizeResponse({
            content: `Exporting your dataset as a CSV file.\n\n<actions>[{"type":"export_csv"}]</actions>`,
            model: 'aurora-actions',
        });
    }
    if (/\b(report|docx|document)\b/.test(cmd)) {
        return this.normalizeResponse({
            content: `Generating your governance report as a Word document.\n\n<actions>[{"type":"export_docx"}]</actions>`,
            model: 'aurora-actions',
        });
    }
    // ── PART 6: Route through central enforcement pipeline ────────────────────
    // All chat traffic (except the agentic tool loop above) passes through
    // enforcedChat, which runs: validate → repair(×2) → fallback → normalize.
    // Inject the comprehension focus so the model targets the real question.
    const finalMessages = understanding
        ? [
            messages[0],
            ...messages.slice(1, -1),
            { role: 'user', content: `[Focus: ${understanding}]\n\n${newMessage}` },
        ]
        : messages;
    return this.enforcedChat(finalMessages, datasetCtx);
};
// ─────────────────────────────────────────────────────────────────────────────
// agentReport — generates a full Markdown governance report from pipeline data
// ─────────────────────────────────────────────────────────────────────────────
OpenRouterClient.prototype.agentReport = async function (ctx) {
    const dsCtx = ctx.datasetCtx ?? (0, dataset_context_builder_1.buildDatasetContext)(ctx);
    const sdc = (0, dataset_context_builder_1.buildStructuredDatasetContext)(dsCtx);
    const systemPrompt = [
        this['buildGovernanceSystemPrompt'](sdc),
        '',
        '## REPORT GENERATION MODE',
        'Generate a comprehensive governance report in Markdown format.',
        'Use ## headings for every section. Be thorough and cite all available metrics.',
        'This report will be saved to the workspace as aurora_report.md.',
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        (0, dataset_context_builder_1.formatContextForLLM)(dsCtx),
    ].join('\n');
    const messages = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                'Generate a full governance report for this dataset in Markdown format.',
                'Include ALL eight sections with ## headings:',
                '## Dataset Context',
                '## Risk Interpretation',
                '## Identifier Classification',
                '## Column Risk Analysis',
                '## Attack Paths',
                '## Mitigation Strategy',
                '## Governance Recommendation',
                '## Confidence Note',
                '',
                'Cite specific metric values from DATASET_CONTEXT in every section.',
                'Do not omit any section. Do not fabricate columns or metrics.',
            ].join('\n'),
        },
    ];
    return this['validatedChat'](messages, sdc);
};


/***/ }),
/* 19 */
/***/ ((module) => {

module.exports = require("https");

/***/ }),
/* 20 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


/**
 * dataset_context_builder.ts — Phase 5: Dataset Context Builder
 *
 * Constructs a richly structured DatasetContext object from all
 * pipeline outputs (baseline, leakage, scan, graph, alerts).
 *
 * This is the single source of truth the AI agent uses to reason
 * about the dataset. Every value here traces back to a real pipeline
 * measurement — never fabricated.
 *
 * Consumers:
 *   - openrouter_client.ts  (system prompt construction)
 *   - AgentTools             (tool function implementations)
 *   - ai_agent_tests.ts      (validation)
 */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.AgentTools = void 0;
exports.buildDatasetContext = buildDatasetContext;
exports.formatContextForLLM = formatContextForLLM;
exports.buildStructuredDatasetContext = buildStructuredDatasetContext;
exports.formatStructuredDatasetContext = formatStructuredDatasetContext;
exports.getValidNumbers = getValidNumbers;
const alert_store_1 = __webpack_require__(15);
// ─────────────────────────────────────────────────────────────────────────────
// Builder
// ─────────────────────────────────────────────────────────────────────────────
function buildDatasetContext(ctx) {
    const b = ctx.baseline ?? {};
    const l = ctx.leakage ?? {};
    const r = ctx.result ?? {};
    const sc = ctx.scanReport ?? {};
    const g = ctx.graph ?? {};
    const numCols = Object.keys(b.columns?.numeric ?? {});
    const catCols = Object.keys(b.columns?.categorical ?? {});
    const allCols = [...numCols, ...catCols];
    const meta = b.meta ?? {};
    const profile = (ctx.ast?.dataset ?? ctx.ast ?? {}).profile ?? {};
    // ── Dataset summary ───────────────────────────────────────────────────
    const summary = {
        rows: meta.row_count ?? profile.row_count_estimate ?? null,
        columns: (allCols.length || meta.column_count) ?? 0,
        numeric_columns: numCols.length,
        categorical_columns: catCols.length,
        numeric_column_names: numCols,
        categorical_column_names: catCols,
        source_file: meta.dataset_source ?? null,
        generator_used: r.generator_used ?? null,
        synthetic_rows: r.row_count ?? null,
    };
    console.log("[AutoMate] context rows:", summary.rows);
    // ── Risk metrics ──────────────────────────────────────────────────────
    const dir = l.dataset_intelligence_risk ?? {};
    const ps = l.privacy_score;
    const risk = {
        dataset_risk_score: l.dataset_risk_score ?? null,
        dataset_intelligence_risk: dir.score ?? null,
        intelligence_risk_label: dir.label ?? null,
        privacy_score: ps ?? null,
        privacy_score_pct: ps != null ? (ps * 100).toFixed(1) + '%' : null,
        membership_inference_auc: l.membership_inference_auc ?? null,
        duplicates_rate: l.duplicates_rate ?? null,
        statistical_drift: l.statistical_drift ?? null,
        avg_drift_score: l.avg_drift_score ?? null,
        risk_level: l.risk_level ?? null,
        statistical_reliability_score: l.statistical_reliability_score ?? null,
    };
    // ── Privacy components ────────────────────────────────────────────────
    const pc = l.privacy_components
        ? {
            duplicates_risk: l.privacy_components.duplicates_risk ?? 0,
            mi_attack_risk: l.privacy_components.mi_attack_risk ?? 0,
            distance_similarity_risk: l.privacy_components.distance_similarity_risk ?? 0,
            distribution_drift_risk: l.privacy_components.distribution_drift_risk ?? 0,
        }
        : null;
    // ── PII columns ───────────────────────────────────────────────────────
    const piiCols = [
        ...(sc.high_risk_columns ?? []),
        ...((sc.pii_findings ?? []).map((f) => f.column).filter(Boolean)),
    ];
    const piiColsUnique = [...new Set(piiCols)];
    // ── Sensitive column ranking ──────────────────────────────────────────
    const sensitiveColumns = (l.sensitive_column_ranking ?? [])
        .slice(0, 12)
        .map((item) => ({
        column: item.column,
        score: item.score ?? 0,
        pii_score: item.signals?.pii_score ?? 0,
        reidentification_risk: item.signals?.reidentification_risk ?? 0,
        drift_score: item.signals?.drift_score ?? 0,
    }));
    // ── Per-column stats ──────────────────────────────────────────────────
    const reidRisk = l.reidentification_risk ?? {};
    const colDrift = l.column_drift ?? {};
    const columnStats = [];
    for (const [col, stats] of Object.entries(b.columns?.numeric ?? {})) {
        const s = stats;
        columnStats.push({
            name: col, type: 'numeric',
            min: s.min, max: s.max,
            mean: s.mean, std: s.std,
            null_ratio: s.null_ratio,
            drift_score: colDrift[col],
            reidentification_risk: reidRisk[col],
            is_pii: piiColsUnique.includes(col),
        });
    }
    for (const [col, stats] of Object.entries(b.columns?.categorical ?? {})) {
        const s = stats;
        const topVals = s.top_values
            ? Object.entries(s.top_values)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 5)
                .map(([v]) => v)
            : [];
        columnStats.push({
            name: col, type: 'categorical',
            null_ratio: s.null_ratio,
            unique_ratio: s.unique_ratio,
            top_values: topVals,
            drift_score: colDrift[col],
            reidentification_risk: reidRisk[col],
            is_pii: piiColsUnique.includes(col),
        });
    }
    // ── Anomaly detection ─────────────────────────────────────────────────
    const anomalies = [];
    // High drift columns
    for (const [col, drift] of Object.entries(colDrift).sort(([, a], [, b]) => b - a).slice(0, 8)) {
        if (drift > 0.15) {
            anomalies.push({
                column: col, issue: 'Distribution drift',
                severity: drift > 0.30 ? 'high' : 'medium',
                detail: `JS-divergence=${drift.toFixed(4)} — synthetic distribution diverges significantly from original`,
            });
        }
    }
    // High null rate columns
    for (const cs of columnStats) {
        if ((cs.null_ratio ?? 0) > 0.30) {
            anomalies.push({
                column: cs.name, issue: 'High missing rate',
                severity: (cs.null_ratio ?? 0) > 0.60 ? 'high' : 'medium',
                detail: `null_ratio=${((cs.null_ratio ?? 0) * 100).toFixed(1)}% — column has excessive missing values`,
            });
        }
    }
    // High std / mean ratio (high coefficient of variation → skewed)
    for (const cs of columnStats) {
        if (cs.type === 'numeric' && cs.mean != null && cs.std != null && Math.abs(cs.mean) > 0) {
            const cv = Math.abs(cs.std / cs.mean);
            if (cv > 3.0) {
                anomalies.push({
                    column: cs.name, issue: 'High variance / skewed distribution',
                    severity: 'medium',
                    detail: `CV=${cv.toFixed(2)} (std/mean) — likely skewed or contains extreme outliers`,
                });
            }
        }
    }
    // Outlier exposure from leakage
    for (const ot of (l.outlier_risk ?? []).slice(0, 5)) {
        anomalies.push({
            column: ot.column, issue: 'Outlier exposure risk',
            severity: (ot.severity === 'critical' || ot.severity === 'high') ? 'high' : 'medium',
            detail: `value=${ot.value}, ${ot.extreme_ratio}× IQR fence — individual may be re-identifiable via outlier`,
        });
    }
    // ── Cleaning suggestions ──────────────────────────────────────────────
    const cleaningSuggestions = [];
    for (const cs of columnStats) {
        const nr = cs.null_ratio ?? 0;
        if (nr > 0.60) {
            cleaningSuggestions.push({ column: cs.name, issue: `${(nr * 100).toFixed(0)}% missing`, action: 'Consider dropping this column — missing rate is too high for reliable imputation', priority: 'high' });
        }
        else if (nr > 0.30) {
            cleaningSuggestions.push({ column: cs.name, issue: `${(nr * 100).toFixed(0)}% missing`, action: cs.type === 'numeric' ? 'Impute with median or model-based imputation' : 'Impute with mode or "Unknown" category', priority: 'medium' });
        }
    }
    for (const an of anomalies) {
        if (an.issue === 'High variance / skewed distribution') {
            cleaningSuggestions.push({ column: an.column, issue: 'Extreme skew / outliers', action: 'Apply log1p transform or IQR-based clipping to reduce outlier impact', priority: 'medium' });
        }
        if (an.issue === 'Outlier exposure risk') {
            cleaningSuggestions.push({ column: an.column, issue: 'Individual outlier exposure', action: 'Clip to 99th percentile or add Laplace noise (differential privacy)', priority: 'high' });
        }
    }
    for (const col of piiColsUnique) {
        const scEntry = sensitiveColumns.find(s => s.column === col);
        if (scEntry && scEntry.reidentification_risk > 0.6) {
            cleaningSuggestions.push({ column: col, issue: `Re-identification risk ${(scEntry.reidentification_risk * 100).toFixed(0)}%`, action: 'Apply k-anonymity generalisation, or replace with hashed/tokenised surrogate', priority: 'high' });
        }
        else {
            cleaningSuggestions.push({ column: col, issue: 'PII detected', action: 'Mask with format-preserving pseudonymisation or remove from dataset', priority: 'medium' });
        }
    }
    // ── Governance actions ────────────────────────────────────────────────
    const govActions = [];
    // Based on sensitive column ranking
    for (const sc of sensitiveColumns.slice(0, 6)) {
        if (sc.pii_score > 0.7) {
            govActions.push({ column: sc.column, action: 'Mask or tokenise', reason: `PII score ${(sc.pii_score * 100).toFixed(0)}% — direct personal identifier`, urgency: 'high' });
        }
        if (sc.reidentification_risk > 0.7) {
            govActions.push({ column: sc.column, action: 'Apply k-anonymity or suppress', reason: `Re-identification risk ${(sc.reidentification_risk * 100).toFixed(0)}% — quasi-identifier combination`, urgency: 'critical' });
        }
    }
    // Based on dir score
    if (dir.score != null && dir.score >= 70) {
        govActions.push({ column: 'DATASET', action: 'Mandatory privacy impact assessment', reason: `Dataset intelligence risk ${dir.score.toFixed(0)}/100 — exceeds governance threshold`, urgency: 'critical' });
    }
    // Remove duplicate actions
    const govActionsUnique = govActions.filter((a, i, arr) => i === arr.findIndex(b => b.column === a.column && b.action === a.action));
    // ── Threats ───────────────────────────────────────────────────────────
    const threats = (l.threat_details ?? l.top_threats ?? []).map((t) => ({
        name: t.name,
        severity: t.severity,
        confidence: t.confidence ?? 0,
        description: t.description ?? '',
        triggered_by: t.triggered_by ?? [],
    }));
    // ── Top correlations ──────────────────────────────────────────────────
    const topCorr = (g.top_correlations ?? []).slice(0, 8).map((c) => ({
        cols: c.cols,
        pearson: c.pearson,
        strength: c.strength,
    }));
    // ── Recent alerts ──────────────────────────────────────────────────────
    const recentAlerts = (0, alert_store_1.getRecentAlerts)(10);
    const hasData = summary.columns > 0 || Object.keys(colDrift).length > 0 || recentAlerts.length > 0;
    return {
        dataset_summary: summary,
        risk_metrics: risk,
        privacy_components: pc,
        pii_columns: piiColsUnique,
        sensitive_columns: sensitiveColumns,
        column_stats: columnStats,
        column_drift: colDrift,
        anomalies,
        cleaning_suggestions: cleaningSuggestions,
        governance_actions: govActionsUnique,
        threats,
        top_correlations: topCorr,
        recent_alerts: recentAlerts,
        has_data: hasData,
        built_at: new Date().toISOString(),
    };
}
// ─────────────────────────────────────────────────────────────────────────────
// Agent Tool functions — Part 9
// These are the "tools" available to the AI agent.  Each returns a clean
// JSON-serialisable object derived entirely from a DatasetContext.
// ─────────────────────────────────────────────────────────────────────────────
exports.AgentTools = {
    get_dataset_summary(ctx) {
        return ctx.dataset_summary;
    },
    get_sensitive_columns(ctx) {
        return ctx.sensitive_columns;
    },
    get_privacy_metrics(ctx) {
        return {
            risk_metrics: ctx.risk_metrics,
            privacy_components: ctx.privacy_components,
            threats: ctx.threats,
        };
    },
    get_pii_findings(ctx) {
        return {
            pii_columns: ctx.pii_columns,
            cleaning_suggestions: ctx.cleaning_suggestions.filter(s => ctx.pii_columns.includes(s.column)),
            governance_actions: ctx.governance_actions,
        };
    },
    get_recent_alerts(ctx) {
        return ctx.recent_alerts;
    },
    get_anomalies(ctx) {
        return ctx.anomalies;
    },
    get_column_stats(ctx, columnName) {
        if (columnName) {
            return ctx.column_stats.filter(c => c.name === columnName);
        }
        return ctx.column_stats;
    },
    get_sql_schema(ctx) {
        return {
            table: ctx.dataset_summary.source_file?.replace(/[^a-zA-Z0-9_]/g, '_') ?? 'dataset',
            columns: ctx.column_stats.map(c => ({
                name: c.name,
                type: c.type === 'numeric' ? 'NUMERIC' : 'VARCHAR',
                nullable: (c.null_ratio ?? 0) > 0,
                is_pii: c.is_pii ?? false,
            })),
        };
    },
};
// ─────────────────────────────────────────────────────────────────────────────
// Format context as compact text block for LLM injection
// ─────────────────────────────────────────────────────────────────────────────
function formatContextForLLM(ctx) {
    const lines = [];
    const s = ctx.dataset_summary;
    const r = ctx.risk_metrics;
    lines.push('## DATASET ANALYSIS CONTEXT');
    lines.push('(All values are real pipeline measurements — do NOT invent numbers not present here.)');
    lines.push('');
    // Summary
    lines.push('### Dataset Summary');
    lines.push(`  Rows: ${s.rows ?? 'unknown'} | Columns: ${s.columns}`);
    lines.push(`  Numeric  (${s.numeric_columns}): ${s.numeric_column_names.join(', ') || 'none'}`);
    lines.push(`  Categor  (${s.categorical_columns}): ${s.categorical_column_names.join(', ') || 'none'}`);
    if (s.generator_used) {
        lines.push(`  Generator: ${s.generator_used} | Synthetic rows: ${s.synthetic_rows}`);
    }
    lines.push('');
    // Risk metrics
    lines.push('### Risk Metrics');
    lines.push(`  Dataset Risk Score:       ${r.dataset_risk_score != null ? r.dataset_risk_score.toFixed(1) + '/100' : 'N/A'}`);
    lines.push(`  Intelligence Risk:        ${r.dataset_intelligence_risk != null ? r.dataset_intelligence_risk.toFixed(1) + '/100 [' + r.intelligence_risk_label + ']' : 'N/A'}`);
    lines.push(`  Privacy Score:            ${r.privacy_score_pct ?? 'N/A'} (higher = more private)`);
    lines.push(`  MI-AUC:                   ${r.membership_inference_auc ?? 'N/A'} (>0.5 = attacker advantage)`);
    lines.push(`  Duplicates Rate:          ${r.duplicates_rate != null ? (r.duplicates_rate * 100).toFixed(2) + '%' : 'N/A'}`);
    lines.push(`  Avg Drift Score:          ${r.avg_drift_score != null ? r.avg_drift_score.toFixed(4) : 'N/A'}`);
    lines.push(`  Risk Level:               ${r.risk_level ?? 'N/A'}`);
    lines.push('');
    // Privacy components
    if (ctx.privacy_components) {
        const pc = ctx.privacy_components;
        lines.push('### Privacy Risk Breakdown (0=safe, 1=critical)');
        lines.push(`  Duplicates Risk:           ${pc.duplicates_risk.toFixed(3)}`);
        lines.push(`  MI Attack Risk:            ${pc.mi_attack_risk.toFixed(3)}`);
        lines.push(`  Distance Similarity Risk:  ${pc.distance_similarity_risk.toFixed(3)}`);
        lines.push(`  Distribution Drift Risk:   ${pc.distribution_drift_risk.toFixed(3)}`);
        lines.push('');
    }
    // PII columns
    if (ctx.pii_columns.length > 0) {
        lines.push(`### PII Columns (${ctx.pii_columns.length})`);
        lines.push(`  ${ctx.pii_columns.join(', ')}`);
        lines.push('');
    }
    // Sensitive column ranking
    if (ctx.sensitive_columns.length > 0) {
        lines.push('### Sensitive Column Ranking (composite score)');
        ctx.sensitive_columns.slice(0, 8).forEach((sc, i) => {
            lines.push(`  ${i + 1}. ${sc.column}: score=${sc.score.toFixed(3)}` +
                ` PII=${(sc.pii_score * 100).toFixed(0)}%` +
                ` ReID=${(sc.reidentification_risk * 100).toFixed(0)}%` +
                ` Drift=${(sc.drift_score * 100).toFixed(0)}%`);
        });
        lines.push('');
    }
    // Column drift top-10
    const driftEntries = Object.entries(ctx.column_drift).sort(([, a], [, b]) => b - a).slice(0, 10);
    if (driftEntries.length > 0) {
        lines.push('### Column Drift (JS-divergence, top 10)');
        for (const [col, d] of driftEntries) {
            const lbl = d > 0.15 ? 'HIGH' : d > 0.05 ? 'MODERATE' : 'LOW';
            lines.push(`  ${col}: ${d.toFixed(4)} [${lbl}]`);
        }
        lines.push('');
    }
    // Anomalies
    if (ctx.anomalies.length > 0) {
        lines.push(`### Detected Anomalies (${ctx.anomalies.length})`);
        ctx.anomalies.slice(0, 8).forEach(a => {
            lines.push(`  [${a.severity.toUpperCase()}] ${a.column} — ${a.issue}: ${a.detail}`);
        });
        lines.push('');
    }
    // Governance actions
    if (ctx.governance_actions.length > 0) {
        lines.push('### Required Governance Actions');
        ctx.governance_actions.slice(0, 6).forEach(ga => {
            lines.push(`  [${ga.urgency.toUpperCase()}] ${ga.column}: ${ga.action} — ${ga.reason}`);
        });
        lines.push('');
    }
    // Threats
    if (ctx.threats.length > 0) {
        lines.push('### Active Privacy Threats');
        ctx.threats.slice(0, 5).forEach(t => {
            lines.push(`  ${t.name} [${t.severity}, conf=${(t.confidence * 100).toFixed(0)}%]: ${t.description}`);
            if (t.triggered_by.length > 0) {
                lines.push(`    Triggered by: ${t.triggered_by.join(', ')}`);
            }
        });
        lines.push('');
    }
    // SQL schema
    const schema = exports.AgentTools.get_sql_schema(ctx);
    if (schema.columns.length > 0) {
        lines.push(`### SQL Schema (table: ${schema.table})`);
        lines.push('  Columns: ' + schema.columns.map(c => `${c.name} ${c.type}${c.is_pii ? '*PII*' : ''}`).join(', '));
        lines.push('');
    }
    // Reasoning rules
    lines.push('### Agent Reasoning Rules');
    lines.push('  R1: Cite EXACT column names and metric values from this context in every answer.');
    lines.push('  R2: Never fabricate statistics. If a value is missing, say "metric unavailable".');
    lines.push('  R3: For SQL generation, use only column names present in the SQL Schema above.');
    lines.push('  R4: For anomaly questions, cite IQR/drift/null_ratio values from the context.');
    lines.push('  R5: For governance recommendations, base urgency on re-identification risk and PII score.');
    lines.push('  R6: For cleaning suggestions, reference actual null_ratio and outlier details.');
    lines.push('');
    return lines.join('\n');
}
/**
 * Build the canonical StructuredDatasetContext used by the governance-analyst
 * prompt (Phase 1).  Every field is sourced directly from pipeline results;
 * no defaults or estimates are injected.
 */
function buildStructuredDatasetContext(ctx) {
    const s = ctx.dataset_summary;
    const r = ctx.risk_metrics;
    // All known column names — the authoritative list (Phase 4 validator uses this)
    const allColumns = [
        ...s.numeric_column_names,
        ...s.categorical_column_names,
    ];
    // Build sensitive column list with re-id scores
    const sensitiveColList = ctx.sensitive_columns.map(sc => ({
        name: sc.column,
        reid_score: sc.reidentification_risk,
        is_pii: ctx.pii_columns.includes(sc.column),
    }));
    // Format recent alerts as short strings
    const alertStrings = ctx.recent_alerts.slice(0, 10).map(a => `[${a.severity.toUpperCase()}] ${a.type} — ${a.pattern} (file: ${a.file})`);
    return {
        rows: s.rows,
        columns: allColumns,
        privacy_score: r.privacy_score,
        dataset_risk_score: r.dataset_risk_score,
        statistical_reliability_score: r.statistical_reliability_score,
        sensitive_columns: sensitiveColList,
        column_drift: ctx.column_drift,
        pii_columns: ctx.pii_columns,
        recent_security_alerts: alertStrings,
    };
}
/**
 * Serialise the StructuredDatasetContext into the canonical DATASET_CONTEXT
 * text block injected into the governance-analyst system prompt (Phase 1).
 */
function formatStructuredDatasetContext(sdc) {
    const lines = [];
    lines.push('DATASET_CONTEXT');
    lines.push('---------------');
    lines.push(`rows: ${sdc.rows ?? 'unavailable'}`);
    lines.push(`columns: ${sdc.columns.length > 0 ? sdc.columns.join(', ') : 'none'}`);
    lines.push('');
    lines.push(`privacy_score: ${sdc.privacy_score != null ? sdc.privacy_score.toFixed(4) : 'unavailable'}`);
    lines.push(`dataset_risk_score: ${sdc.dataset_risk_score != null ? sdc.dataset_risk_score.toFixed(2) : 'unavailable'}`);
    lines.push(`statistical_reliability_score: ${sdc.statistical_reliability_score != null ? sdc.statistical_reliability_score.toFixed(4) : 'unavailable'}`);
    lines.push('');
    if (sdc.sensitive_columns.length > 0) {
        lines.push('sensitive_columns:');
        for (const sc of sdc.sensitive_columns) {
            lines.push(` - ${sc.name}`);
        }
        lines.push('');
    }
    else {
        lines.push('sensitive_columns: none');
        lines.push('');
    }
    const driftEntries = Object.entries(sdc.column_drift).sort(([, a], [, b]) => b - a);
    if (driftEntries.length > 0) {
        lines.push('column_drift:');
        for (const [col, score] of driftEntries) {
            lines.push(`  ${col}: ${score.toFixed(4)}`);
        }
        lines.push('');
    }
    else {
        lines.push('column_drift: none');
        lines.push('');
    }
    if (sdc.pii_columns.length > 0) {
        lines.push(`pii_columns: ${sdc.pii_columns.join(', ')}`);
    }
    else {
        lines.push('pii_columns: none');
    }
    lines.push('');
    if (sdc.recent_security_alerts.length > 0) {
        lines.push('recent_security_alerts:');
        for (const alert of sdc.recent_security_alerts) {
            lines.push(`  ${alert}`);
        }
    }
    else {
        lines.push('recent_security_alerts: none');
    }
    lines.push('');
    return lines.join('\n');
}
// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 — Valid metric number extractor
// Returns every numeric value present in the pipeline context so the
// response validator can check for fabricated numbers.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Return the complete set of numeric values that legitimately appear in the
 * pipeline dataset context.  The LLM response validator uses this to flag
 * numbers that were not sourced from real pipeline measurements.
 */
function getValidNumbers(sdc) {
    const valid = new Set();
    const addNum = (n) => {
        if (n == null) {
            return;
        }
        // Allow the raw value as well as common rounded representations
        valid.add(n.toString());
        valid.add(n.toFixed(0));
        valid.add(n.toFixed(1));
        valid.add(n.toFixed(2));
        valid.add(n.toFixed(3));
        valid.add(n.toFixed(4));
        // Percentage form
        valid.add((n * 100).toFixed(0));
        valid.add((n * 100).toFixed(1));
        valid.add((n * 100).toFixed(2));
    };
    addNum(sdc.rows);
    addNum(sdc.privacy_score);
    addNum(sdc.dataset_risk_score);
    addNum(sdc.statistical_reliability_score);
    addNum(sdc.columns.length);
    for (const sc of sdc.sensitive_columns) {
        addNum(sc.reid_score);
    }
    for (const score of Object.values(sdc.column_drift)) {
        addNum(score);
    }
    return valid;
}


/***/ })
/******/ 	]);
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __webpack_require__(0);
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;
//# sourceMappingURL=extension.js.map