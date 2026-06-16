'use strict';
// ============================================================
//  ai_agent.js — SIGMA Autonomous Agent v2.1
//  RESTORED: Thesis Tracking + Early Warning awareness
// ============================================================

const { ChatGroq }               = require('@langchain/groq');
const { createToolCallingAgent, AgentExecutor } = require('langchain/agents');
const { ChatPromptTemplate, MessagesPlaceholder } = require('@langchain/core/prompts');
const { getAllTools }             = require('./market_tools');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── RESTORED: Thesis state per user+coin ─────────────────────
const thesisState       = new Map();
const CONFLUENCE_THRESHOLD = 5;

// ============================================================
//  SIGMA SYSTEM PROMPT
// ============================================================
const SIGMA_SYSTEM_PROMPT = `You are SIGMA — an elite institutional crypto futures analyst (Smart Money Concepts, Order Flow, multi-timeframe).

## MANDATORY DATA COLLECTION — call ALL tools in order:
1. get_live_price          → current price
2. get_technical_indicators (1d)  → macro
3. get_technical_indicators (4h)  → structure
4. get_technical_indicators (1h)  → momentum
5. get_technical_indicators (15m) → entry timing
6. get_order_blocks (4h)          → HTF institutional zones
7. get_order_blocks (1d)          → macro zones
8. get_market_structure           → BOS/CHoCH + BTC trend + Early Warnings
9. get_funding_and_oi             → derivative sentiment + OI history

Do NOT skip any tool. Each provides unique data.

## OUTPUT FORMAT (follow exactly):

### 📊 MARKET OVERVIEW
Price, 24h change, BTC trend context.

### 🔄 THESIS STATUS
State the THESIS_STATUS value from the input. Explain what CONFIRMED/RETRACEMENT/WEAKENING/INVALIDATED means for this trade.

### 🏗️ STRUCTURAL ANALYSIS
D1 + H4 BOS/CHoCH. HTF bias clearly stated with levels.

### 📈 TECHNICAL CONFLUENCE
- RSI across 1D/4H/1H/15M + any divergence
- MACD histogram direction 4H + 1H
- EMA stack (FULL_BULL_STACK / FULL_BEAR_STACK / mixed)
- Bollinger Bands %B + squeeze
- ADX strength
- Volume spike (from 15M/1H data)
- Candle pattern on 15M
- Previous Day High/Low as S/R context

### 🎯 INSTITUTIONAL ZONES
Key OBs (exact price range), FVGs, Fibonacci 38.2/50/61.8, S/R clusters.

### 💰 DERIVATIVE SENTIMENT
Funding rate, OI trend (RISING/FALLING), OI signal (BULLISH_CONTINUATION / SHORT_SQUEEZE etc.), L/S ratio.

### ⚠️ EARLY WARNINGS
If earlyWarningsCount > 0 from get_market_structure: list each one prominently.

### ⚡ TRADE SETUP
**Direction**: LONG / SHORT / NO_TRADE
**Entry Zone**: $X — $X (must be at OB/FVG/Fib confluence)
**Stop Loss**: $X (ATR-based, below/above structure)
**TP1**: $X (1.5-2R)
**TP2**: $X (2.5-3R)
**TP3**: $X (4R+)
**Leverage**: conservative suggestion
**Confluence Score**: X/10

### ⚠️ KEY RISKS
Specific invalidation factors.

---

## TRADING RULES (enforced):
- 4H RSI > 68 → NO LONG
- 4H RSI < 32 → NO SHORT
- Entry MUST have ≥2 confluence factors
- SL = below/above confirmed structure level + min 1× ATR
- TP R:R: TP1 ≥1.5:1, TP2 ≥2.5:1, TP3 ≥4:1
- ADX < 20 → label RANGING, reduce leverage 50%
- Funding > 0.05% + L/S > 1.3 → flag LONG SQUEEZE RISK
- HTF/LTF conflict → NO_TRADE
- Confluence score < ${CONFLUENCE_THRESHOLD}/10 → direction = NO_TRADE
- OI signal = SHORT_SQUEEZE → add SQUEEZE RISK warning
- OI signal = LONG_LIQUIDATION → add LIQUIDATION RISK warning
- If THESIS_STATUS = INVALIDATED → new direction required
- If THESIS_STATUS = WEAKENING → direction must be NEUTRAL or match new structure

## SIGNALS JSON (REQUIRED — parsed by frontend):
<signals>
{{
  "direction": "LONG",
  "grade": "A",
  "confluenceScore": 7,
  "bias": "BULLISH",
  "thesisStatus": "NEW",
  "entryLow": 0.0,
  "entryHigh": 0.0,
  "stopLoss": 0.0,
  "tp1": 0.0,
  "tp2": 0.0,
  "tp3": 0.0,
  "leverage": "5-10x",
  "riskPerTrade": "1-2%",
  "summary": "Max 2-sentence thesis.",
  "keyRisk": "Primary invalidation factor."
}}
</signals>`;

// ============================================================
//  THESIS HELPERS
// ============================================================

/** Build thesis context string to inject into agent input */
function buildThesisContext(prevThesis) {
  if (!prevThesis || !prevThesis.ts) return '';
  const ageH = (Date.now() - prevThesis.ts) / 3600000;
  if (ageH > 6) return ''; // thesis older than 6h — treat as fresh

  return `
PREVIOUS ANALYSIS (${ageH.toFixed(1)}h ago):
  Direction: ${prevThesis.bias}
  Confluence Score: ${prevThesis.score}/10
  D1 Structure: ${prevThesis.d1Struct || 'UNKNOWN'}
  H4 Structure: ${prevThesis.h4Struct || 'UNKNOWN'}

THESIS INSTRUCTION:
After calling get_market_structure, compare the current D1 + H4 structures with the above.
Determine THESIS_STATUS:
  CONFIRMED   = both D1 and H4 match previous → keep bias unless score drops below ${CONFLUENCE_THRESHOLD}
  RETRACEMENT = D1 matches, H4 changed → explain as normal pullback, show Fib retrace levels
  WEAKENING   = D1 changed, H4 still matches → set bias NEUTRAL, warn user
  INVALIDATED = both D1 and H4 changed → reversal confirmed, give new direction

Always include THESIS_STATUS in the Thesis Status section and in the signals JSON.`;
}

// ============================================================
//  TOOL LABELS + PREVIEW BUILDERS
// ============================================================

function getToolLabel(name, input) {
  const sym = input?.symbol || '', tf = input?.timeframe || '';
  switch (name) {
    case 'get_live_price':            return `Fetching live price for ${sym}`;
    case 'get_technical_indicators':  return `Calculating RSI · MACD · EMA · BB · ATR · Volume · Candle Pattern on ${tf}`;
    case 'get_order_blocks':          return `Scanning Order Blocks + FVGs + Fibonacci on ${tf}`;
    case 'get_market_structure':      return `Analyzing BOS/CHoCH + BTC correlation + Early Warning System`;
    case 'get_funding_and_oi':        return `Fetching funding rate · OI history trend · L/S ratio`;
    default:                          return `Executing ${name}`;
  }
}

function getToolEmoji(name) {
  const map = {
    get_live_price:           '💲',
    get_technical_indicators: '📊',
    get_order_blocks:         '🎯',
    get_market_structure:     '🏗️',
    get_funding_and_oi:       '💰',
  };
  return map[name] || '🔧';
}

function buildPreview(parsed, name) {
  try {
    switch (name) {
      case 'get_live_price':
        return `$${parsed.price?.toLocaleString()} · ${parsed.change24h || ''} · Vol: ${parsed.volume24hUSDT ? '$' + (parsed.volume24hUSDT / 1e6).toFixed(0) + 'M' : 'N/A'}`;
      case 'get_technical_indicators':
        return `RSI ${parsed.rsi} (${parsed.rsiZone}) · MACD ${parsed.macd?.trend} · ${parsed.ema?.stack} · Vol spike: ${parsed.volumeRatio?.spike ? '⚠️ YES ' + parsed.volumeRatio?.ratio + 'x' : 'No'} · Pattern: ${parsed.candlePattern}`;
      case 'get_order_blocks':
        return `${parsed.bullishOrderBlocks?.length || 0} Bull OBs · ${parsed.bearishOrderBlocks?.length || 0} Bear OBs · ${parsed.fairValueGaps?.length || 0} FVGs · Fib: ${parsed.fibonacci?.direction || 'N/A'}`;
      case 'get_market_structure':
        return `Bias: ${parsed.overallBias} · ${parsed.timeframeAlignment} · BTC: ${parsed.btcTrend} · Warnings: ${parsed.earlyWarningsCount || 0}`;
      case 'get_funding_and_oi':
        return `Funding ${parsed.fundingRate ?? 'N/A'}% · OI: ${parsed.oiTrend} (${parsed.oiHistSignal}) · Signal: ${parsed.signal}`;
      default:
        return JSON.stringify(parsed).slice(0, 100);
    }
  } catch { return 'Data received ✓'; }
}

// ============================================================
//  SIGNALS EXTRACTION
// ============================================================

function extractSignals(rawOutput) {
  const match = rawOutput.match(/<signals>([\s\S]*?)<\/signals>/);
  if (!match) return null;
  try { return JSON.parse(match[1].trim()); } catch { return null; }
}

function stripSignalsBlock(text) {
  return text.replace(/<signals>[\s\S]*?<\/signals>/, '').trim();
}

// ============================================================
//  runAgentWithSSE — Main export
// ============================================================

/**
 * @param {string}   symbol   — e.g. "BTCUSDT"
 * @param {Function} onEvent  — (type, payload) => void
 * @param {string}   userId   — Firebase UID for thesis tracking (default 'anon')
 * @param {object}   settings — { apiKey, model, maxTokens, temperature } from globalSettings
 */
async function runAgentWithSSE(symbol, onEvent, userId = 'anon', settings = {}) {
  const coin = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const sym  = coin.endsWith('USDT') ? coin : coin + 'USDT';

  // — Thesis: get previous ─────────────────────────────────
  const thesisKey  = `${userId}:${sym}`;
  const prevThesis = thesisState.get(thesisKey) || null;
  const thesisCtx  = buildThesisContext(prevThesis);

  onEvent('status', { message: `🤖 SIGMA online — analyzing ${sym}`, phase: 'init' });
  if (prevThesis && thesisCtx) {
    onEvent('thesis', {
      status:       'PENDING',
      previousBias: prevThesis.bias,
      previousScore: prevThesis.score,
      ageH:         parseFloat(((Date.now() - prevThesis.ts) / 3600000).toFixed(1)),
    });
  }

  // — Build LLM ─────────────────────────────────────────────
  const apiKey  = settings.groq_api_key  || process.env.GROQ_API_KEY;
  const model   = settings.groq_model    || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const maxTok  = settings.groq_max_tokens   || parseInt(process.env.GROQ_MAX_TOKENS || '3500', 10);
  const temp    = settings.groq_temperature  || parseFloat(process.env.GROQ_TEMPERATURE || '0.1');

  if (!apiKey) {
    onEvent('error', { message: 'GROQ_API_KEY not configured', code: 'AUTH_ERROR' });
    throw new Error('GROQ_API_KEY missing');
  }

  const llm = new ChatGroq({ apiKey, model, temperature: temp, maxTokens: maxTok, streaming: true });

  const tools  = getAllTools();
  const prompt = ChatPromptTemplate.fromMessages([
    ['system', SIGMA_SYSTEM_PROMPT],
    ['human',  '{input}'],
    new MessagesPlaceholder('agent_scratchpad'),
  ]);

  const agent = createToolCallingAgent({ llm, tools, prompt });
  const executor = new AgentExecutor({
    agent, tools,
    maxIterations: 12,
    returnIntermediateSteps: true,
    handleParsingErrors: (err) => {
      console.warn('[SIGMA] parse error (continuing):', err.message?.slice(0, 80));
      return 'Parsing issue — continuing with available data.';
    },
    verbose: process.env.NODE_ENV === 'development',
  });

  // — Callbacks ─────────────────────────────────────────────
  let toolStep = 0;
  const toolLog = [];
  let capturedStructure = null; // for thesis saving

  const callbacks = [{
    async handleAgentAction(action) {
      toolStep++;
      const entry = {
        step: toolStep, tool: action.tool, input: action.toolInput,
        emoji: getToolEmoji(action.tool),
        label: getToolLabel(action.tool, action.toolInput),
        status: 'running', timestamp: new Date().toISOString(),
      };
      toolLog.push(entry);
      onEvent('tool_call', entry);
      console.log(`[SIGMA] ▶ Step ${toolStep}: ${action.tool}`);
    },

    async handleToolEnd(output) {
      const entry = toolLog[toolLog.length - 1];
      if (!entry) return;
      let preview = 'Done ✓', status = 'done';
      try {
        const parsed = JSON.parse(output);
        if (parsed.error) { preview = `⚠️ ${parsed.error}`; status = 'error'; }
        else {
          preview = buildPreview(parsed, entry.tool);
          // Capture market structure for thesis
          if (entry.tool === 'get_market_structure') capturedStructure = parsed;
        }
      } catch { preview = output.slice(0, 120); }
      entry.status = status; entry.preview = preview;
      onEvent('tool_result', { step: entry.step, tool: entry.tool, preview, status, emoji: entry.emoji });
    },

    async handleChainEnd(outputs) {
      if (outputs?.output) onEvent('status', { message: '📝 Synthesizing analysis...', phase: 'synthesizing' });
    },
  }];

  // — Run agent ─────────────────────────────────────────────
  let agentResult;
  onEvent('status', { message: `🔍 Calling market data tools for ${sym}...`, phase: 'running' });

  try {
    agentResult = await executor.invoke({
      input:
        `Perform a complete institutional-grade analysis of ${sym}.\n\n` +
        `Call ALL 5 tool types: get_live_price, get_technical_indicators (1d/4h/1h/15m), ` +
        `get_order_blocks (4h/1d), get_market_structure, get_funding_and_oi.\n\n` +
        (thesisCtx ? thesisCtx + '\n\n' : '') +
        `After all tools, write the full SIGMA analysis then end with the <signals> JSON block.`,
    }, { callbacks });

  } catch (err) {
    let code = 'AGENT_ERROR', msg = err.message || 'Unknown error';
    if (msg.includes('429') || msg.toLowerCase().includes('rate limit')) {
      code = 'RATE_LIMIT'; msg = '⚠️ Groq API rate limit. Please wait ~30s and try again.';
    } else if (msg.includes('timeout') || msg.includes('AbortError')) {
      code = 'TIMEOUT'; msg = '⚠️ Analysis timed out. Server busy — please retry.';
    }
    onEvent('error', { message: msg, code });
    throw err;
  }

  // — Post-process ──────────────────────────────────────────
  const rawOutput  = agentResult.output || '';
  const signals    = extractSignals(rawOutput);
  const cleanedText = stripSignalsBlock(rawOutput);

  // — RESTORED: Save thesis ─────────────────────────────────
  if (signals && capturedStructure) {
    thesisState.set(thesisKey, {
      bias:      signals.direction,
      score:     signals.confluenceScore || 0,
      d1Struct:  capturedStructure.structures?.['1d'] || 'UNKNOWN',
      h4Struct:  capturedStructure.structures?.['4h'] || 'UNKNOWN',
      ts:        Date.now(),
    });

    // Determine thesis status from signals JSON
    const thesisFinal = signals.thesisStatus || 'NEW';
    onEvent('thesis', {
      status:      thesisFinal,
      currentBias: signals.direction,
      previousBias: prevThesis?.bias || null,
      score:       signals.confluenceScore,
    });
  }

  // — Stream analysis text ──────────────────────────────────
  onEvent('status', { message: '📡 Streaming analysis...', phase: 'streaming' });
  const tokens = cleanedText.match(/\S+|\s+/g) || [];
  for (const tok of tokens) {
    onEvent('ai_token', { token: tok });
    if (tok.trim().length > 0) await sleep(7);
  }

  // — Emit signals ──────────────────────────────────────────
  if (signals) {
    onEvent('signals', { signals, symbol: sym });
    console.log(`[SIGMA] Signal: ${signals.direction} | Grade ${signals.grade} | Score ${signals.confluenceScore} | Thesis: ${signals.thesisStatus}`);
  }

  if (agentResult.intermediateSteps?.length)
    console.log(`[SIGMA] Completed ${agentResult.intermediateSteps.length} tool calls for ${sym}`);

  return { output: cleanedText, signals };
}

module.exports = { runAgentWithSSE, thesisState, SIGMA_SYSTEM_PROMPT };
