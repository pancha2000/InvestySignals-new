/**
 * ⚠️⚠️⚠️ THIS FILE IS NOT CURRENTLY USED ⚠️⚠️⚠️
 *
 * server.js defines its OWN inline schema (`paperTradeSchema2`, near the
 * "PAPER TRADING API" section header) and never `require()`s this file.
 * The live PaperTrade model in production is `paperTradeSchema2`, NOT
 * the schema below.
 *
 * This was discovered after several fields (entryAtr, confluenceScore,
 * grade, riskPct, sizingMethod) were added HERE by mistake across
 * multiple edits and silently never persisted — Mongoose drops any field
 * not declared in the schema actually registered for a model name, with
 * no error. The real fix each time was adding the field to
 * `paperTradeSchema2` in server.js instead.
 *
 * If you want this file to become the real source of truth, you'd need to:
 *   1. Add ALL fields paperTradeSchema2 has that this one is missing
 *      (uid, id, entryPrice, entryType, openTime, fillTime, filledAt,
 *      closeTime, totalPnl, totalRoe, tp1Pnl, tp1HitPrice, tp1HitTime,
 *      currentSl, trailOffset, notional, liqPrice, roe) — several of
 *      these (currentSl, trailOffset especially) are actively used by
 *      the trailing-stop logic in runTPSLCheck.
 *   2. Change server.js's PT constant to `require('./models/PaperTrade')`
 *      instead of defining paperTradeSchema2 inline.
 *   3. Test thoroughly — this is a live financial-data schema.
 * Until that migration happens, EDIT paperTradeSchema2 IN SERVER.JS,
 * not this file.
 */
const mongoose = require('mongoose');

const PaperTradeSchema = new mongoose.Schema({
  userUid:       { type: String, required: true, index: true },
  signalId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Signal' },
  pair:          { type: String, required: true },
  direction:     { type: String, enum: ['LONG','SHORT'], required: true },
  orderType:     { type: String, enum: ['MARKET','LIMIT'], default: 'MARKET' },
  entry:         { type: Number, required: true },
  triggerPrice:  { type: Number },
  tp1:           { type: Number },
  tp2:           { type: Number },
  tp3:           { type: Number },
  sl:            { type: Number },
  leverage:      { type: Number, default: 10 },
  size:          { type: Number, default: 100 },   // USDT amount
  remainingSize: { type: Number },
  sizingMethod:  { type: String, enum: ['MANUAL', 'RISK_BASED'], default: 'MANUAL' }, // NEW
  riskPct:       { type: Number }, // NEW — % of balance risked, only set when sizingMethod=RISK_BASED
  // NEW: captured from the analysis that produced this trade's SL/TP —
  // used to give Break-Even a sensible noise buffer instead of an exact
  // entry-price stop (see runTPSLCheck's TP1 handling in server.js).
  entryAtr:      { type: Number },
  // NEW: captured from the analysis that produced this trade — lets us
  // answer "does a higher confluenceScore actually predict a higher win
  // rate" with real numbers instead of assuming the ICT/SMC scoring
  // works. See GET /api/admin/signal-performance.
  confluenceScore: { type: Number },
  grade:           { type: String }, // 'S'|'A'|'B'|'C' at the time this trade was opened
  // NEW: LIMIT orders expire after this time instead of staying pending
  // forever — set at creation time (see POST /api/paper/trade).
  expiresAt:     { type: Date },
  // FIX BUG 1: Added 'PENDING' to enum so LIMIT orders don't fail validation
  status: {
    type: String,
    enum: ['PENDING','PENDING_LONG','PENDING_SHORT','OPEN','TP1_HIT','TP2_HIT','TP3_HIT','SL_HIT','CLOSED','CANCELLED'],
    default: 'OPEN'
},
  pnl:       { type: Number, default: 0 },
  pnlPct:    { type: Number, default: 0 },
  openedAt:  { type: Date, default: Date.now },
  filledAt:  { type: Date },
  closedAt:  { type: Date },
  closePrice:{ type: Number },
  beActive:  { type: Boolean, default: false },   // Break-even SL active
  notes:     { type: String, default: '' }
});

module.exports = mongoose.model('PaperTrade', PaperTradeSchema);
