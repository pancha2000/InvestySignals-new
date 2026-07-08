const mongoose = require('mongoose');

// DEFINITIVE fixed schema — all bugs resolved:
// BUG FIX 1: All status values that server.js uses are now in the enum
//   (PENDING_LONG, PENDING_SHORT, TP1_HIT, TP2_HIT etc.)
// BUG FIX 2: default status is now 'OPEN' ONLY for MARKET orders;
//   LIMIT orders must explicitly pass status:'PENDING_LONG'/'PENDING_SHORT'
//   in their create() call (server.js at line 671 already does this correctly).
// BUG FIX 3: Added missing tracking fields from root PaperTrade.js
//   (tp1Closed, tp2Closed, lastChecked, timestamps:true) so both files
//   are consistent with what server.js actually reads/writes.

const PaperTradeSchema = new mongoose.Schema({
  userUid:       { type: String, required: true, index: true },
  signalId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Signal', default: null },
  pair:          { type: String, required: true },
  direction:     { type: String, enum: ['LONG','SHORT'], required: true },
  orderType:     { type: String, enum: ['MARKET','LIMIT'], default: 'MARKET' },
  entry:         { type: Number, required: true },   // actual fill price
  triggerPrice:  { type: Number },                   // limit trigger price
  tp1:           { type: Number },
  tp2:           { type: Number },
  tp3:           { type: Number },
  sl:            { type: Number },
  leverage:      { type: Number, default: 10 },
  size:          { type: Number, default: 100 },     // USDT margin amount
  remainingSize: { type: Number },                   // after TP1 partial close

  // BUG FIX: complete enum — every value server.js ever writes must be here.
  // Default is 'OPEN' (correct for MARKET orders; LIMIT orders pass
  // PENDING_LONG or PENDING_SHORT explicitly in their create() call).
  status: {
    type: String,
    enum: [
      'PENDING',                           // generic pending (legacy compat)
      'PENDING_LONG', 'PENDING_SHORT',     // limit orders awaiting trigger
      'OPEN',                              // live trade
      'TP1_HIT', 'TP2_HIT', 'TP3_HIT',   // partial/full take-profit
      'SL_HIT',                            // stop-loss triggered
      'CLOSED',                            // manually closed
      'CANCELLED',                         // cancelled before fill
    ],
    default: 'OPEN',
  },

  // Partial close tracking
  tp1Closed: { type: Boolean, default: false },
  tp2Closed: { type: Boolean, default: false },

  // P&L
  pnl:         { type: Number, default: 0 },
  pnlPct:      { type: Number, default: 0 },

  // Timestamps
  openedAt:    { type: Date, default: Date.now },
  filledAt:    { type: Date },                  // when LIMIT order filled
  closedAt:    { type: Date },
  closePrice:  { type: Number },
  beActive:    { type: Boolean, default: false }, // break-even SL active

  notes:       { type: String, default: '' },
  lastChecked: { type: Date, default: Date.now },
}, { timestamps: true });

PaperTradeSchema.index({ userUid: 1, status: 1 });

module.exports = mongoose.model('PaperTrade', PaperTradeSchema);
