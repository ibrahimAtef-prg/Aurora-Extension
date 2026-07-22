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

import * as vscode from 'vscode';
import * as path from 'path';
import { pushAlert, makeAlert, AlertSeverity } from './alert_store';
import { evaluate, evaluateDataset, PolicyAction } from './policy_engine';

// ─────────────────────────────────────────────────────────────────────────────
// Pattern definitions (unchanged from Phase 3)
// ─────────────────────────────────────────────────────────────────────────────

interface SecurityPattern {
    name: string;
    regex: RegExp;
    severity: vscode.DiagnosticSeverity;
    message: string;
    category: 'secret' | 'pii' | 'sensitive';
    alertSeverity: AlertSeverity;
}

const SECURITY_PATTERNS: SecurityPattern[] = [
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

function isDatasetFile(filePath: string): boolean {
    return DATASET_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy notification helper
// ─────────────────────────────────────────────────────────────────────────────

function applyPolicyNotification(action: PolicyAction, message: string): void {
    if (action === 'block') {
        vscode.window.showErrorMessage(`Aurora Security: ${message}`);
    } else if (action === 'warn') {
        vscode.window.showWarningMessage(`Aurora Security: ${message}`);
    }
    // 'log' → silent, stored in alert_store only
}

// ─────────────────────────────────────────────────────────────────────────────
// Core scanner
// ─────────────────────────────────────────────────────────────────────────────

const diagnosticCollection = vscode.languages.createDiagnosticCollection('automate-security');

interface ScanResult {
    diagnostics: vscode.Diagnostic[];
    secretRanges: vscode.Range[];
    piiRanges: vscode.Range[];
    findingCount: number;
}

// Dedup set — prevents re-alerting same (file+line+pattern) on debounce
const _alertedKeys = new Set<string>();

// ─────────────────────────────────────────────────────────────────────────────
// PART 8 — Paths that must never be scanned (false-positive sources)
// ─────────────────────────────────────────────────────────────────────────────

const SCANNER_IGNORE_PATHS: string[] = [
    path.join('.vscode', 'settings.json'),   // VS Code workspace settings
    path.join('.vscode', 'extensions.json'), // Extension recommendations
];

/**
 * Returns true when the document is a VS Code internal file or an extension
 * SecretStorage path — scanning these causes false positives on encrypted blobs
 * or settings that merely *reference* key names (not real keys).
 */
function shouldIgnoreDocument(document: vscode.TextDocument): boolean {
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
    if (
        /\/(?:Code(?:\s-\s\w+)?|Cursor|Windsurf|VSCodium|user-data)\/User\/(?:settings|keybindings)\.json$/i.test(normalised) ||
        /\/User\/(?:settings|keybindings)\.json$/i.test(normalised)
    ) {
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

function scanDocument(
    document: vscode.TextDocument,
    extensionPath?: string
): ScanResult {
    const diagnostics: vscode.Diagnostic[] = [];
    const secretRanges: vscode.Range[] = [];
    const piiRanges: vscode.Range[] = [];

    // PART 8 — skip allowlisted paths to prevent false positives
    if (shouldIgnoreDocument(document)) {
        return { diagnostics, secretRanges, piiRanges, findingCount: 0 };
    }

    if (document.lineCount > 10_000) {
        vscode.window.setStatusBarMessage(
            `Aurora Security: File too large to scan — ${path.basename(document.fileName)} (${document.lineCount.toLocaleString()} lines)`,
            6000
        );
        return { diagnostics, secretRanges, piiRanges, findingCount: 0 };
    }

    const text = document.getText();
    const fileLabel = path.basename(document.fileName);

    for (const pattern of SECURITY_PATTERNS) {
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        let match: RegExpExecArray | null;

        while ((match = regex.exec(text)) !== null) {
            const startPos = document.positionAt(match.index);
            const endPos   = document.positionAt(match.index + match[0].length);
            const range    = new vscode.Range(startPos, endPos);
            const lineNum  = startPos.line + 1;

            // VS Code diagnostic (unchanged behaviour)
            const diagnostic = new vscode.Diagnostic(
                range,
                `[Aurora Security] ${pattern.message}`,
                pattern.severity
            );
            diagnostic.source = 'Aurora';
            diagnostic.code   = pattern.name;
            diagnostics.push(diagnostic);

            if (pattern.category === 'secret') { secretRanges.push(range); }
            else if (pattern.category === 'pii')    { piiRanges.push(range); }

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

                const decision = evaluate(pattern.name, extensionPath);
                const snippet  = match[0].substring(0, 80);

                const alert = makeAlert(
                    pattern.name,
                    decision?.severity ?? pattern.alertSeverity,
                    pattern.category === 'secret' ? 'secret_exposure' : 'pii_detected',
                    fileLabel,
                    pattern.message.replace(/^[⚠ℹ]+\s*/, ''),
                    { line: lineNum, snippet, policyAction: decision?.action as any }
                );
                pushAlert(alert);

                if (decision) {
                    applyPolicyNotification(decision.action, decision.message);
                }
            }
        }
    }

    return { diagnostics, secretRanges, piiRanges, findingCount: diagnostics.length };
}

function updateDecorations(editor: vscode.TextEditor, result: ScanResult): void {
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

async function monitorDatasetFile(
    document: vscode.TextDocument,
    extensionPath?: string
): Promise<void> {
    const fileName = path.basename(document.fileName);
    const ext      = path.extname(document.fileName).toLowerCase();

    // Audit log
    pushAlert(makeAlert(
        'Dataset file opened',
        'low',
        'dataset_risk',
        fileName,
        `${ext.toUpperCase().slice(1)} dataset opened — logged for audit`,
        { policyAction: 'logged' }
    ));

    // Quick heuristic header scan (first 4 KB)
    const sample = document.getText().substring(0, 4096).toLowerCase();
    const matched = PII_HEADER_PATTERNS.filter(p => p.test(sample));
    if (matched.length === 0) { return; }

    const piiDensity = matched.length / PII_HEADER_PATTERNS.length;
    const riskScore  = Math.min(100, matched.length * 8);
    const riskLabel  = riskScore >= 70 ? 'HIGH' : riskScore >= 40 ? 'MODERATE' : 'LOW';
    const topCol     = sample.match(matched[0])?.[0]?.replace(/[^a-z_]/g, '') ?? 'unknown';

    const summaryMsg = `Dataset Risk: ${riskLabel} | PII Signals: ${matched.length} | Top: ${topCol}`;

    pushAlert(makeAlert(
        'Dataset PII signal',
        riskScore >= 70 ? 'high' : 'medium',
        'dataset_risk',
        fileName,
        summaryMsg,
        { policyAction: 'warned' }
    ));

    const decision = evaluateDataset(piiDensity, riskScore, extensionPath);
    if (decision) {
        applyPolicyNotification(decision.action, `${summaryMsg} — ${decision.message}`);
    } else {
        vscode.window.showInformationMessage(
            `📊 Aurora — ${summaryMsg}. Run "Aurora: Scan Dataset for PII" for a full report.`
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API (interface identical to Phase 3 — extension.ts unchanged)
// ─────────────────────────────────────────────────────────────────────────────

let debounceTimer: NodeJS.Timeout | undefined;
let _extensionPath: string | undefined;

export function activateRealtimeScanner(context: vscode.ExtensionContext): void {
    _extensionPath = context.extensionPath;
    _alertedKeys.clear();

    // Scan all currently visible editors (handles files open before activation)
    vscode.window.visibleTextEditors.forEach(editor => {
        const result = scanDocument(editor.document, _extensionPath);
        diagnosticCollection.set(editor.document.uri, result.diagnostics);
        updateDecorations(editor, result);
    });

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (!editor) { return; }
            if (isDatasetFile(editor.document.fileName)) {
                monitorDatasetFile(editor.document, _extensionPath);
            }
            const result = scanDocument(editor.document, _extensionPath);
            diagnosticCollection.set(editor.document.uri, result.diagnostics);
            updateDecorations(editor, result);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            if (debounceTimer) { clearTimeout(debounceTimer); }
            debounceTimer = setTimeout(() => {
                const editor = vscode.window.activeTextEditor;
                if (editor && editor.document === event.document) {
                    const result = scanDocument(editor.document, _extensionPath);
                    diagnosticCollection.set(editor.document.uri, result.diagnostics);
                    updateDecorations(editor, result);
                    const criticals = result.diagnostics.filter(
                        d => d.severity === vscode.DiagnosticSeverity.Error
                    );
                    if (criticals.length > 0) {
                        vscode.window.setStatusBarMessage(
                            `⚠ Aurora: ${criticals.length} security finding(s)`,
                            5000
                        );
                    }
                }
            }, 800);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(document => {
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
                const criticals = result.diagnostics.filter(
                    d => d.severity === vscode.DiagnosticSeverity.Error
                ).length;
                if (criticals > 0) {
                    vscode.window.showWarningMessage(
                        `Aurora Security: ${criticals} critical finding(s) in ${path.basename(document.fileName)}. Review the Problems panel.`
                    );
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(document => {
            if (isDatasetFile(document.fileName)) {
                monitorDatasetFile(document, _extensionPath);
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(document => {
            diagnosticCollection.delete(document.uri);
        })
    );

    context.subscriptions.push(diagnosticCollection);
}

export function deactivateRealtimeScanner(): void {
    diagnosticCollection.clear();
    _alertedKeys.clear();
}
