// ============================================================
//  InvestySignals — Backend Server v4 + SIGMA Agent v2.1
//  Node.js + Express + MongoDB + Firebase + WebSocket + LangChain
//
//  ORIGINAL (v4) routes kept 100% intact:
//  ✅ /api/scan            — Smart Scan
//  ✅ /api/deep-analysis   — Original static-prompt AI analysis
//  ✅ /api/trade-monitor   — Active trade advisor
//  ✅ Paper Trading        — Full CRUD + TP/SL engine
//  ✅ Admin routes         — Users, settings, signals, reports
//  ✅ WebSocket            — Live broadcasts
//  ✅ Thesis tracking      — Per-user per-coin state
//
//  NEW (v2.1 Agent) routes added:
//  🆕 GET  /api/agent/analyze       — SSE streaming agent
//  🆕 POST /api/agent/analyze-sync  — REST fallback
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

// ── Models ────────────────────────────────────────────────────
const Signal       = require('./models/Signal');
const User         = require('./models/User');
const Settings     = require('./models/Settings');
const Announcement = require('./models/Announcement');
const Report       = require('./models/Report');
const BalanceRequest = require('./models/BalanceRequest');
const Event        = require('./models/Event');

// ── NEW: SIGMA Agent ──────────────────────────────────────────
const { runAgentWithSSE } = require('./ai_agent');

// ── Firebase ──────────────────────────────────────────────────
try {
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const jsonStr = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf-8');
    credential = admin.credential.cert(JSON.parse(jsonStr));
  } else {
    credential = admin.credential.cert(require('./serviceAccount.json'));
  }
  admin.initializeApp({ credential });
  console.log('✅ Firebase Admin initialized');
} catch (err) {
  console.error('❌ Firebase Admin init failed:', err.message);
  process.exit(1);
}

// ── MongoDB ───────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/investysignals', {
  maxPoolSize: process.env.VERCEL ? 1 : 10,
  bufferCommands: false,
})
  .then(async () => { console.log('✅ MongoDB connected'); await loadSettingsFromDB(); })
  .catch(err => {
    console.error('❌ MongoDB error:', err.message);
    if (!process.env.VERCEL) process.exit(1);
  });

const ADMIN_EMAILS = ['cdilrukshi52@gmail.com'];

const SETTINGS_DEFAULTS = {
  maintenance: false,
  maintenanceMsg: 'We are making improvements. Please check back shortly.',
  allowRegistrations: true,
  highImpactMode: false,
  highImpactMsg: 'High impact news period — signals temporarily paused.',
  groq_api_key: '',
  groq_model: 'llama-3.3-70b-versatile',
  groq_max_tokens: 3500,
  groq_temperature: 0.1,
};
let globalSettings = { ...SETTINGS_DEFAULTS };

async function loadSettingsFromDB() {
  try {
    const docs = await Settings.find({});
    docs.forEach(d => { globalSettings[d.key] = d.value; });
    console.log('⚙️  Settings loaded');
  } catch(e) { console.warn('⚠️  Settings load failed:', e.message); }
}
async function saveSettingToDB(key, value) {
  await Settings.findOneAndUpdate({ key }, { value }, { upsert: true, new: true });
}

// ── Klines Cache ──────────────────────────────────────────────
const klinesCache = new Map();
const KLINES_TTL  = 5 * 60 * 1000;

async function fetchKlinesCached(symbol, interval, limit = 200, retries = 3) {
  const key    = `${symbol}_${interval}_${limit}`;
  const cached = klinesCache.get(key);
  if (cached && Date.now() - cached.ts < KLINES_TTL) return cached.data;

  const urls = [
    `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
  ];

  for (const url of urls) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const r = await fetch(url);
        if (r.status === 429) { await new Promise(res => setTimeout(res, 1000 * Math.pow(2, attempt))); continue; }
        if (!r.ok) break;
        const data = await r.json();
        if (!Array.isArray(data) || data.length < 5) break;
        klinesCache.set(key, { data, ts: Date.now() });
        return data;
      } catch(e) {
        if (attempt === retries - 1) break;
        await new Promise(res => setTimeout(res, 500 * (attempt + 1)));
      }
    }
  }
  throw new Error(`fetchKlines failed: ${symbol} ${interval}`);
}

// ── Live price cache ──────────────────────────────────────────
const priceCache = new Map();
const PRICE_TTL  = 10 * 1000;

async function getLivePrice(symbol) {
  const cached = priceCache.get(symbol);
  if (cached && Date.now() - cached.ts < PRICE_TTL) return cached.price;
  try {
    let price = null;
    const fr = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
    if (fr.ok) { const fd = await fr.json(); price = parseFloat(fd.price) || null; }
    if (!price) {
      const sr = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
      if (sr.ok) { const sd = await sr.json(); price = parseFloat(sd.price) || null; }
    }
    if (price) priceCache.set(symbol, { price, ts: Date.now() });
    return price;
  } catch(e) { return null; }
}

function normalizePair(pair) {
  if (!pair) return '';
  const p = pair.toString().toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
  return p.endsWith('USDT') ? p : p + 'USDT';
}

function sanitizeCandles(klines) {
  if (!klines || klines.length < 10) return klines;
  const closes = klines.map(k => parseFloat(k[4])).sort((a, b) => a - b);
  const median = closes[Math.floor(closes.length / 2)];
  if (median <= 0) return klines;
  return klines.filter(k => Math.abs(parseFloat(k[4]) - median) / median < 0.30);
}

// ── Thesis Tracking (original — for /api/deep-analysis) ──────
const thesisStateOld   = new Map();
const lastAnalysisTime = new Map();
const CONFLUENCE_THRESHOLD = 5;

// ── Express setup ─────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const allowedOrigin  = process.env.ALLOWED_ORIGIN;
const allowedOrigins = allowedOrigin ? [
  allowedOrigin,
  allowedOrigin.replace('://www.', '://'),
  allowedOrigin.replace('://', '://www.'),
].filter(Boolean) : null;

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || !allowedOrigins) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, true);
  },
  credentials: true,
}));
app.use(express.json({ limit: '5mb' }));

const apiLimiter   = rateLimit({ windowMs: 15*60*1000, max: 300, standardHeaders: true, legacyHeaders: false, message: { success: false, error: 'Too many requests.' } });
const adminLimiter = rateLimit({ windowMs: 15*60*1000, max: 1000, standardHeaders: true, legacyHeaders: false, message: { success: false, error: 'Too many requests.' } });
const agentLimiter = rateLimit({ windowMs: 60*1000, max: 5, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => req.ip + ':agent', message: { success: false, error: 'Agent limit: 5/min. Please wait.' } });

app.use('/api/admin/', adminLimiter);
app.use('/api/', apiLimiter);

const BLOCKED_STATIC = ['.env','serviceAccount.json','package.json','.gitignore','deploy.sh','server.js','node_modules'];
app.use((req, res, next) => {
  const file = path.basename(req.path);
  if (BLOCKED_STATIC.includes(file)) return res.status(403).json({ success: false, error: 'Forbidden' });
  next();
});
app.use(express.static(path.join(__dirname)));

// ── Auth middleware ───────────────────────────────────────────
async function ensureAdminPromotion(uid, emailFromToken) {
  try {
    let user = await User.findOne({ uid });
    const email = (emailFromToken || '').toLowerCase();
    const isAdminEmail = ADMIN_EMAILS.includes(email);
    if (!user) {
      let displayName = '';
      try { const fb = await admin.auth().getUser(uid); displayName = fb.displayName || ''; } catch(_) {}
      user = await User.create({ uid, email, displayName, role: isAdminEmail ? 'admin' : 'user', plan: 'free', paperBalance: 1000 });
    } else if (isAdminEmail && user.role !== 'admin') {
      await User.updateOne({ uid }, { role: 'admin', email }); user.role = 'admin';
    }
    return user;
  } catch(e) { return null; }
}

async function verifyToken(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    let dbUser = await User.findOne({ uid: req.user.uid });
    if (!dbUser) {
      try {
        dbUser = await User.create({ uid: req.user.uid, email: (req.user.email || '').toLowerCase(),
          displayName: req.user.name || '',
          role: ADMIN_EMAILS.includes((req.user.email||'').toLowerCase()) ? 'admin' : 'user',
          plan: 'free', paperBalance: 1000 });
      } catch(_) { dbUser = await User.findOne({ uid: req.user.uid }); }
    }
    if (dbUser?.suspended) return res.status(403).json({ success: false, error: 'Account suspended', reason: dbUser.suspendReason });
    req.dbUser = dbUser;
    next();
  } catch(e) { res.status(401).json({ success: false, error: 'Invalid token' }); }
}

async function verifyAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    const u = await ensureAdminPromotion(req.user.uid, (req.user.email || '').toLowerCase());
    if (!u || u.role !== 'admin') return res.status(403).json({ success: false, error: 'Admin access required' });
    req.dbUser = u;
    next();
  } catch(e) { res.status(401).json({ success: false, error: 'Authentication failed' }); }
}

const PLAN_LEVEL = { free: 0, pro: 1, elite: 2, admin: 99 };
function planLevel(plan) { return PLAN_LEVEL[plan] ?? 0; }

// ============================================================
//  STANDARD ROUTES
// ============================================================

app.get('/api/health', (req, res) => res.json({ success: true, status: 'ok', agent: 'SIGMA v2.1', time: new Date().toISOString() }));
app.get('/api/version', (req, res) => res.json({ version: 'v4+SIGMA-2.1', agentEnabled: true }));

app.get('/api/analysis', async (req, res) => {
  try {
    const pair = (req.query.pair || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const tf   = (req.query.tf || '1h').replace(/[^a-zA-Z0-9]/g, '');
    const r    = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=${tf}&limit=100`);
    if (!r.ok) return res.status(502).json({ success: false, error: `Binance error: ${await r.text()}` });
    const klines = await r.json();
    if (!Array.isArray(klines) || klines.length < 15) return res.status(502).json({ success: false, error: 'Not enough data' });
    const closes = klines.map(k => parseFloat(k[4]));
    let gains=0,losses=0;
    for (let i=1;i<=14;i++){const d=closes[i]-closes[i-1];d>=0?gains+=d:losses-=d;}
    let ag=gains/14,al=losses/14;
    for (let i=15;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*13+(d>0?d:0))/14;al=(al*13+(d<0?-d:0))/14;}
    const rsi=parseFloat((100-100/(1+(al===0?100:ag/al))).toFixed(2));
    function _ema(data,n){const k=2/(n+1);let v=data.slice(0,n).reduce((a,b)=>a+b,0)/n;const o=[v];for(let i=n;i<data.length;i++){v=data[i]*k+v*(1-k);o.push(v);}return o;}
    const e12=_ema(closes,12),e26=_ema(closes,26);
    const ml=e12.slice(e12.length-e26.length).map((v,i)=>v-e26[i]),s9=_ema(ml,9);
    const macd=parseFloat(ml[ml.length-1].toFixed(4)),sig=parseFloat(s9[s9.length-1].toFixed(4));
    const bbC=closes.slice(-20),bbM=bbC.reduce((a,b)=>a+b,0)/20;
    const std=Math.sqrt(bbC.reduce((a,c)=>a+Math.pow(c-bbM,2),0)/20);
    res.json({ success:true, pair, tf, price:parseFloat(closes[closes.length-1].toFixed(4)), rsi,
      macd:{macd,signal:sig,histogram:parseFloat((macd-sig).toFixed(4))},
      bb:{upper:parseFloat((bbM+2*std).toFixed(2)),middle:parseFloat(bbM.toFixed(2)),lower:parseFloat((bbM-2*std).toFixed(2))} });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Smart Scan ────────────────────────────────────────────────
const STABLECOINS = new Set(['USDCUSDT','FDUSDUSDT','TUSDUSDT','BUSDUSDT','EURUSDT','DAIUSDT','USDPUSDT','AEURUSDT']);
app.get('/api/scan', async (req, res) => {
  try {
    const ctrl=new AbortController();
    setTimeout(()=>ctrl.abort(),10000);
    const r=await fetch('https://api.binance.com/api/v3/ticker/24hr',{signal:ctrl.signal});
    if (!r.ok) throw new Error(`Binance error: ${r.status}`);
    const data=await r.json();
    const results=data
      .filter(c=>c.symbol.endsWith('USDT')&&!STABLECOINS.has(c.symbol))
      .filter(c=>parseFloat(c.quoteVolume)>=15_000_000&&parseInt(c.count)>=100_000)
      .filter(c=>{const ch=parseFloat(c.priceChangePercent);return ch>=3||ch<=-3;})
      .sort((a,b)=>parseFloat(b.quoteVolume)-parseFloat(a.quoteVolume)).slice(0,20)
      .map(c=>({symbol:c.symbol,change:parseFloat(c.priceChangePercent),volume:parseFloat(c.quoteVolume),price:parseFloat(c.lastPrice),trades:parseInt(c.count)}));
    res.json({ success:true, count:results.length, coins:results });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

app.get('/api/user/status', verifyToken, async (req, res) => {
  try {
    const user=await ensureAdminPromotion(req.user.uid,(req.user.email||'').toLowerCase());
    if (!user) return res.status(500).json({ success:false, error:'Could not load user' });
    await User.updateOne({uid:req.user.uid},{lastLogin:new Date()});
    res.json({ success:true, status:{role:user.role,plan:user.plan,suspended:user.suspended,suspendReason:user.suspendReason,
      maintenance:globalSettings.maintenance||user.maintenance,
      maintenanceMsg:globalSettings.maintenance?globalSettings.maintenanceMsg:(user.maintenanceMsg||''),
      paperBalance:user.paperBalance}});
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

app.get('/api/signals', verifyToken, async (req, res) => {
  try {
    const user=req.dbUser,userPlan=user?user.plan:'free',userRole=user?user.role:'user';
    const pf=userRole==='admin'?{}:{plan:{$in:Object.keys(PLAN_LEVEL).filter(p=>planLevel(p)<=planLevel(userPlan))}};
    const signals=await Signal.find({active:true,...pf}).sort({createdAt:-1}).limit(50);
    res.json({ success:true, signals, data:signals });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

app.get('/api/registration-status', (req, res) => {
  res.json({ success: true, open: globalSettings.allowRegistrations !== false });
});

app.post('/api/reports', async (req, res) => {
  try {
    const { category, message, context } = req.body;
    if (!message) return res.status(400).json({ success: false, error: 'Message is required.' });
    const report = await Report.create({ reporterUid:'anonymous', reporterEmail:req.body.email||'',
      category:category||'other', message:message.slice(0,2000), context:context||'' });
    res.json({ success: true, data: report });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/announcement', async (req, res) => {
  try {
    const now=new Date();
    const ann=await Announcement.findOne({active:true,showFrom:{$lte:now},$or:[{showUntil:null},{showUntil:{$gte:now}}]}).sort({createdAt:-1});
    res.json({ success:true, data:ann, announcement:ann });
  } catch(err) { res.json({ success:true, data:null, announcement:null }); }
});

// ============================================================
//  PAPER TRADING
// ============================================================

const paperTradeSchema2 = new mongoose.Schema({
  uid:{type:String,required:true,index:true}, userUid:{type:String,index:true},
  id:{type:Number}, symbol:{type:String,required:true}, pair:{type:String,required:true},
  direction:{type:String,enum:['LONG','SHORT'],required:true},
  entryType:{type:String,default:'MARKET'}, orderType:{type:String,default:'MARKET'},
  entryPrice:{type:Number}, entry:{type:Number},
  tp1:{type:Number}, tp2:{type:Number}, tp3:{type:Number}, sl:{type:Number},
  amount:{type:Number}, size:{type:Number}, leverage:{type:Number,default:5},
  notional:Number, liqPrice:Number,
  status:{type:String,default:'OPEN'},
  openTime:String, openedAt:Date, fillTime:String, filledAt:Date,
  closeTime:String, closedAt:Date, closePrice:Number,
  pnl:Number, roe:Number, totalPnl:Number, totalRoe:Number,
  tp1Pnl:Number, tp1HitPrice:Number, tp1HitTime:String,
  currentSl:Number, trailOffset:Number, triggerPrice:Number, remainingSize:Number,
},{ timestamps:true });

const paperBalanceSchema2 = new mongoose.Schema({
  uid:{type:String,required:true,unique:true,index:true},
  balance:{type:Number,default:1000},
},{ timestamps:true });

const PT = mongoose.models.PaperTrade   || mongoose.model('PaperTrade',   paperTradeSchema2);
const PB = mongoose.models.PaperBalance || mongoose.model('PaperBalance', paperBalanceSchema2);

async function ptAuth(req, res, next) {
  const auth = (req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ success:false, error:'Unauthorized' });
  try {
    const decoded = await admin.auth().verifyIdToken(auth.slice(7));
    req.uid = decoded.uid; next();
  } catch(e) { res.status(401).json({ success:false, error:'Invalid token' }); }
}

function uidQuery(uid) { return { $or: [{ uid }, { userUid: uid }] }; }

app.get('/api/paper/trades', ptAuth, async (req, res) => {
  try {
    const trades = await PT.find(uidQuery(req.uid)).sort({ id:-1, openedAt:-1, createdAt:-1 }).lean();
    const normalized = trades.map(t => ({ ...t,
      entryPrice:t.entryPrice||t.entry||0, entry:t.entry||t.entryPrice||0,
      amount:t.amount||t.size||0, size:t.size||t.amount||0,
      symbol:normalizePair(t.symbol||t.pair), pair:normalizePair(t.pair||t.symbol) }));
    res.json({ success:true, trades:normalized });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.get('/api/paper-trades', ptAuth, async (req, res) => {
  try {
    const [trades,pb] = await Promise.all([
      PT.find(uidQuery(req.uid)).sort({ id:-1, openedAt:-1, createdAt:-1 }).lean(),
      PB.findOne({ uid: req.uid }),
    ]);
    const normalized = trades.map(t => ({ ...t,
      entryPrice:t.entryPrice||t.entry||0, entry:t.entry||t.entryPrice||0,
      amount:t.amount||t.size||0, size:t.size||t.amount||0,
      symbol:normalizePair(t.symbol||t.pair), pair:normalizePair(t.pair||t.symbol) }));
    res.json({ success:true, trades:normalized, data:normalized, balance:pb?.balance??1000 });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.post('/api/paper/trades', ptAuth, async (req, res) => {
  try {
    const b = req.body;
    const trade = await PT.create({ uid:req.uid, userUid:req.uid, id:b.id||Date.now(),
      symbol:normalizePair(b.symbol||b.pair), pair:normalizePair(b.pair||b.symbol),
      direction:b.direction, entryType:b.entryType||b.orderType||'MARKET',
      orderType:b.orderType||b.entryType||'MARKET',
      entryPrice:b.entryPrice||b.entry||0, entry:b.entry||b.entryPrice||0,
      tp1:b.tp1, tp2:b.tp2, tp3:b.tp3, sl:b.sl,
      amount:b.amount||b.size||0, size:b.size||b.amount||0, leverage:b.leverage||5,
      notional:b.notional, liqPrice:b.liqPrice,
      status:b.status||((b.entryType==='LIMIT'||b.orderType==='LIMIT')?(b.direction==='SHORT'?'PENDING_SHORT':'PENDING_LONG'):'OPEN'),
      openTime:b.openTime||new Date().toISOString(), openedAt:b.openedAt?new Date(b.openedAt):new Date(),
      fillTime:b.fillTime, triggerPrice:b.triggerPrice, remainingSize:b.remainingSize||b.size||b.amount });
    res.json({ success:true, trade });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.post('/api/paper/trade', ptAuth, async (req, res) => {
  try {
    const b = req.body;
    if (!b.pair||!b.direction||!['LONG','SHORT'].includes(b.direction))
      return res.status(400).json({ success:false, error:'Invalid pair or direction.' });
    const entryPrice=parseFloat(b.entry||b.entryPrice)||0;
    const size=parseFloat(b.size||b.amount)||100;
    const lev=Math.min(Math.max(parseInt(b.leverage)||10,1),125);
    const isLimit=(b.orderType||'MARKET')==='LIMIT';
    const statusVal=isLimit?(b.direction==='LONG'?'PENDING_LONG':'PENDING_SHORT'):'OPEN';
    let pb=await PB.findOne({uid:req.uid});
    if (!pb) pb=await PB.create({uid:req.uid,balance:1000});
    if (pb.balance<size) return res.json({success:false,error:`Insufficient balance ($${pb.balance.toFixed(2)}).`});
    const trade=await PT.create({ uid:req.uid,userUid:req.uid,id:b.id||Date.now(),
      symbol:normalizePair(b.pair),pair:normalizePair(b.pair),direction:b.direction,
      entryType:b.orderType||'MARKET',orderType:b.orderType||'MARKET',
      entryPrice,entry:entryPrice,triggerPrice:parseFloat(b.triggerPrice)||entryPrice,
      tp1:parseFloat(b.tp1)||null,tp2:parseFloat(b.tp2)||null,tp3:parseFloat(b.tp3)||null,sl:parseFloat(b.sl)||null,
      amount:size,size,leverage:lev,
      notional:entryPrice?parseFloat((size*lev).toFixed(4)):0,
      liqPrice:entryPrice?parseFloat((b.direction==='LONG'?entryPrice*(1-1/lev*0.9):entryPrice*(1+1/lev*0.9)).toFixed(4)):0,
      remainingSize:size,status:statusVal,openTime:new Date().toISOString(),openedAt:new Date(),
      fillTime:isLimit?null:new Date().toISOString(),filledAt:isLimit?null:new Date() });
    await PB.updateOne({uid:req.uid},{$inc:{balance:-size}});
    try { broadcastToAll({ type:'paper_trade_opened', trade, uid:req.uid }); } catch(_) {}
    res.json({ success:true, trade, message:'Trade opened!' });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.patch('/api/paper/trades/:id', ptAuth, async (req, res) => {
  try {
    const trade=await PT.findOneAndUpdate({...uidQuery(req.uid),id:parseInt(req.params.id)},{$set:req.body},{new:true});
    if (!trade) return res.status(404).json({ success:false, error:'Trade not found' });
    res.json({ success:true, trade });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.patch('/api/paper/trade/:id/close', ptAuth, async (req, res) => {
  try {
    const isObjectId=/^[a-f\d]{24}$/i.test(req.params.id);
    const idFilter=isObjectId?{_id:req.params.id}:{id:parseInt(req.params.id)||0};
    const filter={$and:[uidQuery(req.uid),idFilter]};
    const tradeBeforeClose=await PT.findOne(filter).lean();
    if (!tradeBeforeClose) return res.status(404).json({ success:false, error:'Trade not found' });
    const closePrice=parseFloat(req.body.closePrice)||0;
    const entryPrice=tradeBeforeClose.entryPrice||tradeBeforeClose.entry||0;
    const tradeSize=tradeBeforeClose.remainingSize||tradeBeforeClose.size||tradeBeforeClose.amount||0;
    const leverage=tradeBeforeClose.leverage||1;
    const isLong=tradeBeforeClose.direction==='LONG';
    let pnl=parseFloat(req.body.pnl||req.body.totalPnl||0);
    if (!pnl&&closePrice&&entryPrice&&tradeSize) {
      const notional=tradeSize*leverage;
      pnl=isLong?(closePrice-entryPrice)/entryPrice*notional:(entryPrice-closePrice)/entryPrice*notional;
      pnl=parseFloat(pnl.toFixed(4));
    }
    const notionalForRoe=tradeSize*leverage;
    const roe=notionalForRoe?parseFloat((pnl/(notionalForRoe/leverage)*100).toFixed(2)):0;
    const patch={...req.body,pnl,roe,status:req.body.status||'CLOSED',closedAt:new Date(),closeTime:new Date().toISOString()};
    const trade=await PT.findOneAndUpdate(filter,{$set:patch},{new:true});
    if (!trade) return res.status(404).json({ success:false, error:'Trade not found' });
    if (tradeSize>0) await PB.updateOne({uid:req.uid},{$inc:{balance:tradeSize+pnl}},{upsert:true});
    res.json({ success:true, trade, pnl, roe });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.patch('/api/paper/trade/:id/cancel', ptAuth, async (req, res) => {
  try {
    const isObjectId=/^[a-f\d]{24}$/i.test(req.params.id);
    const idFilter=isObjectId?{_id:req.params.id}:{id:parseInt(req.params.id)||0};
    const filter={$and:[uidQuery(req.uid),idFilter]};
    const trade=await PT.findOneAndUpdate(filter,{$set:{status:'CANCELLED',closedAt:new Date(),closeTime:new Date().toISOString()}},{new:true});
    if (!trade) return res.status(404).json({ success:false, error:'Trade not found' });
    const size=trade.size||trade.amount||0;
    if (size>0) await PB.updateOne({uid:req.uid},{$inc:{balance:size}});
    res.json({ success:true, trade });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.delete('/api/paper/trades/:id', ptAuth, async (req, res) => {
  try {
    await PT.findOneAndDelete({...uidQuery(req.uid),id:parseInt(req.params.id)});
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.delete('/api/paper/trades', ptAuth, async (req, res) => {
  try {
    const { scope } = req.body || {};
    if (scope==='all') { await PT.deleteMany(uidQuery(req.uid)); }
    else {
      const closedStatuses=['TP2','TP2_HIT','TP3_HIT','BE_CLOSE','TRAIL_WIN','SL','SL_HIT','CLOSED','CANCELLED'];
      await PT.deleteMany({...uidQuery(req.uid),status:{$in:closedStatuses}});
    }
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.get('/api/paper/balance', ptAuth, async (req, res) => {
  try {
    let [pb,user]=await Promise.all([PB.findOne({uid:req.uid}),User.findOne({uid:req.uid}).lean()]);
    if (!pb) pb=await PB.create({uid:req.uid,balance:1000});
    res.json({ success:true, balance:pb.balance, hasSetInitialBalance:user?.hasSetInitialBalance??false });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.put('/api/paper/balance', ptAuth, async (req, res) => {
  try {
    const bal=parseFloat(req.body.balance);
    if (isNaN(bal)||bal<0) return res.status(400).json({ success:false, error:'Invalid balance' });
    const pb=await PB.findOneAndUpdate({uid:req.uid},{balance:bal},{upsert:true,new:true});
    res.json({ success:true, balance:pb.balance });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.post('/api/paper/balance/set', ptAuth, async (req, res) => {
  try {
    const bal=parseFloat(req.body.amount||req.body.balance);
    if (isNaN(bal)||bal<1||bal>1_000_000) return res.status(400).json({ success:false, error:'Amount must be 1–1,000,000.' });
    const [pb]=await Promise.all([
      PB.findOneAndUpdate({uid:req.uid},{balance:bal},{upsert:true,new:true}),
      User.findOneAndUpdate({uid:req.uid},{hasSetInitialBalance:true}),
    ]);
    res.json({ success:true, balance:pb.balance });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.get('/api/paper/balance/my-requests', ptAuth, async (req, res) => {
  res.json({ success:true, requests:[] });
});

app.post('/api/paper/balance/request', ptAuth, async (req, res) => {
  try {
    const amount=parseFloat(req.body.amount);
    if (isNaN(amount)||amount<100||amount>1_000_000) return res.status(400).json({ success:false, error:'Amount must be 100–1,000,000.' });
    const reason=(req.body.reason||'').trim().slice(0,300);
    const [user,pb]=await Promise.all([User.findOne({uid:req.uid}).lean(),PB.findOne({uid:req.uid})]);
    const BR_m=mongoose.models.BalanceRequest||require('./models/BalanceRequest');
    await BR_m.create({ userUid:req.uid, userEmail:user?.email||'', displayName:user?.displayName||'',
      requestType:'CUSTOM', requestedAmount:amount, currentBalance:pb?.balance??1000, reason, status:'pending' });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

// ============================================================
//  DEEP ANALYSIS — original static-prompt route (kept intact)
// ============================================================
app.post('/api/deep-analysis', verifyToken, async (req, res) => {
  let analysis = null;
  try {
    const rawPair = req.body.pair || 'BTCUSDT';
    const coin    = normalizePair(rawPair);

    if (globalSettings.maintenance) return res.status(503).json({ success:false, error: globalSettings.maintenanceMsg||'Maintenance' });
    if (globalSettings.highImpactMode) return res.status(503).json({ success:false, error: globalSettings.highImpactMsg||'High impact mode' });

    const currentPrice = await getLivePrice(coin);
    if (!currentPrice) return res.status(502).json({ success:false, error:`Could not fetch price for ${coin}` });

    // ── Fetch all timeframe klines ──────────────────────────
    const [raw_m15, raw_h1, raw_h4, raw_d1, raw_btcH4] = await Promise.all([
      fetchKlinesCached(coin, '15m', 100),
      fetchKlinesCached(coin, '1h',  250),
      fetchKlinesCached(coin, '4h',  150),
      fetchKlinesCached(coin, '1d',  250),
      fetchKlinesCached('BTCUSDT', '4h', 50),
    ]);

    const s = sanitizeCandles;
    const m15k=s(raw_m15), h1k=s(raw_h1), h4k=s(raw_h4), d1k=s(raw_d1);

    // Parse to OHLCV
    const parseK = (k) => k.map(c => ({ open:+c[1],high:+c[2],low:+c[3],close:+c[4],volume:+c[5] }));
    const m15c=parseK(m15k), h1c=parseK(h1k), h4c=parseK(h4k), d1c=parseK(d1k), btcH4c=parseK(raw_btcH4);

    const m15cl=m15c.map(x=>x.close), h1cl=h1c.map(x=>x.close), h4cl=h4c.map(x=>x.close), d1cl=d1c.map(x=>x.close);
    const btcCl=btcH4c.map(x=>x.close);

    // ── Shared indicator helpers ────────────────────────────
    function _rsi(closes,period=14) {
      if (closes.length<period+2) return 50;
      let g=0,l=0;
      for(let i=1;i<=period;i++){const d=closes[i]-closes[i-1];d>=0?g+=d:l-=d;}
      let ag=g/period,al=l/period;
      for(let i=period+1;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*(period-1)+(d>0?d:0))/period;al=(al*(period-1)+(d<0?-d:0))/period;}
      if(al===0)return 100;if(ag===0)return 0;
      return parseFloat((100-100/(1+ag/al)).toFixed(1));
    }
    function _rsiArr(closes,period=14) {
      const out=[];if(closes.length<period+2)return out;
      let g=0,l=0;
      for(let i=1;i<=period;i++){const d=closes[i]-closes[i-1];d>=0?g+=d:l-=d;}
      let ag=g/period,al=l/period;
      const push=()=>{if(al===0)out.push(100);else if(ag===0)out.push(0);else out.push(parseFloat((100-100/(1+ag/al)).toFixed(1)));};
      push();
      for(let i=period+1;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*(period-1)+(d>0?d:0))/period;al=(al*(period-1)+(d<0?-d:0))/period;push();}
      return out;
    }
    function _ema(arr,n){const k=2/(n+1);let v=arr.slice(0,n).reduce((a,b)=>a+b,0)/n;const o=[v];for(let i=n;i<arr.length;i++){v=arr[i]*k+v*(1-k);o.push(v);}return o;}
    function _macd(closes){
      if(closes.length<35)return{signal:'NEUTRAL',hist:0,prevHist:0};
      const k12=2/13,k26=2/27,k9=2/10;
      let e12=closes.slice(0,12).reduce((a,b)=>a+b,0)/12;
      let e26=closes.slice(0,26).reduce((a,b)=>a+b,0)/26;
      for(let i=12;i<26;i++)e12=closes[i]*k12+e12*(1-k12);
      const ml=[];
      for(let i=26;i<closes.length;i++){e12=closes[i]*k12+e12*(1-k12);e26=closes[i]*k26+e26*(1-k26);ml.push(e12-e26);}
      if(ml.length<9)return{signal:'NEUTRAL',hist:0,prevHist:0};
      let sig=ml.slice(0,9).reduce((a,b)=>a+b,0)/9;
      for(let i=9;i<ml.length;i++)sig=ml[i]*k9+sig*(1-k9);
      const hist=parseFloat((ml[ml.length-1]-sig).toFixed(6));
      const prevHist=ml.length>1?(()=>{let s2=ml.slice(0,9).reduce((a,b)=>a+b,0)/9;for(let i=9;i<ml.length-1;i++)s2=ml[i]*k9+s2*(1-k9);return parseFloat((ml[ml.length-2]-s2).toFixed(6));})():0;
      return{signal:hist>0?'BULLISH':'BEARISH',hist,prevHist};
    }
    function _struct(candles){
      if(candles.length<20)return'RANGING';
      const c=candles.slice(-20),mid=Math.floor(c.length/2);
      const pHH=Math.max(...c.slice(0,mid).map(x=>x.high)),pLL=Math.min(...c.slice(0,mid).map(x=>x.low));
      const cHH=Math.max(...c.slice(mid).map(x=>x.high)),cLL=Math.min(...c.slice(mid).map(x=>x.low));
      const last=c[c.length-1].close;
      if(cHH>pHH&&last>pHH)return'BOS_BULLISH';if(cLL<pLL&&last<pLL)return'BOS_BEARISH';
      if(cHH>pHH)return'CHOCH_BULLISH';if(cLL<pLL)return'CHOCH_BEARISH';return'RANGING';
    }
    function _atr(candles,n=14){
      if(candles.length<n+1)return 0;
      const trs=candles.slice(1).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-candles[i].close),Math.abs(c.low-candles[i].close)));
      let atr=trs.slice(0,n).reduce((a,b)=>a+b,0)/n;
      for(let i=n;i<trs.length;i++)atr=(atr*(n-1)+trs[i])/n;
      return parseFloat(atr.toFixed(6));
    }
    function _adx(candles,period=14){
      if(candles.length<period*2+1)return{adx:0,plusDI:0,minusDI:0,trend:'RANGING',strength:'WEAK'};
      const trA=[],pDM=[],mDM=[];
      for(let i=1;i<candles.length;i++){const c=candles[i],p=candles[i-1];const hd=c.high-p.high,ld=p.low-c.low;trA.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));pDM.push(hd>0&&hd>ld?hd:0);mDM.push(ld>0&&ld>hd?ld:0);}
      function ws(a,p){let s=a.slice(0,p).reduce((x,y)=>x+y,0);const o=[s];for(let i=p;i<a.length;i++){s=s-s/p+a[i];o.push(s);}return o;}
      const sTR=ws(trA,period),sPDM=ws(pDM,period),sMDM=ws(mDM,period);
      const dx=sTR.map((tr,i)=>{if(!tr)return 0;const pd=100*sPDM[i]/tr,md=100*sMDM[i]/tr;return Math.abs(pd-md)/((pd+md)||1)*100;});
      const adxA=ws(dx,period);const adxV=parseFloat((adxA[adxA.length-1]/period).toFixed(2));
      const lTR=sTR[sTR.length-1];const pdi=lTR?parseFloat((100*sPDM[sPDM.length-1]/lTR).toFixed(2)):0;const mdi=lTR?parseFloat((100*sMDM[sMDM.length-1]/lTR).toFixed(2)):0;
      return{adx:adxV,plusDI:pdi,minusDI:mdi,trend:adxV>25?(pdi>mdi?'TRENDING_BULL':'TRENDING_BEAR'):'RANGING',strength:adxV>50?'VERY_STRONG':adxV>35?'STRONG':adxV>25?'MODERATE':'WEAK'};
    }
    function _bb(closes,period=20){
      const sl=closes.slice(-period);if(sl.length<period)return null;
      const mean=sl.reduce((a,b)=>a+b,0)/period;
      const std=Math.sqrt(sl.reduce((a,c)=>a+(c-mean)**2,0)/period);
      return{upper:parseFloat((mean+2*std).toFixed(4)),middle:parseFloat(mean.toFixed(4)),lower:parseFloat((mean-2*std).toFixed(4)),bandwidth:parseFloat((4*std/mean*100).toFixed(2))};
    }
    function _volRatio(candles,n=20){
      if(candles.length<n+1)return 1;
      const avg=candles.slice(-n-1,-1).reduce((a,c)=>a+c.volume,0)/n;
      return avg>0?parseFloat((candles[candles.length-1].volume/avg).toFixed(2)):1;
    }
    function _candlePat(c){
      const body=Math.abs(c.close-c.open),range=c.high-c.low;
      if(range===0||body/range<0.1)return'DOJI';
      const upper=c.high-Math.max(c.open,c.close),lower=Math.min(c.open,c.close)-c.low;
      if(c.close>c.open){if(lower>body*2)return'PIN_BAR_BULL';return'BULL_CANDLE';}
      else{if(upper>body*2)return'PIN_BAR_BEAR';return'BEAR_CANDLE';}
    }
    function _fvg(candles){
      const fvgs=[];
      for(let i=2;i<candles.length;i++){const p=candles[i-2],c=candles[i];
        if(c.low>p.high&&!candles.slice(i+1).some(x=>x.low<c.low))fvgs.push({type:'BULL',low:parseFloat(p.high.toFixed(4)),high:parseFloat(c.low.toFixed(4))});
        else if(c.high<p.low&&!candles.slice(i+1).some(x=>x.high>c.high))fvgs.push({type:'BEAR',low:parseFloat(c.high.toFixed(4)),high:parseFloat(p.low.toFixed(4))});}
      return fvgs.slice(-5);
    }
    function _ob(candles,max=5){
      const last=candles[candles.length-1].close;
      const avgBody=candles.slice(-30).reduce((s,c)=>s+Math.abs(c.close-c.open),0)/30;
      const obs=[];const fmt=v=>parseFloat(v.toFixed(4));
      for(let i=candles.length-4;i>=1;i--){if(obs.length>=max)break;
        const ob=candles[i],nx=candles[i+1];if(Math.abs(nx.close-nx.open)<avgBody*0.5)continue;
        if(ob.close<ob.open&&nx.close>nx.open&&nx.close>ob.high&&last>ob.low&&!candles.slice(i+2).some(c=>c.close<ob.low))
          obs.push({type:'BULL_OB',low:fmt(ob.low),high:fmt(ob.high),dist:parseFloat(((last-ob.high)/ob.high*100).toFixed(2))});
        if(ob.close>ob.open&&nx.close<nx.open&&nx.close<ob.low&&last<ob.high&&!candles.slice(i+2).some(c=>c.close>ob.high))
          obs.push({type:'BEAR_OB',low:fmt(ob.low),high:fmt(ob.high),dist:parseFloat(((ob.low-last)/last*100).toFixed(2))});}
      return obs;
    }
    function _div(candles,rsiArr){
      if(candles.length<12||rsiArr.length<12)return'NONE';
      const n=Math.min(candles.length,rsiArr.length,20),half=Math.floor(n/2);
      const phH=Math.max(...candles.slice(-n,-half).map(c=>c.high)),plL=Math.min(...candles.slice(-n,-half).map(c=>c.low));
      const chH=Math.max(...candles.slice(-half).map(c=>c.high)),clL=Math.min(...candles.slice(-half).map(c=>c.low));
      const prH=Math.max(...rsiArr.slice(-n,-half)),prL=Math.min(...rsiArr.slice(-n,-half));
      const crH=Math.max(...rsiArr.slice(-half)),crL=Math.min(...rsiArr.slice(-half));
      if(chH>phH&&crH<prH)return'BEARISH_DIV';if(clL<plL&&crL>prL)return'BULLISH_DIV';return'NONE';
    }
    function _sr(candles,n=5){
      const price=candles[candles.length-1].close,pivots=[];
      for(let i=n;i<candles.length-n;i++){const w=candles.slice(i-n,i+n+1);if(candles[i].high===Math.max(...w.map(c=>c.high)))pivots.push(candles[i].high);if(candles[i].low===Math.min(...w.map(c=>c.low)))pivots.push(candles[i].low);}
      const u=[...new Set(pivots.map(p=>parseFloat(p.toFixed(4))))].sort((a,b)=>a-b);
      return[...u.filter(p=>p<=price).slice(-4),...u.filter(p=>p>price).slice(0,4)].sort((a,b)=>a-b);
    }

    // ── Compute all indicators ──────────────────────────────
    const m15RSI=_rsi(m15cl), h1RSI=_rsi(h1cl), h4RSI=_rsi(h4cl), d1RSI=_rsi(d1cl);
    const m15rsiArr=_rsiArr(m15cl), h1rsiArr=_rsiArr(h1cl), h4rsiArr=_rsiArr(h4cl);
    const m15Div=_div(m15c,m15rsiArr), h1Div=_div(h1c,h1rsiArr), h4Div=_div(h4c,h4rsiArr);
    const h1MACD=_macd(h1cl), h4MACD=_macd(h4cl), d1MACD=_macd(d1cl);
    const m15Struct=_struct(m15c), h1Struct=_struct(h1c), h4Struct=_struct(h4c), d1Struct=_struct(d1c);
    const h4ATR=_atr(h4c), h1ATR=_atr(h1c), m15ATR=_atr(m15c);
    const adx=_adx(h4c);
    const h1BB=_bb(h1cl), h4BB=_bb(h4cl);
    const h1VolR=_volRatio(h1c), m15VolR=_volRatio(m15c);
    const m15Pat=_candlePat(m15c[m15c.length-1]);
    const h4FVGs=_fvg(h4c), h1FVGs=_fvg(h1c);
    const h4OBs=_ob(h4c,5), d1OBs=_ob(d1c,3);
    const h4SR=_sr(h4c), d1SR=_sr(d1c);

    // EMA values
    const h1Ema20=parseFloat(_ema(h1cl,20).at(-1).toFixed(4));
    const h1Ema50=parseFloat(_ema(h1cl,50).at(-1).toFixed(4));
    const h1Ema200=parseFloat(_ema(h1k.map(k=>+k[4]),200).at(-1).toFixed(4));
    const h4Ema20=parseFloat(_ema(h4cl,20).at(-1).toFixed(4));
    const h4Ema50=parseFloat(_ema(h4cl,50).at(-1).toFixed(4));
    const d1Ema200=parseFloat(_ema(d1k.map(k=>+k[4]),200).at(-1).toFixed(4));

    // BTC 4H trend
    const btcEma20=parseFloat(_ema(btcCl,20).at(-1).toFixed(4));
    const btcPrice=btcCl[btcCl.length-1];
    const btcGap=Math.abs(btcPrice-btcEma20)/btcEma20*100;
    const btcTrend=btcPrice>btcEma20?(btcGap>1.5?'STRONG_BULL':'BULL'):(btcGap>1.5?'STRONG_BEAR':'BEAR');

    // Prev day H/L
    const d1Candles=parseK(d1k);
    const prevDay=d1Candles.length>=2?d1Candles[d1Candles.length-2]:null;
    const prevDayHigh=prevDay?parseFloat(prevDay.high.toFixed(4)):null;
    const prevDayLow=prevDay?parseFloat(prevDay.low.toFixed(4)):null;

    // Fibonacci
    const d1Highs=d1Candles.map(c=>c.high).slice(-20),d1Lows=d1Candles.map(c=>c.low).slice(-20);
    const swHigh=Math.max(...d1Highs),swLow=Math.min(...d1Lows),rng=swHigh-swLow||currentPrice*0.01;
    const isBullFib=currentPrice>swLow+rng*0.5;
    const fibLev=(r)=>isBullFib?swHigh-rng*r:swLow+rng*r;
    const fib={f236:parseFloat(fibLev(0.236).toFixed(4)),f382:parseFloat(fibLev(0.382).toFixed(4)),f500:parseFloat(fibLev(0.500).toFixed(4)),f618:parseFloat(fibLev(0.618).toFixed(4)),f786:parseFloat(fibLev(0.786).toFixed(4))};

    // Funding + OI
    let fundRate=null,oiTrend='UNKNOWN',oiSignalStr='NEUTRAL',lsRatio=null;
    try {
      const [fRes,oiHistRes,lsRes]=await Promise.allSettled([
        fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin}`).then(r=>r.json()),
        fetch(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${coin}&period=1h&limit=6`).then(r=>r.json()),
        fetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${coin}&period=1h&limit=2`).then(r=>r.json()),
      ]);
      if(fRes.status==='fulfilled')fundRate=parseFloat(fRes.value.lastFundingRate)*100;
      if(oiHistRes.status==='fulfilled'&&Array.isArray(oiHistRes.value)&&oiHistRes.value.length>=2){
        const oiOld=parseFloat(oiHistRes.value[0].sumOpenInterest),oiNew=parseFloat(oiHistRes.value[oiHistRes.value.length-1].sumOpenInterest);
        oiTrend=oiNew>oiOld?'RISING':'FALLING';
        const priceDir=currentPrice>btcPrice*1.001?'UP':currentPrice<btcPrice*0.999?'DOWN':'FLAT';
        oiSignalStr=oiTrend==='RISING'&&priceDir==='UP'?'BULLISH_CONTINUATION':oiTrend==='RISING'&&priceDir==='DOWN'?'BEARISH_CONTINUATION':oiTrend==='FALLING'&&priceDir==='UP'?'SHORT_SQUEEZE':'LONG_LIQUIDATION';
      }
      if(lsRes.status==='fulfilled'&&Array.isArray(lsRes.value)&&lsRes.value.length)lsRatio=parseFloat(lsRes.value[lsRes.value.length-1].longShortRatio);
    } catch(_) {}

    // Early warnings
    const earlyWarnings=[];
    if(m15RSI>70&&h4RSI<70&&h4Struct==='BOS_BULLISH')earlyWarnings.push(`M15 RSI overbought (${m15RSI}) vs 4H bullish — short-term top possible`);
    if(m15RSI<30&&h4RSI>30&&h4Struct==='BOS_BEARISH')earlyWarnings.push(`M15 RSI oversold (${m15RSI}) vs 4H bearish — bounce possible`);
    if(m15Div==='BEARISH_DIV'&&h1Struct==='BOS_BULLISH')earlyWarnings.push('M15 bearish divergence vs H1 bullish — watch for CHoCH');
    if(m15Div==='BULLISH_DIV'&&h1Struct==='BOS_BEARISH')earlyWarnings.push('M15 bullish divergence vs H1 bearish — reversal signal');
    const m15MACDv=_macd(m15cl);
    if(m15MACDv.hist<0&&m15MACDv.prevHist>0&&h4Struct==='BOS_BULLISH')earlyWarnings.push('M15 MACD crossed bearish vs 4H bullish — early warning');
    if(m15VolR>2&&m15Struct==='BOS_BEARISH'&&h4Struct==='BOS_BULLISH')earlyWarnings.push(`Volume spike (${m15VolR}×) on M15 bearish vs 4H bullish — distribution risk`);

    // Score
    let bullScore=0,bearScore=0;
    const score=(b,c)=>{if(b)bullScore+=c;else bearScore+=c;};
    score(h4Struct.includes('BULLISH'),2); score(d1Struct.includes('BULLISH'),2);
    score(h4RSI>50&&h4RSI<70,1); score(h1MACD.signal==='BULLISH',1);
    score(h4MACD.signal==='BULLISH',1); score(currentPrice>h1Ema200,1);
    score(h4Div!=='BEARISH_DIV',0.5); score(!h4Struct.includes('BEARISH'),0.5);
    const netScore=Math.round(bullScore-bearScore);
    const confScore=Math.min(10,Math.round(Math.abs(netScore)+3));

    // Thesis tracking (old deep-analysis)
    const uid=req.user?.uid||'anon';
    const thesisKey=`${uid}:${coin}`;
    const prevT=thesisStateOld.get(thesisKey);
    let thesisStatus='NEW',thesisCtx='';
    if(prevT&&prevT.ts&&(Date.now()-prevT.ts<6*3600000)){
      const d1M=prevT.d1Struct===d1Struct,h4M=prevT.h4Struct===h4Struct;
      thesisStatus=d1M&&h4M?'CONFIRMED':d1M?'RETRACEMENT':!h4M?'WEAKENING':'INVALIDATED';
      thesisCtx=`Previous: ${prevT.bias} (Score ${prevT.score}/10) | Thesis: ${thesisStatus}`;
    }

    // Determine direction
    const isLong=bullScore>bearScore;
    const direction=confScore<CONFLUENCE_THRESHOLD?'NEUTRAL':(isLong?'LONG':'SHORT');

    // Entry zone
    const h4ATRv=h4ATR,m15ATRv=m15ATR;
    let entryLow,entryHigh,slLevel;
    if(direction==='LONG'){
      const nearBullOB=h4OBs.find(o=>o.type==='BULL_OB');
      entryLow=nearBullOB?nearBullOB.low:parseFloat((currentPrice-h4ATRv*0.5).toFixed(4));
      entryHigh=parseFloat((entryLow+m15ATRv*2).toFixed(4));
      const swL15=Math.min(...m15c.slice(-15).map(c=>c.low));
      slLevel=parseFloat((swL15-h4ATRv*0.3).toFixed(4));
    } else if(direction==='SHORT'){
      const nearBearOB=h4OBs.find(o=>o.type==='BEAR_OB');
      entryHigh=nearBearOB?nearBearOB.high:parseFloat((currentPrice+h4ATRv*0.5).toFixed(4));
      entryLow=parseFloat((entryHigh-m15ATRv*2).toFixed(4));
      const swH15=Math.max(...m15c.slice(-15).map(c=>c.high));
      slLevel=parseFloat((swH15+h4ATRv*0.3).toFixed(4));
    } else {
      entryLow=parseFloat((currentPrice-h4ATRv).toFixed(4));
      entryHigh=parseFloat((currentPrice+h4ATRv).toFixed(4));
      slLevel=parseFloat((direction==='LONG'?currentPrice-h4ATRv*1.5:currentPrice+h4ATRv*1.5).toFixed(4));
    }
    const riskAmt=Math.abs((entryLow+entryHigh)/2-slLevel)||h4ATRv;
    const tp1=parseFloat(((direction==='LONG'?(entryHigh+riskAmt*1.5):(entryLow-riskAmt*1.5))).toFixed(4));
    const tp2=parseFloat(((direction==='LONG'?(entryHigh+riskAmt*2.5):(entryLow-riskAmt*2.5))).toFixed(4));
    const tp3=parseFloat(((direction==='LONG'?(entryHigh+riskAmt*4):(entryLow-riskAmt*4))).toFixed(4));

    // Save thesis
    thesisStateOld.set(thesisKey,{bias:direction,score:confScore,d1Struct,h4Struct,ts:Date.now()});

    // Build response
    analysis={
      success:true, pair:coin, currentPrice,
      thesisStatus, thesisContext:thesisCtx,
      btcTrend,
      indicators:{
        rsi:{m15:m15RSI,h1:h1RSI,h4:h4RSI,d1:d1RSI},
        rsiDivergence:{m15:m15Div,h1:h1Div,h4:h4Div},
        macd:{h1:h1MACD.signal,h4:h4MACD.signal,d1:d1MACD.signal},
        ema:{h1_20:h1Ema20,h1_50:h1Ema50,h1_200:h1Ema200,h4_20:h4Ema20,h4_50:h4Ema50,d1_200:d1Ema200},
        bb:{h1:h1BB,h4:h4BB},
        atr:{h4:h4ATR,h1:h1ATR,m15:m15ATR},
        adx,
        volume:{h1Ratio:h1VolR,m15Ratio:m15VolR},
        candlePattern:{m15:m15Pat},
        prevDayHL:{high:prevDayHigh,low:prevDayLow},
        oiTrend, oiSignal:oiSignalStr,
        fundingRate:fundRate,lsRatio,
      },
      structures:{m15:m15Struct,h1:h1Struct,h4:h4Struct,d1:d1Struct},
      orderBlocks:{h4:h4OBs,d1:d1OBs},
      fvgs:{h4:h4FVGs,h1:h1FVGs},
      fibonacci:fib, srLevels:{h4:h4SR,d1:d1SR},
      earlyWarnings,
      signal:{
        direction, confluenceScore:confScore,
        entryZone:{low:entryLow,high:entryHigh},
        stopLoss:slLevel, tp1, tp2, tp3,
        grade:confScore>=8?'S':confScore>=7?'A':confScore>=6?'B':'C',
      },
    };

    // Groq AI narrative
    const groqKey=(globalSettings.groq_api_key||'').trim()||process.env.GROQ_API_KEY;
    const groqModel=globalSettings.groq_model||'llama-3.3-70b-versatile';
    const groqMaxTok=globalSettings.groq_max_tokens||3500;
    const groqTemp=globalSettings.groq_temperature||0.1;

    if(groqKey){
      const prompt=`You are SIGMA, an institutional crypto analyst. Analyze ${coin} and produce a structured trade report.

DATA:
- Price: $${currentPrice}
- BTC 4H Trend: ${btcTrend}
- Thesis: ${thesisStatus}${thesisCtx?` — ${thesisCtx}`:''}
- Structure: D1=${d1Struct}, H4=${h4Struct}, H1=${h1Struct}, M15=${m15Struct}
- RSI: D1=${d1RSI}, H4=${h4RSI} (${h4Div}), H1=${h1RSI}, M15=${m15RSI} (${m15Div})
- MACD: H4=${h4MACD.signal}, H1=${h1MACD.signal}
- EMA: H1_20=${h1Ema20}, H1_50=${h1Ema50}, H1_200=${h1Ema200}, D1_200=${d1Ema200}
- BB H4: ${JSON.stringify(h4BB)}
- ADX: ${adx.adx} (${adx.trend}) +DI=${adx.plusDI} -DI=${adx.minusDI}
- Volume Spike: H1=${h1VolR}× M15=${m15VolR}×
- Candle Pattern M15: ${m15Pat}
- Prev Day: High=${prevDayHigh} Low=${prevDayLow}
- Funding: ${fundRate!==null?fundRate+'%/8h':'N/A'}
- OI Trend: ${oiTrend} → ${oiSignalStr}
- Long/Short Ratio: ${lsRatio||'N/A'}
- H4 Order Blocks: ${JSON.stringify(h4OBs.slice(0,3))}
- H4 FVGs: ${JSON.stringify(h4FVGs.slice(0,3))}
- Key Fibonacci: 38.2%=${fib.f382}, 50%=${fib.f500}, 61.8%=${fib.f618}
- Early Warnings: ${earlyWarnings.length>0?earlyWarnings.join(' | '):'None'}
- Suggested: ${direction} | Entry ${entryLow}-${entryHigh} | SL ${slLevel} | TP1 ${tp1} | Score ${confScore}/10

Write a concise institutional analysis (4-6 paragraphs): overview, structure, entry rationale, risks.`;

      try{
        const gRes=await fetch('https://api.groq.com/openai/v1/chat/completions',{
          method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+groqKey},
          body:JSON.stringify({model:groqModel,max_tokens:groqMaxTok,temperature:groqTemp,
            messages:[{role:'system',content:'You are SIGMA, an institutional crypto analyst. Be precise and concise.'},{role:'user',content:prompt}]})
        });
        if(gRes.ok){const gData=await gRes.json();analysis.aiNarrative=gData.choices?.[0]?.message?.content||'';}
      }catch(e){console.warn('Groq narrative error:',e.message);}
    }

    res.json(analysis);
  } catch(err){
    console.error('/api/deep-analysis error:', err.message);
    if(!res.headersSent) res.status(500).json({ success:false, error:err.message });
  }
});

// ============================================================
//  TRADE MONITOR — kept 100% intact
// ============================================================
app.post('/api/trade-monitor', verifyToken, async (req, res) => {
  try {
    const { pair, direction, entry, sl, tp1, tp2, tp3 } = req.body;
    if (!pair||!direction||!entry) return res.status(400).json({ success:false, error:'pair, direction, entry required.' });
    const normalizedPair=normalizePair(pair);
    const currentPrice=await getLivePrice(normalizedPair);
    if (!currentPrice) return res.status(502).json({ success:false, error:`Could not fetch price for ${normalizedPair}.` });

    async function getKlines(sym,interval,limit){
      let klines=null;
      try{const fr=await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${limit}`);if(fr.ok){const d=await fr.json();if(Array.isArray(d)&&d.length>5)klines=d;}}catch(_){}
      if(!klines){try{const sr=await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`);if(sr.ok){const d=await sr.json();if(Array.isArray(d)&&d.length>5)klines=d;}}catch(_){}}
      if(!klines)return[];
      return klines.map(k=>({open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5]}));
    }

    const [m15k,h1k,h4k,d1k]=await Promise.all([getKlines(normalizedPair,'15m',100),getKlines(normalizedPair,'1h',250),getKlines(normalizedPair,'4h',100),getKlines(normalizedPair,'1d',250)]);
    function monRsi(closes,period=14){if(closes.length<period+2)return 50;let g=0,l=0;for(let i=1;i<=period;i++){const d=closes[i]-closes[i-1];d>=0?g+=d:l-=d;}let ag=g/period,al=l/period;for(let i=period+1;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*(period-1)+(d>0?d:0))/period;al=(al*(period-1)+(d<0?-d:0))/period;}if(al===0)return 100;if(ag===0)return 0;return parseFloat((100-100/(1+ag/al)).toFixed(1));}
    function monEma(arr,n){if(arr.length<n)return arr[arr.length-1]||0;const k=2/(n+1);let v=arr.slice(0,n).reduce((a,b)=>a+b,0)/n;for(let i=n;i<arr.length;i++)v=arr[i]*k+v*(1-k);return parseFloat(v.toFixed(6));}
    function monMacd(closes){if(closes.length<35)return{signal:'NEUTRAL',hist:0};const k12=2/13,k26=2/27,k9=2/10;let e12=closes.slice(0,12).reduce((a,b)=>a+b,0)/12,e26=closes.slice(0,26).reduce((a,b)=>a+b,0)/26;for(let i=12;i<26;i++)e12=closes[i]*k12+e12*(1-k12);const ml=[];for(let i=26;i<closes.length;i++){e12=closes[i]*k12+e12*(1-k12);e26=closes[i]*k26+e26*(1-k26);ml.push(e12-e26);}if(ml.length<9)return{signal:'NEUTRAL',hist:0};let sig=ml.slice(0,9).reduce((a,b)=>a+b,0)/9;for(let i=9;i<ml.length;i++)sig=ml[i]*k9+sig*(1-k9);const hist=parseFloat((ml[ml.length-1]-sig).toFixed(6));return{signal:hist>0?'BULLISH':'BEARISH',hist};}
    function monStruct(candles){if(candles.length<20)return'RANGING';const c=candles.slice(-20),mid=Math.floor(c.length/2);const pHH=Math.max(...c.slice(0,mid).map(x=>x.high)),pLL=Math.min(...c.slice(0,mid).map(x=>x.low)),cHH=Math.max(...c.slice(mid).map(x=>x.high)),cLL=Math.min(...c.slice(mid).map(x=>x.low)),last=c[c.length-1].close;if(cHH>pHH&&last>pHH)return'BOS_BULLISH';if(cLL<pLL&&last<pLL)return'BOS_BEARISH';if(cHH>pHH)return'CHOCH_BULLISH';if(cLL<pLL)return'CHOCH_BEARISH';return'RANGING';}
    function monAtr(candles,n=14){if(candles.length<n+1)return 0;const trs=candles.slice(1).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-candles[i].close),Math.abs(c.low-candles[i].close)));let atr=trs.slice(0,n).reduce((a,b)=>a+b,0)/n;for(let i=n;i<trs.length;i++)atr=(atr*(n-1)+trs[i])/n;return parseFloat(atr.toFixed(6));}
    function _da_volRatio(candles,n=20){if(candles.length<n+1)return 1;const avg=candles.slice(-n-1,-1).reduce((a,c)=>a+c.volume,0)/n;return avg>0?parseFloat((candles[candles.length-1].volume/avg).toFixed(2)):1;}

    const m15c=m15k.slice(-50),h1c=h1k.slice(-80),h4c=h4k.slice(-80),d1c=d1k.slice(-30);
    const m15cl=m15c.map(x=>x.close),h1cl=h1c.map(x=>x.close),h4cl=h4c.map(x=>x.close),d1cl=d1c.map(x=>x.close);
    const m15RSI=monRsi(m15cl),h1RSI=monRsi(h1cl),h4RSI=monRsi(h4cl);
    const h1Ema20=monEma(h1cl,20),h1Ema50=monEma(h1cl,50),h1Ema200=monEma(h1k.map(x=>x.close),200),d1Ema200=monEma(d1k.map(x=>x.close),200),h4Ema20=monEma(h4cl,20),h4Ema50=monEma(h4cl,50);
    const h1MACD=monMacd(h1cl),h4MACD=monMacd(h4cl);
    const m15Struct=monStruct(m15c),h1Struct=monStruct(h1c),h4Struct=monStruct(h4c),d1Struct=monStruct(d1c);
    const h4ATR=monAtr(h4c),h1ATR=monAtr(h1c),h1VolR=_da_volRatio(h1c);
    const priceAboveEma20H1=currentPrice>h1Ema20,priceAboveEma50H1=currentPrice>h1Ema50,priceAboveEma200H1=currentPrice>h1Ema200,priceAboveD1Ema200=currentPrice>d1Ema200,ema20AboveEma50H4=h4Ema20>h4Ema50;
    const isLong=direction==='LONG',entryNum=parseFloat(entry),slNum=parseFloat(sl)||null,tp1Num=parseFloat(tp1)||null;
    const d1Highs=d1c.map(c=>c.high),d1Lows=d1c.map(c=>c.low),swingHigh=Math.max(...d1Highs.slice(-20)),swingLow=Math.min(...d1Lows.slice(-20)),range=Math.max(swingHigh-swingLow,entryNum*0.01);
    const fib382=isLong?swingHigh-range*0.382:swingLow+range*0.382,fib500=isLong?swingHigh-range*0.500:swingLow+range*0.500,fib618=isLong?swingHigh-range*0.618:swingLow+range*0.618,fib786=isLong?swingHigh-range*0.786:swingLow+range*0.786;
    const pullbackPct=isLong?Math.max(0,(entryNum-currentPrice)/entryNum*100):Math.max(0,(currentPrice-entryNum)/entryNum*100);
    let pullbackZone='NONE';
    if(isLong){if(currentPrice<=fib786)pullbackZone='CRITICAL';else if(currentPrice<=fib618)pullbackZone='DEEP';else if(currentPrice<=fib500)pullbackZone='NORMAL';else if(currentPrice<=fib382)pullbackZone='SHALLOW';}
    else{if(currentPrice>=fib786)pullbackZone='CRITICAL';else if(currentPrice>=fib618)pullbackZone='DEEP';else if(currentPrice>=fib500)pullbackZone='NORMAL';else if(currentPrice>=fib382)pullbackZone='SHALLOW';}
    const h4AgainstTrade=isLong?h4Struct==='BOS_BEARISH':h4Struct==='BOS_BULLISH',d1AgainstTrade=isLong?d1Struct==='BOS_BEARISH':d1Struct==='BOS_BULLISH',h4ForTrade=isLong?h4Struct.includes('BULLISH'):h4Struct.includes('BEARISH'),d1ForTrade=isLong?d1Struct.includes('BULLISH'):d1Struct.includes('BEARISH');
    const tp1Hit=tp1Num&&(isLong?currentPrice>=tp1Num*0.998:currentPrice<=tp1Num*1.002),slClose=slNum&&Math.abs(currentPrice-slNum)/currentPrice<0.008;
    const rsiOversold=h4RSI<35&&h1RSI<40,rsiOverbought=h4RSI>65&&h1RSI>60;
    let action='HOLD',reason='',dcaLevel=null,newSL=null,slMoveTarget=null;const warnings=[];
    if(h4AgainstTrade&&d1AgainstTrade){action='CLOSE';reason=`Structure fully invalidated: H4 (${h4Struct}) and D1 (${d1Struct}) both flipped ${isLong?'bearish':'bullish'}.`;}
    else if(pullbackZone==='CRITICAL'&&h4AgainstTrade){action='CLOSE';reason=`Price breached 78.6% Fib ($${fib786.toFixed(4)}) AND H4 flipped (${h4Struct}). High probability reversal.`;}
    else if(slClose){action='CLOSE';reason=`Price within 0.8% of SL ($${slNum}). R:R no longer valid.`;}
    else if(tp1Hit){action='MOVE_SL';slMoveTarget=entryNum;reason=`TP1 ($${tp1Num}) reached! Move SL to Break-Even ($${entryNum.toFixed(4)}).`;}
    else if(pullbackZone==='DEEP'&&d1ForTrade&&(isLong?rsiOversold:rsiOverbought)){dcaLevel=parseFloat(fib618.toFixed(4));newSL=slNum?parseFloat((isLong?Math.min(slNum,fib786):Math.max(slNum,fib786)).toFixed(4)):null;action='DCA';reason=`Price at 61.8% Fib ($${fib618.toFixed(4)}) + D1 intact + RSI confirms zone. Valid DCA.`;}
    else if(pullbackZone==='DEEP'&&!d1ForTrade){warnings.push(`⚠️ 61.8% Fib but D1 (${d1Struct}) not aligned`);action='HOLD';reason=`Deep pullback but D1 structure not clearly ${isLong?'bullish':'bearish'}. Wait for confirmation.`;}
    else if(pullbackZone==='CRITICAL'&&!h4AgainstTrade){warnings.push(`🔴 Below 78.6% Fib ($${fib786.toFixed(4)}) — near invalidation`);action='HOLD';reason=`Critical pullback but H4 (${h4Struct}) not confirmed reversal. Watch closely.`;}
    else{action='HOLD';reason=pullbackZone==='NONE'?`In profit territory. D1:${d1ForTrade?'✓':'ranging'} H4:${h4ForTrade?'✓':'ranging'}. H4 RSI ${h4RSI}. Hold.`:`Pullback (${pullbackZone} ${pullbackPct.toFixed(1)}%) within range. Structures ok. Hold.`;}
    if(h4AgainstTrade&&!d1AgainstTrade)warnings.push(`⚠️ H4 flipped (${h4Struct}) — D1 still holds`);
    if(h1MACD.signal!==(isLong?'BULLISH':'BEARISH'))warnings.push(`ℹ️ H1 MACD ${h1MACD.signal} — against ${direction}`);
    if(h1VolR>2.5&&action!=='CLOSE')warnings.push(`📊 Volume spike H1 (${h1VolR}×) — big move may start`);
    const emaAlignment=isLong?{ok:priceAboveEma20H1&&priceAboveEma50H1,desc:(priceAboveEma20H1?'✅':'❌')+' EMA20 '+(priceAboveEma50H1?'✅':'❌')+' EMA50 '+(priceAboveEma200H1?'✅':'❌')+' H1-200 '+(priceAboveD1Ema200?'✅':'❌')+' D1-200'}:{ok:!priceAboveEma20H1&&!priceAboveEma50H1,desc:(!priceAboveEma20H1?'✅':'❌')+' <EMA20 '+(!priceAboveEma50H1?'✅':'❌')+' <EMA50 '+(!priceAboveEma200H1?'✅':'❌')+' <H1-200 '+(!priceAboveD1Ema200?'✅':'❌')+' <D1-200'};
    res.json({ success:true, pair:normalizedPair, direction, currentPrice, action, reason, warnings,
      indicators:{rsi:{m15:m15RSI,h1:h1RSI,h4:h4RSI},macd:{h1:h1MACD.signal,h4:h4MACD.signal},ema:{h1_20:h1Ema20,h1_50:h1Ema50,h1_200:h1Ema200,h4_20:h4Ema20,h4_50:h4Ema50,d1_200:d1Ema200},struct:{m15:m15Struct,h1:h1Struct,h4:h4Struct,d1:d1Struct},atr:{h4:h4ATR,h1:h1ATR},volume:{h1Ratio:h1VolR},emaAlignment},
      structureIntact:{h4:h4ForTrade,d1:d1ForTrade},h4Struct,d1Struct,pullbackZone,pullbackPct:parseFloat(pullbackPct.toFixed(2)),
      fibonacci:{fib382:parseFloat(fib382.toFixed(4)),fib500:parseFloat(fib500.toFixed(4)),fib618:parseFloat(fib618.toFixed(4)),fib786:parseFloat(fib786.toFixed(4))},
      dcaLevel,newSL,slMoveTarget,invalidationLevel:parseFloat(fib786.toFixed(4)),tp1Hit });
  } catch(err) { console.error('/api/trade-monitor error:',err.message); res.status(500).json({ success:false, error:err.message }); }
});

// ============================================================
//  ADMIN ROUTES — kept 100% intact
// ============================================================
app.get('/api/admin/users', verifyAdmin, async (req, res) => { try { const users=await User.find({}).sort({createdAt:-1}).lean(); res.json({success:true,users}); } catch(e){res.status(500).json({success:false,error:e.message});}});
app.patch('/api/admin/users/:uid', verifyAdmin, async (req, res) => { try { const allowed=['suspended','suspendReason','plan','role','maintenance','maintenanceMsg'];const update={};allowed.forEach(k=>{if(req.body[k]!==undefined)update[k]=req.body[k];});const user=await User.findOneAndUpdate({uid:req.params.uid},update,{new:true});if(!user)return res.status(404).json({success:false,error:'User not found'});res.json({success:true,user}); } catch(e){res.status(500).json({success:false,error:e.message});}});
app.delete('/api/admin/users/:uid', verifyAdmin, async (req, res) => { try { await User.findOneAndDelete({uid:req.params.uid});try{await admin.auth().deleteUser(req.params.uid);}catch(_){}res.json({success:true}); } catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/admin/stats', verifyAdmin, async (req, res) => { try { const [totalUsers,activeSignals,openReports,pendingBalReqs]=await Promise.all([User.countDocuments({}),Signal.countDocuments({active:true}),Report.countDocuments({status:'open'}),mongoose.models.BalanceRequest?mongoose.models.BalanceRequest.countDocuments({status:'pending'}):0]); res.json({success:true,stats:{totalUsers,activeSignals,openReports,pendingBalReqs}}); } catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/admin/settings', verifyAdmin, (req, res) => { res.json({success:true,settings:{maintenance:globalSettings.maintenance||false,maintenanceMsg:globalSettings.maintenanceMsg||'',allowRegistrations:globalSettings.allowRegistrations!==false,highImpactMode:globalSettings.highImpactMode||false,highImpactMsg:globalSettings.highImpactMsg||'',autoEngine:globalSettings.autoEngine||false}});});
app.patch('/api/admin/settings', verifyAdmin, async (req, res) => { try { const allowed=['maintenance','maintenanceMsg','allowRegistrations','highImpactMode','highImpactMsg','autoEngine'];for(const k of allowed){if(req.body[k]!==undefined){globalSettings[k]=req.body[k];await saveSettingToDB(k,req.body[k]);}}res.json({success:true,settings:globalSettings}); } catch(e){res.status(500).json({success:false,error:e.message});}});
app.post('/api/admin/settings', verifyAdmin, async (req, res) => { try { const allowed=['maintenance','maintenanceMsg','allowRegistrations','highImpactMode','highImpactMsg','autoEngine'];for(const k of allowed){if(req.body[k]!==undefined){globalSettings[k]=req.body[k];await saveSettingToDB(k,req.body[k]);}}res.json({success:true,settings:globalSettings}); } catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/admin/reports', verifyAdmin, async (req, res) => { try { const filter=req.query.status?{status:req.query.status}:{};const reports=await Report.find(filter).sort({createdAt:-1}).lean();const openReports=await Report.countDocuments({status:'open'});res.json({success:true,data:reports,openReports}); } catch(e){res.status(500).json({success:false,error:e.message});}});
app.patch('/api/admin/reports/:id', verifyAdmin, async (req, res) => { try { const update={};['status','adminNote','adminReply','readByAdmin'].forEach(k=>{if(req.body[k]!==undefined)update[k]=req.body[k];});if(req.body.status&&['resolved','dismissed'].includes(req.body.status)){update.resolvedBy=req.dbUser?.email||'admin';update.resolvedAt=new Date();}const report=await Report.findByIdAndUpdate(req.params.id,update,{new:true});if(!report)return res.status(404).json({success:false,error:'Report not found'});res.json({success:true,report}); } catch(e){res.status(500).json({success:false,error:e.message});}});
app.delete('/api/admin/reports/:id', verifyAdmin, async (req, res) => { try { await Report.findByIdAndDelete(req.params.id);res.json({success:true}); } catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/admin/announcements', verifyAdmin, async (req, res) => { try { const anns=await Announcement.find({}).sort({createdAt:-1}).lean();res.json({success:true,data:anns}); } catch(e){res.status(500).json({success:false,error:e.message});}});
app.post('/api/admin/announcements', verifyAdmin, async (req, res) => { try { const {title,message,type,active,showFrom,showUntil}=req.body;if(!title||!message)return res.status(400).json({success:false,error:'Title and message required'});const ann=await Announcement.create({title,message,type:type||'info',active:active!==false,showFrom:showFrom?new Date(showFrom):new Date(),showUntil:showUntil?new Date(showUntil):null,createdBy:req.dbUser?.email||'admin'});try{broadcastToAll({type:'announcement',data:ann});}catch(_){}res.json({success:true,data:ann}); } catch(e){res.status(500).json({success:false,error:e.message});}});
app.put('/api/admin/announcements/:id', verifyAdmin, async (req, res) => { try { const update={};['title','message','type','active','showFrom','showUntil'].forEach(k=>{if(req.body[k]!==undefined)update[k]=req.body[k];});const ann=await Announcement.findByIdAndUpdate(req.params.id,update,{new:true});if(!ann)return res.status(404).json({success:false,error:'Announcement not found'});res.json({success:true,data:ann}); } catch(e){res.status(500).json({success:false,error:e.message});}});
app.delete('/api/admin/announcements/:id', verifyAdmin, async (req, res) => { try { await Announcement.findByIdAndDelete(req.params.id);res.json({success:true}); } catch(e){res.status(500).json({success:false,error:e.message});}});
app.post('/api/admin/broadcast', verifyAdmin, (req, res) => { try { const{subject,message}=req.body;if(!message)return res.status(400).json({success:false,error:'Message required'});broadcastToAll({type:'announcement',data:{title:subject||'Notice',message,type:'info',active:true}});res.json({success:true,message:'Broadcast sent.'}); } catch(e){res.status(500).json({success:false,error:e.message});}});
const BR=mongoose.models.BalanceRequest||require('./models/BalanceRequest');
app.get('/api/admin/balance-requests', verifyAdmin, async (req, res) => { try { const data=await BR.find({}).sort({createdAt:-1}).lean();const pending=data.filter(r=>r.status==='pending').length;res.json({success:true,data,pending}); } catch(e){res.status(500).json({success:false,error:e.message});}});
app.patch('/api/admin/balance-requests/:id', verifyAdmin, async (req, res) => { try { const{action,adminNote}=req.body;if(!['approve','reject'].includes(action))return res.status(400).json({success:false,error:'action must be approve or reject'});const br=await BR.findById(req.params.id);if(!br)return res.status(404).json({success:false,error:'Request not found'});br.status=action==='approve'?'approved':'rejected';br.adminNote=adminNote||'';br.processedBy=req.dbUser?.email||'admin';br.processedAt=new Date();await br.save();if(action==='approve')await PB.findOneAndUpdate({uid:br.userUid},{balance:br.requestedAmount},{upsert:true});res.json({success:true,data:br}); } catch(e){res.status(500).json({success:false,error:e.message});}});
app.post('/api/signals', verifyAdmin, async (req, res) => { try { const b=req.body;if(!b.pair||!b.direction||!b.entry||!b.tp1||!b.sl)return res.status(400).json({success:false,error:'pair, direction, entry, tp1, sl required'});const lev=parseInt(String(b.leverage||10).replace(/[^0-9]/g,''))||10;const signal=await Signal.create({pair:b.pair.toUpperCase().trim(),direction:b.direction,entry:parseFloat(b.entry),tp1:parseFloat(b.tp1),tp2:b.tp2?parseFloat(b.tp2):undefined,sl:parseFloat(b.sl),leverage:lev,timeframe:b.timeframe||'1h',notes:b.notes||'',score:b.score?parseInt(b.score):0,plan:b.plan||'free',active:true,status:'ACTIVE'});broadcastToAll({type:'new_signal',signal});res.json({success:true,signal}); } catch(e){res.status(500).json({success:false,error:e.message});}});
app.patch('/api/signals/:id', verifyAdmin, async (req, res) => { try { const update={};['status','active','notes','pnl','closedAt'].forEach(k=>{if(req.body[k]!==undefined)update[k]=req.body[k];});if(update.status&&['TP1_HIT','TP2_HIT','SL_HIT','CANCELLED'].includes(update.status)){update.active=false;update.closedAt=update.closedAt||new Date();}const signal=await Signal.findByIdAndUpdate(req.params.id,update,{new:true});if(!signal)return res.status(404).json({success:false,error:'Signal not found'});broadcastToAll({type:'signal_update',signal});res.json({success:true,signal}); } catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/admin/ai-settings', verifyAdmin, (req, res) => { res.json({success:true,settings:{groq_api_key:globalSettings.groq_api_key||'',groq_model:globalSettings.groq_model||'llama-3.3-70b-versatile',groq_max_tokens:globalSettings.groq_max_tokens||3500,groq_temperature:globalSettings.groq_temperature||0.1,groq_api_key_masked:globalSettings.groq_api_key?'gsk_'+'*'.repeat(20)+globalSettings.groq_api_key.slice(-6):'(using .env key)'}});});
app.post('/api/admin/ai-settings', verifyAdmin, async (req, res) => { try { const{groq_api_key,groq_model,groq_max_tokens,groq_temperature}=req.body;const ALLOWED_MODELS=['llama-3.3-70b-versatile','llama-3.1-70b-versatile','llama-3.1-8b-instant','llama3-70b-8192','llama3-8b-8192','mixtral-8x7b-32768','gemma2-9b-it'];if(groq_model&&!ALLOWED_MODELS.includes(groq_model))return res.status(400).json({success:false,error:'Invalid model.'});const maxTok=parseInt(groq_max_tokens);if(maxTok&&(maxTok<100||maxTok>8000))return res.status(400).json({success:false,error:'max_tokens: 100–8000.'});const temp=parseFloat(groq_temperature);if(!isNaN(temp)&&(temp<0||temp>2))return res.status(400).json({success:false,error:'temperature: 0–2.'});const updates={};if(groq_api_key!==undefined){const k=groq_api_key.trim();updates.groq_api_key=k;globalSettings.groq_api_key=k;await saveSettingToDB('groq_api_key',k);}if(groq_model){updates.groq_model=groq_model.trim();globalSettings.groq_model=groq_model.trim();await saveSettingToDB('groq_model',groq_model.trim());}if(groq_max_tokens){updates.groq_max_tokens=maxTok;globalSettings.groq_max_tokens=maxTok;await saveSettingToDB('groq_max_tokens',maxTok);}if(!isNaN(temp)&&groq_temperature!==undefined){updates.groq_temperature=temp;globalSettings.groq_temperature=temp;await saveSettingToDB('groq_temperature',temp);}console.log(`[Admin] AI settings updated by ${req.dbUser?.email}:`,Object.keys(updates).join(', '));res.json({success:true,message:'AI settings updated.',updated:Object.keys(updates)}); } catch(e){res.status(500).json({success:false,error:e.message});}});
app.post('/api/admin/ai-settings/test', verifyAdmin, async (req, res) => { try { const keyToTest=(req.body.groq_api_key||'').trim()||(globalSettings.groq_api_key||'').trim()||process.env.GROQ_API_KEY;if(!keyToTest)return res.status(400).json({success:false,error:'No API key to test.'});const modelToTest=(req.body.groq_model||globalSettings.groq_model||'llama-3.3-70b-versatile').trim();const testRes=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+keyToTest},body:JSON.stringify({model:modelToTest,max_tokens:10,temperature:0.1,messages:[{role:'user',content:'Reply with OK only.'}]})});if(!testRes.ok){const e=await testRes.text();return res.json({success:false,error:`API returned ${testRes.status}: ${e.slice(0,150)}`});}const data=await testRes.json();const reply=data.choices?.[0]?.message?.content||'';res.json({success:true,message:`✅ API key works! Model "${modelToTest}" responded: "${reply.slice(0,50)}"`}); } catch(e){res.json({success:false,error:'Connection error: '+e.message});}});

// ============================================================
//  🆕 SIGMA AGENT ROUTES — SSE Streaming
// ============================================================

/** GET /api/agent/analyze?symbol=BTCUSDT — requires Firebase auth */
app.get('/api/agent/analyze', agentLimiter, verifyToken, async (req, res) => {
  const raw = req.query.symbol;
  if (!raw) return res.status(400).json({ success:false, error:'?symbol= required' });
  const sym = normalizePair(raw);

  if (globalSettings.maintenance)
    return res.status(503).json({ success:false, error: globalSettings.maintenanceMsg||'Maintenance mode' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let alive = true;
  const send = (type, data) => {
    if (!alive) return;
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    } catch { alive = false; }
  };

  // Heartbeat — prevents nginx/load-balancer timeout
  const hb = setInterval(() => {
    if (!alive) { clearInterval(hb); return; }
    try { res.write(': ♥\n\n'); if (typeof res.flush === 'function') res.flush(); }
    catch { clearInterval(hb); alive = false; }
  }, 25_000);

  req.on('close', () => { alive = false; clearInterval(hb); });

  const t0 = Date.now();
  console.log(`[SIGMA Agent] ► ${sym} [${req.user.uid}] [${req.ip}]`);

  try {
    await runAgentWithSSE(sym, send, req.user.uid, {
      groq_api_key:     globalSettings.groq_api_key,
      groq_model:       globalSettings.groq_model,
      groq_max_tokens:  globalSettings.groq_max_tokens,
      groq_temperature: globalSettings.groq_temperature,
    });
    const elapsed = ((Date.now()-t0)/1000).toFixed(1);
    send('done', { symbol:sym, duration:parseFloat(elapsed), message:`Analysis complete in ${elapsed}s` });
    console.log(`[SIGMA Agent] ✓ ${sym} in ${elapsed}s`);
  } catch(err) {
    console.error(`[SIGMA Agent] ✗ ${sym}:`, err.message);
    if (alive) send('error', { message: err.message, symbol: sym });
  } finally {
    clearInterval(hb);
    if (alive) res.end();
  }
});

/** POST /api/agent/analyze-sync — REST fallback (no streaming) */
app.post('/api/agent/analyze-sync', agentLimiter, verifyToken, async (req, res) => {
  const sym = normalizePair(req.body?.symbol || req.query?.symbol || '');
  if (!sym) return res.status(400).json({ success:false, error:'symbol required' });
  const events = [];
  try {
    const { output, signals } = await runAgentWithSSE(sym,
      (type, data) => { if (type !== 'ai_token') events.push({ type, data }); },
      req.user.uid,
      { groq_api_key:globalSettings.groq_api_key, groq_model:globalSettings.groq_model,
        groq_max_tokens:globalSettings.groq_max_tokens, groq_temperature:globalSettings.groq_temperature }
    );
    res.json({ success:true, symbol:sym, output, signals, events });
  } catch(err) { res.status(500).json({ success:false, symbol:sym, error:err.message }); }
});

// ============================================================
//  WebSocket + Cron
// ============================================================
const PORT   = process.env.PORT || 3000;
const server = http.createServer(app);
const clients = new Map();
let wss = null;

function broadcastToAll(data) {
  if (!wss) { try { Event.create({ data, uid:null }).catch(()=>{}); } catch(_){} return; }
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => { if (ws.readyState===WebSocket.OPEN) ws.send(msg); });
}
function broadcastToUser(uid, data) {
  if (!wss) { try { Event.create({ data, uid }).catch(()=>{}); } catch(_){} return; }
  const msg = JSON.stringify(data);
  const uc  = clients.get(uid);
  if (!uc) return;
  uc.forEach(ws => { if (ws.readyState===WebSocket.OPEN) ws.send(msg); });
}

if (!process.env.VERCEL) {
  const { WebSocketServer } = require('ws');
  wss = new WebSocketServer({ server });
  wss.on('connection', async (ws, req) => {
    let uid = null;
    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type==='auth'&&msg.token) {
          try {
            const decoded = await admin.auth().verifyIdToken(msg.token);
            uid = decoded.uid;
            if (!clients.has(uid)) clients.set(uid, new Set());
            clients.get(uid).add(ws);
            ws.send(JSON.stringify({ type:'auth_ok', uid }));
          } catch(e) { ws.send(JSON.stringify({ type:'auth_error', error:e.message })); }
        }
      } catch(_) {}
    });
    ws.on('close', () => {
      if (uid&&clients.has(uid)) { clients.get(uid).delete(ws); if (clients.get(uid).size===0) clients.delete(uid); }
    });
    ws.on('error', ()=>{});
  });
}

// ── TP/SL Engine ──────────────────────────────────────────────
let _tpslRunning = false;
async function runTPSLCheck() {
  if (_tpslRunning) return;
  _tpslRunning = true;
  try {
    const openTrades = await PT.find({ status:{ $in:['OPEN','TP1_HIT','PENDING_LONG','PENDING_SHORT'] } });
    if (!openTrades.length) return;
    const uniqueSymbols=[...new Set(openTrades.map(t=>normalizePair(t.pair||t.symbol)).filter(Boolean))];
    const priceMap={};
    await Promise.all(uniqueSymbols.map(async sym=>{try{const p=await getLivePrice(sym);if(p)priceMap[sym]=p;}catch(_){}}));
    for (const trade of openTrades) {
      try {
        const symbol=normalizePair(trade.pair||trade.symbol);if(!symbol)continue;
        const price=priceMap[symbol];if(!price)continue;
        const isLong=trade.direction==='LONG',entry=trade.entryPrice||trade.entry;
        const size=trade.remainingSize||trade.size||trade.amount||0;
        const lev=trade.leverage||1,notional=size*lev;
        if(trade.status==='PENDING_LONG'&&price<=trade.triggerPrice){await PT.findByIdAndUpdate(trade._id,{status:'OPEN',fillTime:new Date()});continue;}
        if(trade.status==='PENDING_SHORT'&&price>=trade.triggerPrice){await PT.findByIdAndUpdate(trade._id,{status:'OPEN',fillTime:new Date()});continue;}
        if(!['OPEN','TP1_HIT'].includes(trade.status))continue;
        const sl=trade.currentSl||trade.sl,tp1=trade.tp1,tp2=trade.tp2;
        if(trade.status==='OPEN'&&tp1&&(isLong?price>=tp1:price<=tp1)){
          const tp1Pnl=isLong?(tp1-entry)/entry*notional*0.5:(entry-tp1)/entry*notional*0.5;
          await PT.findByIdAndUpdate(trade._id,{status:'TP1_HIT',tp1HitPrice:tp1,tp1Pnl,currentSl:entry,remainingSize:size*0.5});
          await PB.findOneAndUpdate({uid:trade.uid},{$inc:{balance:size*0.5+tp1Pnl}},{upsert:true});continue;
        }
        if(tp2&&(isLong?price>=tp2:price<=tp2)){
          const pnl=isLong?(tp2-entry)/entry*notional:(entry-tp2)/entry*notional;
          await PT.findByIdAndUpdate(trade._id,{status:'CLOSED',closePrice:tp2,closedAt:new Date(),pnl});
          await PB.findOneAndUpdate({uid:trade.uid},{$inc:{balance:size+pnl}},{upsert:true});continue;
        }
        if(sl&&(isLong?price<=sl:price>=sl)){
          const pnl=isLong?(sl-entry)/entry*notional:(entry-sl)/entry*notional;
          await PT.findByIdAndUpdate(trade._id,{status:'CLOSED',closePrice:sl,closedAt:new Date(),pnl});
          await PB.findOneAndUpdate({uid:trade.uid},{$inc:{balance:size+pnl}},{upsert:true});continue;
        }
        if(trade.status==='TP1_HIT'){
          const trailOffset=Math.abs(trade.tp1-entry)*0.5;
          const newTrailSL=isLong?Math.max(entry,price-trailOffset):Math.min(entry,price+trailOffset);
          if(newTrailSL!==trade.currentSl)await PT.findByIdAndUpdate(trade._id,{currentSl:newTrailSL});
        }
      } catch(e){console.error('TPSLCheck trade error:',e.message);}
    }
  } catch(e){console.error('runTPSLCheck error:',e.message);}
  finally{_tpslRunning=false;}
}

// ── Ticker cache & market/events/cron ────────────────────────
const TICKER_SYMS=['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT'];
let _tickerCache={data:null,ts:0};
app.get('/api/market/prices', async (req, res) => {
  try {
    if(_tickerCache.data&&Date.now()-_tickerCache.ts<5000)return res.json(_tickerCache.data);
    const ctrl=new AbortController();setTimeout(()=>ctrl.abort(),6000);
    const r=await fetch('https://api.binance.com/api/v3/ticker/24hr',{signal:ctrl.signal});
    if(!r.ok)throw new Error('Binance error');
    const all=await r.json();
    const ticker=all.filter(c=>TICKER_SYMS.includes(c.symbol)).map(c=>({symbol:c.symbol,price:parseFloat(c.lastPrice),change:parseFloat(c.priceChangePercent)}));
    const response={type:'market_update',ticker};_tickerCache={data:response,ts:Date.now()};res.json(response);
  } catch(e){res.json({type:'market_update',ticker:[]});}
});
app.get('/api/events', async (req, res) => {
  try {
    const since=req.query.since?new Date(parseInt(req.query.since)):new Date(Date.now()-10000);
    let uid=null;const token=(req.headers.authorization||'').replace('Bearer ','');
    if(token){try{const d=await admin.auth().verifyIdToken(token);uid=d.uid;}catch(_){}}
    const query={ts:{$gt:since},$or:[{uid:null},...(uid?[{uid}]:[])]};
    const events=await Event.find(query).sort({ts:1}).limit(100).lean();
    res.json({events:events.map(e=>e.data),ts:Date.now()});
  } catch(e){res.json({events:[],ts:Date.now()});}
});
app.post('/api/cron/tpsl-check', async (req, res) => {
  const secret=req.headers['x-cron-secret'];
  if(process.env.CRON_SECRET&&secret!==process.env.CRON_SECRET)return res.status(401).json({error:'Unauthorized'});
  try{await runTPSLCheck();res.json({success:true,ts:new Date()});}catch(e){res.status(500).json({error:e.message});}
});

// ── Start ──────────────────────────────────────────────────────
if (!process.env.VERCEL) {
  setInterval(runTPSLCheck, 30000);
  console.log('⚡ Auto TP/SL engine started');
  server.listen(PORT, () => {
    console.log(`🚀 InvestySignals + SIGMA Agent running on port ${PORT}`);
    console.log(`   /api/agent/analyze  ← New SSE agent endpoint`);
    console.log(`   /api/deep-analysis  ← Original analysis (kept)`);
    console.log(`   /api/scan           ← Smart Scan (kept)`);
  });
}
module.exports = app;
