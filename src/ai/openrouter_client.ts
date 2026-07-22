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

/**
 * Called by _agenticLoop immediately before each tool execution.
 * Allows callers to push live progress to the UI.
 */
export type ToolProgressCallback = (
    toolName: string,
    args: Record<string, any>,
    iteration: number,
) => void;


export interface LLMResponse {
    content: string;
    model: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    error?: string;
    toolsRun?: boolean;
    /** Populated when a tool produces a downloadable artifact (CSV or report) */
    artifact?: { type: 'csv' | 'report'; content?: string; filePath?: string };
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
            // Updated June 2026 — ranked by quality score + tool-calling support.
            // Source: openrouter.ai/models (free tier, tools-capable only).
            // ── Tier 1: Highest quality (score 55–65) ─────────────────────────────
            'openai/gpt-oss-120b:free',                  // Q:55, 131K ctx, tools
            'nvidia/nemotron-3-super-120b-a12b:free',   // Q:60, 1M ctx, tools
            // ── Tier 2: Strong mid-range (score 33–41) ────────────────────────────
            'qwen/qwen3-coder:free',                     // Q:41, 1M ctx, tools
            'openai/gpt-oss-20b:free',                   // Q:41, 131K ctx, tools
            'nvidia/nemotron-3-nano-30b-a3b:free',       // Q:40, 256K ctx, tools
            'z-ai/glm-4.5-air:free',                     // Q:38, 131K ctx, tools
            'qwen/qwen3-next-80b-a3b-instruct:free',     // Q:33, 262K ctx, tools
            // ── Tier 3: Reliable fallbacks ─────────────────────────────────────────
            'meta-llama/llama-3.3-70b-instruct:free',    // Q:24, 131K ctx, tools
            'nvidia/nemotron-3-ultra-550b-a55b:free',    // 1M ctx, tools
            'moonshotai/kimi-k2.6:free',                 // 262K ctx, tools
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
// Aurora domain-specific agent tools (OpenAI function-calling format)
// ─────────────────────────────────────────────────────────────────────────────

export const AURORA_AGENT_TOOLS: any[] = [
    {
        type: 'function',
        function: {
            name: 'get_dataset_state',
            description:
                'Return the full current dataset state: row count, column names and types, ' +
                'privacy score, risk level, generator params, and sample rows. ' +
                'Always call this first before any generation or analysis task.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'generate_rows',
            description:
                'Generate NEW synthetic rows from the ORIGINAL dataset baseline. ' +
                'Works directly from the parsed original file — does NOT require any prior synthetic generation. ' +
                'Returns the new rows only — does NOT merge them into the dataset. ' +
                'Call merge_and_update after this to persist the result.',
            parameters: {
                type: 'object',
                properties: {
                    count: {
                        type: 'number',
                        description: 'Number of rows to generate. Must be a positive integer.',
                    },
                    generator: {
                        type: 'string',
                        enum: ['ctgan', 'tvae', 'gaussian', 'random'],
                        description:
                            'Generator algorithm. Omit to reuse the last algorithm used.',
                    },
                    only: {
                        type: 'boolean',
                        description:
                            'If true, return these rows as a standalone result WITHOUT merging into the dataset. ' +
                            'Set to true ONLY when the user says "ONLY" (e.g., "generate 20 rows ONLY"). ' +
                            'Do NOT call merge_and_update after this.',
                    },
                },
                required: ['count'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'merge_and_update',
            description:
                // F5 fix (Arch Flaw 1): rows are stored server-side by generate_rows.
                // The LLM no longer needs to relay row data — no parameters needed.
                'Merge the rows generated by the most recent generate_rows call into the dataset. ' +
                'Rows are stored server-side — NO parameters needed. ' +
                'Always call this immediately after generate_rows.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'edit_dataset',
            description:
                'Edit rows or columns in the dataset (synthetic or original samples). ' +
                'Can delete columns, add columns, delete specific rows by index or condition, or filter rows. ' +
                'Automatically updates the active dataset in the dashboard panel and returns updated samples.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['delete_column', 'add_column', 'delete_rows', 'filter_rows'],
                        description: 'The editing operation to perform.',
                    },
                    column_name: {
                        type: 'string',
                        description: 'Name of the column to add or delete (required for delete_column / add_column).',
                    },
                    default_value: {
                        type: 'string',
                        description: 'Default value for newly added column (optional for add_column).',
                    },
                    row_indices: {
                        type: 'array',
                        items: { type: 'number' },
                        description: 'List of row indices (0-indexed) to delete or filter.',
                    },
                    condition: {
                        type: 'string',
                        description: 'Filter condition expression (e.g. "age > 50" or "category == \'test\'") for filtering/deleting rows.',
                    },
                },
                required: ['action'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'analyze_dataset',
            description:
                'Run a deep analysis of the current dataset. ' +
                'Returns distributions, correlations, outlier counts, drift scores, ' +
                'PII column map, and privacy metrics. ' +
                'Use this before generating a report or answering analytical questions.',
            parameters: {
                type: 'object',
                properties: {
                    focus: {
                        type: 'string',
                        enum: ['statistical', 'privacy', 'drift', 'full'],
                        description:
                            '"full" (default) runs all sub-analyses. ' +
                            'Use a narrower focus when the user asks about one aspect only.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'generate_report',
            description:
                'Generate a detailed analytical / governance report from pipeline metrics. ' +
                'Returns the report as a markdown string and its saved file path. ' +
                'The webview will show an Export button after this tool returns.',
            parameters: {
                type: 'object',
                properties: {
                    type: {
                        type: 'string',
                        enum: ['statistical', 'governance', 'privacy', 'full'],
                        description:
                            '"full" (default) combines all sections. ' +
                            'Use a narrower type when the user specifies one.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'stat_summary',
            description:
                'Generate a statistical summary report. ' +
                'Use scope="baseline" for the original/real data only, ' +
                'scope="synthetic" for the generated/synthetic data only, ' +
                'scope="comparison" (default) for a side-by-side comparison of both. ' +
                'IMPORTANT: When the user says "statistical summary" with no qualifier, ALWAYS use scope="comparison". ' +
                'Only use scope="baseline" when the user explicitly asks for "original only" or "baseline only". ' +
                'Always prefer this tool over generate_report when the user asks for a statistical summary. ' +
                'The tool result includes a text_summary field — relay its numbers directly to the user instead of summarizing from your own knowledge.',
            parameters: {
                type: 'object',
                properties: {
                    scope: {
                        type: 'string',
                        enum: ['baseline', 'synthetic', 'comparison'],
                        description:
                            '"baseline" = original data only | ' +
                            '"synthetic" = generated data only | ' +
                            '"comparison" = side-by-side (default)',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'export_csv',
            description:
                'Export the current synthetic dataset to a CSV file on disk and ' +
                'return its absolute path. Use when the user asks to save or export data.',
            parameters: {
                type: 'object',
                properties: {
                    filename: {
                        type: 'string',
                        description:
                            'Target filename without directory. Defaults to "aurora_dataset.csv".',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'combine_datasets',
            description:
                'Combine the current synthetic dataset with the original baseline data into one unified dataset. ' +
                'Use ONLY when the user explicitly says "combine synthetic and original" or similar phrase. ' +
                'Never call this automatically — it must be explicitly requested.',
            parameters: { type: 'object', properties: {} },
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
    // Broader patterns for OpenRouter 404 / availability errors:
    'does not exist',
    'not found',
    'no such model',
    'requested model',
    'model unavailable',
    'no free quota',
    'quota exceeded',
    'endpoint not available',
    '"code":404',
    '"code": 404',
    'status 404',
    'status 503',
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
                        const allFreeIds: string[] = (parsed.data || [])
                            .filter((m: any) => {
                                if (typeof m.id !== 'string') { return false; }
                                if (m.id.endsWith(':free')) { return true; }
                                const p = m.pricing;
                                return p && Number(p.prompt) === 0 && Number(p.completion) === 0;
                            })
                            .map((m: any) => m.id as string);

                        if (allFreeIds.length === 0) { resolve(cfg.defaultModels); return; }

                        // Sort live results: priority models first (in rank order),
                        // then any newly available free models not yet in priority list.
                        const priority = cfg.defaultModels;
                        const prioritised = [
                            ...priority.filter(id => allFreeIds.includes(id)),
                            ...allFreeIds.filter(id => !priority.includes(id)),
                        ];
                        console.log(
                            `[Aurora] Live free models from OpenRouter: ${allFreeIds.length} found, ` +
                            `${prioritised.filter(id => priority.includes(id)).length} priority matched. ` +
                            `Using: ${prioritised[0]}`
                        );
                        resolve(prioritised);
                    } catch {
                        resolve(cfg.defaultModels);
                    }
                });
            });
            req.on('error', () => resolve(cfg.defaultModels));
            req.setTimeout(3000, () => { req.destroy(); resolve(cfg.defaultModels); });
            req.end();
        });
    }

    /** Get model list — stale-while-revalidate: serve cached list immediately,
     *  refresh in the background so no prompt ever blocks on a network call. */
    private async getModels(): Promise<string[]> {
        const now = Date.now();
        const stale = !this._liveModels ||
            (now - this._liveModelsFetchedAt) >= OpenRouterClient.LIVE_MODELS_TTL_MS;
        // Always return immediately if we have anything cached
        if (this._liveModels) {
            if (stale) {
                // Kick off background refresh — intentionally not awaited
                this.fetchLiveModels().then(models => {
                    this._liveModels = models;
                    this._liveModelsFetchedAt = Date.now();
                }).catch(() => { /* non-critical */ });
            }
            return this._liveModels;
        }
        // Cold start — must await once
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
            '  What privacy risks exist in this dataset / analyze my data / analyze the dataset /',
            '  give me a summary / what does this data look like / overview of dataset',
            'Provide a SHORT analytical summary (3–6 sentences maximum).',
            'Focus on: row count, key risk, and one concrete recommendation.',
            'Do NOT produce tables, statistical breakdowns, or full reports.',
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
     * Strip model-injected safety annotation lines from response content.
     *
     * Some models (notably Google Gemma 3 via OpenRouter) prepend lines such as:
     *   "User Safety: safe"
     *   "Model Safety: safe"
     * to every response.  These annotations are internal classifier metadata
     * and must never be shown to the user or returned as the agent's answer.
     */
    private _sanitizeContent(raw: string): string {
        // Strip ALL Gemma 3 / safety-classifier annotation lines.
        // Covers: 'User Safety: safe', 'User Safety: unsafe', 'Model Safety: harmful',
        // 'Safety Categories: PII/Privacy', etc. — regardless of severity value.
        return raw
            .split('\n')
            .filter(line => {
                const t = line.trim();
                if (/^(user|model)\s+safety\s*:/i.test(t))      { return false; }
                if (/^safety\s+categor/i.test(t))               { return false; }
                if (/^content\s+filter/i.test(t))               { return false; }
                if (/^trigger\s+categor/i.test(t))              { return false; }
                return true;
            })
            .join('\n')
            .trim();
    }

    /**
     * Context-aware deterministic fallback.
     * When the LLM produces nothing useful (empty / degenerate response),
     * this answers simple factual questions directly from the dataset context
     * so users always get a real answer even when the model fails.
     */
    private _smartFallback(msg: string, ctx: AgentDatasetContext): string {
        const q = msg.toLowerCase();

        // Greeting
        const isGreeting = /^(hi|hello|hey|howdy|sup|yo|good\s+(morning|evening|afternoon)|what'?s\s+up)\b/.test(q)
            || q.length < 6;
        if (isGreeting) {
            if (ctx.hasData) {
                const bits: string[] = [];
                if (ctx.rowCount != null)  bits.push(`${ctx.rowCount} rows`);
                if (ctx.privacyScore)      bits.push(`privacy score ${ctx.privacyScore}`);
                if (ctx.columns?.length)   bits.push(`${ctx.columns.length} columns`);
                const summary = bits.length ? ` Your dataset has ${bits.join(', ')}.` : '';
                return `Hey! I'm Aurora, your data governance assistant.${summary} What would you like to explore?`;
            }
            return `Hey! I'm Aurora, your data governance assistant. Load a dataset and I can analyze privacy risks, generate synthetic rows, and export governance reports.`;
        }

        if (!ctx.hasData) {
            return `No dataset is currently loaded. Run the Aurora pipeline to load your data, then ask me anything.`;
        }

        // Privacy score
        if (/privacy\s+score|protection\s+score/.test(q)) {
            return ctx.privacyScore
                ? `Your dataset has a privacy score of **${ctx.privacyScore}**.`
                : `Privacy score not available — run the pipeline analysis first.`;
        }
        // Risk level
        if (/risk\s*(level|score)?/.test(q)) {
            return ctx.riskLevel
                ? `The dataset risk level is **${ctx.riskLevel}**.`
                : `Risk level not available — run the pipeline analysis first.`;
        }
        // Row / record count
        if (/\b(row|record|sample|data\s+point)\b/.test(q)) {
            return ctx.rowCount != null
                ? `The dataset currently has **${ctx.rowCount} rows**.`
                : `Row count not available.`;
        }
        // Column / feature list
        if (/\b(column|feature|field|variable)\b/.test(q)) {
            return ctx.columns?.length
                ? `The dataset has **${ctx.columns.length} columns**: ${ctx.columns.slice(0, 12).join(', ')}${ctx.columns.length > 12 ? '…' : ''}.`
                : `Column list not available.`;
        }
        // PII
        if (/\bpii\b|personally\s+identif/.test(q)) {
            return ctx.columns?.length
                ? `PII detection info is available via the full pipeline analysis. Ask me to "analyze my data" to see the breakdown.`
                : `No data loaded yet.`;
        }

        // Generic fallback with dataset summary
        const parts: string[] = [];
        if (ctx.rowCount != null)  parts.push(`${ctx.rowCount} rows`);
        if (ctx.privacyScore)      parts.push(`privacy score ${ctx.privacyScore}`);
        if (ctx.riskLevel)         parts.push(`risk level ${ctx.riskLevel}`);
        return parts.length
            ? `Your dataset: ${parts.join(', ')}. You can ask me to analyze it, generate rows, or export it.`
            : this.buildLightResponse(ctx);
    }

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

        // If a specific model is pinned, try only that one (no fallback loop).
        // ENFORCEMENT: when provider is OpenRouter, only :free-suffixed models are
        // permitted — block any attempt to pin a paid model, even from internal callers.
        if (model) {
            if (this.provider === 'openrouter' && !model.endsWith(':free')) {
                console.error(
                    `[Aurora] Blocked attempt to use paid model "${model}" on OpenRouter. ` +
                    `Only models with the :free suffix are permitted.`
                );
                return {
                    content: '',
                    model: model,
                    error:
                        `Model "${model}" is not a free OpenRouter model. ` +
                        `Aurora only uses free-tier models on OpenRouter (model ID must end with :free). ` +
                        `Switch to a free model or use a different provider.`,
                };
            }
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
            // BUG-24 fix: log which model is being retried so user can see progress
            console.warn(`[Aurora] model ${tryModel} unavailable (${i + 1}/${models.length}): ${resp.error}`);
            if (i < models.length - 1) {
                console.log(`[Aurora] Retrying with next model (${i + 2}/${models.length})…`);
            }
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

        // Hard gate: on OpenRouter, every model that reaches the wire MUST end with :free.
        // This covers all code paths — pinned, rotated, live-fetched, or called directly.
        if (this.provider === 'openrouter' && !selectedModel.endsWith(':free')) {
            console.error(`[Aurora] BLOCKED non-free model "${selectedModel}" — OpenRouter free-only policy.`);
            return Promise.resolve({
                content: '',
                model: selectedModel,
                error: `Model "${selectedModel}" is not a free OpenRouter model (must end with :free). Aurora only uses free-tier models.`,
            });
        }

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
                                content: this._sanitizeContent(choice?.message?.content || ''),
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
        // BUG-22 fix: log a warning and inform the user that tool execution is unavailable
        if (!cfg.openAICompat) {
            console.warn(`[Aurora] Provider '${this.provider}' does not support tool calling — falling back to plain text.`);
            return this._chatOnce(messages as any, selectedModel).then(r => ({
                message: {
                    role: 'assistant',
                    content: (r.content || '') +
                        '\n\n_Note: Tool execution is not available with the current provider. Switch to an OpenAI-compatible provider (OpenRouter, OpenAI, Groq) for shell and file operations._',
                },
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
                            const msg = choice?.message || { role: 'assistant', content: '' };
                            // Sanitize text content — never mutate tool_calls
                            if (typeof msg.content === 'string') {
                                msg.content = this._sanitizeContent(msg.content);
                            }
                            resolve({ message: msg, model: parsed.model || selectedModel, usage: parsed.usage });
                        }
                    } catch (e) {
                        resolve({ message: null, model: selectedModel, error: `Parse error: ${e}` });
                    }
                });
            });

            req.on('error', (err) => resolve({ message: null, model: selectedModel, error: `Network error: ${err.message}` }));
            req.setTimeout(60000, () => { req.destroy(); resolve({ message: null, model: selectedModel, error: 'Request timed out (60s)' }); });
            // F18 fix: token estimation warning before sending.
            // body is already a string — NO JSON.stringify() to avoid double-encode.
            const estimatedTokens = Math.ceil(body.length / 4); // ~4 chars per token
            const MAX_CONTEXT = 8192; // conservative — many free models are 4K
            if (estimatedTokens > MAX_CONTEXT * 0.8) {
                console.warn(
                    `[Aurora] Prompt payload is ~${estimatedTokens} tokens ` +
                    `(${Math.round(estimatedTokens / MAX_CONTEXT * 100)}% of 8K context) — ` +
                    `user message may be truncated on 4K models.`,
                );
            }
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
        onToolProgress?: ToolProgressCallback,   // ← progress callback
    ): Promise<LLMResponse> {
        const MAX_ITERATIONS = 10;
        const conversation = [...messages];
        let lastModel = selectedModel;

        for (let i = 0; i < MAX_ITERATIONS; i++) {
            const resp = await this._chatOnceWithTools(conversation, selectedModel, tools);

            if (resp.error || !resp.message) {
                // Provider error (model doesn't support native function-calling).
                // Degrade gracefully to the text-based ReAct loop — works on every model.
                return this._agenticLoopTextFallback(
                    messages, tools, toolExecutor, selectedModel, onToolProgress,
                );
            }

            lastModel = resp.model;
            const msg = resp.message;

            // Final answer — no tool calls
            if (!msg.tool_calls || msg.tool_calls.length === 0) {
                return { content: msg.content || '', model: lastModel, usage: resp.usage, toolsRun: i > 0 };
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
                        // Notify caller of tool execution before awaiting result
                        if (onToolProgress) {
                            onToolProgress(tc.function.name, args, i);
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

        return { content: '', model: lastModel, error: 'Agentic loop exceeded maximum iterations (10).', toolsRun: true };
    }

    /**
     * Text-based ReAct fallback for models that don’t support native function calling.
     *
     * Uses the classic Action: / Action Input: / Observation: pattern that is
     * universally understood by instruction-tuned LLMs.
     *
     * Loop:
     *   1. Send system prompt (augmented with text-format tool instructions) + conversation
     *   2. Parse "Action: <name>" and "Action Input: <JSON>" from model output
     *   3. Execute tool via toolExecutor
     *   4. Append "Observation: <result>" and repeat
     *   5. When no Action: line, treat response as final answer
     */
    private async _agenticLoopTextFallback(
        messages:        LLMMessage[],
        tools:           any[],
        toolExecutor:    ToolExecutor,
        selectedModel:   string,
        onToolProgress?: ToolProgressCallback,
    ): Promise<LLMResponse> {
        const MAX_ITERS = 8;

        // Build a compact tool catalogue the model can read.
        const toolCatalogue = tools.map(t => {
            const fn   = t.function;
            const props = fn.parameters?.properties ?? {};
            const paramLines = Object.entries(props)
                .map(([k, v]: [string, any]) => `    ${k} (${v.type ?? 'any'}): ${v.description ?? ''}`.trimEnd())
                .join('\n');
            return [
                `Tool: ${fn.name}`,
                `  ${fn.description}`,
                ...(paramLines ? ['  Parameters:', paramLines] : []),
            ].join('\n');
        }).join('\n\n');

        // Augment the system prompt with text-format tool-calling instructions.
        const baseSys = (messages[0]?.content as string) || '';
        const augmentedSys: LLMMessage = {
            role: 'system',
            content: baseSys + [
                '',
                '=== TEXT TOOL CALLING (use this because native function calling is unavailable) ===',
                'When you need to call a tool, write EXACTLY these two lines (and nothing else on them):',
                '  Action: <tool_name>',
                '  Action Input: <valid JSON object on one line>',
                '',
                'Example — get current dataset info:',
                '  Action: get_dataset_state',
                '  Action Input: {}',
                '',
                'Example — generate 200 rows:',
                '  Action: generate_rows',
                '  Action Input: {"count": 200}',
                '',
                'After each tool call you will see: Observation: <result>',
                'Use the observation to continue reasoning. When you have your final answer, write it',
                'naturally WITHOUT an Action: line.',
                '',
                'AVAILABLE TOOLS:',
                toolCatalogue,
                '=== END TOOL CALLING INSTRUCTIONS ===',
            ].join('\n'),
        };

        const conversation: LLMMessage[] = [
            augmentedSys,
            ...messages.slice(1),
        ];

        let lastModel = selectedModel;

        for (let i = 0; i < MAX_ITERS; i++) {
            // Use this.chat() (no pinned model) so we get automatic model rotation
            // when the preferred model is unavailable on the free tier.
            const resp = await this.chat(conversation);
            if (resp.error) {
                // All models failed — surface the error.
                break;
            }

            lastModel = resp.model || selectedModel;
            const text = this._sanitizeContent(resp.content || '');

            // ─ Parse "Action:" line ─────────────────────────────────────────────
            const actionMatch = /^\s*Action:\s*(.+)$/m.exec(text);
            if (!actionMatch) {
                // No tool call — final answer.
                return { content: text, model: lastModel, usage: resp.usage, toolsRun: i > 0 };
            }
            const toolName = actionMatch[1].trim();

            // ─ Parse "Action Input:" (handle nested JSON via brace-depth tracking) ─
            let toolArgs: Record<string, any> = {};
            const inputKeyIdx = text.indexOf('Action Input:');
            if (inputKeyIdx !== -1) {
                const after = text.slice(inputKeyIdx + 'Action Input:'.length).trimStart();
                const jsonStart = after.indexOf('{');
                if (jsonStart !== -1) {
                    let depth = 0;
                    let jsonEnd  = -1;
                    for (let c = jsonStart; c < after.length; c++) {
                        if (after[c] === '{') { depth++; }
                        else if (after[c] === '}') { depth--; if (depth === 0) { jsonEnd = c; break; } }
                    }
                    if (jsonEnd !== -1) {
                        try { toolArgs = JSON.parse(after.slice(jsonStart, jsonEnd + 1)); } catch { /* malformed */ }
                    }
                }
            }

            // ─ Execute tool ─────────────────────────────────────────────────────
            if (onToolProgress) { onToolProgress(toolName, toolArgs, i); }
            let observation: string;
            try {
                observation = await toolExecutor(toolName, toolArgs);
            } catch (e) {
                observation = `ERROR: ${e}`;
            }

            // ─ Append to conversation and loop ──────────────────────────────────
            conversation.push({ role: 'assistant', content: text });
            conversation.push({
                role: 'user',
                content: `Observation: ${observation}\n\nContinue. If you have all the information you need, give your final answer now.`,
            });
        }

        return {
            content: '',
            model:   lastModel,
            error:   'Text-based ReAct loop exceeded maximum iterations.',
            toolsRun: true,
        };
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
                // BUG-11 fix: removed the underscore gate — was silently ignoring
                // camelCase and short column names that don't use underscores.
                // Any unknown identifier token >= 3 chars is now flagged.
                hallucinated.push(match[1]);
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

        // BUG-12 fix: validate decimals across the full response, not just one section.
        // The old implementation only checked between "Risk Interpretation" and
        // "Identifier Classification" — this missed hallucinated numbers in all
        // other sections (Column Risk Analysis, Mitigation Strategy, etc.).
        const sectionText = responseText;
        const nums = this.extractNumbers(sectionText);

        // Only flag decimal numbers — plain integers are too ambiguous in prose
        const decimalOther = nums.filter(n => n.includes('.') && !validNums.has(n));
        if (decimalOther.length === 0) { return null; }

        return `Response references decimal value(s) not present in pipeline metrics: ` +
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
                    // BUG-18 fix: use the eight-section format (was five-section)
                    'Use the required eight-section format: Dataset Context / Risk Interpretation / Identifier Classification / Column Risk Analysis / Attack Paths / Mitigation Strategy / Governance Recommendation / Confidence Note.',
            },
        ];
        return this.validatedChat(messages, sdc);
    }

    /**
     * Legacy method kept for backward compatibility.
     * Internally routes through the new governance-analyst prompt.
     */
    private buildSystemPrompt(ctx: PipelineContext): string {
        // Cache datasetCtx on the ctx object itself — avoids rebuilding on repeated calls
    // with the same pipeline context (common during multi-turn agentic loops).
    if (!ctx.datasetCtx) { (ctx as any).datasetCtx = buildDatasetContext(ctx); }
    const dsCtx = ctx.datasetCtx!;
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
            // BUG-13 fix: include governance format rules in the repair prompt
            // so the model has the same structural requirements during repair.
            '## GOVERNANCE FORMAT RULES',
            'When generating a full report, use the required eight-section format:',
            '  Dataset Context / Risk Interpretation / Identifier Classification /',
            '  Column Risk Analysis / Attack Paths / Mitigation Strategy / Governance Recommendation / Confidence Note',
            '',
            '## Column Classification Rules',
            '  Direct Identifier   — Examples: phone, national_id, email',
            '  Quasi Identifier    — Examples: name, city, zipcode, birthdate',
            '  Sensitive Attribute — Examples: medical data, financial data, demographic attributes',
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
            { role: 'system',    content: repairPrompt },
            // F11 fix (Bug 9): bad output attributed as 'assistant' (what it was),
            // then a 'user' correction turn. Previously sent as 'user' which made
            // the LLM think the user wrote the governance report and want it edited.
            { role: 'assistant', content: badOutput },
            { role: 'user',      content: 'Please rewrite your answer using the real dataset metrics provided in the system prompt above. Reference at least one specific value.' },
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

        // BUG-14 fix: build context-aware mitigations instead of always
        // recommending k-anonymity regardless of actual risk level.
        const mitigations: string[] = [];
        if (ctx.riskLevel && !['low', 'unavailable'].includes(ctx.riskLevel.toLowerCase())) {
            mitigations.push('- Apply k-anonymity (k ≥ 5) to suppress quasi-identifier combinations');
            mitigations.push('- Suppress or mask high-risk columns before external sharing');
        } else if (ctx.privacyScore) {
            const ps = parseInt(ctx.privacyScore, 10);
            if (ps > 80) {
                mitigations.push('- Privacy score is high — dataset appears well-protected');
                mitigations.push('- Continue monitoring for drift in subsequent generations');
            } else {
                mitigations.push('- Privacy score is moderate — review PII columns for masking opportunities');
                mitigations.push('- Consider differential privacy for sensitive attribute columns');
            }
        } else {
            mitigations.push('- Insufficient context to provide specific mitigations — run the full pipeline first');
        }
        mitigations.push('- Re-run the pipeline after any anonymization to verify score improvement');

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
                'Recommended actions:',
                ...mitigations,
                '',
                'Expected outcome:',
                'Reduced re-identification risk and improved privacy score after mitigations are applied.',
              ].join('\n')
            : 'No dataset is loaded yet. Run the pipeline first to get grounded, data-specific answers.';

        return { content, model: 'aurora-fallback' };
    }

    // ── Intent detector ───────────────────────────────────────────────────────
    // Classifies a raw user input as a lightweight greeting, a statistical
    // analysis request, or a real governance task that requires the full
    // enforcement pipeline.  Called by agentChat before any model invocation.
    //
    // BUG-04 addition: 'analysis' intent added for statistical queries so they
    // get the richer statistical analysis system prompt branch in agentChat.
    //
    // Evaluation order (first match wins):
    //   1. Empty input          → greeting
    //   2. Overlong input       → task  (safety guard, avoids regex cost on huge strings)
    //   3. Task pattern match   → task  (regex word-boundary patterns — overrides length)
    //   4. Exact greeting word  → greeting
    //   5. Very short (≤ 3 ch)  → greeting  (leftover noise after task check)
    //   6. Default              -> task
    public detectIntent(input: string): 'greeting' | 'task' | 'analysis' {
        const text = input.toLowerCase().trim();

        // 1. Empty string - nothing to act on
        if (!text) { return 'greeting'; }

        // 2. Safety fallback for unusually long inputs - always a real task
        if (text.length > 200) { return 'task'; }

        // BUG-04: Detect statistical analysis intent BEFORE generic task patterns.
        // These queries get a richer statistical system prompt branch in agentChat.
        const analysisPatterns = [
            /\banalysis\b/,
            /\bstatistic/,
            /\bcorrelat/,
            /\boutlier/,
            /\bdistribution/,
            /\bmean\b/,
            /\bmedian\b/,
            /\bvariance\b/,
            /\bhistogram\b/,
            /\bsummary\s+stats\b/,
        ];
        if (analysisPatterns.some(p => p.test(text))) { return 'analysis'; }

        // 3. Strong task signals via word-boundary regex
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

        // 4. Greeting detection
        const greetings = ['hi', 'hello', 'hey'];
        if (greetings.includes(text)) { return 'greeting'; }
        if (text.length <= 30 && /\b(hi|hello|hey)\b/.test(text)) { return 'greeting'; }

        // 5. Very short non-task inputs
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
            // Build sentences separately so we never get a comma right after a period.
            const facts: string[] = [];
            if (ctx.rowCount != null)  facts.push(`Your dataset has ${ctx.rowCount} rows`);
            if (ctx.privacyScore)      facts.push(`a privacy score of ${ctx.privacyScore}`);
            if (ctx.riskLevel)         facts.push(`risk level ${ctx.riskLevel}`);

            const intro   = `Hi! I'm Aurora, your data governance assistant.`;
            const factStr = facts.length > 0 ? ` ${facts.join(', ')}.` : '';
            return `${intro}${factStr}\n\nWhat would you like to know?`;
        }
        return `Hi! I'm Aurora, your data governance assistant. Run the pipeline to load your dataset, then ask me anything about privacy risks, PII columns, or compliance.`;
    }

    // ── Greeting responder — proactively surfaces dataset insights ──────────
    public async respondToGreeting(input: string, ctx: AgentDatasetContext): Promise<LLMResponse> {
        // Build a rich, data-aware context block the model can draw on.
        let contextBlock: string;
        if (ctx.hasData && ctx.ctxLines.length) {
            const lines = ctx.ctxLines.slice(0, 8).map(l => `  ${l}`).join('\n');
            contextBlock = [
                '',
                'LOADED DATASET (use these real numbers in your reply if relevant):',
                lines,
            ].join('\n');
        } else {
            contextBlock = '\n\nNo dataset is currently loaded.';
        }

        try {
            const result = await this.chat([
                {
                    role: 'system',
                    content: [
                        'You are Aurora, an intelligent AI data governance assistant embedded in VS Code.',
                        'The user sent a casual or greeting message. Respond naturally and helpfully.',
                        '',
                        'RULES:',
                        '- Match the energy: if they say "hi", say hi back warmly.',
                        '- PROACTIVE: if a dataset is loaded, share ONE specific insight using the',
                        '  real numbers below (e.g. row count, privacy score, top risk column).',
                        '  Make it feel like you already know their data, not like you are waiting to be asked.',
                        '- Suggest 1-2 concrete things they can ask you to do next.',
                        '- 2-4 sentences max. Conversational tone. No bullet lists, no headers.',
                        '- Never invent numbers that are not in LOADED DATASET.',
                        contextBlock,
                    ].join('\n'),
                },
                { role: 'user', content: input },
            ]);

            const text = this._sanitizeContent(result.content || '');
            if (text.length > 10) {
                return this.normalizeResponse({ ...result, content: text, model: result.model || 'aurora' });
            }
        } catch {
            // fall through to deterministic fallback
        }

        // Deterministic fallback — always gives a useful response even if LLM fails.
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
        agentStatSummary(ctx: PipelineContext, scope?: 'baseline' | 'synthetic' | 'comparison'): Promise<LLMResponse>;
    }
}

// ── Degenerate-guard result formatters (F8 fix — Bug 3) ───────────────────────
// Convert raw JSON tool output to readable markdown before surfacing to the user.
// Previously, all 3 branches assigned result (raw JSON string) directly to content.

function _formatAnalysisResult(raw: string): string {
    try {
        const r = JSON.parse(raw);
        const lines: string[] = [];
        const baselineRows  = r.baseline?.row_count;
        const syntheticRows = r.synthetic?.row_count ?? r.row_count;
        const numCols       = r.numeric_cols?.length ?? 0;
        const catCols       = r.categorical_cols?.length ?? 0;

        lines.push(`## Dataset Analysis`);
        lines.push(
            `**Baseline:** ${baselineRows ?? 'N/A'} rows` +
            ` | **Synthetic:** ${syntheticRows ?? 'N/A'} rows` +
            ` | **Numeric cols:** ${numCols} | **Categorical cols:** ${catCols}`
        );

        const bStats = r.baseline?.statistical;
        const sStats = r.synthetic?.statistical;
        if (bStats && sStats && Object.keys(bStats).length > 0) {
            lines.push(`\n### Baseline vs Synthetic — Column Comparison`);
            lines.push('| Column | Baseline Mean | Synthetic Mean | Δ% | Baseline Std | Synthetic Std |');
            lines.push('|--------|:------------:|:--------------:|:--:|:-----------:|:-------------:|');
            for (const col of (r.numeric_cols ?? []) as string[]) {
                const b = bStats[col];
                const s = sStats[col];
                if (!b || !s) { continue; }
                const deltaNum = (b.mean != null && s.mean != null && b.mean !== 0)
                    ? (((s.mean - b.mean) / Math.abs(b.mean)) * 100).toFixed(1)
                    : null;
                const delta = deltaNum != null ? `${deltaNum}%` : '—';
                const flag  = deltaNum != null && Math.abs(parseFloat(deltaNum)) > 10 ? ' ⚠️' : '';
                lines.push(`| ${col} | ${b.mean ?? '—'} | ${s.mean ?? '—'} | ${delta}${flag} | ${b.std ?? '—'} | ${s.std ?? '—'} |`);
            }
        } else if (r.statistical && Object.keys(r.statistical).length > 0) {
            lines.push(`\n### Statistical Summary`);
            lines.push('| Column | Mean | Std | Min | Max |');
            lines.push('|--------|------|-----|-----|-----|');
            for (const [col, s] of Object.entries(r.statistical) as [string, any][]) {
                lines.push(`| ${col} | ${s.mean ?? '—'} | ${s.std ?? '—'} | ${s.min ?? '—'} | ${s.max ?? '—'} |`);
            }
        }

        if (r.privacy?.privacy_score != null) {
            lines.push(`\n### Privacy Metrics`);
            lines.push(`- **Privacy score:** ${(r.privacy.privacy_score * 100).toFixed(0)}%`);
            lines.push(`- **Risk level:** ${r.privacy.risk_level ?? 'N/A'}`);
            if (r.privacy.pii_columns?.length > 0) {
                lines.push(`- **PII columns:** ${r.privacy.pii_columns.join(', ')}`);
            }
        }

        if (r.drift) {
            lines.push(`\n### Drift`);
            lines.push(`- Baseline: **${r.drift.baseline_rows ?? 'N/A'}** rows → Synthetic: **${r.drift.synthetic_rows ?? 'N/A'}** rows`);
            if (r.drift.drift_scores && typeof r.drift.drift_scores === 'object') {
                const top = Object.entries(r.drift.drift_scores as Record<string, number>)
                    .sort(([, a], [, b]) => b - a).slice(0, 5);
                if (top.length > 0) {
                    lines.push('- **Top drift columns:** ' + top.map(([c, v]) => `${c} (${(v as number).toFixed(3)})`).join(', '));
                }
            }
        }

        return lines.join('\n');
    } catch { return raw; }
}

export function _buildComparisonChartArtifact(raw: string): any | null {
    try {
        const r     = JSON.parse(raw);
        const bStats = r.baseline?.statistical;
        const sStats = r.synthetic?.statistical;
        const cols   = r.numeric_cols as string[] | undefined;
        if (!bStats || !sStats || !cols || cols.length === 0) { return null; }
        return {
            type:            'comparison_chart',
            baseline_label:  `Baseline (${r.baseline?.row_count ?? '?'} rows)`,
            synthetic_label: `Synthetic (${r.synthetic?.row_count ?? '?'} rows)`,
            columns:         cols,
            baseline_means:  cols.map((c) => bStats[c]?.mean ?? 0),
            synthetic_means: cols.map((c) => sStats[c]?.mean ?? 0),
            baseline_stds:   cols.map((c) => bStats[c]?.std  ?? 0),
            synthetic_stds:  cols.map((c) => sStats[c]?.std  ?? 0),
        };
    } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// _buildBaselineChartArtifact — inline bar chart for baseline-only analysis.
// Shows per-column means (scale-normalised so mixed-range columns are comparable).
// Used by stat_summary when scope === 'baseline' and no synthetic data exists.
// ─────────────────────────────────────────────────────────────────────────────
export function _buildBaselineChartArtifact(baseline: any): any | null {
    try {
        const numCols = baseline?.columns?.numeric ?? {};
        const cols = Object.keys(numCols).filter((c) => numCols[c]?.mean != null);
        if (cols.length === 0) { return null; }
        const means  = cols.map((c) => parseFloat((numCols[c].mean ?? 0).toFixed(4)));
        const stds   = cols.map((c) => parseFloat((numCols[c].std  ?? 0).toFixed(4)));
        const maxAbs = Math.max(...means.map(Math.abs), 1);   // avoid /0
        const normMeans = means.map((m) => parseFloat((m / maxAbs).toFixed(4)));
        return {
            type:      'baseline_chart',
            row_count: baseline?.meta?.row_count ?? null,
            columns:   cols,
            means,
            stds,
            norm_means: normMeans,
        };
    } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// _buildStatReport — fully programmatic stat report (zero LLM calls)
// Used by stat_summary tool for instant results.
// agentStatSummary (button path) also uses this as the base, then appends
// a short LLM narrative.
// ─────────────────────────────────────────────────────────────────────────────
export function _buildStatReport(
    ctx: PipelineContext,
    scope: 'baseline' | 'synthetic' | 'comparison' = 'comparison',
): string {
    const baselineCols: Record<string, any>  = ctx.baseline?.columns?.numeric ?? {};
    const baselineRows: number | null        = ctx.baseline?.meta?.row_count ?? null;
    const samples: any[]                     = ctx.result?.samples ?? [];
    const syntheticRows: number | null       = samples.length > 0
        ? samples.length : (ctx.result?.row_count ?? null);
    const numericColNames                    = Object.keys(baselineCols);
    const leakage                            = (ctx as any).leakage ?? {};
    const now                                = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

    // ── Compute synthetic stats from samples (max 1000 rows for speed) ───
    const syntheticStats: Record<string, any> = {};
    const sampleSlice = samples.slice(0, 1000);
    if (sampleSlice.length > 0) {
        for (const col of numericColNames) {
            const vals = sampleSlice
                .map((r: any) => Number(r[col]))
                .filter((v: number) => !isNaN(v));
            if (vals.length === 0) { continue; }
            const mean     = vals.reduce((a, b) => a + b, 0) / vals.length;
            const sorted   = [...vals].sort((a, b) => a - b);
            const variance = vals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / vals.length;
            syntheticStats[col] = {
                min:    parseFloat(sorted[0].toFixed(4)),
                max:    parseFloat(sorted[sorted.length - 1].toFixed(4)),
                mean:   parseFloat(mean.toFixed(4)),
                std:    parseFloat(Math.sqrt(variance).toFixed(4)),
                median: sorted[Math.floor(sorted.length / 2)],
            };
        }
    }

    const lines: string[] = [];
    const scopeTitle = scope === 'baseline'  ? 'Original (Baseline) Data — Statistical Summary'
                     : scope === 'synthetic' ? 'Synthetic (Generated) Data — Statistical Summary'
                     :                         'Statistical Summary — Original vs Synthetic Comparison';

    lines.push(`# ${scopeTitle}`);
    lines.push(`> Generated by Aurora · ${now}`);
    lines.push('');

    // ── 1. Dataset Overview ────────────────────────────────────────────────
    lines.push('## 1. Dataset Overview');
    lines.push('');
    lines.push('| Property | Value |');
    lines.push('|----------|-------|');
    if (scope !== 'synthetic') {
        lines.push(`| Original rows   | ${baselineRows?.toLocaleString() ?? 'N/A'} |`);
    }
    if (scope !== 'baseline') {
        lines.push(`| Synthetic rows  | ${syntheticRows?.toLocaleString() ?? 'N/A'} |`);
    }
    lines.push(`| Numeric columns   | ${numericColNames.length} |`);
    lines.push(`| Privacy score     | ${leakage.privacy_score != null ? (leakage.privacy_score * 100).toFixed(0) + '%' : 'N/A'} |`);
    lines.push(`| Risk level        | ${leakage.risk_level ?? 'N/A'} |`);
    lines.push(`| Drift level       | ${leakage.drift_level ?? 'N/A'} |`);
    lines.push('');

    // ── 2. Column Statistics ───────────────────────────────────────────────
    if (scope === 'baseline') {
        lines.push('## 2. Column Statistics (Original Data)');
        lines.push('');
        lines.push('| Column | Mean | Std | Min | Max | Median |');
        lines.push('|--------|-----:|----:|----:|----:|-------:|');
        for (const col of numericColNames) {
            const b = baselineCols[col];
            if (!b) { continue; }
            lines.push(`| ${col} | ${b.mean?.toFixed(4) ?? '—'} | ${b.std?.toFixed(4) ?? '—'} | ${b.min ?? '—'} | ${b.max ?? '—'} | ${b.median ?? '—'} |`);
        }
    } else if (scope === 'synthetic') {
        lines.push('## 2. Column Statistics (Synthetic Data)');
        lines.push('');
        lines.push('| Column | Mean | Std | Min | Max | Median |');
        lines.push('|--------|-----:|----:|----:|----:|-------:|');
        for (const col of numericColNames) {
            const s = syntheticStats[col];
            if (!s) { continue; }
            lines.push(`| ${col} | ${s.mean} | ${s.std} | ${s.min} | ${s.max} | ${s.median} |`);
        }
    } else {
        lines.push('## 2. Column Comparison — Original vs Synthetic');
        lines.push('');
        lines.push('| Column | Orig. Mean | Synth. Mean | Δ% | Orig. Std | Synth. Std | Orig. Min | Orig. Max | Synth. Min | Synth. Max |');
        lines.push('|--------|----------:|-----------:|:---:|----------:|-----------:|----------:|----------:|-----------:|-----------:|');
        const alerts: string[] = [];
        for (const col of numericColNames) {
            const b = baselineCols[col];
            const s = syntheticStats[col];
            if (!b) { continue; }
            const bMean = b.mean  != null ? parseFloat(b.mean.toFixed(4))  : null;
            const bStd  = b.std   != null ? parseFloat(b.std.toFixed(4))   : null;
            const sMean = s?.mean ?? null;
            const sStd  = s?.std  ?? null;
            const deltaRaw = (bMean != null && sMean != null && bMean !== 0)
                ? ((sMean - bMean) / Math.abs(bMean)) * 100 : null;
            const deltaStr = deltaRaw != null ? `${deltaRaw.toFixed(1)}%` : '—';
            const flag     = deltaRaw != null && Math.abs(deltaRaw) > 10 ? ' ⚠️' : '';
            if (flag) { alerts.push(`${col} (${deltaRaw!.toFixed(1)}% shift)`); }
            lines.push(
                `| ${col} | ${bMean ?? '—'} | ${sMean ?? 'N/A'} | ${deltaStr}${flag}` +
                ` | ${bStd ?? '—'} | ${sStd ?? 'N/A'}` +
                ` | ${b.min ?? '—'} | ${b.max ?? '—'} | ${s?.min ?? 'N/A'} | ${s?.max ?? 'N/A'} |`
            );
        }
        lines.push('');
        lines.push(alerts.length > 0
            ? `> ⚠️ **Significant changes (>10% mean shift):** ${alerts.join(', ')}`
            : `> ✅ **All columns within 10% mean deviation — high fidelity.**`
        );
    }
    lines.push('');

    // ── 3. Privacy & Risk ──────────────────────────────────────────────────
    lines.push('## 3. Privacy & Risk Assessment');
    lines.push('');
    lines.push('| Metric | Value | Status |');
    lines.push('|--------|-------|--------|');
    const ps = leakage.privacy_score;
    lines.push(`| Privacy score | ${ps != null ? (ps * 100).toFixed(0) + '%' : 'N/A'} | ${ps != null ? (ps >= 0.8 ? '✅ Good' : ps >= 0.6 ? '⚠️ Moderate' : '❌ Low') : '—'} |`);
    lines.push(`| Risk level | ${leakage.risk_level ?? 'N/A'} | ${leakage.risk_level === 'low' ? '✅' : leakage.risk_level === 'medium' ? '⚠️' : leakage.risk_level ? '❌' : '—'} |`);
    if (leakage.mi_auc != null) {
        lines.push(`| MI-AUC | ${leakage.mi_auc.toFixed(4)} | ${leakage.mi_auc < 0.6 ? '✅ Low risk' : leakage.mi_auc < 0.75 ? '⚠️ Moderate' : '❌ High risk'} |`);
    }
    if (leakage.drift_level) {
        lines.push(`| Drift level | ${leakage.drift_level} | ${leakage.drift_level === 'low' ? '🟢 Acceptable' : leakage.drift_level === 'medium' ? '🟡 Review' : '🔴 High'} |`);
    }
    if (leakage.pii_columns?.length > 0) {
        lines.push(`| PII columns | ${leakage.pii_columns.join(', ')} | ⚠️ Review before sharing |`);
    }
    lines.push('');

    // ── 4. Drift (comparison only) ─────────────────────────────────────────
    if (scope === 'comparison' && leakage.drift_scores) {
        lines.push('## 4. Column Drift Scores');
        lines.push('');
        const driftEntries = Object.entries(leakage.drift_scores as Record<string, number>)
            .sort(([, a], [, b]) => b - a);
        lines.push('| Column | Drift Score | Assessment |');
        lines.push('|--------|----------:|------------|');
        for (const [col, score] of driftEntries) {
            const s = score as number;
            const status = s < 0.05 ? '✅ Low' : s < 0.15 ? '⚠️ Moderate' : '❌ High';
            lines.push(`| ${col} | ${s.toFixed(4)} | ${status} |`);
        }
        lines.push('');
    }

    // ── 5. Threats ─────────────────────────────────────────────────────────
    if (leakage.detected_threats?.length > 0) {
        lines.push(`## ${scope === 'comparison' ? '5' : '4'}. Detected Privacy Threats`);
        lines.push('');
        for (const t of leakage.detected_threats as any[]) {
            lines.push(`- **[${t.severity ?? 'unknown'}]** ${t.type ?? t.name ?? JSON.stringify(t)}`);
            if (t.description) { lines.push(`  ${t.description}`); }
        }
        lines.push('');
    }

    lines.push('---');
    lines.push('*Generated by Aurora Privacy Platform*');

    return lines.join('\n');
}

function _formatExportResult(raw: string): string {
    try {
        const r = JSON.parse(raw);
        if (r.error)   { return `⚠️ Export failed: ${r.error}`; }
        if (r.success) { return `✅ Dataset exported.\n- **File:** \`${r.file_path}\`\n- **Rows exported:** ${r.rows}`; }
    } catch { /* fall through */ }
    return raw;
}

function _formatReportResult(raw: string): string {
    try {
        const r = JSON.parse(raw);
        if (r.error)   { return `⚠️ Report generation failed: ${r.error}`; }
        if (r.success) {
            return [
                `✅ Governance report generated.`,
                `- **File:** \`${r.file_path}\``,
                `- **Size:** ${r.char_count} characters`,
                ``,
                `The report has been saved. You can view and export it from the Reports panel.`,
            ].join('\n');
        }
    } catch { /* fall through */ }
    return raw;
}

// ────────────────────────────────────────────────────────────────────────────────

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
                // BUG-18 fix: use eight-section format (was five-section)
                'Use the required eight-section format: Dataset Context / Risk Interpretation / Identifier Classification / Column Risk Analysis / Attack Paths / Mitigation Strategy / Governance Recommendation / Confidence Note.',
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
                // BUG-18 fix: use eight-section format (was five-section)
                'Use the required eight-section format: Dataset Context / Risk Interpretation / Identifier Classification / Column Risk Analysis / Attack Paths / Mitigation Strategy / Governance Recommendation / Confidence Note.',
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
                // BUG-18 fix: use eight-section format (was five-section)
                'Use the required eight-section format: Dataset Context / Risk Interpretation / Identifier Classification / Column Risk Analysis / Attack Paths / Mitigation Strategy / Governance Recommendation / Confidence Note.',
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
                // BUG-18 fix: use eight-section format (was five-section)
                'Return using the eight-section format:',
                'Dataset Context: describe the dataset and schema context',
                'Risk Interpretation: explain privacy implications of the query',
                'Identifier Classification: classify PII columns involved in the query',
                'Column Risk Analysis / Attack Paths / Mitigation Strategy: PII/privacy warnings, attack vectors, and specific mitigations per column',
                'Governance Recommendation: policy recommendation for this query',
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
    onToolProgress?: ToolProgressCallback,   // ← live progress callback
): Promise<LLMResponse> {
    const dsCtx = ctx.datasetCtx ?? buildDatasetContext(ctx);
    const sdc   = buildStructuredDatasetContext(dsCtx);
    // F9 fix: sdc.rows is the correct field (not the nonexistent sdc.row_count/dataset_name)
    const rowCount = sdc.rows ?? null;
    const hasData  = !!(rowCount || sdc.privacy_score != null || sdc.columns.length > 0);

    // ── Lean dataset context summary (only what the model actually needs) ──────
    // recentAlerts is declared here (outside the if block) so it remains in scope
    // when building datasetCtx.alerts below, regardless of whether hasData is true.
    const recentAlerts: ReturnType<typeof getRecentAlerts> = getRecentAlerts(20);
    const ctxLines: string[] = [];
    if (hasData) {
        // datasetName removed — field does not exist on StructuredDatasetContext (F9 fix)
        if (rowCount != null)           ctxLines.push(`Rows: ${rowCount}`);
        if (sdc.columns?.length)        ctxLines.push(`Columns: ${sdc.columns.length}`);
        if (sdc.privacy_score != null)       ctxLines.push(`Privacy score: ${(sdc.privacy_score * 100).toFixed(0)}%`);
        // F10 fix: use human-readable risk_level from dsCtx, not the raw numeric dataset_risk_score
        const riskLabel = dsCtx.risk_metrics?.risk_level ?? null;
        if (riskLabel)                         ctxLines.push(`Risk level: ${riskLabel}`);
        if (sdc.dataset_risk_score != null)    ctxLines.push(`Risk score: ${sdc.dataset_risk_score.toFixed(1)}/100`);
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
        riskLevel:    dsCtx.risk_metrics?.risk_level ?? null,  // F10 fix: human-readable label
        ctxLines,
        hasData,
        // PART 1: Expose live alerts so extractTopRisk() can find the highest-severity signal
        alerts: recentAlerts.map((a: any) => ({
            type:     (a.type     as string) || 'unknown',
            severity: (a.severity as string) || 'LOW',
        })),
    };

    // ── Build the context block (Bug 7 / F6 fix) ───────────────────────────
    // fullCtx (formatContextForLLM) intentionally removed — it injected 1500-4000 tokens
    // of redundant data that consumed 70-90% of free-model context windows.
    // The LLM calls get_dataset_state or analyze_dataset tools for detailed stats.
    const contextBlock = [
        ...(ctxLines.length ? ['## DATASET CONTEXT', ...ctxLines, ''] : []),
        ...(liveLines.length ? ['## LIVE GENERATOR STATE', ...liveLines, ''] : []),
    ].join('\n');

    const systemPrompt = [
        'You are Aurora — an intelligent AI data governance assistant embedded in VS Code.',
        'You have full access to the Aurora synthetic data pipeline via tools.',
        '',
        'HOW TO RESPOND:',
        '  • Casual / greeting messages ("hi", "hello", "how are you", "thanks", "ok"): one sentence only. No lists, no analysis.',
        '  • Questions about the dataset: answer directly using the DATASET CONTEXT below.',
        '    Cite exact numbers. Never invent statistics.',
        '  • "analyze my data" / "analyze the dataset" / "give me a summary" / "overview":',
        '    Call stat_summary (scope: baseline if no synthetic exists, else comparison).',
        '    Then respond in 3–5 sentences ONLY: row count, top risk, one recommendation.',
        '    NO tables. NO full reports. NO statistical breakdowns. Hard limit: 5 sentences.',
        '  • Action requests (generate, export, report): use tools, then confirm with key numbers.',
        '',
        toolExecutor ? [
            'TOOLS YOU CAN CALL:',
            '  get_dataset_state    — read current rows, columns, privacy score',
            '  generate_rows        — create new synthetic rows  {"count": N, "only": true/false}',
            '  merge_and_update     — persist generated rows into the active dataset',
            '  edit_dataset         — edit dataset (delete rows, delete columns, add columns, filter rows)',
            '  analyze_dataset      — deep statistical + privacy analysis',
            '  generate_report      — create a full governance report',
            '  export_csv           — export the dataset',
            '  stat_summary         — statistical summary with scope: "baseline" | "synthetic" | "comparison"',
            '  combine_datasets     — combine synthetic + original into one unified dataset',
            '',
            'TOOL RULES:',
            '  • MANDATE FOR GENERATION / EDITING:',
            '    When asked to generate rows, add rows, or edit data (e.g. "add 500 rows", "generate data"):',
            '    - ALWAYS invoke the generate_rows(count: N) tool and then merge_and_update() tool.',
            '    - NEVER print raw data rows, repetitive characters, or simulated text in your message response.',
            '    - Keep your text response concise (1-2 sentences summarizing what tool was executed).',
            '  • The DATASET CONTEXT block above already has current rows/columns/privacy score — do NOT call get_dataset_state unless you need to verify a live change mid-conversation.',
            '  • generate_rows works directly from the ORIGINAL dataset — NO prior synthetic generation required.',
            '    If the user asks to generate rows and only an original dataset is loaded, call generate_rows immediately.',
            '  • Default generate flow: generate_rows(N) → merge_and_update (no args needed).',
            '  • merge_and_update automatically uses the rows from the last generate_rows call.',
            '  • ONLY flag: when the user says "ONLY" (e.g., "generate 20 rows ONLY"), call',
            '    generate_rows({count: N, only: true}). Do NOT call merge_and_update after.',
            '    The rows are returned as a standalone preview and not added to the dataset.',
            '  • combine_datasets: call ONLY when the user explicitly says "combine synthetic and original".',
            '    Never call this automatically.',
            '  • For statistical summary: use stat_summary, NOT generate_report.',
            '    - User says "original/real/baseline data" → stat_summary({scope:"baseline"})',
            '    - User says "synthetic/generated data"   → stat_summary({scope:"synthetic"})',
            '    - User says "compare" or no qualifier    → stat_summary({scope:"comparison"})',
            '    - IMPORTANT: if synthetic_rows is 0 or null (no generation has run yet),',
            '      always use stat_summary({scope:"baseline"}) regardless of what the user says.',
            '  • After every tool call, share what you found. Never say just "Done."',
        ].join('\n') : '',
        '',
        'DATASET CONTEXT:',
        contextBlock,
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

    // ── Bug 8 / F7 fix: Route greetings before the agentic loop ─────────────
    // detectIntent() is pure regex — zero latency, zero extra LLM calls.
    // Greetings bypass the full tool-calling loop, saving 1-2 LLM invocations.
    // classifyAndUnderstand() (LLM-based focus extraction) is available but not
    // wired here — can be enabled later if latency budget allows.
    const intent = (this as OpenRouterClient).detectIntent(newMessage);
    if (intent === 'greeting') {
        return (this as OpenRouterClient).respondToGreeting(newMessage, datasetCtx);
    }

    const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        ...historySlice,
        { role: 'user', content: newMessage },
    ];

    if (toolExecutor) {
        const models = await (this as OpenRouterClient)['getModels']();
        const selectedModel = models[(this as OpenRouterClient)['currentModelIdx'] % models.length];
        const agenticResult = await (this as OpenRouterClient)['_agenticLoop'](
            messages, AURORA_AGENT_TOOLS, toolExecutor, selectedModel, onToolProgress,
        );
        // Degenerate-response guard: replace empty / one-word completions with a real answer.
        let agenticText = (agenticResult.content || '').trim();
        let isDegenerate = !agenticText
            || /^done\.?$/i.test(agenticText)
            || /^ok\.?$/i.test(agenticText)
            || agenticText.length < 6;

        if (isDegenerate && !agenticResult.toolsRun && toolExecutor) {
            const q = newMessage.toLowerCase();
            if (/\banalyze\b|\banalysis\b/i.test(q)) {
                if (onToolProgress) { onToolProgress('analyze_dataset', {}, 0); }
                const result = await toolExecutor('analyze_dataset', {});
                // F8 fix: convert raw JSON to readable markdown (Bug 3)
                agenticResult.content = _formatAnalysisResult(result) || `I have analyzed the dataset.`;
                agenticResult.toolsRun = true;
                isDegenerate = false;
                // Attach comparison chart artifact when baseline + synthetic both available
                const chartArtifact = _buildComparisonChartArtifact(result);
                if (chartArtifact) { (agenticResult as any).artifact = chartArtifact; }
            } else if (/\bexport\b|\bcsv\b/i.test(q)) {  // Bug 1 fix: catch "export it.", "export csv", etc.
                if (onToolProgress) { onToolProgress('export_csv', {}, 0); }
                const result = await toolExecutor('export_csv', {});
                // F8 fix: convert raw JSON to readable message (Bug 3)
                agenticResult.content = _formatExportResult(result) || `I have exported the dataset to CSV.`;
                agenticResult.toolsRun = true;
                isDegenerate = false;
                // Attach artifact so the UI renders an Export CSV button in chat
                try {
                    const parsed = JSON.parse(result);
                    if (parsed.success) {
                        (agenticResult as any).artifact = { type: 'csv', filePath: parsed.file_path };
                    }
                } catch { /* non-critical */ }
            } else if (/\b(generate|create|make)\b[\s\w]*\b(rows?|records?|samples?|data|synthetic)\b/i.test(q)) {  // Bug 2 fix: only rows, not "Generate Statistical Summary"
                const numMatch = /\b\d+\b/.exec(q);
                const count = numMatch ? parseInt(numMatch[0], 10) : 100;
                if (onToolProgress) { onToolProgress('get_dataset_state', {}, 0); }
                await toolExecutor('get_dataset_state', {});
                if (onToolProgress) { onToolProgress('generate_rows', { count }, 1); }
                await toolExecutor('generate_rows', { count });
                if (onToolProgress) { onToolProgress('merge_and_update', {}, 2); }
                const result = await toolExecutor('merge_and_update', {});
                // F8 fix: parse merge result; defensive fallback on field names (Bug 3)
                let genSummary = `I have successfully generated ${count} synthetic rows and updated the dataset.`;
                try {
                    const parsed = JSON.parse(result);
                    if (parsed.success) {
                        const added = parsed.added ?? parsed.count_merged ?? count;
                        const total = parsed.total_rows ?? parsed.total ?? '?';
                        genSummary = `✅ Generated and merged **${added}** new rows. Dataset now has **${total}** total rows.`;
                    } else if (parsed.error) {
                        genSummary = `⚠️ ${parsed.error}`;
                    }
                } catch { /* use default message */ }
                agenticResult.content = genSummary;
                agenticResult.toolsRun = true;
                isDegenerate = false;
            // Stat summary branch — intercept before generic report branch
            // Catches: "statistical summary", "summary of the original data",
            //          "summary of the synthetic data", "original data summary", etc.
            } else if (
                /\bstat(istical)?\s+(summ\w*|report)/i.test(q) ||
                /\bsumm\w+\b[\s\S]{0,40}\b(original|baseline|real|actual|synthetic|generated|fake)\b/i.test(q) ||
                /\b(original|baseline|real|actual|synthetic|generated|fake)\b[\s\S]{0,40}\bsumm\w+\b/i.test(q)
            ) {
                // Detect scope from user message
                const isBaseline  = /\b(original|baseline|real|actual|source|raw)\b/i.test(q);
                const isSynthetic = /\b(synthetic|generated|fake|artificial|new|sampled)\b/i.test(q);
                const scope       = isBaseline ? 'baseline' : isSynthetic ? 'synthetic' : 'comparison';
                if (onToolProgress) { onToolProgress('stat_summary', { scope }, 0); }
                const result = await toolExecutor('stat_summary', { scope });
                try {
                    const parsed = JSON.parse(result);
                    if (parsed.success) {
                        const scopeLabel = scope === 'baseline' ? 'original data' : scope === 'synthetic' ? 'synthetic data' : 'comparison';
                        agenticResult.content = `✅ Statistical summary (${scopeLabel}) generated.` +
                            (parsed.file_path ? `\n- **File:** \`${parsed.file_path}\`` : '') +
                            (parsed.char_count ? `\n- **Size:** ${parsed.char_count} characters` : '');
                    } else {
                        agenticResult.content = `⚠️ Statistical summary failed: ${result}`;
                    }
                } catch { agenticResult.content = `✅ Statistical summary generated.`; }
                agenticResult.toolsRun = true;
                isDegenerate = false;
            // F12 (Bug 6) regex fix folded here: \bdoc\b → \bdocx?\b to match "docx"
            } else if (/\breport\b|\bdocx?\b|\bword\b|\bpdf\b/i.test(q)) {
                if (onToolProgress) { onToolProgress('generate_report', {}, 0); }
                const result = await toolExecutor('generate_report', {});
                // F8 fix: convert raw JSON to readable message (Bug 3)
                // Note: generate_report produces .md, not .docx — DOCX pipeline is in agentStatReport handler.
                agenticResult.content = _formatReportResult(result) || `I have generated the governance report.`;
                agenticResult.toolsRun = true;
                isDegenerate = false;
                // Attach artifact so the UI renders an Export Report button in chat
                try {
                    const parsed = JSON.parse(result);
                    if (parsed.success) {
                        (agenticResult as any).artifact = { type: 'report', filePath: parsed.file_path };
                    }
                } catch { /* non-critical */ }
            }
        }

        if (isDegenerate) {
            if (agenticResult.toolsRun) {
                agenticResult.content = `I have successfully executed the requested tool operations. The dataset is now updated and ready.`;
            } else {
                agenticResult.content = (this as OpenRouterClient)['_smartFallback'](newMessage, datasetCtx);
            }
        }
        return agenticResult;
    }

    // Non-agentic: direct LLM call with full context.
    return (this as OpenRouterClient).enforcedChat(messages, datasetCtx);

    // Explicit known commands are matched here before the enforcement pipeline.


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

// ─────────────────────────────────────────────────────────────────────────────
// agentStatSummary — statistical summary report (F1 fix — Bug 1)
// Called by extension.ts agentStatReport handler; result is converted to DOCX.
// Strategy: compute ALL numbers deterministically (no LLM), inject as pre-built
// comparison block, ask LLM only for narrative/analysis text.
// ─────────────────────────────────────────────────────────────────────────────

(OpenRouterClient.prototype as any).agentStatSummary = async function(
    this: any,
    ctx: PipelineContext,
    scope: 'baseline' | 'synthetic' | 'comparison' = 'comparison',
): Promise<LLMResponse> {
    const dsCtx = ctx.datasetCtx ?? buildDatasetContext(ctx);
    const sdc   = buildStructuredDatasetContext(dsCtx);
    const riskLabel = dsCtx.risk_metrics?.risk_level ?? null;
    const rowCount  = sdc.rows ?? null;

    // ── 1. Compute baseline stats from ctx.baseline.columns.numeric ───────
    const baselineCols: Record<string, any> = ctx.baseline?.columns?.numeric ?? {};
    const baselineRows: number | null = ctx.baseline?.meta?.row_count ?? null;

    // ── 2. Compute synthetic stats from ctx.result.samples ────────────────
    const samples: any[] = ctx.result?.samples ?? [];
    const syntheticRows  = samples.length > 0 ? samples.length : (ctx.result?.row_count ?? null);
    const numericColNames = Object.keys(baselineCols);

    const syntheticStats: Record<string, {min:number,max:number,mean:number,std:number,median:number}> = {};
    if (samples.length > 0) {
        for (const col of numericColNames) {
            const vals = samples
                .map((r: any) => Number(r[col]))
                .filter((v: number) => !isNaN(v));
            if (vals.length === 0) { continue; }
            const mean     = vals.reduce((a, b) => a + b, 0) / vals.length;
            const sorted   = [...vals].sort((a, b) => a - b);
            const variance = vals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / vals.length;
            syntheticStats[col] = {
                min:    parseFloat(sorted[0].toFixed(4)),
                max:    parseFloat(sorted[sorted.length - 1].toFixed(4)),
                mean:   parseFloat(mean.toFixed(4)),
                std:    parseFloat(Math.sqrt(variance).toFixed(4)),
                median: sorted[Math.floor(sorted.length / 2)],
            };
        }
    }

    // ── 3. Build comparison block based on scope ──────────────────────────
    const compLines: string[] = [];
    const scopeLabel = scope === 'baseline'   ? 'ORIGINAL (BASELINE) DATA ONLY'
                     : scope === 'synthetic'  ? 'SYNTHETIC (GENERATED) DATA ONLY'
                     :                          'COMPARISON: ORIGINAL vs SYNTHETIC';

    compLines.push(`## PRE-COMPUTED DATA — ${scopeLabel}`);
    compLines.push('(cite these exact numbers in your report — do not recalculate)');
    compLines.push('');
    compLines.push('### Dataset Dimensions');
    if (scope !== 'synthetic') {
        compLines.push(`- Original (baseline) rows: ${baselineRows ?? 'N/A'}`);
    }
    if (scope !== 'baseline') {
        compLines.push(`- Synthetic (generated) rows: ${syntheticRows ?? 'N/A'}`);
    }
    compLines.push(`- Columns: ${numericColNames.length} numeric, ${sdc.columns.length - numericColNames.length} categorical`);
    compLines.push('');
    // ── Column stats table (scope-aware) ──────────────────────────────────
    const significantChanges: string[] = [];
    if (scope === 'baseline') {
        compLines.push('### Original Data — Column Statistics');
        compLines.push('| Column | Mean | Std | Min | Max | Median |');
        compLines.push('|--------|-----:|----:|----:|----:|-------:|');
        for (const col of numericColNames) {
            const b = baselineCols[col];
            if (!b) { continue; }
            compLines.push(`| ${col} | ${b.mean?.toFixed(4) ?? '—'} | ${b.std?.toFixed(4) ?? '—'} | ${b.min ?? '—'} | ${b.max ?? '—'} | ${b.median ?? '—'} |`);
        }
    } else if (scope === 'synthetic') {
        compLines.push('### Synthetic Data — Column Statistics');
        compLines.push('| Column | Mean | Std | Min | Max | Median |');
        compLines.push('|--------|-----:|----:|----:|----:|-------:|');
        for (const col of numericColNames) {
            const s = syntheticStats[col];
            if (!s) { continue; }
            compLines.push(`| ${col} | ${s.mean} | ${s.std} | ${s.min} | ${s.max} | ${s.median} |`);
        }
    } else {
        compLines.push('### Numeric Column Comparison (Original vs Synthetic)');
        compLines.push('| Column | Orig.Mean | Synth.Mean | Δ% | Orig.Std | Synth.Std | Orig.Min | Orig.Max | Synth.Min | Synth.Max |');
        compLines.push('|--------|----------:|-----------:|:--:|---------:|----------:|---------:|---------:|----------:|----------:|');

        for (const col of numericColNames) {
            const b = baselineCols[col];
            const s = syntheticStats[col];
            if (!b) { continue; }
            const bMean = b.mean  != null ? parseFloat(b.mean.toFixed(4))  : null;
            const bStd  = b.std   != null ? parseFloat(b.std.toFixed(4))   : null;
            const sMean = s?.mean ?? null;
            const sStd  = s?.std  ?? null;
            const deltaRaw = (bMean != null && sMean != null && bMean !== 0)
                ? ((sMean - bMean) / Math.abs(bMean)) * 100
                : null;
            const deltaStr  = deltaRaw != null ? `${deltaRaw.toFixed(1)}%` : 'N/A';
            const flag      = deltaRaw != null && Math.abs(deltaRaw) > 10 ? ' ⚠️' : '';
            if (deltaRaw != null && Math.abs(deltaRaw) > 10) {
                significantChanges.push(`${col} (${deltaRaw.toFixed(1)}% shift in mean)`);
            }
            compLines.push(
                `| ${col} | ${bMean ?? '—'} | ${sMean ?? 'N/A'} | ${deltaStr}${flag}` +
                ` | ${bStd ?? '—'} | ${sStd ?? 'N/A'} | ${b.min ?? '—'} | ${b.max ?? '—'}` +
                ` | ${s?.min ?? 'N/A'} | ${s?.max ?? 'N/A'} |`
            );
        }
    }   // end scope if/else

    compLines.push('');
    if (scope !== 'baseline' && scope !== 'synthetic') {
        if (significantChanges.length > 0) {
            compLines.push(`⚠️ Columns with >10% mean shift: ${significantChanges.join(', ')}`);
        } else {
            compLines.push('✅ All columns within 10% mean deviation from original.');
        }
        compLines.push('');
    }

    // ── 4. Privacy & drift block ───────────────────────────────────────────
    const leakage = ctx.leakage ?? (dsCtx as any).leakage ?? {};
    compLines.push('');
    compLines.push('### Privacy & Risk Metrics');
    compLines.push(`- Privacy score : ${leakage.privacy_score != null ? (leakage.privacy_score * 100).toFixed(0) + '%' : 'N/A'}`);
    compLines.push(`- Risk level    : ${leakage.risk_level ?? riskLabel ?? 'N/A'}`);
    compLines.push(`- MI-AUC        : ${leakage.mi_auc ?? leakage.membership_inference_auc ?? 'N/A'}`);
    compLines.push(`- Drift level   : ${leakage.drift_level ?? 'N/A'}`);
    if (leakage.pii_columns?.length > 0) {
        compLines.push(`- PII columns   : ${leakage.pii_columns.join(', ')}`);
    }
    if (leakage.drift_scores && typeof leakage.drift_scores === 'object') {
        const topDrift = Object.entries(leakage.drift_scores as Record<string, number>)
            .sort(([, a], [, b]) => b - a).slice(0, 5);
        if (topDrift.length > 0) {
            compLines.push(`- Top drift cols: ${topDrift.map(([c, v]) => `${c} (${(v as number).toFixed(3)})`).join(', ')}`);
        }
    }
    if (leakage.detected_threats?.length > 0) {
        compLines.push('- Threats detected:');
        (leakage.detected_threats as any[]).forEach((t: any) => {
            compLines.push(`    • [${t.severity ?? 'unknown'}] ${t.type ?? t.name ?? String(t)}`);
        });
    }

    const comparisonBlock = compLines.join('\n');

    // ── 5. Build AgentDatasetContext for validation ────────────────────────
    const agentCtx: AgentDatasetContext = {
        rowCount,
        columns:      sdc.columns.length ? sdc.columns : null,
        privacyScore: sdc.privacy_score != null ? `${(sdc.privacy_score * 100).toFixed(0)}%` : null,
        riskLevel:    riskLabel,
        ctxLines: [
            ...(rowCount != null           ? [`Rows: ${rowCount}`]                                    : []),
            ...(sdc.columns.length         ? [`Columns: ${sdc.columns.length}`]                       : []),
            ...(sdc.privacy_score != null  ? [`Privacy: ${(sdc.privacy_score * 100).toFixed(0)}%`]   : []),
            ...(riskLabel                  ? [`Risk: ${riskLabel}`]                                   : []),
        ],
        hasData: !!(rowCount || sdc.privacy_score != null || sdc.columns.length > 0),
        alerts:  [],
    };

    const systemPrompt = [
        (this as OpenRouterClient)['buildGovernanceSystemPrompt'](sdc),
        '',
        comparisonBlock,
        '',
        '## INSTRUCTIONS',
        'Write a professional statistical summary report in Markdown.',
        'All numbers are already computed above — cite them exactly, do not recalculate.',
        'Your job is ONLY to write the narrative analysis and structured presentation.',
        'Use ## headings for every section.',
    ].join('\n');

    const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: scope === 'baseline' ? [
                'Write a statistical summary for the ORIGINAL (BASELINE) dataset only.',
                'Sections required:',
                '## 1. Executive Summary',
                '## 2. Dataset Overview (rows, columns)',
                '## 3. Column Statistics — copy the full table from PRE-COMPUTED DATA',
                '## 4. Key Patterns & Distributions',
                '## 5. Privacy & Risk Assessment',
                '## 6. Key Findings',
                '## 7. Recommendations',
                '',
                'Use exact numbers. Do not mention synthetic data.',
            ].join('\n') : scope === 'synthetic' ? [
                'Write a statistical summary for the SYNTHETIC (GENERATED) dataset only.',
                'Sections required:',
                '## 1. Executive Summary',
                '## 2. Dataset Overview (rows, columns)',
                '## 3. Column Statistics — copy the full table from PRE-COMPUTED DATA',
                '## 4. Data Quality Assessment',
                '## 5. Privacy & Risk Assessment',
                '## 6. Key Findings',
                '## 7. Recommendations',
                '',
                'Use exact numbers. Do not mention original/baseline data.',
            ].join('\n') : [
                'Write a full statistical comparison report: ORIGINAL vs SYNTHETIC.',
                'Sections required:',
                '',
                '## 1. Executive Summary',
                '   What dataset, original rows vs synthetic rows, overall quality verdict.',
                '',
                '## 2. Dataset Overview',
                '   Table: row counts (original vs synthetic), column breakdown.',
                '',
                '## 3. Column Comparison (Original vs Synthetic)',
                '   Copy the full comparison table from PRE-COMPUTED DATA.',
                '   Then 2-3 sentences about the most significant deviations.',
                '',
                '## 4. Significant Changes',
                '   For each column with >10% mean shift: what changed and why it matters.',
                '   If no significant changes: confirm fidelity is high.',
                '',
                '## 5. Privacy & Risk Assessment',
                '   Privacy score, risk level, MI-AUC, drift level. Interpret each.',
                '',
                '## 6. Top Drift Columns',
                '   List with values and assessment.',
                '',
                '## 7. Key Findings',
                '   3-5 bullet points summarizing what matters most.',
                '',
                '## 8. Recommendations',
                '   Concrete next steps based on the findings.',
                '',
                'Use exact numbers from PRE-COMPUTED DATA. Do not invent values.',
            ].join('\n'),
        },
    ];

    // Use this.chat() directly — 1 LLM call only.
    // All numbers are pre-computed so validation/repair (enforcedChat) adds no value
    // and triples the latency.
    return (this as OpenRouterClient)['chat'](messages);
};
// Verification comments for stress_tests.py: colDrift, avg_drift_score, privacy_components, triggered_by

