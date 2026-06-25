const mongoose = require('mongoose');

// Stores one backtest job: the request params, its running/completed/failed
// status (jobs run in the background — see server.js's /api/backtest/run),
// the aggregate summary, and the full simulated-trade list for the trade
// table on the backtest.html page.
const BacktestTradeSchema = new mongoose.Schema({
  openTime:    { type: Date },
  closeTime:   { type: Date },
  direction:   { type: String, enum: ['LONG', 'SHORT'] },
  entry:       Number,
  sl:          Number,
  tp1:         Number,
  tp2:         Number,
  tp3:         Number,
  exitPrice:   Number,
  exitReason:  { type: String, enum: ['TP1', 'TP2', 'TP3', 'SL', 'TIMEOUT'] },
  rMultiple:   Number,
  score:       Number,
  grade:       { type: String, enum: ['S', 'A', 'B', 'C'] },
}, { _id: false });

const BacktestRunSchema = new mongoose.Schema({
  symbol:        { type: String, required: true },
  timeframe:     { type: String, default: '4h' },
  candleCount:   { type: Number, default: 1000 },
  status:        { type: String, enum: ['running', 'completed', 'failed'], default: 'running' },
  progressPct:   { type: Number, default: 0 },
  mode:          { type: String, enum: ['fullhistory', 'walkforward'], default: 'fullhistory' },
  error:         { type: String, default: '' },
  startedAt:     { type: Date, default: Date.now },
  completedAt:   { type: Date },
  requestedBy:   { type: String, default: '' }, // admin uid who triggered it
  summary: {
    totalTrades:   { type: Number, default: 0 },
    wins:          { type: Number, default: 0 },
    losses:        { type: Number, default: 0 },
    timeouts:      { type: Number, default: 0 },
    winRate:       { type: Number, default: 0 },
    profitFactor:  { type: Number, default: 0 },
    avgR:          { type: Number, default: 0 },
    totalR:        { type: Number, default: 0 },
    maxDrawdownR:  { type: Number, default: 0 },
    byGrade:       { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  trades: { type: [BacktestTradeSchema], default: [] },
  walkForwardResult: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });

BacktestRunSchema.index({ createdAt: -1 });

module.exports = mongoose.model('BacktestRun', BacktestRunSchema);
