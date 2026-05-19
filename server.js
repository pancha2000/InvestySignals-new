// ============================================================
//  InvestySignals — Backend Server (Fixed)
//  Node.js + Express + MongoDB + Firebase Admin + WebSocket
// ============================================================

'use strict';
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const mongoose   = require('mongoose');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const admin      = require('firebase-admin');

// ── Models ──────────────────────────────────────────────────
const Signal      = require('./models/Signal');
const User        = require('./models/User');
const PaperTrade  = require('./models/PaperTrade');
const Settings    = require('./models/Settings');
const Announcement = require('./models/Announcement');
const Report      = require('./models/Report');

// ── Firebase Admin Init ─────────────────────────────────────
try {
  const serviceAccount = require('./serviceAccount.json');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log('✅ Firebase Admin initialized');
} catch (err) {
  console.error('❌ Firebase Admin init failed:', err.message);
  process.exit(1);
}

// ── MongoDB Connect ──────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/investysignals')
  .then(async () => {
    console.log('✅ MongoDB connected');
    await loadSettingsFromDB();
  })
  .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

// ── Admin Emails — auto-promoted to 'admin' role on first login ──
const ADMIN_EMAILS = [
  'cdilrukshi52@gmail.com',
  // Add more admin emails here
];

// ── Global Platform Settings ──────────────────────────────────
const SETTINGS_DEFAULTS = {
  maintenance:        false,
  maintenanceMsg:     'We are making improvements. Please check back shortly.',
  allowRegistrations: true,
};
let globalSettings = { ...SETTINGS_DEFAULTS };

async function loadSettingsFromDB() {
  try {
    const docs = await Settings.find({});
    docs.forEach(d => { globalSettings[d.key] = d.value; });
    console.log('⚙️  Platform settings loaded from DB');
  } catch(e) {
    console.warn('⚠️  Could not load settings from DB, using defaults:', e.message);
  }
}

async function saveSettingToDB(key, value) {
  await Settings.findOneAndUpdate({ key }, { value }, { upsert: true, new: true });
}

// ── Express Setup ────────────────────────────────────────────
const app = express();

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || true,
  credentials: true
}));
app.use(express.json({ limit: '5mb' }));

// ── Rate Limiters ─────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' }
});

// FIX: Admin routes get a higher limit so bulk operations don't get throttled
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests.' }
});

// FIX: Register admin limiter BEFORE the general /api/ limiter
app.use('/api/admin/', adminLimiter);
app.use('/api/', apiLimiter);

// FIX: Block sensitive files from being served as static assets
const BLOCKED_STATIC = ['.env', 'serviceAccount.json', 'package.json', '.gitignore'];
app.use((req, res, next) => {
  const basename = path.basename(req.path);
  if (BLOCKED_STATIC.includes(basename)) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  next();
});

app.use(express.static(path.join(__dirname)));

// ── Auth Helpers ─────────────────────────────────────────────

// Promote user to admin if their email is in ADMIN_EMAILS
async function ensureAdminPromotion(uid, emailFromToken) {
  try {
    let user = await User.findOne({ uid });
    const email = (emailFromToken || '').toLowerCase();
    const isAdminEmail = ADMIN_EMAILS.includes(email);

    if (!user) {
      let displayName = '';
      try {
        const fb = await admin.auth().getUser(uid);
        displayName = fb.displayName || '';
      } catch(_) {}
      user = await User.create({
        uid, email, displayName,
        role: isAdminEmail ? 'admin' : 'user',
        plan: 'free'
      });
    } else {
      if (isAdminEmail && user.role !== 'admin') {
        await User.updateOne({ uid }, { role: 'admin', email });
        user.role = 'admin';
      }
    }
    return user;
  } catch(e) {
    return null;
  }
}

// ── verifyToken middleware ───────────────────────────────────
async function verifyToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (e) {
    res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

// ── verifyAdmin middleware (FIXED — no broken callback wrapping) ──
async function verifyAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    // 1. Verify Firebase token
    req.user = await admin.auth().verifyIdToken(token);
    const email = (req.user.email || '').toLowerCase();

    // 2. Get/create user record, auto-promote admin emails
    const u = await ensureAdminPromotion(req.user.uid, email);

    // 3. Check admin role
    if (!u || u.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    req.dbUser = u;
    next();
  } catch (e) {
    console.error('[verifyAdmin] error:', e.message);
    res.status(401).json({ success: false, error: 'Authentication failed' });
  }
}

// ============================================================
//  API ROUTES
// ============================================================

// ── Health check ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ok', time: new Date().toISOString() });
});

// ── Analysis — RSI from Binance klines ───────────────────────
app.get('/api/analysis', async (req, res) => {
  try {
    const pair      = (req.query.pair || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const tf        = (req.query.tf   || '1h').replace(/[^a-zA-Z0-9]/g, '');
    const limit     = 100; // need at least 14+1 candles for RSI

    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=${tf}&limit=${limit}`;
    const response = await fetch(url);
    if (!response.ok) {
      const err = await response.text();
      return res.status(502).json({ success: false, error: `Binance error: ${err}` });
    }
    const klines = await response.json();
    if (!Array.isArray(klines) || klines.length < 15) {
      return res.status(502).json({ success: false, error: 'Not enough candle data' });
    }

    // Closing prices
    const closes = klines.map(k => parseFloat(k[4]));

    // ── RSI(14) ──
    const period = 14;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff; else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      const g = diff > 0 ? diff : 0;
      const l = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + g) / period;
      avgLoss = (avgLoss * (period - 1) + l) / period;
    }
    const rs  = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = parseFloat((100 - 100 / (1 + rs)).toFixed(2));

    // ── MACD(12,26,9) ──
    function ema(data, n) {
      const k = 2 / (n + 1);
      let val = data.slice(0, n).reduce((a, b) => a + b, 0) / n;
      const out = [val];
      for (let i = n; i < data.length; i++) {
        val = data[i] * k + val * (1 - k);
        out.push(val);
      }
      return out;
    }
    const ema12    = ema(closes, 12);
    const ema26    = ema(closes, 26);
    const macdLine = ema12.slice(ema12.length - ema26.length).map((v, i) => v - ema26[i]);
    const signal9  = ema(macdLine, 9);
    const macd     = parseFloat(macdLine[macdLine.length - 1].toFixed(4));
    const macdSig  = parseFloat(signal9[signal9.length - 1].toFixed(4));
    const macdHist = parseFloat((macd - macdSig).toFixed(4));

    // ── Bollinger Bands(20, 2σ) ──
    const bbPeriod = 20;
    const bbCloses = closes.slice(-bbPeriod);
    const bbMiddle = bbCloses.reduce((a, b) => a + b, 0) / bbPeriod;
    const variance = bbCloses.reduce((a, c) => a + Math.pow(c - bbMiddle, 2), 0) / bbPeriod;
    const stdDev   = Math.sqrt(variance);
    const bbUpper  = parseFloat((bbMiddle + 2 * stdDev).toFixed(2));
    const bbLower  = parseFloat((bbMiddle - 2 * stdDev).toFixed(2));
    const bbMid    = parseFloat(bbMiddle.toFixed(2));
    const currentPrice = closes[closes.length - 1];

    res.json({
      success: true,
      pair, tf,
      price: parseFloat(currentPrice.toFixed(4)),
      rsi,
      macd: { macd, signal: macdSig, histogram: macdHist },
      bb:   { upper: bbUpper, middle: bbMid, lower: bbLower },
      data: { rsi, macd, signal: macdSig, histogram: macdHist, bbUpper, bbMid, bbLower }
    });
  } catch (err) {
    console.error('/api/analysis error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── User Status ──────────────────────────────────────────────
app.get('/api/user/status', async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid) return res.json({ success: false, error: 'uid required' });

    // Get email from Bearer token
    let tokenEmail = '';
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      try {
        const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
        tokenEmail = (decoded.email || '').toLowerCase();
      } catch(_) {}
    }

    const user = await ensureAdminPromotion(uid, tokenEmail);
    if (!user) return res.status(500).json({ success: false, error: 'Could not load user' });

    // FIX: track last login time
    await User.updateOne({ uid }, { lastLogin: new Date() });

    const isMaintenance = globalSettings.maintenance || user.maintenance;
    const maintMsg = globalSettings.maintenance
      ? globalSettings.maintenanceMsg
      : (user.maintenanceMsg || '');

    res.json({ success: true, status: {
      role:           user.role,
      plan:           user.plan,
      suspended:      user.suspended,
      suspendReason:  user.suspendReason,
      maintenance:    isMaintenance,
      maintenanceMsg: maintMsg,
      paperBalance:   user.paperBalance
    }});
  } catch (err) {
    console.error('user/status error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Signals (public) ─────────────────────────────────────────
app.get('/api/signals', async (req, res) => {
  try {
    const signals = await Signal.find({ active: true })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ success: true, signals, data: signals });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Active Announcement (public) ─────────────────────────────
app.get('/api/announcement', async (req, res) => {
  try {
    const now = new Date();
    const ann = await Announcement.findOne({
      active: true,
      showFrom: { $lte: now },
      $or: [{ showUntil: null }, { showUntil: { $gte: now } }]
    }).sort({ createdAt: -1 });
    res.json({ success: true, data: ann, announcement: ann });
  } catch (err) {
    res.json({ success: true, data: null, announcement: null });
  }
});

// ── Paper Trades ──────────────────────────────────────────────
async function getPaperTrades(req, res) {
  try {
    const token = (req.headers.authorization || '').slice(7);
    if (!token) return res.status(401).json({ success: false });
    const decoded = await admin.auth().verifyIdToken(token);
    const trades = await PaperTrade.find({ userUid: decoded.uid })
      .sort({ openedAt: -1 }).limit(100);
    res.json({ success: true, trades });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
app.get('/api/paper-trades', getPaperTrades);
app.get('/api/paper/trades', getPaperTrades);

app.get('/api/paper/balance', verifyToken, async (req, res) => {
  try {
    const user = await User.findOne({ uid: req.user.uid });
    res.json({ success: true, balance: user ? user.paperBalance : 1000 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/paper/trade', verifyToken, async (req, res) => {
  try {
    const { signalId, size } = req.body;
    const signal = await Signal.findById(signalId);
    if (!signal) return res.json({ success: false, error: 'Signal not found' });
    const user = await User.findOne({ uid: req.user.uid });
    const tradeSize = parseFloat(size) || 100;
    if (user && user.paperBalance < tradeSize) {
      return res.json({ success: false, error: 'Insufficient paper balance' });
    }
    const trade = await PaperTrade.create({
      userUid: req.user.uid,
      signalId: signal._id,
      pair: signal.pair,
      direction: signal.direction,
      entry: signal.entry,
      tp1: signal.tp1,
      tp2: signal.tp2,
      sl: signal.sl,
      leverage: signal.leverage,
      size: tradeSize,
      status: 'OPEN'
    });
    if (user) {
      await User.updateOne({ uid: req.user.uid }, { $inc: { paperBalance: -tradeSize } });
    }
    res.json({ success: true, trade });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// FIX: Paper trade CLOSE endpoint — was missing; open trades stuck forever
app.patch('/api/paper/trade/:id/close', verifyToken, async (req, res) => {
  try {
    const trade = await PaperTrade.findOne({ _id: req.params.id, userUid: req.user.uid });
    if (!trade) return res.status(404).json({ success: false, error: 'Trade not found' });
    if (trade.status !== 'OPEN') {
      return res.json({ success: false, error: 'Trade is already closed' });
    }

    // closePrice from body, or fall back to current entry price
    const closePrice = parseFloat(req.body.closePrice) || trade.entry;
    const priceDiff  = trade.direction === 'LONG'
      ? closePrice - trade.entry
      : trade.entry - closePrice;
    const pnlPct = (priceDiff / trade.entry) * trade.leverage * 100;
    const pnl    = parseFloat(((pnlPct / 100) * trade.size).toFixed(2));

    const closedTrade = await PaperTrade.findByIdAndUpdate(
      trade._id,
      { status: 'CLOSED', closePrice, closedAt: new Date(), pnl, pnlPct: parseFloat(pnlPct.toFixed(2)) },
      { new: true }
    );

    // Refund size + PnL to paper balance
    await User.updateOne({ uid: req.user.uid }, { $inc: { paperBalance: trade.size + pnl } });

    res.json({ success: true, trade: closedTrade });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── User Report Submission (public — no auth required) ────────
app.post('/api/reports', async (req, res) => {
  try {
    const { category, message, context, reporterUid, reporterEmail } = req.body;
    if (!category || !message || message.trim().length < 3) {
      return res.status(400).json({ success: false, error: 'Category and message are required' });
    }
    const allowed = ['signal_accuracy','technical_bug','inappropriate_content','other'];
    if (!allowed.includes(category)) {
      return res.status(400).json({ success: false, error: 'Invalid category' });
    }
    const report = await Report.create({
      category,
      message: message.trim().slice(0, 2000),
      context: (context || '').slice(0, 500),
      reporterUid:   reporterUid  || 'anonymous',
      reporterEmail: reporterEmail || '',
    });
    // Notify admin via WebSocket
    broadcastToAll({ type: 'new_report', reportId: report._id, category: report.category });
    res.json({ success: true, message: 'Report submitted. Thank you.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── User's own reports ────────────────────────────────────────
app.get('/api/my-reports', verifyToken, async (req, res) => {
  try {
    // FIX: use token UID instead of trusting query param uid
    const data = await Report.find({ reporterUid: req.user.uid })
      .sort({ createdAt: -1 }).limit(20);
    res.json({ success: true, data });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  ADMIN API ROUTES
// ============================================================

// ── Admin Stats ───────────────────────────────────────────────
app.get('/api/admin/stats', verifyAdmin, async (req, res) => {
  try {
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const [totalUsers, activeSignals, totalSignals, openTrades,
           proCount, eliteCount, adminCount, newUsersToday,
           closedSignals, openReports] = await Promise.all([
      User.countDocuments(),
      Signal.countDocuments({ active: true, status: 'ACTIVE' }),
      Signal.countDocuments(),
      PaperTrade.countDocuments({ status: 'OPEN' }),
      User.countDocuments({ plan: 'pro' }),
      User.countDocuments({ plan: 'elite' }),
      User.countDocuments({ role: 'admin' }),
      User.countDocuments({ createdAt: { $gte: todayStart } }),
      Signal.find({ status: { $in: ['TP1_HIT','TP2_HIT','SL_HIT'] } }).select('status pnl').lean(),
      Report.countDocuments({ status: 'open' }),
    ]);
    const wins   = closedSignals.filter(s => ['TP1_HIT','TP2_HIT'].includes(s.status)).length;
    const losses = closedSignals.filter(s => s.status === 'SL_HIT').length;
    const total  = wins + losses;
    const winRate = total > 0 ? ((wins/total)*100).toFixed(1) : 0;
    res.json({ success: true, stats: {
      totalUsers, activeSignals, totalSignals, openTrades,
      proCount, eliteCount, adminCount, newUsersToday,
      wins, losses, winRate, openReports
    }});
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin: List Users ─────────────────────────────────────────
app.get('/api/admin/users', verifyAdmin, async (req, res) => {
  try {
    const { skip=0, limit=200, plan, suspended } = req.query;
    const filter = {};
    if (plan) filter.plan = plan;
    if (suspended === 'true') filter.suspended = true;
    if (suspended === 'false') filter.suspended = { $ne: true };
    const [users, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip(+skip).limit(+limit),
      User.countDocuments(filter)
    ]);
    res.json({ success: true, users, total, data: users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin: Update User ────────────────────────────────────────
app.patch('/api/admin/users/:uid', verifyAdmin, async (req, res) => {
  try {
    const allowed = ['role','plan','suspended','suspendReason','maintenance','maintenanceMsg','paperBalance'];
    const update  = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    const user = await User.findOneAndUpdate({ uid: req.params.uid }, update, { new: true });
    if (!user) return res.json({ success: false, error: 'User not found' });
    // Sync suspend state to Firebase Auth
    if (update.suspended !== undefined) {
      try {
        await admin.auth().updateUser(req.params.uid, { disabled: update.suspended });
      } catch(_) {}
    }
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin: Delete User ────────────────────────────────────────
app.delete('/api/admin/users/:uid', verifyAdmin, async (req, res) => {
  try {
    const deleted = await User.findOneAndDelete({ uid: req.params.uid });
    if (!deleted) return res.status(404).json({ success: false, error: 'User not found' });
    try { await admin.auth().deleteUser(req.params.uid); } catch(_) {}
    res.json({ success: true, message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin: Signals ────────────────────────────────────────────
app.post('/api/signals', verifyAdmin, async (req, res) => {
  try {
    const body = { ...req.body };
    if (body.leverage) {
      body.leverage = parseInt(String(body.leverage).replace(/[^0-9]/g, '')) || 10;
    }
    const signal = await Signal.create(body);
    broadcastToAll({ type: 'new_signal', signal });
    res.json({ success: true, signal });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.patch('/api/signals/:id', verifyAdmin, async (req, res) => {
  try {
    const signal = await Signal.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!signal) return res.status(404).json({ success: false, error: 'Signal not found' });
    broadcastToAll({ type: 'signal_update', signal });
    res.json({ success: true, signal });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/signals/:id', verifyAdmin, async (req, res) => {
  try {
    await Signal.findByIdAndUpdate(req.params.id, { active: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin: Global Settings ────────────────────────────────────
app.get('/api/admin/settings', verifyAdmin, (req, res) => {
  res.json({ success: true, settings: globalSettings });
});

app.patch('/api/admin/settings', verifyAdmin, async (req, res) => {
  try {
    const allowed = ['maintenance','maintenanceMsg','allowRegistrations'];
    const saves = [];
    allowed.forEach(k => {
      if (req.body[k] !== undefined) {
        globalSettings[k] = req.body[k];
        saves.push(saveSettingToDB(k, req.body[k]));
      }
    });
    await Promise.all(saves);
    // Push maintenance changes to all clients
    if (req.body.maintenance !== undefined) {
      broadcastToAll({ type: 'maintenance', active: globalSettings.maintenance, message: globalSettings.maintenanceMsg });
    }
    res.json({ success: true, settings: globalSettings });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin: Announcements CRUD ─────────────────────────────────
app.get('/api/admin/announcements', verifyAdmin, async (req, res) => {
  try {
    const data = await Announcement.find().sort({ createdAt: -1 });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/announcements', verifyAdmin, async (req, res) => {
  try {
    const ann = await Announcement.create({ ...req.body, createdBy: req.dbUser.email || 'admin' });
    // Push to all connected clients
    if (ann.active) {
      broadcastToAll({ type: 'announcement', data: ann });
    }
    res.json({ success: true, data: ann });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.put('/api/admin/announcements/:id', verifyAdmin, async (req, res) => {
  try {
    const ann = await Announcement.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!ann) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: ann });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/announcements/:id', verifyAdmin, async (req, res) => {
  try {
    await Announcement.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin: Broadcast (WebSocket only — instant push) ─────────
app.post('/api/admin/broadcast', verifyAdmin, async (req, res) => {
  try {
    const { subject, message, audience, saveToDb } = req.body;
    if (!message) return res.json({ success: false, error: 'Message is required' });
    broadcastToAll({
      type:     'announcement',
      subject:  subject || 'Platform Announcement',
      message,
      audience: audience || 'All Users',
      time:     new Date().toISOString()
    });
    // Also persist to DB if requested
    if (saveToDb !== false) {
      await Announcement.create({
        title:     subject || 'Platform Announcement',
        message,
        audience:  audience || 'All Users',
        active:    true,
        createdBy: req.dbUser.email || 'admin'
      });
    }
    res.json({ success: true, message: 'Broadcast sent' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin: Reports CRUD ───────────────────────────────────────
// FIX: /unread-count MUST be registered BEFORE /:id — otherwise Express matches
// "unread-count" as the :id param and this route is never reached.
app.get('/api/admin/reports/unread-count', verifyAdmin, async (req, res) => {
  try {
    const count = await Report.countDocuments({ status: 'open', readByAdmin: false });
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/reports', verifyAdmin, async (req, res) => {
  try {
    const { status, skip=0, limit=50 } = req.query;
    const filter = status ? { status } : {};
    const [data, total, openCount] = await Promise.all([
      Report.find(filter).sort({ createdAt: -1 }).skip(+skip).limit(+limit),
      Report.countDocuments(filter),
      Report.countDocuments({ status: 'open' }),
    ]);
    res.json({ success: true, total, openCount, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/admin/reports/:id', verifyAdmin, async (req, res) => {
  try {
    const { status, adminNote, adminReply, readByAdmin } = req.body;
    const update = {};
    if (status)              update.status      = status;
    if (adminNote  !== undefined) update.adminNote   = adminNote;
    if (adminReply !== undefined) update.adminReply  = adminReply;
    if (readByAdmin !== undefined) update.readByAdmin = readByAdmin;
    if (status === 'resolved' || status === 'dismissed') {
      update.resolvedBy = req.dbUser.email || 'admin';
      update.resolvedAt = new Date();
    }
    const r = await Report.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!r) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: r });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/reports/:id', verifyAdmin, async (req, res) => {
  try {
    await Report.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin: Activity Log ───────────────────────────────────────
app.get('/api/reports/activity', verifyAdmin, async (req, res) => {
  try {
    const trades = await PaperTrade.find({}).sort({ openedAt: -1 }).limit(100);
    res.json({ success: true, trades });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Catch-all: serve HTML pages ───────────────────────────────
app.get('*', (req, res) => {
  const file = req.path.replace('/', '') || 'index.html';
  const safeName = path.basename(file);
  const fullPath = path.join(__dirname, safeName);
  res.sendFile(fullPath, err => {
    if (err) res.sendFile(path.join(__dirname, 'index.html'));
  });
});

// ============================================================
//  HTTP + WebSocket SERVER
// ============================================================

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

function broadcastToAll(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch(_) {}
    }
  });
}

// ── Binance WebSocket ─────────────────────────────────────────
const BINANCE_STREAM = 'wss://fstream.binance.com/stream?streams=' + [
  'btcusdt@ticker','ethusdt@ticker','bnbusdt@ticker',
  'solusdt@ticker','xrpusdt@ticker','adausdt@ticker',
  'dogeusdt@ticker','dotusdt@ticker'
].join('/');

let binanceWs = null;
let binanceReconnectTimer = null;

function connectBinance() {
  if (binanceWs) { try { binanceWs.terminate(); } catch(_) {} }
  console.log('🔌 Connecting to Binance WebSocket...');
  binanceWs = new WebSocket(BINANCE_STREAM);

  binanceWs.on('open', () => {
    console.log('✅ Binance WebSocket connected');
    if (binanceReconnectTimer) { clearTimeout(binanceReconnectTimer); binanceReconnectTimer = null; }
  });

  binanceWs.on('message', raw => {
    try {
      const parsed = JSON.parse(raw);
      const d = parsed.data;
      if (!d) return;
      broadcastToAll({ type: 'market_update', ticker: [{
        symbol: d.s,
        price:  parseFloat(d.c),
        change: parseFloat(d.P),
        high:   parseFloat(d.h),
        low:    parseFloat(d.l),
        volume: parseFloat(d.v)
      }]});
    } catch(_) {}
  });

  binanceWs.on('close', () => {
    console.log('⚠️  Binance WebSocket closed — reconnecting in 5s...');
    binanceReconnectTimer = setTimeout(connectBinance, 5000);
  });

  binanceWs.on('error', err => {
    console.error('Binance WS error:', err.message);
    try { binanceWs.terminate(); } catch(_) {}
  });
}

// ── Client WebSocket ──────────────────────────────────────────
wss.on('connection', async ws => {
  console.log('Client connected. Total:', wss.clients.size);
  try {
    const signals = await Signal.find({ active: true }).sort({ createdAt: -1 }).limit(20);
    ws.send(JSON.stringify({ type: 'signals_update', signals }));
    // Send active announcement
    const now = new Date();
    const ann = await Announcement.findOne({
      active: true,
      showFrom: { $lte: now },
      $or: [{ showUntil: null }, { showUntil: { $gte: now } }]
    }).sort({ createdAt: -1 });
    if (ann) ws.send(JSON.stringify({ type: 'announcement', data: ann }));
  } catch(_) {}
  ws.on('close', () => { console.log('Client disconnected. Total:', wss.clients.size); });
  ws.on('error', () => {});
});

// ============================================================
//  START
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 InvestySignals server running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}`);
  connectBinance();
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

// FIX: also handle Ctrl+C in dev (SIGINT)
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
