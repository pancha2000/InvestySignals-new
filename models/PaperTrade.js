const mongoose = require('mongoose');

const PaperTradeSchema = new mongoose.Schema({
  userUid:    { type: String, required: true, index: true },
  signalId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Signal' },
  pair:       { type: String, required: true },
  direction:  { type: String, enum: ['LONG','SHORT'], required: true },
  entry:      { type: Number, required: true },
  tp1:        { type: Number },
  tp2:        { type: Number },
  sl:         { type: Number },
  leverage:   { type: Number, default: 10 },
  size:       { type: Number, default: 100 },   // USDT amount
  status:     { type: String, enum: ['OPEN','PENDING_LONG','PENDING_SHORT','TP1_HIT','TP2_HIT','SL_HIT','CLOSED','CANCELLED'], default: 'OPEN' },
  pnl:        { type: Number, default: 0 },
  pnlPct:     { type: Number, default: 0 },
  openedAt:   { type: Date, default: Date.now },
  closedAt:   { type: Date },
  closePrice: { type: Number },
  notes:      { type: String, default: '' }
});

module.exports = mongoose.model('PaperTrade', PaperTradeSchema);
