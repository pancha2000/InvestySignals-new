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

// Trust proxy — required when behind nginx/reverse proxy
app.set('trust proxy', 1);

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

// FIX #1 (partial): Block sensitive files — checked before static, after API routes
const BLOCKED_STATIC = ['.env', 'serviceAccount.json', 'package.json', '.gitignore', 'deploy.sh'];

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

// ── Market Scanner — Binance 24hr ticker funnel ─────────────
const STABLECOINS = new Set([
  'USDCUSDT','FDUSDUSDT','TUSDUSDT','BUSDUSDT',
  'EURUSDT','DAIUSDT','USDPUSDT','AEURUSDT',
]);

app.get('/api/scan', async (req, res) => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const response = await fetch('https://api.binance.com/api/v3/ticker/24hr', { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`Binance error: ${response.status}`);
    const data = await response.json();

    const results = data
      .filter(c => c.symbol.endsWith('USDT'))                        // USDT pairs only
      .filter(c => !STABLECOINS.has(c.symbol))                       // No stablecoins
      .filter(c => parseFloat(c.quoteVolume) >= 15_000_000)          // Volume ≥ $15M
      .filter(c => parseInt(c.count) >= 100_000)                     // Trades ≥ 100k
      .filter(c => {                                                  // Volatility ≥ ±3%
        const chg = parseFloat(c.priceChangePercent);
        return chg >= 3.0 || chg <= -3.0;
      })
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume)) // Sort by volume
      .slice(0, 20)
      .map(c => ({
        symbol:  c.symbol,
        change:  parseFloat(c.priceChangePercent),
        volume:  parseFloat(c.quoteVolume),
        price:   parseFloat(c.lastPrice),
        trades:  parseInt(c.count),
      }));

    res.json({ success: true, count: results.length, coins: results });
  } catch (err) {
    console.error('/api/scan error:', err.message);
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
    const dbUser = await User.findOne({ uid: decoded.uid });
    if (dbUser && dbUser.suspended) {
      return res.status(403).json({ success: false, error: 'Account suspended' });
    }
    const trades = await PaperTrade.find({ userUid: decoded.uid })
      .sort({ openedAt: -1 }).limit(100);
    res.json({ success: true, trades, data: trades });
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
           closedSignals, openReports, suspendedCount] = await Promise.all([
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
      User.countDocuments({ suspended: true }),
    ]);
    const wins    = closedSignals.filter(s => ['TP1_HIT','TP2_HIT'].includes(s.status)).length;
    const losses  = closedSignals.filter(s => s.status === 'SL_HIT').length;
    const total   = wins + losses;
    const winRate = total > 0 ? ((wins/total)*100).toFixed(1) : 0;
    res.json({ success: true, stats: {
      totalUsers, activeSignals, totalSignals, openTrades,
      proCount, eliteCount, adminCount, newUsersToday,
      wins, losses, winRate, openReports,
      bannedCount: suspendedCount,   // alias used by admin.html
      suspendedCount
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
    broadcastToAll({ type: 'signal_deleted', signalId: req.params.id });
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
    const annTitle = subject || 'Platform Announcement';
    // FIX 2: include 'data' field so dashboard WS handler (d.data) receives it correctly
    broadcastToAll({
      type: 'announcement',
      data: { title: annTitle, message, type: 'info', audience: audience || 'All Users' },
      time: new Date().toISOString()
    });
    // FIX #11: Always persist to DB for audit trail
    await Announcement.create({
      title:     annTitle,
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


// ── Deep Analysis — 5-Level confluence engine ─────────────────
app.post('/api/deep-analysis', verifyToken, async (req, res) => {
  try {
    const { coin } = req.body;
    if (!coin || !/^[A-Z0-9]{2,20}$/.test(coin)) {
      return res.status(400).json({ success: false, error: 'Invalid coin symbol' });
    }
    const pair = coin.replace(/USDT$/i, '') + 'USDT';

    // ── Helper: fetch klines from Binance Futures ──
    async function fetchKlines(symbol, interval, limit = 200) {
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Binance klines error ${r.status}`);
      return r.json();
    }

    // ── Helper: EMA ──
    function calcEMA(closes, n) {
      const k = 2 / (n + 1);
      let val = closes.slice(0, n).reduce((a, b) => a + b, 0) / n;
      for (let i = n; i < closes.length; i++) val = closes[i] * k + val * (1 - k);
      return val;
    }

    // ── Helper: EMA array ──
    function calcEMAArr(closes, n) {
      const k = 2 / (n + 1);
      let val = closes.slice(0, n).reduce((a, b) => a + b, 0) / n;
      const out = [val];
      for (let i = n; i < closes.length; i++) { val = closes[i] * k + val * (1 - k); out.push(val); }
      return out;
    }

    // ── Helper: RSI ──
    function calcRSI(closes, period = 14) {
      let gains = 0, losses = 0;
      for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) gains += d; else losses -= d;
      }
      let ag = gains / period, al = losses / period;
      for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
        al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
      }
      return al === 0 ? 100 : parseFloat((100 - 100 / (1 + ag / al)).toFixed(2));
    }

    // ── Helper: RSI array (last N) ──
    function calcRSIArr(closes, period = 14, count = 5) {
      const result = [];
      for (let offset = count - 1; offset >= 0; offset--) {
        const slice = closes.slice(0, closes.length - offset);
        result.push(calcRSI(slice, period));
      }
      return result;
    }

    // ── Helper: MACD ──
    function calcMACD(closes) {
      const ema12 = calcEMAArr(closes, 12);
      const ema26 = calcEMAArr(closes, 26);
      const macdLine = ema12.slice(ema12.length - ema26.length).map((v, i) => v - ema26[i]);
      const signal9 = calcEMAArr(macdLine, 9);
      return {
        macd: macdLine[macdLine.length - 1],
        signal: signal9[signal9.length - 1],
        histogram: macdLine[macdLine.length - 1] - signal9[signal9.length - 1],
        prevHistogram: macdLine[macdLine.length - 2] - signal9[signal9.length - 2],
      };
    }

    // ── Helper: Bollinger Bands ──
    function calcBB(closes, period = 20) {
      const slice = closes.slice(-period);
      const mid = slice.reduce((a, b) => a + b, 0) / period;
      const std = Math.sqrt(slice.reduce((a, c) => a + Math.pow(c - mid, 2), 0) / period);
      return { upper: mid + 2 * std, middle: mid, lower: mid - 2 * std };
    }

    // ── Helper: ATR ──
    function calcATR(klines, period = 14) {
      const trs = [];
      for (let i = 1; i < klines.length; i++) {
        const h = parseFloat(klines[i][2]), l = parseFloat(klines[i][3]), pc = parseFloat(klines[i-1][4]);
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
      }
      return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
    }

    // ── Helper: BOS/CHoCH ──
    function detectStructure(closes, highs, lows) {
      const len = closes.length;
      const recentHighs = highs.slice(-20);
      const recentLows  = lows.slice(-20);
      const prevHigh = Math.max(...recentHighs.slice(0, 15));
      const prevLow  = Math.min(...recentLows.slice(0, 15));
      const lastClose = closes[len - 1];
      const lastHigh  = highs[len - 1];
      const lastLow   = lows[len - 1];
      if (lastHigh > prevHigh) return 'BOS_BULLISH';
      if (lastLow < prevLow)   return 'BOS_BEARISH';
      const midHigh = Math.max(...recentHighs.slice(5, 12));
      const midLow  = Math.min(...recentLows.slice(5, 12));
      if (lastClose > midHigh) return 'CHOCH_BULLISH';
      if (lastClose < midLow)  return 'CHOCH_BEARISH';
      return 'NEUTRAL';
    }

    // ── Helper: RSI Divergence ──
    function detectDivergence(closes, rsiArr) {
      const priceUp   = closes[closes.length - 1] > closes[closes.length - 3];
      const rsiUp     = rsiArr[rsiArr.length - 1] > rsiArr[rsiArr.length - 3];
      if (priceUp && !rsiUp)  return 'BEARISH_DIV';
      if (!priceUp && rsiUp)  return 'BULLISH_DIV';
      if (priceUp && rsiUp)   return 'HIDDEN_BEARISH';
      if (!priceUp && !rsiUp) return 'HIDDEN_BULLISH';
      return 'NONE';
    }

    // ── Helper: FVG detect ──
    function detectFVG(klines) {
      const fvgs = [];
      for (let i = 2; i < klines.length; i++) {
        const prevHigh = parseFloat(klines[i-2][2]);
        const curLow   = parseFloat(klines[i][3]);
        const prevLow  = parseFloat(klines[i-2][3]);
        const curHigh  = parseFloat(klines[i][2]);
        if (curLow > prevHigh) fvgs.push({ type: 'BULL', high: curLow, low: prevHigh });
        if (curHigh < prevLow) fvgs.push({ type: 'BEAR', high: prevLow, low: curHigh });
      }
      return fvgs.slice(-3);
    }

    // ── Helper: Volume spike ──
    function detectVolumeSpike(volumes) {
      const avg = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
      const last = volumes[volumes.length - 1];
      return { ratio: parseFloat((last / avg).toFixed(2)), spike: last > avg * 1.5 };
    }

    // ── Helper: Key S/R levels ──
    function findSRLevels(highs, lows) {
      const allLevels = [...highs.slice(-50), ...lows.slice(-50)].sort((a, b) => a - b);
      const clusters = [];
      let i = 0;
      while (i < allLevels.length) {
        const base = allLevels[i];
        const cluster = allLevels.filter(v => Math.abs(v - base) / base < 0.005);
        if (cluster.length >= 2) clusters.push(parseFloat((cluster.reduce((a,b)=>a+b,0)/cluster.length).toFixed(4)));
        i += Math.max(1, cluster.length);
      }
      return [...new Set(clusters)].slice(-6);
    }

    // ── Helper: Order Block ──
    function findOrderBlock(klines) {
      for (let i = klines.length - 5; i >= klines.length - 30; i--) {
        const open  = parseFloat(klines[i][1]);
        const close = parseFloat(klines[i][4]);
        const high  = parseFloat(klines[i][2]);
        const low   = parseFloat(klines[i][3]);
        const body  = Math.abs(close - open);
        const range = high - low;
        if (body / range > 0.6) {
          return { high, low, open, close, type: close > open ? 'BULL_OB' : 'BEAR_OB' };
        }
      }
      return null;
    }

    // ── Helper: Candle Pattern ──
    function detectCandlePattern(klines) {
      const last = klines[klines.length - 1];
      const prev = klines[klines.length - 2];
      const o = parseFloat(last[1]), c = parseFloat(last[4]);
      const h = parseFloat(last[2]), l = parseFloat(last[3]);
      const po = parseFloat(prev[1]), pc = parseFloat(prev[4]);
      const body = Math.abs(c - o), range = h - l;
      const upperWick = h - Math.max(o, c);
      const lowerWick = Math.min(o, c) - l;
      if (lowerWick > body * 2 && upperWick < body * 0.5) return 'PIN_BAR_BULL';
      if (upperWick > body * 2 && lowerWick < body * 0.5) return 'PIN_BAR_BEAR';
      if (c > po && o < pc && c > po) return 'BULLISH_ENGULFING';
      if (c < po && o > pc && c < po) return 'BEARISH_ENGULFING';
      if (body / range < 0.1) return 'DOJI';
      if (c > o && body / range > 0.7) return 'STRONG_BULL';
      if (c < o && body / range > 0.7) return 'STRONG_BEAR';
      return 'NONE';
    }

    // ── Fetch all data in parallel ──
    const [k1d, k4h, k1h, k15m, btcK1d, fundingRaw, oiRaw] = await Promise.all([
      fetchKlines(pair, '1d', 200),
      fetchKlines(pair, '4h', 200),
      fetchKlines(pair, '1h', 200),
      fetchKlines(pair, '15m', 200),
      fetchKlines('BTCUSDT', '1d', 200),
      fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${pair}&limit=1`).then(r=>r.json()).catch(()=>[]),
      fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${pair}`).then(r=>r.json()).catch(()=>({})),
    ]);

    // ── Parse closes/highs/lows/volumes ──
    function parseKlines(klines) {
      return {
        opens:   klines.map(k => parseFloat(k[1])),
        highs:   klines.map(k => parseFloat(k[2])),
        lows:    klines.map(k => parseFloat(k[3])),
        closes:  klines.map(k => parseFloat(k[4])),
        volumes: klines.map(k => parseFloat(k[5])),
      };
    }

    const d1  = parseKlines(k1d);
    const h4  = parseKlines(k4h);
    const h1  = parseKlines(k1h);
    const m15 = parseKlines(k15m);
    const btc = parseKlines(btcK1d);

    const currentPrice = d1.closes[d1.closes.length - 1];

    // ══ LEVEL 1 — Macro Context ══
    const btcEma20  = calcEMA(btc.closes, 20);
    const btcEma50  = calcEMA(btc.closes, 50);
    const btcEma200 = calcEMA(btc.closes, 200);
    const btcClose  = btc.closes[btc.closes.length - 1];
    const btcTrend  = btcClose > btcEma20 && btcEma20 > btcEma50 && btcEma50 > btcEma200
      ? 'STRONG_BULL' : btcClose > btcEma50 ? 'BULL' : btcClose < btcEma200 ? 'STRONG_BEAR' : 'BEAR';

    const fundingRate = fundingRaw[0]?.fundingRate ? parseFloat(fundingRaw[0].fundingRate) * 100 : 0;
    const fundingBias = fundingRate > 0.05 ? 'LONGS_PAYING' : fundingRate < -0.01 ? 'SHORTS_PAYING' : 'NEUTRAL';

    const openInterest = oiRaw?.openInterest ? parseFloat(oiRaw.openInterest) : null;

    // ══ LEVEL 2 — HTF Structure ══
    // Daily
    const d1Ema20  = calcEMA(d1.closes, 20);
    const d1Ema50  = calcEMA(d1.closes, 50);
    const d1Ema200 = calcEMA(d1.closes, 200);
    const d1Struct = detectStructure(d1.closes, d1.highs, d1.lows);
    const d1SR     = findSRLevels(d1.highs, d1.lows);
    const d1OB     = findOrderBlock(k1d);
    // 4H
    const h4Ema20  = calcEMA(h4.closes, 20);
    const h4Ema50  = calcEMA(h4.closes, 50);
    const h4Ema200 = calcEMA(h4.closes, 200);
    const h4Struct = detectStructure(h4.closes, h4.highs, h4.lows);
    const h4SR     = findSRLevels(h4.highs, h4.lows);
    const h4OB     = findOrderBlock(k4h);
    const h4FVGs   = detectFVG(k4h);
    const h4RSIArr = calcRSIArr(h4.closes, 14, 5);
    const h4RSI    = h4RSIArr[h4RSIArr.length - 1];
    const h4Div    = detectDivergence(h4.closes, h4RSIArr);
    const prevDayHigh = Math.max(...h4.highs.slice(-6));
    const prevDayLow  = Math.min(...h4.lows.slice(-6));

    // ══ LEVEL 3 — Momentum (1H) ══
    const h1Ema20  = calcEMA(h1.closes, 20);
    const h1Ema50  = calcEMA(h1.closes, 50);
    const h1Ema200 = calcEMA(h1.closes, 200);
    const h1Struct = detectStructure(h1.closes, h1.highs, h1.lows);
    const h1RSIArr = calcRSIArr(h1.closes, 14, 5);
    const h1RSI    = h1RSIArr[h1RSIArr.length - 1];
    const h1Div    = detectDivergence(h1.closes, h1RSIArr);
    const h1MACD   = calcMACD(h1.closes);
    const h1BB     = calcBB(h1.closes);
    const h1Vol    = detectVolumeSpike(h1.volumes);
    const h1FVGs   = detectFVG(k1h);

    // ══ LEVEL 4 — Entry Timing (15m) ══
    const m15Ema20  = calcEMA(m15.closes, 20);
    const m15Ema50  = calcEMA(m15.closes, 50);
    const m15Struct = detectStructure(m15.closes, m15.highs, m15.lows);
    const m15RSIArr = calcRSIArr(m15.closes, 14, 5);
    const m15RSI    = m15RSIArr[m15RSIArr.length - 1];
    const m15Div    = detectDivergence(m15.closes, m15RSIArr);
    const m15MACD   = calcMACD(m15.closes);
    const m15Vol    = detectVolumeSpike(m15.volumes);
    const m15FVGs   = detectFVG(k15m);
    const m15Candle = detectCandlePattern(k15m);

    // ══ LEVEL 5 — Trade Setup ══
    const atr4h = calcATR(k4h, 14);
    const atr1h = calcATR(k1h, 14);

    // Confluence scoring
    let score = 0;
    const isBullish = ['BOS_BULLISH','CHOCH_BULLISH'].includes(h4Struct) || ['BOS_BULLISH','CHOCH_BULLISH'].includes(h1Struct);

    if (btcTrend === 'STRONG_BULL' || btcTrend === 'BULL') score += 2;
    if (d1Struct === 'BOS_BULLISH' || d1Struct === 'CHOCH_BULLISH') score += 2;
    if (h4Struct === 'BOS_BULLISH' || h4Struct === 'CHOCH_BULLISH') score += 2;
    if (h1RSI < 40 || h1RSI > 60) score += 1;
    if (h1MACD.histogram > 0 !== h1MACD.prevHistogram > 0) score += 1; // fresh cross
    if (h4Div === 'BULLISH_DIV' || h1Div === 'BULLISH_DIV') score += 1;
    if (m15Struct === 'BOS_BULLISH' || m15Struct === 'CHOCH_BULLISH') score += 1;
    if (m15Vol.spike) score += 1;

    // Entry zone based on ATR + OB/FVG
    const entryLow  = parseFloat((currentPrice - atr1h * 0.3).toFixed(4));
    const entryHigh = parseFloat((currentPrice + atr1h * 0.3).toFixed(4));
    const sl        = parseFloat((isBullish ? currentPrice - atr4h * 1.5 : currentPrice + atr4h * 1.5).toFixed(4));
    const riskAmt   = Math.abs(currentPrice - sl);
    const tp1       = parseFloat((isBullish ? currentPrice + riskAmt * 1.5 : currentPrice - riskAmt * 1.5).toFixed(4));
    const tp2       = parseFloat((isBullish ? currentPrice + riskAmt * 2.5 : currentPrice - riskAmt * 2.5).toFixed(4));
    const tp3       = parseFloat((isBullish ? currentPrice + riskAmt * 4.0 : currentPrice - riskAmt * 4.0).toFixed(4));

    // ── Build prompt for Groq ──
    const GROQ_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_KEY) return res.status(500).json({ success: false, error: 'AI key not configured' });

    const prompt = `You are a professional crypto futures trader and analyst. Analyze the following REAL calculated market data for ${pair} and provide a structured 5-level trade analysis.

=== REAL MARKET DATA ===

CURRENT PRICE: $${currentPrice}

--- LEVEL 1: MACRO CONTEXT ---
BTC 1D Trend: ${btcTrend} (EMA20: ${btcEma20.toFixed(2)}, EMA50: ${btcEma50.toFixed(2)}, EMA200: ${btcEma200.toFixed(2)})
BTC Price: $${btcClose.toFixed(2)}
Funding Rate: ${fundingRate.toFixed(4)}% (${fundingBias})
Open Interest: ${openInterest ? openInterest.toFixed(2) : 'N/A'}

--- LEVEL 2: HTF STRUCTURE ---
Daily Structure: ${d1Struct}
Daily EMA20: ${d1Ema20.toFixed(4)}, EMA50: ${d1Ema50.toFixed(4)}, EMA200: ${d1Ema200.toFixed(4)}
Daily S/R Levels: ${d1SR.join(', ')}
Daily Order Block: ${d1OB ? JSON.stringify(d1OB) : 'None detected'}

4H Structure: ${h4Struct}
4H EMA20: ${h4Ema20.toFixed(4)}, EMA50: ${h4Ema50.toFixed(4)}, EMA200: ${h4Ema200.toFixed(4)}
4H RSI: ${h4RSI} | Divergence: ${h4Div}
4H S/R: ${h4SR.join(', ')}
4H Order Block: ${h4OB ? JSON.stringify(h4OB) : 'None'}
4H FVG Zones: ${JSON.stringify(h4FVGs)}
Prev Day High/Low: ${prevDayHigh.toFixed(4)} / ${prevDayLow.toFixed(4)}

--- LEVEL 3: MOMENTUM (1H) ---
1H Structure: ${h1Struct}
1H EMA20: ${h1Ema20.toFixed(4)}, EMA50: ${h1Ema50.toFixed(4)}, EMA200: ${h1Ema200.toFixed(4)}
1H RSI: ${h1RSI} | Divergence: ${h1Div}
1H MACD: ${h1MACD.macd.toFixed(4)} | Signal: ${h1MACD.signal.toFixed(4)} | Hist: ${h1MACD.histogram.toFixed(4)} | Fresh Cross: ${h1MACD.histogram > 0 !== h1MACD.prevHistogram > 0}
1H Bollinger: Upper ${h1BB.upper.toFixed(4)}, Mid ${h1BB.middle.toFixed(4)}, Lower ${h1BB.lower.toFixed(4)}
1H Volume Spike: ${h1Vol.spike} (ratio: ${h1Vol.ratio}x avg)
1H FVG Zones: ${JSON.stringify(h1FVGs)}

--- LEVEL 4: ENTRY TIMING (15m) ---
15m Structure: ${m15Struct}
15m EMA20: ${m15Ema20.toFixed(4)}, EMA50: ${m15Ema50.toFixed(4)}
15m RSI: ${m15RSI} | Divergence: ${m15Div}
15m MACD Hist: ${m15MACD.histogram.toFixed(4)} | Fresh Cross: ${m15MACD.histogram > 0 !== m15MACD.prevHistogram > 0}
15m Candle Pattern: ${m15Candle}
15m Volume Spike: ${m15Vol.spike} (ratio: ${m15Vol.ratio}x avg)
15m FVG Zones: ${JSON.stringify(m15FVGs)}

--- LEVEL 5: TRADE SETUP (CALCULATED) ---
Direction Bias: ${isBullish ? 'LONG' : 'SHORT'}
Entry Zone: $${entryLow} — $${entryHigh}
Stop Loss (ATR×1.5): $${sl}
TP1 (1:1.5): $${tp1}
TP2 (1:2.5): $${tp2}
TP3 (1:4.0): $${tp3}
ATR 4H: ${atr4h.toFixed(4)}, ATR 1H: ${atr1h.toFixed(4)}
Confluence Score: ${score}/10

=== YOUR TASK ===
Based on this REAL data, provide analysis in this EXACT JSON format (no markdown, no extra text):
{
  "overallBias": "LONG or SHORT or NEUTRAL",
  "confluenceScore": ${score},
  "grade": "S or A or B or C",
  "level1": {
    "btcTrend": "one sentence interpretation",
    "fundingSignal": "one sentence interpretation",
    "oiSignal": "one sentence interpretation",
    "macroConclusion": "BULLISH or BEARISH or NEUTRAL"
  },
  "level2": {
    "dailyStructure": "one sentence",
    "dailyEMA": "one sentence — price vs EMA position",
    "h4Structure": "one sentence",
    "h4EMA": "one sentence",
    "h4Divergence": "one sentence",
    "keyLevels": "important S/R levels to watch",
    "orderBlock": "OB interpretation",
    "fvgZones": "FVG interpretation",
    "structureConclusion": "BULLISH or BEARISH or NEUTRAL"
  },
  "level3": {
    "h1Structure": "one sentence",
    "h1RSI": "one sentence",
    "h1Divergence": "one sentence",
    "macdSignal": "one sentence — cross direction and strength",
    "bollingerSignal": "one sentence — price position in BB",
    "volumeSignal": "one sentence",
    "momentumConclusion": "STRONG_BULL or BULL or NEUTRAL or BEAR or STRONG_BEAR"
  },
  "level4": {
    "m15Structure": "one sentence",
    "m15RSI": "one sentence",
    "m15Divergence": "one sentence",
    "macdCross": "one sentence",
    "candlePattern": "one sentence interpretation",
    "volumeConfirm": "one sentence",
    "fvgEntry": "one sentence",
    "sessionNote": "note about current session timing",
    "entryConclusion": "CONFIRMED or WAIT or AVOID"
  },
  "level5": {
    "direction": "${isBullish ? 'LONG' : 'SHORT'}",
    "entryZone": "$${entryLow} — $${entryHigh}",
    "stopLoss": "$${sl}",
    "tp1": "$${tp1}",
    "tp2": "$${tp2}",
    "tp3": "$${tp3}",
    "invalidationLevel": "price level that fully invalidates this setup",
    "leverage": "suggested leverage range based on volatility",
    "positionSize": "risk 1-2% of account — how to size",
    "tradeManagement": "when to move SL to BE, when to trail",
    "reEntry": "conditions for a valid re-entry",
    "riskNote": "overall risk assessment"
  },
  "summary": "2-3 sentence overall trade summary",
  "warning": "any major risk or reason to avoid this trade"
}`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.2,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!groqRes.ok) {
      const err = await groqRes.text();
      return res.status(502).json({ success: false, error: `AI error: ${err}` });
    }

    const groqData = await groqRes.json();
    const rawText = groqData.choices?.[0]?.message?.content || '';
    if (!rawText) return res.status(502).json({ success: false, error: 'AI returned empty response' });
    const cleaned = rawText.replace(/```json|```/g, '').trim();

    let analysis;
    try { analysis = JSON.parse(cleaned); }
    catch (e) { return res.status(500).json({ success: false, error: 'AI response parse failed', raw: rawText }); }

    res.json({
      success: true,
      coin: pair,
      price: currentPrice,
      confluenceScore: score,
      rawData: {
        btcTrend, fundingRate, fundingBias,
        d1Struct, h4Struct, h1Struct, m15Struct,
        h4RSI, h1RSI, m15RSI,
        h4Div, h1Div, m15Div,
        h1MACD, m15MACD,
        h1BB, h1Vol, m15Vol,
        m15Candle, atr4h, atr1h,
        entryLow, entryHigh, sl, tp1, tp2, tp3,
        // Extra fields for UI display
        h1Ema20, h1Ema50, h1Ema200,
        h4Ema20, h4Ema50, h4Ema200,
        d1Ema20, d1Ema50, d1Ema200,
        h4SR, d1SR,
        h4FVGs, h1FVGs, m15FVGs,
        h4OB, d1OB,
        prevDayHigh, prevDayLow,
      },
      analysis,
    });

  } catch (err) {
    console.error('/api/deep-analysis error:', err.message);
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

// ── Static files — served AFTER all API routes ───────────────
app.use((req, res, next) => {
  const basename = path.basename(req.path);
  if (BLOCKED_STATIC.includes(basename)) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  next();
});
app.use(express.static(path.join(__dirname)));

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
