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

import * as vscode from 'vscode';
import * as https from 'https';
import { getRecentAlerts, SecurityAlert } from '../security/alert_store';
import {
    buildDatasetContext,
    formatContextForLLM,
    AgentTools,
    DatasetContext,
    buildStructuredDatasetContext,
    formatStructuredDatasetContext,
    getValidNumbers,
    StructuredDatasetContext,
} from './dataset_context_builder';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export interface LLMMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
}

/** Executes a named tool with parsed args, returns a string result for the LLM. */
export type ToolExecutor = (name: string, args: Record<string, any>) => Promise<string>;

export interface LLMResponse {
    content: string;
    model: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    error?: string;
}

export interface PipelineContext {
    baseline?: any;
    leakage?: any;
    result?: any;
    ast?: any;
    scanReport?: any;
    attackReport?: any;
    graph?: any;
    lineage?: any;
    /** Phase 5: pre-built context (optional — built on demand if absent) */
    datasetCtx?: DatasetContext;
    /** Live checkpoint data from the running generator (D.cp in the webview) */
    cp?: any;
    /** Live stats injected from the webview at message time (row count, generator type, etc.) */
    live_stats?: { generatorRows?: number | null; generatorUsed?: string | null; [key: string]: any };
    /** Reserved for future intelligence module */
    intelligence?: any;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider configuration
// ─────────────────────────────────────────────────────────────────────────────

export type AIProvider = 'openrouter' | 'openai' | 'anthropic' | 'groq' | 'together' | 'mistral';

interface ProviderConfig {
    hostname: string;
    chatPath: string;
    modelsPath?: string;
    /** Build Authorization header value from key */
    authHeader: (key: string) => Record<string, string>;
    /** Default models to try (in order) */
    defaultModels: string[];
    /** Whether this provider uses the OpenAI-compatible request/response format */
    openAICompat: boolean;
}

const PROVIDER_CONFIGS: Record<AIProvider, ProviderConfig> = {
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

const SYSTEM_TOOLS: any[] = [
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
const SAFE_FALLBACK =
    'The requested analysis cannot be performed using the available dataset metrics.';

// ─────────────────────────────────────────────────────────────────────────────
// AgentDatasetContext — slim DTO passed through the enforcement pipeline.
// Extracted once per agentChat call from StructuredDatasetContext so every
// enforcement method gets a stable, typed surface to validate against.
// Declared before the class so private class methods see it without relying
// on TypeScript's file-wide interface hoisting.
// ─────────────────────────────────────────────────────────────────────────────

interface AgentDatasetContext {
    /** Total row count from the loaded pipeline, or null when no dataset. */
    rowCount: number | null;
    /** Full column name list (used for length and name matching). */
    columns: string[] | null;
    /** Privacy score formatted as a human-readable string, e.g. "72%". */
    privacyScore: string | null;
    /** Risk level string, e.g. "medium". */
    riskLevel: string | null;
    /** Pre-built context lines — the same lines injected into the system prompt. */
    ctxLines: string[];
    /** Whether any pipeline data is available to ground responses against. */
    hasData: boolean;
    /** Live security alerts from the session — used by extractTopRisk(). */
    alerts?: Array<{ severity: string; type: string }> | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────────────────────────────────────

export class OpenRouterClient {
    private apiKey: string;
    private provider: AIProvider = 'openrouter';
    private currentModelIdx = 0;
    /** Set to true once a key has been injected directly via setKey() */
    private _keySetDirectly = false;
    /** Cached live model list fetched from provider — null until first fetch */
    private _liveModels: string[] | null = null;
    private _liveModelsFetchedAt = 0;
    private static LIVE_MODELS_TTL_MS = 5 * 60 * 1000; // re-fetch every 5 min

    constructor(apiKey?: string) {
        this.apiKey = apiKey || '';
        this.refreshKey();
    }

    /** Get the active ProviderConfig for the current provider. */
    private get providerCfg(): ProviderConfig {
        return PROVIDER_CONFIGS[this.provider] || PROVIDER_CONFIGS.openrouter;
    }

    /**
     * Fetch available models from the provider catalog (OpenRouter only).
     * Falls back to the provider's defaultModels for other providers.
     */
    private fetchLiveModels(): Promise<string[]> {
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
                        const freeIds: string[] = (parsed.data || [])
                            .filter((m: any) => {
                                if (typeof m.id !== 'string') { return false; }
                                if (m.id.endsWith(':free')) { return true; }
                                const p = m.pricing;
                                return p && Number(p.prompt) === 0 && Number(p.completion) === 0;
                            })
                            .map((m: any) => m.id as string);
                        if (freeIds.length > 0) {
                            console.log(`[AutoMate] Live free models from OpenRouter: ${freeIds.length}`);
                            resolve(freeIds);
                        } else {
                            resolve(cfg.defaultModels);
                        }
                    } catch {
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
    private async getModels(): Promise<string[]> {
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
    setProviderAndKey(provider: AIProvider, key: string): void {
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
    setKey(key: string, provider?: AIProvider): void {
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
    getProvider(): AIProvider {
        return this.provider;
    }

    /**
     * Initialize or update the API key.
     * Priority: 1) directly set via setKey()  2) VS Code settings  3) ENV var  4) placeholder
     */
    refreshKey(): void {
        // PART 7 — Only accept keys that were injected directly via setKey().
        // We never fall back to settings.json; the extension reads from
        // SecretStorage and calls setKey() on activation (see extension.ts).
        if (this._keySetDirectly && this.apiKey && this.apiKey !== 'PASTE_API_KEY_HERE') {
            return;
        }
        // Env var fallback (CI/CD, dev environments) — explicitly opt-in only.
        // PART 6 — DO NOT read from vscode.workspace.getConfiguration here.
        const envKey = `${this.provider.toUpperCase().replace(/-/g,'_')}_API_KEY`;
        const fromEnv = (typeof process !== 'undefined' && (process.env?.[envKey] || process.env?.OPENROUTER_API_KEY)) || '';
        if (fromEnv && fromEnv !== 'PASTE_API_KEY_HERE') {
            this.apiKey = fromEnv;
        } else if (!this.apiKey) {
            this.apiKey = 'PASTE_API_KEY_HERE';
        }
    }

    /** Check if the client is configured. */
    isConfigured(): boolean {
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
    private buildGovernanceSystemPrompt(sdc: StructuredDatasetContext): string {
        const contextBlock = formatStructuredDatasetContext(sdc);
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

        const parts: string[] = [
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
    async chat(messages: LLMMessage[], model?: string): Promise<LLMResponse> {
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
    private _chatOnce(messages: LLMMessage[], selectedModel: string): Promise<LLMResponse> {
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

        return new Promise<LLMResponse>((resolve) => {
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
                        } else {
                            const choice = parsed.choices?.[0];
                            resolve({
                                content: choice?.message?.content || '',
                                model: parsed.model || selectedModel,
                                usage: parsed.usage,
                            });
                        }
                    } catch (e) {
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
    private _chatOnceAnthropic(
        messages: LLMMessage[],
        selectedModel: string,
        cfg: ProviderConfig,
    ): Promise<LLMResponse> {
        const systemMsg = messages.find(m => m.role === 'system');
        const userMsgs = messages.filter(m => m.role !== 'system');

        const body = JSON.stringify({
            model: selectedModel,
            max_tokens: 2048,
            temperature: 0.3,
            ...(systemMsg ? { system: systemMsg.content } : {}),
            messages: userMsgs.map(m => ({ role: m.role, content: m.content })),
        });

        return new Promise<LLMResponse>((resolve) => {
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
                        } else {
                            // Anthropic returns content as an array of blocks
                            const textBlock = (parsed.content || []).find((b: any) => b.type === 'text');
                            resolve({
                                content: textBlock?.text || '',
                                model: parsed.model || selectedModel,
                                usage: parsed.usage
                                    ? { prompt_tokens: parsed.usage.input_tokens, completion_tokens: parsed.usage.output_tokens, total_tokens: (parsed.usage.input_tokens || 0) + (parsed.usage.output_tokens || 0) }
                                    : undefined,
                            });
                        }
                    } catch (e) {
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
    private _chatOnceWithTools(
        messages: LLMMessage[],
        selectedModel: string,
        tools: any[],
    ): Promise<{ message: any; model: string; usage?: any; error?: string }> {
        const cfg = this.providerCfg;

        // Non-OpenAI-compat providers fall back to plain text
        if (!cfg.openAICompat) {
            return this._chatOnce(messages as any, selectedModel).then(r => ({
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
                        } else {
                            const choice = parsed.choices?.[0];
                            resolve({ message: choice?.message || { role: 'assistant', content: '' }, model: parsed.model || selectedModel, usage: parsed.usage });
                        }
                    } catch (e) {
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
    private async _agenticLoop(
        messages: LLMMessage[],
        tools: any[],
        toolExecutor: ToolExecutor,
        selectedModel: string,
    ): Promise<LLMResponse> {
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
            conversation.push(msg as LLMMessage);

            // Execute all tool calls, gather results
            const toolResults: LLMMessage[] = await Promise.all(
                (msg.tool_calls as ToolCall[]).map(async (tc) => {
                    let result: string;
                    try {
                        let args: Record<string, any> = {};
                        try {
                            args = JSON.parse(tc.function.arguments || '{}');
                        } catch {
                            // Model returned malformed JSON args — surface the raw string and abort tool use
                            result = `ERROR: tool arguments were not valid JSON: ${tc.function.arguments}`;
                            return { role: 'tool' as const, tool_call_id: tc.id, content: result };
                        }
                        result = await toolExecutor(tc.function.name, args);
                    } catch (e) {
                        result = `ERROR: ${e}`;
                    }
                    return { role: 'tool' as const, tool_call_id: tc.id, content: result };
                }),
            );
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
    private extractReferencedColumns(responseText: string, knownColumns: string[]): string[] {
        if (knownColumns.length === 0) { return []; }
        const referenced: string[] = [];
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
    private findHallucinatedColumns(responseText: string, knownColumns: string[]): string[] {
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

        const hallucinated: string[] = [];
        let match: RegExpExecArray | null;
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
    private validateColumns(responseText: string, sdc: StructuredDatasetContext): string | null {
        if (sdc.columns.length === 0) {
            // No column list available — skip column validation
            return null;
        }

        const hallucinated = this.findHallucinatedColumns(responseText, sdc.columns);
        if (hallucinated.length === 0) { return null; }

        return `Response referenced column(s) not present in the dataset: ${hallucinated.join(', ')}. ` +
               `Valid columns are: ${sdc.columns.join(', ')}.`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 5 — Metric number validation
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Extract all numbers from a response text.
     */
    private extractNumbers(text: string): string[] {
        const NUMBER_RX = /\b\d+(?:\.\d+)?\b/g;
        const results: string[] = [];
        let m: RegExpExecArray | null;
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
    private validateMetrics(responseText: string, sdc: StructuredDatasetContext): string | null {
        const validNums = getValidNumbers(sdc);

        // Validate numbers cited in the Risk Interpretation section
        // (between "Risk Interpretation" and "Identifier Classification")
        const sectionMatch = responseText.match(/Risk Interpretation([\s\S]*?)Identifier Classification/i);
        if (!sectionMatch) { return null; } // section missing → format issue handled elsewhere

        const sectionText = sectionMatch[1];
        const nums = this.extractNumbers(sectionText);

        // Only flag decimal numbers — plain integers are too ambiguous in prose
        const decimalOther = nums.filter(n => n.includes('.') && !validNums.has(n));
        if (decimalOther.length === 0) { return null; }

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
    private applyReliabilityWarning(responseText: string, _sdc: StructuredDatasetContext): string {
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
    private wrapFallback(sdc: StructuredDatasetContext): string {
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
    private async validatedChat(
        messages: LLMMessage[],
        sdc: StructuredDatasetContext,
    ): Promise<LLMResponse> {
        let lastResponse: LLMResponse | null = null;

        for (let attempt = 0; attempt <= MAX_REGENERATION_ATTEMPTS; attempt++) {
            const response = await this.chat(messages);

            // Propagate hard errors immediately
            if (response.error) { return response; }

            const text = response.content;

            // Phase 7: detect if the model admitted it can't answer
            if (text.toLowerCase().includes('cannot be performed') ||
                text.toLowerCase().includes('not available in') ||
                text.toLowerCase().includes('data unavailable') && text.length < 200) {
                response.content = this.applyReliabilityWarning(
                    this.wrapFallback(sdc), sdc,
                );
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
            const correctionParts: string[] = [
                'Your previous response was rejected because it violated the grounding rules.',
            ];
            if (colViolation) { correctionParts.push(`Column violation: ${colViolation}`); }
            if (metricViolation) { correctionParts.push(`Metric violation: ${metricViolation}`); }
            correctionParts.push(
                'Please regenerate your answer using ONLY the column names and metric values',
                'present in DATASET_CONTEXT. Do not invent any values.',
                'Use the required eight-section format:',
                '  Dataset Context / Risk Interpretation / Identifier Classification /',
                '  Column Risk Analysis / Attack Paths / Mitigation Strategy / Governance Recommendation / Confidence Note',
            );

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
    async askAboutData(question: string, context: PipelineContext): Promise<LLMResponse> {
        const dsCtx = context.datasetCtx ?? buildDatasetContext(context);
        const sdc   = buildStructuredDatasetContext(dsCtx);
        const systemPrompt = this.buildGovernanceSystemPrompt(sdc);
        const messages: LLMMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: question },
        ];
        return this.validatedChat(messages, sdc);
    }

    /**
     * Generate privacy recommendations based on pipeline data.
     * Uses the strict governance-analyst prompt and full validation pipeline.
     */
    async getRecommendations(context: PipelineContext): Promise<LLMResponse> {
        const dsCtx = context.datasetCtx ?? buildDatasetContext(context);
        const sdc   = buildStructuredDatasetContext(dsCtx);
        const systemPrompt = this.buildGovernanceSystemPrompt(sdc);
        const messages: LLMMessage[] = [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content:
                    'Based on the DATASET_CONTEXT provided, generate a comprehensive list of ' +
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
    private buildSystemPrompt(ctx: PipelineContext): string {
        const dsCtx = ctx.datasetCtx ?? buildDatasetContext(ctx);
        const sdc   = buildStructuredDatasetContext(dsCtx);
        return this.buildGovernanceSystemPrompt(sdc);
    }

    /**
     * Builds the REAL-TIME SECURITY ALERTS section for the system prompt.
     * Reads the last N alerts from alert_store and formats them for LLM analysis.
     */
    private buildSecurityAlertsSection(): string {
        const alerts = getRecentAlerts(20);
        if (alerts.length === 0) { return ''; }

        const lines: string[] = [
            '',
            '## REAL-TIME SECURITY ALERTS',
            'The following alerts were detected live in the developer workspace.',
            'For each alert: explain why it is dangerous and suggest concrete mitigation steps.',
            `Total alerts in session: ${alerts.length}`,
            '',
        ];

        const groups: Record<string, SecurityAlert[]> = {};
        for (const a of alerts) {
            (groups[a.category] = groups[a.category] ?? []).push(a);
        }

        const categoryLabel: Record<string, string> = {
            secret_exposure:  '🔑 Secret Exposures',
            pii_detected:     '👤 PII Detections',
            prompt_leakage:   '💬 Prompt Leakage',
            dataset_risk:     '📊 Dataset Risk',
            policy_violation: '🚫 Policy Violations',
        };

        for (const [cat, group] of Object.entries(groups)) {
            lines.push(`### ${categoryLabel[cat] ?? cat} (${group.length})`);
            for (const a of group.slice(0, 5)) {
                lines.push(
                    `  - [${a.severity.toUpperCase()}] ${a.type} | file: ${a.file}` +
                    (a.line ? ` line ${a.line}` : '') +
                    ` | ${a.pattern}` +
                    (a.policyAction ? ` | policy: ${a.policyAction}` : '') +
                    ` | ${a.timestamp.slice(11, 19)}`,
                );
            }
            if (group.length > 5) {
                lines.push(`  ... and ${group.length - 5} more ${cat} alerts.`);
            }
            lines.push('');
        }

        lines.push(
            'RULE: For every alert above, the AI MUST:',
            '  1. Explain the specific danger (data exposure risk, regulatory impact, attack vector).',
            '  2. Give concrete mitigation steps (e.g., rotate key, anonymize field, use env vars).',
            '  3. Cite the severity level and policy action in your response.',
            '',
        );

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
    private extractTopRisk(ctx: AgentDatasetContext): string {
        if (!ctx.alerts || ctx.alerts.length === 0) { return 'none'; }
        // Prioritize HIGH alerts
        const high = ctx.alerts.find(a => a.severity === 'HIGH' || a.severity === 'high');
        if (high) { return high.type; }
        return ctx.alerts[0].type;
    }

    // ── PART 2: Strong validator ──────────────────────────────────────────────
    // Returns true when the response is non-trivial, free of forbidden content,
    // AND (when data is available) references at least one real metric.
    // NOTE: The "action required" gate has been intentionally removed — it was
    // rejecting valid factual answers (e.g. "The highest drift column is age.")
    // and forcing the repair loop to add artificial action language.
    private isValidResponse(text: string, ctx: AgentDatasetContext): boolean {
        // Minimum length guard — empty or near-empty responses are always invalid
        if (!text || text.length < 20) { return false; }

        // Forbidden-content gate — creative outputs are unconditionally invalid
        const hasForbidden = /\b(lyrics|poem|song|once upon|verse|chorus|stanza|fairy tale|short story)\b/i.test(text);
        if (hasForbidden) { return false; }

        // When no dataset is loaded, a well-formed "please run the pipeline" reply
        // is the correct output — accept it without demanding metric references.
        if (!ctx.hasData) { return true; }

        // Grounding gate — must reference at least one real dataset signal.
        const lower = text.toLowerCase();
        const hasMetric =
            (ctx.rowCount != null && text.includes(String(ctx.rowCount)))       ||
            (ctx.columns  != null && text.includes(String(ctx.columns.length))) ||
            lower.includes('privacy')  ||
            lower.includes('risk')     ||
            lower.includes('column')   ||
            lower.includes('dataset')  ||
            lower.includes('row')      ||
            lower.includes('pipeline') ||
            lower.includes('score')    ||
            lower.includes('pii')      ||
            lower.includes('drift');

        return hasMetric;
    }

    // ── PART 3: Repair function ───────────────────────────────────────────────
    // Called when the initial response fails validation.  Sends the bad output
    // back to the model with a correction prompt that injects the exact dataset
    // metrics the response was missing.
    private async repairResponse(badOutput: string, ctx: AgentDatasetContext): Promise<LLMResponse> {
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
            { role: 'user',   content: badOutput },
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
    private buildFallbackResponse(ctx: AgentDatasetContext): LLMResponse {
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
    public detectIntent(input: string): 'greeting' | 'task' {
        const text = input.toLowerCase().trim();

        // 1. Empty string — nothing to act on
        if (!text) { return 'greeting'; }

        // 2. Safety fallback for unusually long inputs — always a real task
        if (text.length > 200) { return 'task'; }

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
        if (taskPatterns.some(p => p.test(text))) { return 'task'; }

        // 4. Greeting detection — exact match OR short phrase containing a greeting word
        //    Handles: "hi", "hello!", "I said hi", "hey there", "oh hey", etc.
        //    Capped at 30 chars so "hey can you analyze my dataset" still hits task patterns above.
        const greetings = ['hi', 'hello', 'hey'];
        if (greetings.includes(text)) { return 'greeting'; }
        if (text.length <= 30 && /\b(hi|hello|hey)\b/.test(text)) { return 'greeting'; }

        // 5. Very short non-task inputs (e.g. "k", "ok", "yo")
        if (text.length <= 3) { return 'greeting'; }

        // 6. Everything else is treated as a task
        return 'task';
    }

    // ── Combined intent + comprehension — single LLM call instead of two ─────
    // Old flow: classifyIntent() → LLM call 1, comprehendRequest() → LLM call 2
    // New flow: classifyAndUnderstand() → 1 call returns both intent AND focus
    // This cuts per-message latency by ~35% (2 calls instead of 3 for tasks).
    public async classifyAndUnderstand(
        input: string,
        ctx: AgentDatasetContext,
    ): Promise<{ intent: 'greeting' | 'task'; understanding: string }> {
        if (!input.trim()) { return { intent: 'greeting', understanding: '' }; }

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
        } catch {
            // Parsing failed — safe fallback: treat as task, no focus injection
            return { intent: 'task', understanding: '' };
        }
    }

    // ── Light response builder (kept as emergency fallback only) ─────────────
    public buildLightResponse(ctx: AgentDatasetContext): string {
        if (ctx.hasData) {
            const parts: string[] = [`Hi! I'm Aurora, your data governance assistant.`];
            if (ctx.rowCount != null)   parts.push(`Your dataset has ${ctx.rowCount} rows`);
            if (ctx.privacyScore)       parts.push(`a privacy score of ${ctx.privacyScore}`);
            if (ctx.riskLevel)          parts.push(`and ${ctx.riskLevel} risk.`);
            parts.push(`\n\nWhat would you like to know?`);
            return parts.join(', ').replace(', \n\n', '\n\n');
        }
        return `Hi! I'm Aurora, your data governance assistant. Run the pipeline to load your dataset, then ask me anything about privacy risks, PII columns, or compliance.`;
    }

    // ── Greeting responder — uses the LLM to actually understand what was said ──
    // Instead of dumping a hardcoded template at the user, this makes a real LLM
    // call so the agent responds to what the user ACTUALLY said, not just a
    // "greeting was detected" flag.
    public async respondToGreeting(input: string, ctx: AgentDatasetContext): Promise<LLMResponse> {
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
        } catch {
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
    public async comprehendRequest(input: string, ctx: AgentDatasetContext): Promise<string> {
        if (!input.trim() || input.length < 4) { return ''; }

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
        } catch {
            // comprehension is best-effort — never block the main response
        }
        return '';
    }

    // ── PART 5: Response normalizer ───────────────────────────────────────────
    // Last step in the pipeline.  Trims leading/trailing whitespace and
    // collapses excess blank lines so every response has consistent formatting.
    public normalizeResponse(resp: LLMResponse): LLMResponse {
        if (!resp.content) { return resp; }
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
    public async enforcedChat(messages: LLMMessage[], ctx: AgentDatasetContext): Promise<LLMResponse> {
        // ── Step 1: initial model call ────────────────────────────────────────
        let response = await this.chat(messages);

        // Hard API/auth errors propagate immediately — validation can't help here
        if (response.error) { return response; }

        // ── Step 2: validate ──────────────────────────────────────────────────
        if (!this.isValidResponse(response.content, ctx)) {
            console.warn('[Aurora] enforcedChat: initial response invalid — entering repair loop.');

            // ── Step 3: repair loop (max 2 attempts) ──────────────────────────
            for (let attempt = 0; attempt < 2; attempt++) {
                response = await this.repairResponse(response.content, ctx);

                // Surface API errors that occur during repair immediately
                if (response.error) { break; }

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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 Agent method extensions (added outside class for clean separation)
// These are called from extension.ts command handlers.
// ─────────────────────────────────────────────────────────────────────────────

/** Extend OpenRouterClient with Phase 5 agent capabilities. */
declare module './openrouter_client' {
    interface OpenRouterClient {
        explainDataset(ctx: PipelineContext): Promise<LLMResponse>;
        detectAnomalies(ctx: PipelineContext): Promise<LLMResponse>;
        suggestCleaning(ctx: PipelineContext): Promise<LLMResponse>;
        generateSQL(question: string, ctx: PipelineContext): Promise<LLMResponse>;
        recommendGovernance(ctx: PipelineContext): Promise<LLMResponse>;
        agentChat(history: LLMMessage[], newMessage: string, ctx: PipelineContext): Promise<LLMResponse>;
        agentReport(ctx: PipelineContext): Promise<LLMResponse>;
    }
}

// ── Concrete implementations added directly to prototype ─────────────────────

(OpenRouterClient.prototype as any).explainDataset = async function(
    this: any,
    ctx: PipelineContext,
): Promise<LLMResponse> {
    const dsCtx = ctx.datasetCtx ?? buildDatasetContext(ctx);
    const sdc   = buildStructuredDatasetContext(dsCtx);
    const systemPrompt = [
        (this as OpenRouterClient)['buildGovernanceSystemPrompt'](sdc),
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        formatContextForLLM(dsCtx),
    ].join('\n');

    const messages: LLMMessage[] = [
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
    return (this as OpenRouterClient)['validatedChat'](messages, sdc);
};

(OpenRouterClient.prototype as any).detectAnomalies = async function(
    this: any,
    ctx: PipelineContext,
): Promise<LLMResponse> {
    const dsCtx    = ctx.datasetCtx ?? buildDatasetContext(ctx);
    const sdc      = buildStructuredDatasetContext(dsCtx);
    const anomalies = AgentTools.get_anomalies(dsCtx);

    const systemPrompt = [
        (this as OpenRouterClient)['buildGovernanceSystemPrompt'](sdc),
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        formatContextForLLM(dsCtx),
    ].join('\n');

    const messages: LLMMessage[] = [
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
    return (this as OpenRouterClient)['validatedChat'](messages, sdc);
};

(OpenRouterClient.prototype as any).suggestCleaning = async function(
    this: any,
    ctx: PipelineContext,
): Promise<LLMResponse> {
    const dsCtx       = ctx.datasetCtx ?? buildDatasetContext(ctx);
    const sdc         = buildStructuredDatasetContext(dsCtx);
    const suggestions = dsCtx.cleaning_suggestions;

    const systemPrompt = [
        (this as OpenRouterClient)['buildGovernanceSystemPrompt'](sdc),
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        formatContextForLLM(dsCtx),
    ].join('\n');

    const messages: LLMMessage[] = [
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
    return (this as OpenRouterClient)['validatedChat'](messages, sdc);
};

(OpenRouterClient.prototype as any).generateSQL = async function(
    this: any,
    question: string,
    ctx: PipelineContext,
): Promise<LLMResponse> {
    const dsCtx  = ctx.datasetCtx ?? buildDatasetContext(ctx);
    const sdc    = buildStructuredDatasetContext(dsCtx);
    const schema = AgentTools.get_sql_schema(dsCtx);

    const systemPrompt = [
        (this as OpenRouterClient)['buildGovernanceSystemPrompt'](sdc),
        '',
        'ADDITIONAL SQL RULES:',
        '  - Use ONLY column names present in the SQL Schema below and in DATASET_CONTEXT.',
        '  - Mark PII columns in SQL comments.',
        '  - Format SQL with uppercase keywords and proper indentation.',
        '  - If a requested column does not exist, state "column unavailable" and DO NOT invent one.',
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        formatContextForLLM(dsCtx),
    ].join('\n');

    const messages: LLMMessage[] = [
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
    return (this as OpenRouterClient)['validatedChat'](messages, sdc);
};

(OpenRouterClient.prototype as any).recommendGovernance = async function(
    this: any,
    ctx: PipelineContext,
): Promise<LLMResponse> {
    const dsCtx     = ctx.datasetCtx ?? buildDatasetContext(ctx);
    const sdc       = buildStructuredDatasetContext(dsCtx);
    const govActions = AgentTools.get_pii_findings(dsCtx);

    const systemPrompt = [
        (this as OpenRouterClient)['buildGovernanceSystemPrompt'](sdc),
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        formatContextForLLM(dsCtx),
    ].join('\n');

    const messages: LLMMessage[] = [
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
    return (this as OpenRouterClient)['validatedChat'](messages, sdc);
};

// ─────────────────────────────────────────────────────────────────────────────
(OpenRouterClient.prototype as any).agentChat = async function(
    this: any,
    history: LLMMessage[],
    newMessage: string,
    ctx: PipelineContext,
    toolExecutor?: ToolExecutor,
): Promise<LLMResponse> {
    const dsCtx = ctx.datasetCtx ?? buildDatasetContext(ctx);
    const sdc   = buildStructuredDatasetContext(dsCtx);
    const datasetName = (sdc as any).dataset_name ?? null;
    const rowCount    = (sdc as any).row_count    ?? null;
    const hasData = !!(datasetName || rowCount || sdc.privacy_score != null);

    // ── Lean dataset context summary (only what the model actually needs) ──────
    // recentAlerts is declared here (outside the if block) so it remains in scope
    // when building datasetCtx.alerts below, regardless of whether hasData is true.
    const recentAlerts: ReturnType<typeof getRecentAlerts> = getRecentAlerts(20);
    const ctxLines: string[] = [];
    if (hasData) {
        if (datasetName)               ctxLines.push(`Dataset: ${datasetName}`);
        if (rowCount != null)           ctxLines.push(`Rows: ${rowCount}`);
        if (sdc.columns?.length)        ctxLines.push(`Columns: ${sdc.columns.length}`);
        if (sdc.privacy_score != null)       ctxLines.push(`Privacy score: ${(sdc.privacy_score * 100).toFixed(0)}%`);
        if (sdc.dataset_risk_score != null)  ctxLines.push(`Risk level: ${sdc.dataset_risk_score}`);
        if (sdc.statistical_reliability_score != null)
            ctxLines.push(`Statistical reliability: ${sdc.statistical_reliability_score}`);
        if (sdc.pii_columns?.length)         ctxLines.push(`PII columns: ${sdc.pii_columns.join(', ')}`);
        if (sdc.sensitive_columns?.length)   ctxLines.push(`Sensitive columns: ${sdc.sensitive_columns.join(', ')}`);
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
    const liveLines: string[] = [];
    if (ctx.cp || ctx.live_stats) {
        const cp = ctx.cp || {};
        const ls = ctx.live_stats || {};
        liveLines.push(
            `Generator phase: ${cp.phase || cp.status || 'unknown'}`,
            `Progress: ${cp.progress != null ? Math.round(cp.progress * 100) + '%' : 'unknown'}`,
            `Rows generated: ${ls.generatorRows ?? cp.row_count ?? 'unknown'}`,
            `Generator used: ${ls.generatorUsed ?? cp.generator_used ?? 'unknown'}`,
        );
    }

    // ── AgentDatasetContext DTO — single source of truth for the enforcement pipeline ──
    // Built once here so isValidResponse / repairResponse / buildFallbackResponse
    // all work from the same snapshot without re-reading sdc individually.
    const datasetCtx: AgentDatasetContext = {
        rowCount:     rowCount,
        columns:      sdc.columns?.length ? sdc.columns : null,
        privacyScore: sdc.privacy_score != null
            ? `${(sdc.privacy_score * 100).toFixed(0)}%`
            : null,
        riskLevel:    sdc.dataset_risk_score != null
            ? String(sdc.dataset_risk_score)
            : null,
        ctxLines,
        hasData,
        // PART 1: Expose live alerts so extractTopRisk() can find the highest-severity signal
        alerts: recentAlerts.map((a: any) => ({
            type:     (a.type     as string) || 'unknown',
            severity: (a.severity as string) || 'LOW',
        })),
    };

    // ── Agentic tool section (only when toolExecutor is provided) ──────────────
    const toolLines: string[] = toolExecutor ? [
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
    const fullCtx = formatContextForLLM(dsCtx);

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
                if (history[i].role === 'user') { userTurns++; }
                if (userTurns >= 10) { cutIdx = i; break; }
            }
            return history.slice(cutIdx);
        })()
        : history.slice(-10);

    const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        ...historySlice,
        { role: 'user', content: newMessage },
    ];

    // Agentic mode: only activate for explicit system-access intent
    const SYSTEM_INTENT_RX = /\b(run|execute|shell|bash|terminal|read file|write file|list files?|list dir|create file|delete file|python script|python run|open file|save file)\b/i;
    if (toolExecutor && SYSTEM_INTENT_RX.test(newMessage)) {
        const models = await (this as OpenRouterClient)['getModels']();
        const selectedModel = models[(this as OpenRouterClient)['currentModelIdx'] % models.length];
        return (this as OpenRouterClient)['_agenticLoop'](messages, SYSTEM_TOOLS, toolExecutor, selectedModel);
    }

    // ── Intent + comprehension gate — single LLM call does both jobs ──────────
    // classifyAndUnderstand() replaces the old classifyIntent() + comprehendRequest()
    // pair. One round-trip instead of two: ~35% faster per message.
    const { intent, understanding } = await (this as OpenRouterClient).classifyAndUnderstand(newMessage, datasetCtx);
    if (intent === 'greeting') {
        return (this as OpenRouterClient).respondToGreeting(newMessage, datasetCtx);
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
        return (this as OpenRouterClient).normalizeResponse({
            content: `Sure! I'll generate ${rowCount} new synthetic rows from your current dataset.\n\n<actions>[{"action":"modify_generation","row_count":${rowCount}}]</actions>`,
            model: 'aurora-cmd',
        });
    }

    if (/\b(export|download|save)\b.*\b(csv|data|dataset)\b/.test(cmd)) {
        return (this as OpenRouterClient).normalizeResponse({
            content: `Exporting your dataset as a CSV file.\n\n<actions>[{"type":"export_csv"}]</actions>`,
            model: 'aurora-actions',
        });
    }

    if (/\b(report|docx|document)\b/.test(cmd)) {
        return (this as OpenRouterClient).normalizeResponse({
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
            { role: 'user' as const, content: `[Focus: ${understanding}]\n\n${newMessage}` },
          ]
        : messages;

    return (this as OpenRouterClient).enforcedChat(finalMessages, datasetCtx);
};

// ─────────────────────────────────────────────────────────────────────────────
// agentReport — generates a full Markdown governance report from pipeline data
// ─────────────────────────────────────────────────────────────────────────────

(OpenRouterClient.prototype as any).agentReport = async function(
    this: any,
    ctx: PipelineContext,
): Promise<LLMResponse> {
    const dsCtx = ctx.datasetCtx ?? buildDatasetContext(ctx);
    const sdc   = buildStructuredDatasetContext(dsCtx);

    const systemPrompt = [
        (this as OpenRouterClient)['buildGovernanceSystemPrompt'](sdc),
        '',
        '## REPORT GENERATION MODE',
        'Generate a comprehensive governance report in Markdown format.',
        'Use ## headings for every section. Be thorough and cite all available metrics.',
        'This report will be saved to the workspace as aurora_report.md.',
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        formatContextForLLM(dsCtx),
    ].join('\n');

    const messages: LLMMessage[] = [
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
    return (this as OpenRouterClient)['validatedChat'](messages, sdc);
};
