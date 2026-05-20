// ============================================================
//  InvestySignals — Backend Server (Security Fixed v2)
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
const Signal       = require('./models/Signal');
const User         = require('./models/User');
const PaperTrade   = require('./models/PaperTrade');
const Settings     = require('./models/Settings');
const Announcement = require('./models/Announcement');
const Report       = require('./models/Report');

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

// FIX #8: CORS — use explicit origin from env, never wildcard true
const allowedOrigin = process.env.ALLOWED_ORIGIN;
app.use(cors({
  origin: allowedOrigin
    ? (origin, cb) => {
        if (!origin || origin === allowedOrigin) cb(null, true);
        else cb(new Error('Not allowed by CORS'));
      }
    : true, // fallback for local dev only — set ALLOWED_ORIGIN in production
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

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests.' }
});

// Register admin limiter BEFORE the general /api/ limiter
app.use('/api/admin/', adminLimiter);
app.use('/api/', apiLimiter);

// FIX #1 (partial): Block sensitive files from being served as static assets
// serviceAccount.json, .env, package.json must never be served
const BLOCKED_STATIC = ['.env', 'serviceAccount.json', 'package.json', '.gitignore', 'deploy.sh'];
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
// FIX #5: Also checks suspended status
async function verifyToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    // FIX #5: Block suspended users
    const dbUser = await User.findOne({ uid: req.user.uid });
    if (dbUser && dbUser.suspended) {
      return res.status(403).json({ success: false, error: 'Account suspended', reason: dbUser.suspendReason });
    }
    req.dbUser = dbUser;
    next();
  } catch (e) {
    res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

// ── verifyAdmin middleware ────────────────────────────────────
async function verifyAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    const email = (req.user.email || '').toLowerCase();
    const u = await ensureAdminPromotion(req.user.uid, email);
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

// ── Plan level helper ─────────────────────────────────────────
const PLAN_LEVEL = { free: 0, pro: 1, elite: 2, admin: 99 };
function planLevel(plan) { return PLAN_LEVEL[plan] ?? 0; }

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
    const pair  = (req.query.pair || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const tf    = (req.query.tf   || '1h').replace(/[^a-zA-Z0-9]/g, '');
    const limit = 100;

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

    const closes = klines.map(k => parseFloat(k[4]));

    // RSI(14)
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

    // MACD(12,26,9)
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

    // Bollinger Bands(20, 2σ)
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
// FIX #3 & #9: uid always taken from verified token — never from query param
app.get('/api/user/status', verifyToken, async (req, res) => {
  try {
    const uid   = req.user.uid;
    const email = (req.user.email || '').toLowerCase();

    const user = await ensureAdminPromotion(uid, email);
    if (!user) return res.status(500).json({ success: false, error: 'Could not load user' });

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

// ── Signals (auth required + plan gating) ────────────────────
// FIX #4: verifyToken required; signals filtered by user plan
app.get('/api/signals', verifyToken, async (req, res) => {
  try {
    const user = req.dbUser;
    const userPlan = user ? user.plan : 'free';
    const userRole = user ? user.role : 'user';

    // Admin sees everything; others see only signals at or below their plan level
    const planFilter = userRole === 'admin'
      ? {}
      : { plan: { $in: Object.keys(PLAN_LEVEL).filter(p => planLevel(p) <= planLevel(userPlan)) } };

    const signals = await Signal.find({ active: true, ...planFilter })
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

    // FIX #2: Validate trade size — must be positive and within limits
    const tradeSize = parseFloat(size);
    if (!tradeSize || tradeSize <= 0 || tradeSize > 100000 || !isFinite(tradeSize)) {
      return res.status(400).json({ success: false, error: 'Invalid trade size. Must be between 1 and 100,000.' });
    }

    const signal = await Signal.findById(signalId);
    if (!signal) return res.json({ success: false, error: 'Signal not found' });

    const user = await User.findOne({ uid: req.user.uid });
    if (user && user.paperBalance < tradeSize) {
      return res.json({ success: false, error: 'Insufficient paper balance' });
    }
    const trade = await PaperTrade.create({
      userUid:   req.user.uid,
      signalId:  signal._id,
      pair:      signal.pair,
      direction: signal.direction,
      entry:     signal.entry,
      tp1:       signal.tp1,
      tp2:       signal.tp2,
      sl:        signal.sl,
      leverage:  signal.leverage,
      size:      tradeSize,
      status:    'OPEN'
    });
    if (user) {
      await User.updateOne({ uid: req.user.uid }, { $inc: { paperBalance: -tradeSize } });
    }
    res.json({ success: true, trade });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Paper trade CLOSE endpoint
app.patch('/api/paper/trade/:id/close', verifyToken, async (req, res) => {
  try {
    const trade = await PaperTrade.findOne({ _id: req.params.id, userUid: req.user.uid });
    if (!trade) return res.status(404).json({ success: false, error: 'Trade not found' });
    if (trade.status !== 'OPEN') {
      return res.json({ success: false, error: 'Trade is already closed' });
    }

    // FIX #12: Validate closePrice — must be a positive finite number
    const closePrice = parseFloat(req.body.closePrice);
    if (!closePrice || closePrice <= 0 || !isFinite(closePrice)) {
      return res.status(400).json({ success: false, error: 'Invalid close price. Must be a positive number.' });
    }

    const priceDiff = trade.direction === 'LONG'
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

// ── User Report Submission ─────────────────────────────────────
// FIX #6: reporterUid/Email taken from token when available, never trusted from body
app.post('/api/reports', async (req, res) => {
  try {
    const { category, message, context } = req.body;
    if (!category || !message || message.trim().length < 3) {
      return res.status(400).json({ success: false, error: 'Category and message are required' });
    }
    const allowed = ['signal_accuracy','technical_bug','inappropriate_content','other'];
    if (!allowed.includes(category)) {
      return res.status(400).json({ success: false, error: 'Invalid category' });
    }

    // Try to get identity from token (optional auth)
    let reporterUid   = 'anonymous';
    let reporterEmail = '';
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      try {
        const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
        reporterUid   = decoded.uid || 'anonymous';
        reporterEmail = (decoded.email || '').toLowerCase();
      } catch(_) {}
    }

    const report = await Report.create({
      category,
      message: message.trim().slice(0, 2000),
      context: (context || '').slice(0, 500),
      reporterUid,
      reporterEmail,
    });
    broadcastToAll({ type: 'new_report', reportId: report._id, category: report.category });
    res.json({ success: true, message: 'Report submitted. Thank you.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── User's own reports ────────────────────────────────────────
app.get('/api/my-reports', verifyToken, async (req, res) => {
  try {
    const data = await Report.find({ reporterUid: req.user.uid })
      .sort({ createdAt: -1 }).limit(20);
    res.json({ success: true, data });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Check Registration Status (public) ───────────────────────
// FIX #10: Client can check if registrations are open
app.get('/api/registration-status', (req, res) => {
  res.json({ success: true, open: globalSettings.allowRegistrations !== false });
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
    const wins    = closedSignals.filter(s => ['TP1_HIT','TP2_HIT'].includes(s.status)).length;
    const losses  = closedSignals.filter(s => s.status === 'SL_HIT').length;
    const total   = wins + losses;
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
    if (suspended === 'true')  filter.suspended = true;
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

    // FIX #13: paperBalance must be a non-negative finite number
    if (update.paperBalance !== undefined) {
      const bal = parseFloat(update.paperBalance);
      if (!isFinite(bal) || bal < 0) {
        return res.status(400).json({ success: false, error: 'Invalid paperBalance value.' });
      }
      update.paperBalance = bal;
    }

    const user = await User.findOneAndUpdate({ uid: req.params.uid }, update, { new: true });
    if (!user) return res.json({ success: false, error: 'User not found' });
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
// Allowed fields whitelist for signal create/update
const SIGNAL_ALLOWED_FIELDS = [
  'pair','direction','entry','tp1','tp2','sl','leverage',
  'timeframe','notes','score','plan','status','pnl','winRate','active','closedAt'
];

function pickSignalFields(body) {
  const obj = {};
  SIGNAL_ALLOWED_FIELDS.forEach(k => { if (body[k] !== undefined) obj[k] = body[k]; });
  return obj;
}

app.post('/api/signals', verifyAdmin, async (req, res) => {
  try {
    // FIX #7: Whitelist fields — no mass assignment
    const body = pickSignalFields(req.body);
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
    // FIX #7: Whitelist fields — no mass assignment
    const update = pickSignalFields(req.body);
    const signal = await Signal.findByIdAndUpdate(req.params.id, update, { new: true });
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
    if (req.body.maintenance !== undefined) {
      broadcastToAll({ type: 'maintenance', active: globalSettings.maintenance, message: globalSettings.maintenanceMsg });
    }
    res.json({ success: true, settings: globalSettings });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin: Announcements CRUD ─────────────────────────────────
const ANNOUNCEMENT_ALLOWED = ['title','message','type','active','showFrom','showUntil','audience'];
function pickAnnouncementFields(body) {
  const obj = {};
  ANNOUNCEMENT_ALLOWED.forEach(k => { if (body[k] !== undefined) obj[k] = body[k]; });
  return obj;
}

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
    const fields = pickAnnouncementFields(req.body);
    const ann = await Announcement.create({ ...fields, createdBy: req.dbUser.email || 'admin' });
    if (ann.active) {
      broadcastToAll({ type: 'announcement', data: ann });
    }
    res.json({ success: true, data: ann });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// FIX #15: Whitelist fields on announcement update — no mass assignment
app.put('/api/admin/announcements/:id', verifyAdmin, async (req, res) => {
  try {
    const update = pickAnnouncementFields(req.body);
    const ann = await Announcement.findByIdAndUpdate(req.params.id, update, { new: true });
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

// ── Admin: Broadcast ──────────────────────────────────────────
// FIX #11: Always save broadcast to DB (audit trail); saveToDb flag removed
app.post('/api/admin/broadcast', verifyAdmin, async (req, res) => {
  try {
    const { subject, message, audience } = req.body;
    if (!message) return res.json({ success: false, error: 'Message is required' });
    broadcastToAll({
      type:     'announcement',
      subject:  subject || 'Platform Announcement',
      message,
      audience: audience || 'All Users',
      time:     new Date().toISOString()
    });
    // FIX #11: Always persist to DB for audit trail
    await Announcement.create({
      title:     subject || 'Platform Announcement',
      message,
      audience:  audience || 'All Users',
      active:    true,
      createdBy: req.dbUser.email || 'admin'
    });
    res.json({ success: true, message: 'Broadcast sent' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin: Reports CRUD ───────────────────────────────────────
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
    if (status)                    update.status      = status;
    if (adminNote  !== undefined)  update.adminNote   = adminNote;
    if (adminReply !== undefined)  update.adminReply  = adminReply;
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
  const file     = req.path.replace('/', '') || 'index.html';
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
// FIX #14: Authenticate WebSocket connections via token in query param
wss.on('connection', async (ws, req) => {
  // Parse token from ?token=... query string
  const urlParams = new URLSearchParams(req.url.replace(/^.*\?/, ''));
  const wsToken   = urlParams.get('token');

  let wsUser = null;
  if (wsToken) {
    try {
      wsUser = await admin.auth().verifyIdToken(wsToken);
    } catch(_) {}
  }

  // Only send signals_update if authenticated
  if (wsUser) {
    console.log('Authenticated WS client connected. Total:', wss.clients.size);
    try {
      // Load user plan to filter signals
      const dbUser   = await User.findOne({ uid: wsUser.uid });
      const userPlan = dbUser ? dbUser.plan : 'free';
      const userRole = dbUser ? dbUser.role : 'user';

      const planFilter = userRole === 'admin'
        ? {}
        : { plan: { $in: Object.keys(PLAN_LEVEL).filter(p => planLevel(p) <= planLevel(userPlan)) } };

      const signals = await Signal.find({ active: true, ...planFilter }).sort({ createdAt: -1 }).limit(20);
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
  } else {
    // Unauthenticated — send only public announcements, no signals
    console.log('Unauthenticated WS client. Total:', wss.clients.size);
    try {
      const now = new Date();
      const ann = await Announcement.findOne({
        active: true, showFrom: { $lte: now },
        $or: [{ showUntil: null }, { showUntil: { $gte: now } }]
      }).sort({ createdAt: -1 });
      if (ann) ws.send(JSON.stringify({ type: 'announcement', data: ann }));
    } catch(_) {}
  }

  ws.on('close', () => { console.log('WS client disconnected. Total:', wss.clients.size); });
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

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); });
