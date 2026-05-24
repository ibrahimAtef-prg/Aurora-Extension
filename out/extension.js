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
function resolvePythonCommand() {
    const config = vscode.workspace.getConfiguration('idelense');
    const userPath = config.get('pythonPath');
    if (userPath && userPath.trim()) {
        return userPath.trim();
    }
    if (process.platform === 'win32') {
        return 'py';
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
// Active dashboard panel reference (for live theme updates)
let monitorPanel;
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
    // ── Aurora: Switch Theme (Command Palette) ────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('aurora.switchTheme', async () => {
        const choice = await vscode.window.showQuickPick([
            { label: '$(star) Aurora', description: 'Default purple theme', value: 'aurora' },
            { label: '$(color-mode) Dark Theme', description: 'Follows your VS Code theme', value: 'dark' }
        ], { placeHolder: 'Select Aurora theme' });
        if (!choice) {
            return;
        }
        const theme = choice.value;
        context.globalState.update('aurora.theme', theme);
        if (monitorPanel) {
            monitorPanel.webview.postMessage({ command: 'applyTheme', theme });
        }
    }));
    // ── Open Aurora Dashboard directly (standalone, without prior generate) ─
    context.subscriptions.push(vscode.commands.registerCommand('automate.openDashboard', () => {
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
        const trimmed = stdout.trim();
        if (trimmed) {
            try {
                const parsed = JSON.parse(trimmed);
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
                resolve(errorResult(`Invalid JSON from leakage_bridge.py: ${trimmed.slice(0, 120)}`));
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
// Shared report-panel styles (theme-aware)
// ─────────────────────────────────────────────────────────────────────────────
function buildReportStyles(theme) {
    if (theme === 'aurora') {
        return `<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family,sans-serif);font-size:13px;color:#ede5f8;background:#0f0f17;padding:20px}
h2{font-size:15px;margin-bottom:12px;font-weight:600;color:#c084fc}
.card{background:#171723;border:1px solid #2a2a3b;border-radius:10px;padding:16px;margin-bottom:14px}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px}
.stat-box label{font-size:10px;text-transform:uppercase;color:#9080b0;display:block;margin-bottom:2px}
.stat-box span{font-size:18px;font-weight:700}
table{width:100%;border-collapse:collapse;font-size:11px;margin-top:8px}
th{text-align:left;padding:5px 8px;background:#1a1a2e;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#9080b0}
td{padding:5px 8px;border-bottom:1px solid rgba(139,92,246,.08)}
.gen-row{display:flex;align-items:center;gap:10px;margin-bottom:12px}
input[type=number]{background:#1e1e2e;border:1px solid #2a2a3b;color:#ede5f8;border-radius:6px;padding:5px 8px;font-size:13px;width:90px}
button{background:linear-gradient(135deg,#7c3aed,#9333ea);color:#fff;border:none;border-radius:6px;padding:6px 16px;font-size:13px;cursor:pointer;font-weight:500}
button:hover{opacity:.85}
#status{font-size:12px;color:#9080b0;margin-top:8px}
</style>`;
    }
    // 'dark' — follows VS Code active theme
    return `<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family,sans-serif);font-size:13px;
  color:var(--vscode-editor-foreground,#ede5f8);
  background:var(--vscode-editor-background,#0f0f17);padding:20px}
h2{font-size:15px;margin-bottom:12px;font-weight:600;color:var(--vscode-textLink-foreground,#c084fc)}
.card{background:var(--vscode-sideBar-background,#171723);
  border:1px solid var(--vscode-panel-border,#2a2a3b);
  border-radius:10px;padding:16px;margin-bottom:14px}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px}
.stat-box label{font-size:10px;text-transform:uppercase;
  color:var(--vscode-descriptionForeground,#9080b0);display:block;margin-bottom:2px}
.stat-box span{font-size:18px;font-weight:700}
table{width:100%;border-collapse:collapse;font-size:11px;margin-top:8px}
th{text-align:left;padding:5px 8px;
  background:var(--vscode-editorWidget-background,#1a1a2e);
  font-size:10px;text-transform:uppercase;letter-spacing:.05em;
  color:var(--vscode-descriptionForeground,#9080b0)}
td{padding:5px 8px;border-bottom:1px solid rgba(139,92,246,.08)}
.gen-row{display:flex;align-items:center;gap:10px;margin-bottom:12px}
input[type=number]{background:var(--vscode-input-background,#1e1e2e);
  border:1px solid var(--vscode-input-border,#2a2a3b);
  color:var(--vscode-input-foreground,#ede5f8);
  border-radius:6px;padding:5px 8px;font-size:13px;width:90px}
button{background:linear-gradient(135deg,#7c3aed,#9333ea);color:#fff;
  border:none;border-radius:6px;padding:6px 16px;font-size:13px;cursor:pointer;font-weight:500}
button:hover{opacity:.85}
#status{font-size:12px;color:var(--vscode-descriptionForeground,#9080b0);margin-top:8px}
</style>`;
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
    const theme = context.globalState.get('aurora.theme', 'aurora');
    panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
${buildReportStyles(theme)}</head><body>
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
    const theme = context.globalState.get('aurora.theme', 'aurora');
    panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
${buildReportStyles(theme)}</head><body>
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
    const panel = vscode.window.createWebviewPanel("idelenseCombined", "Aurora — Parse + Baseline", vscode.ViewColumn.Beside, { enableScripts: true });
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
    const theme = context.globalState.get('aurora.theme', 'aurora');
    panel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
${buildReportStyles(theme)}</head><body>
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
    const chartUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chart.min.js'));
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
    // ── Theme: read saved preference, default to 'aurora' ──────────────────────────
    const savedTheme = context.globalState.get('aurora.theme', 'aurora');
    panel.webview.html = (0, monitorPanel_1.buildMonitorHtml)(dashboardData, savedTheme);
    monitorPanel = panel;
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
        monitorPanel = undefined;
    }, null, context.subscriptions);
    // VS Code re-injects its CSS vars automatically on theme change.
    // We only need to notify the webview so it can re-read computed CSS vars
    // for JS-driven colors (e.g. Chart.js datasets).
    vscode.window.onDidChangeActiveColorTheme(() => {
        panel.webview.postMessage({ command: 'themeChanged' });
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
//# sourceMappingURL=extension.js.map