// ============================================================
//  InvestySignals — Backend Server
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
const Signal     = require('./models/Signal');
const User       = require('./models/User');
const PaperTrade = require('./models/PaperTrade');

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
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

// ── Express Setup ────────────────────────────────────────────
const app = express();

app.use(helmet({
  contentSecurityPolicy: false,   // Firebase CDN scripts need this off
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(express.json());

// Rate limiting — protect APIs from abuse
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' }
});
app.use('/api/', apiLimiter);

// ── Serve Static HTML/CSS ────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ── Auth Middleware ──────────────────────────────────────────
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

async function verifyAdmin(req, res, next) {
  await verifyToken(req, res, async () => {
    const u = await User.findOne({ uid: req.user.uid });
    if (!u || u.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }
    req.dbUser = u;
    next();
  });
}

// ============================================================
//  API ROUTES
// ============================================================

// ── Health check ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ok', time: new Date().toISOString() });
});

// ── User Status ──────────────────────────────────────────────
app.get('/api/user/status', async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid) return res.json({ success: false, error: 'uid required' });

    let user = await User.findOne({ uid });
    if (!user) {
      // Auto-create user record on first access
      try {
        const firebaseUser = await admin.auth().getUser(uid);
        user = await User.create({
          uid,
          email: firebaseUser.email || '',
          displayName: firebaseUser.displayName || '',
          role: 'user',
          plan: 'free'
        });
      } catch {
        user = { uid, role: 'user', plan: 'free', suspended: false, maintenance: false };
      }
    } else {
      // Update last login
      await User.updateOne({ uid }, { lastLogin: new Date() });
    }

    res.json({ success: true, status: {
      role:           user.role,
      plan:           user.plan,
      suspended:      user.suspended,
      suspendReason:  user.suspendReason,
      maintenance:    user.maintenance,
      maintenanceMsg: user.maintenanceMsg,
      paperBalance:   user.paperBalance
    }});
  } catch (err) {
    console.error('user/status error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Signals ──────────────────────────────────────────────────
app.get('/api/signals', async (req, res) => {
  try {
    const signals = await Signal.find({ active: true })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ success: true, signals });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Announcement ─────────────────────────────────────────────
app.get('/api/announcement', async (req, res) => {
  // You can store this in DB later; for now return empty
  res.json({ success: true, announcement: null });
});

// ── Paper Trades (both endpoints — consistent) ───────────────
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
app.get('/api/paper-trades',   getPaperTrades);   // dashboard
app.get('/api/paper/trades',   getPaperTrades);   // live-signals

// ── Paper Balance ─────────────────────────────────────────────
app.get('/api/paper/balance', verifyToken, async (req, res) => {
  try {
    const user = await User.findOne({ uid: req.user.uid });
    res.json({ success: true, balance: user ? user.paperBalance : 1000 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Place Paper Trade ─────────────────────────────────────────
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

// ── Analysis (RSI + direction) ────────────────────────────────
app.get('/api/analysis', async (req, res) => {
  try {
    const pair = (req.query.pair || 'BTCUSDT').toUpperCase();
    const tf   = req.query.tf || '1h';

    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=${tf}&limit=100`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Binance API error');
    const candles = await resp.json();

    if (!Array.isArray(candles) || candles.length < 15) {
      return res.json({ success: false, error: 'Not enough candle data' });
    }

    const closes = candles.map(c => parseFloat(c[4]));
    const highs  = candles.map(c => parseFloat(c[2]));
    const lows   = candles.map(c => parseFloat(c[3]));
    const vols   = candles.map(c => parseFloat(c[5]));

    // RSI-14
    function calcRSI(data, period = 14) {
      let gains = 0, losses = 0;
      for (let i = 1; i <= period; i++) {
        const diff = data[i] - data[i - 1];
        if (diff > 0) gains += diff; else losses -= diff;
      }
      let avgGain = gains / period;
      let avgLoss = losses / period;
      for (let i = period + 1; i < data.length; i++) {
        const diff = data[i] - data[i - 1];
        avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
      }
      if (avgLoss === 0) return 100;
      const rs = avgGain / avgLoss;
      return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
    }

    // EMA
    function ema(data, period) {
      const k = 2 / (period + 1);
      let e = data[0];
      for (let i = 1; i < data.length; i++) e = data[i] * k + e * (1 - k);
      return parseFloat(e.toFixed(8));
    }

    // MACD
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const macdLine = parseFloat((ema12 - ema26).toFixed(8));

    // Bollinger Bands (20)
    const recent20 = closes.slice(-20);
    const bbMean = recent20.reduce((a, b) => a + b, 0) / 20;
    const bbStd  = Math.sqrt(recent20.reduce((a, b) => a + Math.pow(b - bbMean, 2), 0) / 20);
    const bbUpper = parseFloat((bbMean + 2 * bbStd).toFixed(2));
    const bbLower = parseFloat((bbMean - 2 * bbStd).toFixed(2));

    const rsi      = calcRSI(closes);
    const price    = closes[closes.length - 1];
    const vol24h   = vols.slice(-24).reduce((a, b) => a + b, 0);

    // Signal logic
    let signal = 'NEUTRAL';
    let signalScore = 0;
    if (rsi < 35) signalScore += 2;
    else if (rsi < 45) signalScore += 1;
    else if (rsi > 65) signalScore -= 2;
    else if (rsi > 55) signalScore -= 1;
    if (macdLine > 0) signalScore += 1; else signalScore -= 1;
    if (price < bbLower) signalScore += 1;
    else if (price > bbUpper) signalScore -= 1;

    if (signalScore >= 3) signal = 'STRONG_BUY';
    else if (signalScore >= 1) signal = 'BUY';
    else if (signalScore <= -3) signal = 'STRONG_SELL';
    else if (signalScore <= -1) signal = 'SELL';

    res.json({
      success: true,
      pair, timeframe: tf,
      price,
      rsi,
      macd: { macdLine, signal: signal },
      bb: { upper: bbUpper, middle: parseFloat(bbMean.toFixed(2)), lower: bbLower },
      volume: parseFloat(vol24h.toFixed(2)),
      signal,
      signalScore,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('analysis error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  ADMIN API ROUTES
// ============================================================

// ── Admin Stats ───────────────────────────────────────────────
app.get('/api/admin/stats', verifyAdmin, async (req, res) => {
  try {
    const [totalUsers, activeSignals, totalSignals, openTrades] = await Promise.all([
      User.countDocuments(),
      Signal.countDocuments({ active: true, status: 'ACTIVE' }),
      Signal.countDocuments(),
      PaperTrade.countDocuments({ status: 'OPEN' })
    ]);
    res.json({ success: true, stats: { totalUsers, activeSignals, totalSignals, openTrades } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin: List Users ─────────────────────────────────────────
app.get('/api/admin/users', verifyAdmin, async (req, res) => {
  try {
    const users = await User.find({}).sort({ createdAt: -1 }).limit(200);
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin: Update User ────────────────────────────────────────
app.patch('/api/admin/users/:uid', verifyAdmin, async (req, res) => {
  try {
    const allowed = ['role', 'plan', 'suspended', 'suspendReason', 'maintenance', 'maintenanceMsg', 'paperBalance'];
    const update  = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    const user = await User.findOneAndUpdate({ uid: req.params.uid }, update, { new: true });
    if (!user) return res.json({ success: false, error: 'User not found' });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin: Create Signal ──────────────────────────────────────
app.post('/api/signals', verifyAdmin, async (req, res) => {
  try {
    const signal = await Signal.create(req.body);
    // Broadcast new signal via WebSocket
    broadcastToAll({ type: 'new_signal', signal });
    res.json({ success: true, signal });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── Admin: Update Signal ──────────────────────────────────────
app.patch('/api/signals/:id', verifyAdmin, async (req, res) => {
  try {
    const signal = await Signal.findByIdAndUpdate(req.params.id, req.body, { new: true });
    broadcastToAll({ type: 'signal_update', signal });
    res.json({ success: true, signal });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin: Delete Signal ──────────────────────────────────────
app.delete('/api/signals/:id', verifyAdmin, async (req, res) => {
  try {
    await Signal.findByIdAndUpdate(req.params.id, { active: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin: Reports ────────────────────────────────────────────
app.get('/api/reports', verifyAdmin, async (req, res) => {
  try {
    const signals = await Signal.find({}).sort({ createdAt: -1 }).limit(100);
    const wins    = signals.filter(s => ['TP1_HIT','TP2_HIT'].includes(s.status)).length;
    const losses  = signals.filter(s => s.status === 'SL_HIT').length;
    const total   = wins + losses;
    res.json({ success: true, reports: { signals, wins, losses, total,
      winRate: total > 0 ? ((wins / total) * 100).toFixed(1) : 0 }});
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/reports/activity', verifyAdmin, async (req, res) => {
  try {
    const trades = await PaperTrade.find({}).sort({ openedAt: -1 }).limit(100);
    res.json({ success: true, trades });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Catch-all: serve index.html ───────────────────────────────
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

// ── WebSocket: Broadcast helper ───────────────────────────────
function broadcastToAll(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// ── Binance WebSocket for live market data ────────────────────
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
      const ticker = {
        symbol: d.s,
        price:  parseFloat(d.c),
        change: parseFloat(d.P),
        high:   parseFloat(d.h),
        low:    parseFloat(d.l),
        volume: parseFloat(d.v)
      };
      broadcastToAll({ type: 'market_update', ticker: [ticker] });
    } catch(_) {}
  });

  binanceWs.on('close', () => {
    console.log('⚠️  Binance WebSocket closed — reconnecting in 5s...');
    binanceReconnectTimer = setTimeout(connectBinance, 5000);
  });

  binanceWs.on('error', err => {
    console.error('Binance WS error:', err.message);
    binanceWs.terminate();
  });
}

// ── Client WebSocket connections ──────────────────────────────
wss.on('connection', async ws => {
  console.log('Client connected. Total:', wss.clients.size);

  // Send latest signals immediately on connect
  try {
    const signals = await Signal.find({ active: true }).sort({ createdAt: -1 }).limit(20);
    ws.send(JSON.stringify({ type: 'signals_update', signals }));
  } catch(_) {}

  ws.on('close', () => {
    console.log('Client disconnected. Total:', wss.clients.size);
  });
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

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down...');
  server.close(() => process.exit(0));
});
