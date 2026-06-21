/**
 * ════════════════════════════════════════════════════════════════════════
 *  ai_agent.js
 * ────────────────────────────────────────────────────────────────────────
 *  InvestySignals — The Hybrid Autonomous AI Agent ("Quant Analyst Copilot")
 *
 *  WHAT THIS FILE DOES
 *  This is the brain of the new AI layer. It wraps a Groq LLM (via
 *  LangChain.js) with the 5 requested tools — each backed 1:1 by
 *  market_tools.js — runs a bullet-proof tool-calling loop, and streams
 *  the result to the browser over Server-Sent Events (SSE), token-by-token,
 *  the moment the model starts producing its real answer.
 *
 *  "CODE CALCULATES, AI REASONS" is enforced STRUCTURALLY, not just by
 *  prompt wording: every number the model can talk about (price, RSI,
 *  MACD, support/resistance, OI, funding, news) comes back from a tool
 *  call to market_tools.js, or from the pre-computed report context. The
 *  model is never asked to do arithmetic — only to read results and
 *  reason/decide/explain.
 *
 *  TWO CHAT MODES, ONE ENGINE:
 *    'trade_copilot' → side-panel chat on the dashboard. A `reportContext`
 *                       (the JSON the user is already looking at) is
 *                       injected so the agent can explain THIS trade
 *                       without re-fetching data it already has.
 *    'global_chat'   → the /ask-ai page. No pre-loaded report — the agent
 *                       must reach for its tools for every factual claim.
 *
 *  This file never touches Express routing — server.js only needs to call
 *  handleAgentChat({ res, ... }); this module owns the SSE response from
 *  there on.
 * ════════════════════════════════════════════════════════════════════════
 */

'use strict';

const { ChatGroq } = require('@langchain/groq');
const { DynamicStructuredTool } = require('@langchain/core/tools');
const { SystemMessage, HumanMessage, AIMessage, ToolMessage } = require('@langchain/core/messages');
const { z } = require('zod');
const marketTools = require('./market_tools');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ════════════════════════════════════════════════════════════════════════
// SECTION 1 — Configuration (every knob overridable via .env; sane defaults
//             so the agent works out of the box with zero extra config)
// ════════════════════════════════════════════════════════════════════════

/** Groq models confirmed to support tool-calling at the time of writing.
 *  Kept completely separate from server.js's existing deep-analysis model
 *  whitelist on purpose — we never touch that list, per the "don't remove
 *  or break anything existing" rule. This is a NEW, independent allow-list
 *  scoped only to the new agent. */
const ALLOWED_MODELS = [
  'llama-3.3-70b-versatile', // same default the rest of the app already uses — proven, fast, strong tool-use
  'llama-3.1-8b-instant',    // cheapest/fastest — good automatic fallback under heavy load
  'openai/gpt-oss-120b',     // strongest reasoning — best for nuanced "news overrides technicals" judgment calls
  'openai/gpt-oss-20b',
];

const DEFAULT_MODEL =
  process.env.GROQ_AGENT_MODEL && ALLOWED_MODELS.includes(process.env.GROQ_AGENT_MODEL)
    ? process.env.GROQ_AGENT_MODEL
    : 'llama-3.3-70b-versatile';

const DEFAULT_TEMPERATURE = Number.isFinite(parseFloat(process.env.GROQ_AGENT_TEMPERATURE))
  ? parseFloat(process.env.GROQ_AGENT_TEMPERATURE)
  : 0.4;

// NEW: repetition-prevention (see the BUG FIX note above ChatGroq's
// instantiation, and inside streamOneTurn, for the full root-cause story).
const FREQUENCY_PENALTY = Number.isFinite(parseFloat(process.env.GROQ_AGENT_FREQUENCY_PENALTY))
  ? parseFloat(process.env.GROQ_AGENT_FREQUENCY_PENALTY)
  : 0.4;
const PRESENCE_PENALTY = Number.isFinite(parseFloat(process.env.GROQ_AGENT_PRESENCE_PENALTY))
  ? parseFloat(process.env.GROQ_AGENT_PRESENCE_PENALTY)
  : 0.15;

const MAX_TOOL_ITERATIONS = parseInt(process.env.AI_MAX_TOOL_ITERATIONS || '5', 10);
// NEW: hard wall-clock ceiling for one ENTIRE chat turn (covers however many
// tool round-trips it takes). Protects against a rare hung Groq call or a
// slow tool leaving the user staring at a spinner forever — Nginx alone
// won't save us here since this VPS's proxy_read_timeout is intentionally
// generous (86400s) to support legitimate long SSE streams.
const MAX_TURN_MS = parseInt(process.env.AI_MAX_TURN_MS || '90000', 10);
const MAX_USER_MESSAGE_CHARS = parseInt(process.env.AI_MAX_USER_MESSAGE_CHARS || '2000', 10);
const MAX_RESPONSE_TOKENS = parseInt(process.env.AI_MAX_RESPONSE_TOKENS || '1000', 10);
const MAX_TOOL_RESULT_CHARS = parseInt(process.env.AI_MAX_TOOL_RESULT_CHARS || '6000', 10);
const MAX_REPORT_CONTEXT_CHARS = parseInt(process.env.AI_MAX_REPORT_CONTEXT_CHARS || '6000', 10);

// ---- Context Management: sliding-window memory truncation -----------
// This guarantees the LLM context window can NEVER overflow, no matter
// how long a single chat session runs.
const MAX_HISTORY_MESSAGES = parseInt(process.env.AI_MAX_HISTORY_MESSAGES || '20', 10);
const MAX_HISTORY_CHARS = parseInt(process.env.AI_MAX_HISTORY_CHARS || '16000', 10);

// ════════════════════════════════════════════════════════════════════════
// SECTION 2 — Small generic helpers (retry, capping, truncation, mapping)
// ════════════════════════════════════════════════════════════════════════

/**
 * Retry a Promise-returning function with exponential backoff — used only
 * around the Groq call itself. We deliberately do NOT add another retry
 * layer around individual tool calls here: market_tools.js already retries
 * every outbound Binance/news request internally, so stacking a second
 * retry layer on top would just compound worst-case latency (3 retries ×
 * 3 retries = 9 attempts) for a chat UX that needs to feel snappy. One
 * retry layer, in the right place, beats the most retry layers.
 */
async function withRetry(fn, { retries = 2, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.status || err?.response?.status || err?.cause?.status;
      // Retry on rate-limit / server errors / unknown (likely network) errors.
      // Do NOT retry on 4xx client errors (bad request, auth) — retrying those
      // just wastes the iteration budget on something that will never succeed.
      const retriable = status === 429 || (status >= 500 && status < 600) || !status;
      if (!retriable || attempt === retries) break;
      await sleep(baseDelayMs * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

/** Hard-cap a string so one oversized tool result or report can never blow
 *  the model's context budget. */
function capString(str, max) {
  if (typeof str !== 'string') return str;
  return str.length > max ? str.slice(0, max) + '…(truncated)' : str;
}

/**
 * Sliding-window + char-budget memory truncation. Keeps the conversation
 * feeling continuous (recent turns are always preserved) while guaranteeing
 * the prompt sent to Groq can never silently overflow the model's context
 * window, however long a user's chat history grows.
 */
function truncateHistory(history) {
  if (!Array.isArray(history)) return [];
  let trimmed = history.slice(-MAX_HISTORY_MESSAGES);
  let totalChars = trimmed.reduce((sum, m) => sum + (m && m.content ? String(m.content).length : 0), 0);
  while (totalChars > MAX_HISTORY_CHARS && trimmed.length > 0) {
    const removed = trimmed.shift(); // drop OLDEST first
    totalChars -= removed && removed.content ? String(removed.content).length : 0;
  }
  return trimmed;
}

function toLangchainMessage(m) {
  const content = typeof m?.content === 'string' ? m.content : String(m?.content || '');
  return m?.role === 'assistant' ? new AIMessage(content) : new HumanMessage(content);
}

/**
 * Compact the report JSON the dashboard's existing engine already
 * generated into a single context block for the Trade Copilot. This is a
 * straight pass-through of the SAME numbers the code already computed —
 * we never re-derive or re-summarize them — just capped so one giant
 * report can't blow the context budget.
 */
function buildReportContextBlock(reportContext) {
  if (!reportContext) return '';
  let json;
  try {
    json = JSON.stringify(reportContext);
  } catch (_) {
    json = String(reportContext);
  }
  return (
    '\n\n--- CURRENT TRADE REPORT (already computed by the platform\'s own engine — READ it, do not recompute it) ---\n' +
    capString(json, MAX_REPORT_CONTEXT_CHARS) +
    '\n--- END REPORT ---'
  );
}

// ════════════════════════════════════════════════════════════════════════
// SECTION 3 — Tools: the 5 requested DynamicStructuredTools, each a thin,
//             defensive wrapper 1:1 over market_tools.js. No tool here
//             ever throws past this boundary — failures become a JSON
//             error string the model can read and react to.
// ════════════════════════════════════════════════════════════════════════

function toToolResult(payload) {
  return capString(JSON.stringify(payload), MAX_TOOL_RESULT_CHARS);
}

const TOOLS = [
  new DynamicStructuredTool({
    name: 'scan_market',
    description:
      'Scan the entire Binance USDT market right now. Two modes: "top_movers" (default) returns coins ALREADY moving — highest volume / biggest gainers&losers, for "what should I watch today" or "what is pumping". "early_signals" returns coins that have NOT made a big move yet but show volatility compression (Bollinger Squeeze) and/or unusual incoming volume relative to their own recent history — for "find me something before it moves", "any coins about to break out", "catch something early". Use early_signals whenever the user wants to get in BEFORE a move rather than chase one that already happened.',
    schema: z.object({
      mode: z.enum(['top_movers', 'early_signals']).optional().describe('Defaults to "top_movers" if omitted.'),
    }),
    func: async ({ mode } = {}) => {
      try {
        const result = mode === 'early_signals' ? await marketTools.scanMarketSmart() : await marketTools.scanMarket();
        return toToolResult(result);
      } catch (err) {
        return toToolResult({ success: false, error: err.message || 'scan_market failed' });
      }
    },
  }),

  new DynamicStructuredTool({
    name: 'get_live_price',
    description:
      'Get the current real-time price for one coin on Binance. Use this whenever the user asks "what price is X at" or whenever you need a fresh, current price to ground your reasoning.',
    schema: z.object({
      symbol: z.string().describe('Coin ticker, e.g. "BTC", "ETH", "SOL". A USDT suffix is optional and added automatically.'),
    }),
    func: async ({ symbol } = {}) => {
      try {
        return toToolResult(await marketTools.getLivePriceSnapshot(symbol));
      } catch (err) {
        return toToolResult({ success: false, error: err.message || 'get_live_price failed' });
      }
    },
  }),

  new DynamicStructuredTool({
    name: 'get_technical_indicators',
    description:
      'Calculate technical indicators for a coin: RSI, MACD, EMA 20/50/200, Bollinger Bands, ATR, ADX, BOS/CHoCH market structure, candle pattern, volume ratio, and RSI divergence. Defaults to "multi", which returns 15m/1h/4h/1d all at once in a single call — prefer "multi" unless the user explicitly asks about one specific timeframe only, since it gives the most complete confluence picture for one tool call.',
    schema: z.object({
      symbol: z.string().describe('Coin ticker, e.g. "BTC", "SOL", "ETHUSDT".'),
      timeframe: z
        .enum(['15m', '1h', '4h', '1d', 'multi'])
        .optional()
        .describe('Chart timeframe. Defaults to "multi" (all 4 timeframes at once) if omitted.'),
    }),
    func: async ({ symbol, timeframe } = {}) => {
      try {
        return toToolResult(await marketTools.getTechnicalIndicators(symbol, timeframe));
      } catch (err) {
        return toToolResult({ success: false, error: err.message || 'get_technical_indicators failed' });
      }
    },
  }),

  new DynamicStructuredTool({
    name: 'get_market_structure',
    description:
      'Get smart-money market structure for a coin: Support/Resistance levels, Order Blocks, Fair Value Gaps (FVGs), Fibonacci retracement, Open Interest trend, Funding Rate, and the BTC macro-trend backdrop. Use this whenever the user asks WHY a level (entry/SL/TP/support/resistance) sits where it does, or asks about order blocks, FVGs, liquidity, funding, or open interest.',
    schema: z.object({
      symbol: z.string().describe('Coin ticker, e.g. "BTC", "SOL", "ETHUSDT".'),
    }),
    func: async ({ symbol } = {}) => {
      try {
        return toToolResult(await marketTools.getMarketStructure(symbol));
      } catch (err) {
        return toToolResult({ success: false, error: err.message || 'get_market_structure failed' });
      }
    },
  }),

  new DynamicStructuredTool({
    name: 'get_crypto_news',
    description:
      'Get the latest crypto news headlines. Pass a symbol to filter for that coin (e.g. "BTC"), or omit the symbol entirely for general crypto market headlines. ALWAYS check this before giving a confident directional opinion — a clean technical chart can be completely invalidated by a hack, depeg, regulatory action, or exchange insolvency that just broke. News/fundamentals must take priority over technicals when the two conflict.',
    schema: z.object({
      symbol: z.string().optional().describe('Optional coin ticker to filter news for, e.g. "BTC". Omit for general market-wide headlines.'),
    }),
    func: async ({ symbol } = {}) => {
      try {
        return toToolResult(await marketTools.getCryptoNews(symbol));
      } catch (err) {
        return toToolResult({ success: false, error: err.message || 'get_crypto_news failed' });
      }
    },
  }),
];

const TOOLS_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/** Execute a single tool call by name. Never throws — always resolves to a
 *  string (JSON success or JSON error) so a tool failure becomes something
 *  the model can read and react to ("the news API is down, proceeding on
 *  technicals alone") instead of crashing the whole chat turn.
 *
 *  IMPORTANT: uses tool.invoke(), not tool.func() directly. .invoke() runs
 *  the Zod schema (defined per-tool above) FIRST — coercing/validating the
 *  model's raw tool-call arguments before they ever reach market_tools.js.
 *  If Groq sends a slightly malformed argument (wrong type, missing field,
 *  extra junk), .invoke() catches it and we hand the model back a precise
 *  validation error it can read and self-correct from on the next turn —
 *  instead of either crashing, or silently passing bad data straight
 *  through to a Binance call that then fails in a confusing way. */
async function runTool(name, args) {
  const tool = TOOLS_BY_NAME[name];
  if (!tool) return toToolResult({ success: false, error: `Unknown tool "${name}".` });
  try {
    return await tool.invoke(args || {});
  } catch (err) {
    return toToolResult({ success: false, error: `Invalid arguments for ${name}: ${err.message || 'schema validation failed'}. Re-check the parameters and try again.` });
  }
}

/** Friendly, human-readable status line shown in the UI while a tool runs
 *  — this is the "Scanning the market…" loading-state the spec asked for. */
function statusLabelFor(toolName, args) {
  const sym = args && args.symbol ? String(args.symbol).toUpperCase().replace(/USDT$/, '') : '';
  switch (toolName) {
    case 'scan_market':
      return args && args.mode === 'early_signals'
        ? '⚡ Scanning for early-stage setups (squeeze + volume anomaly)…'
        : '🔍 Scanning the market for volatile, high-volume coins…';
    case 'get_live_price':
      return `💰 Fetching the live price for ${sym || 'that coin'}…`;
    case 'get_technical_indicators':
      return `📊 Crunching ${sym || ''} indicators (${(args && args.timeframe) || 'multi-timeframe'})…`;
    case 'get_market_structure':
      return `🧱 Mapping ${sym || ''} structure — S/R, order blocks, FVGs…`;
    case 'get_crypto_news':
      return sym ? `📰 Checking the latest ${sym} news…` : "📰 Checking today's crypto headlines…";
    default:
      return `⚙️ Running ${toolName}…`;
  }
}

// ════════════════════════════════════════════════════════════════════════
// SECTION 4 — System prompts (the "personality" + the hard safety rails)
// ════════════════════════════════════════════════════════════════════════

const CORE_RULES = `You are the InvestySignals AI Quant Analyst — a sharp, calm, no-hype crypto markets co-pilot built into the InvestySignals platform.

NON-NEGOTIABLE RULES:
1. CODE CALCULATES, YOU REASON. Every number you mention — price, RSI, MACD, EMA, support/resistance, order blocks, funding rate, open interest — must come from a tool result or the report context given to you. Never invent, estimate, or mentally calculate a number yourself. If you need a number you don't already have, call the right tool for it first.
2. NEWS OVERRIDES TECHNICALS. Technical indicators only describe historical price action. If get_crypto_news (or the user) surfaces a real fundamental risk — a hack, depeg, exchange insolvency, lawsuit, regulatory ban, mass liquidation cascade — that conflicts with bullish/bearish technicals, you must say so plainly and let that override the technical read. A clean chart never excuses ignoring a live red flag.
3. NEVER FABRICATE. If a tool fails or data is missing, say so honestly and work with what you do have — never pretend you checked something you didn't.
4. BE CONCISE. Most users are on a phone. Lead with the answer. Use short paragraphs, and use markdown formatting (bold for key numbers/levels, short bullet lists for multi-point breakdowns) only where it genuinely helps scanning — don't over-format simple answers.
5. RISK FIRST. You may share a directional read when asked, but frame it around risk management (position sizing, invalidation levels, what would change your mind) rather than hype or certainty. You are not a financial advisor and you don't place trades — let that come through in tone, without repeating a disclaimer in every single message.
6. LANGUAGE. Always reply in the same language the user just wrote in (English, Sinhala, or otherwise) — match them naturally.
7. NEVER REPEAT YOURSELF. State each point exactly once. Do not restate the same sentence, conclusion, or paragraph in different words within one answer — if you notice yourself about to repeat a point already made, stop and move on instead.`;

const TRADE_COPILOT_ADDENDUM = `
MODE: Trade Copilot (side panel). The user is currently looking at a specific trade report, included below — it already contains the entry, stop-loss, take-profit levels and the platform's own confluence reasoning. Use that data directly to answer "why is my SL here" / "why this entry" style questions instead of re-deriving it. Only call a tool if the user asks about a different coin, explicitly wants a fresher real-time check, or asks something the report doesn't cover — get_crypto_news is a good example of something genuinely worth fetching fresh even in this mode, since the report is a price/structure snapshot and contains no headlines.`;

const GLOBAL_CHAT_ADDENDUM = `
MODE: Global Market Chat (full page, "Crypto ChatGPT"). There is no pre-loaded report here — you're starting from zero for every new symbol or claim. Proactively reach for your tools (scan_market, get_live_price, get_technical_indicators, get_market_structure, get_crypto_news) before stating anything factual about price, trend, or news. Never guess.`;

function buildSystemPrompt(mode, reportContext) {
  if (mode === 'trade_copilot') {
    return CORE_RULES + '\n' + TRADE_COPILOT_ADDENDUM + buildReportContextBlock(reportContext);
  }
  return CORE_RULES + '\n' + GLOBAL_CHAT_ADDENDUM;
}

// ════════════════════════════════════════════════════════════════════════
// SECTION 5 — SSE transport helper. Every AI response in this app streams
//             over this single chokepoint.
// ════════════════════════════════════════════════════════════════════════

function createSSEStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // tells Nginx not to buffer this response — see nginx.conf notes in the deploy summary
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  return {
    send(event, data) {
      if (closed) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch (_) {
        closed = true;
      }
    },
    end() {
      if (!closed) {
        try {
          res.end();
        } catch (_) {
          /* socket already gone — nothing to do */
        }
      }
      closed = true;
    },
    isClosed() {
      return closed;
    },
  };
}

// ════════════════════════════════════════════════════════════════════════
// SECTION 6 — One model turn. TRUE token-by-token streaming whenever the
//             model is producing its final answer; silent accumulation
//             whenever it's only forming a tool call (there is nothing to
//             show the user in that case — a friendly 'status' event is
//             sent separately once we know which tool is running).
// ════════════════════════════════════════════════════════════════════════

/**
 * Stream ONE model turn and return the gathered AIMessageChunk.
 *
 * BUG FIX (repeated/duplicated answers): Groq's tool-calling models
 * sometimes emit ordinary `content` ALONGSIDE `tool_calls` in the very
 * same message (a "lead-in" sentence before deciding to call a tool), and
 * the agent loop can also run several iterations back-to-back when
 * multiple tool calls are needed. The OLD code streamed `content` to the
 * user the moment ANY content chunk arrived — with no way to know yet
 * whether THIS iteration would turn out to be a tool call. The result:
 * a "thinking out loud" preamble got shown as if it were the answer, then
 * the model's REAL final answer (after seeing tool results) streamed
 * again afterwards — landing in the same chat bubble as a near-identical,
 * repeated paragraph.
 *
 * THE FIX: buffer this iteration's content chunks silently while
 * streaming. Only once the stream finishes do we know for certain whether
 * `tool_calls` ended up non-empty:
 *   - tool_calls present  → this was just a lead-in; DISCARD the buffer,
 *                            nothing is shown to the user for this iteration.
 *   - tool_calls empty    → this IS the genuine final answer; replay the
 *                            buffered text to the user as a fast, smooth
 *                            "typing" stream (small word-sized chunks),
 *                            so the live-streaming feel is preserved for
 *                            the one piece of content that actually matters.
 */
async function streamOneTurn(boundModel, messages, sse) {
  let stream;
  try {
    stream = await withRetry(() => boundModel.stream(messages), { retries: 2, baseDelayMs: 600 });
  } catch (err) {
    console.error('[ai_agent] Groq stream() failed to start:', err.message);
    throw new Error('AI_UPSTREAM_UNAVAILABLE');
  }

  let gathered;
  let buffer = '';
  try {
    for await (const chunk of stream) {
      gathered = gathered === undefined ? chunk : gathered.concat(chunk);
      if (chunk.content) buffer += chunk.content; // buffered, NOT sent yet — see fix note above
      if (sse.isClosed()) break; // client navigated away — stop burning tokens/CPU
    }
  } catch (midStreamErr) {
    console.error('[ai_agent] stream interrupted mid-turn:', midStreamErr.message);
    if (!sse.isClosed()) sse.send('status', { label: '⚠️ Connection hiccup — wrapping up with what we have…' });
  }

  gathered = gathered || { content: '', tool_calls: [] };
  const isToolCallTurn = gathered.tool_calls && gathered.tool_calls.length > 0;

  if (!isToolCallTurn && buffer && !sse.isClosed()) {
    // Genuine final answer — replay it as small word-chunks with a tiny
    // delay so it still reads as a live "typing" stream on the frontend,
    // even though we deliberately waited for the full generation first.
    // Groq's inference is fast enough that this adds negligible delay.
    const words = buffer.match(/\S+\s*/g) || [buffer];
    for (let i = 0; i < words.length; i += 3) {
      if (sse.isClosed()) break;
      sse.send('token', { text: words.slice(i, i + 3).join('') });
      await sleep(12);
    }
  }
  // isToolCallTurn === true → buffer is intentionally discarded here.
  // gathered.content still holds the raw text internally (LangChain keeps
  // it on the AIMessage pushed into history below), which is fine — the
  // model is allowed to see its own prior lead-in text in context, we just
  // never SHOW that lead-in to the user as if it were a real answer.

  return gathered;
}

// ════════════════════════════════════════════════════════════════════════
// SECTION 7 — Main entry point: the full bullet-proof agent loop
// ════════════════════════════════════════════════════════════════════════

/**
 * Run one user turn end-to-end and stream the result over SSE.
 *
 * @param {object}   opts
 * @param {object}   opts.res            Express response — this module owns
 *                                        the SSE headers + writes from here on.
 * @param {'trade_copilot'|'global_chat'} opts.mode
 * @param {Array<{role:'user'|'assistant', content:string}>} [opts.history]
 * @param {string}   opts.userMessage
 * @param {object|null} [opts.reportContext]  Only meaningful for 'trade_copilot'.
 * @param {string}   [opts.modelName]    Overrides DEFAULT_MODEL (validated
 *                                        against ALLOWED_MODELS — silently
 *                                        falls back if not recognized).
 * @param {number}   [opts.temperature]
 */
async function handleAgentChat({ res, mode, history, userMessage, reportContext, modelName, temperature, apiKey }) {
  const sse = createSSEStream(res);
  const resolvedKey = apiKey || process.env.GROQ_API_KEY;

  try {
    if (!resolvedKey) {
      sse.send('error', { message: 'The AI service is not configured on this server (missing GROQ_API_KEY).' });
      return;
    }
    if (typeof userMessage !== 'string' || !userMessage.trim()) {
      sse.send('error', { message: 'Please enter a message.' });
      return;
    }
    if (userMessage.length > MAX_USER_MESSAGE_CHARS) {
      sse.send('error', { message: `That message is a bit long — please keep it under ${MAX_USER_MESSAGE_CHARS} characters.` });
      return;
    }

    const safeModel = modelName && ALLOWED_MODELS.includes(modelName) ? modelName : DEFAULT_MODEL;
    const safeTemp = Number.isFinite(temperature) ? Math.min(Math.max(temperature, 0), 1) : DEFAULT_TEMPERATURE;

    const baseModel = new ChatGroq({
      apiKey: resolvedKey,
      model: safeModel,
      temperature: safeTemp,
      maxTokens: MAX_RESPONSE_TOKENS,
      // BUG FIX (repeated/duplicated answers, part 2): without a frequency
      // penalty, Llama-family models — especially when generating in a
      // lower-resource language like Sinhala, where the model is far less
      // fluent/confident than in English — can fall into a verbatim
      // repetition loop, restating the same sentence 3-4+ times in one
      // response. A modest frequencyPenalty directly discourages repeating
      // the same tokens/phrases; a small presencePenalty nudges the model
      // to keep moving forward rather than circling the same point.
      frequencyPenalty: FREQUENCY_PENALTY,
      presencePenalty: PRESENCE_PENALTY,
    });
    const modelWithTools = baseModel.bindTools(TOOLS);

    const messages = [
      new SystemMessage(buildSystemPrompt(mode, reportContext)),
      ...truncateHistory(history).map(toLangchainMessage),
      new HumanMessage(userMessage.trim()),
    ];

    let finalContent = '';
    let iterations = 0;
    const turnDeadline = Date.now() + MAX_TURN_MS;
    let timedOut = false;

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations += 1;
      if (Date.now() > turnDeadline) { timedOut = true; break; } // wall-clock safety valve
      const gathered = await streamOneTurn(modelWithTools, messages, sse);

      if (gathered.tool_calls && gathered.tool_calls.length > 0) {
        messages.push(gathered);
        for (const call of gathered.tool_calls) {
          if (sse.isClosed()) return;
          sse.send('status', { label: statusLabelFor(call.name, call.args) });
          const resultStr = await runTool(call.name, call.args);
          sse.send('tool_done', { tool: call.name });
          messages.push(new ToolMessage({ content: resultStr, tool_call_id: call.id, name: call.name }));
        }
        continue; // let the model read the tool results and decide what's next
      }

      finalContent = gathered.content || '';
      break; // already streamed live inside streamOneTurn — nothing more to send
    }

    if (!finalContent && (iterations >= MAX_TOOL_ITERATIONS || timedOut)) {
      // Safety valve: force a tool-free final answer so the user is never
      // left with a blank reply if the model gets stuck repeatedly calling tools,
      // or if the turn ran past its wall-clock budget.
      sse.send('status', { label: '✍️ Wrapping up…' });
      messages.push(new SystemMessage('You now have enough information. Give your final, concise answer to the user. Do not call any more tools.'));
      const forced = await streamOneTurn(baseModel, messages, sse);
      finalContent = forced.content || '';
      if (!finalContent) {
        sse.send('token', {
          text: "I wasn't able to pin that down with the data available right now — could you try rephrasing, or ask about a specific coin?",
        });
      }
    }
  } catch (err) {
    console.error('[ai_agent] fatal error in handleAgentChat:', err);
    if (!sse.isClosed()) {
      sse.send('error', {
        message:
          err && err.message === 'AI_UPSTREAM_UNAVAILABLE'
            ? 'The AI service is busy right now — please try again in a few seconds.'
            : 'Something went wrong generating that response. Please try again.',
      });
    }
  } finally {
    if (!sse.isClosed()) sse.send('done', {});
    sse.end();
  }
}

// ════════════════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════════════════

module.exports = {
  handleAgentChat,
  ALLOWED_MODELS,
  DEFAULT_MODEL,
  // exported for reuse / unit testing
  truncateHistory,
  buildSystemPrompt,
};
