// ============================================================
//  InvestySignals — Backend Server (Upgraded v3)
//  Node.js + Express + MongoDB + Firebase Admin + WebSocket
//
//  UPGRADES v3:
//  [1]  Klines cache (5-min TTL)
//  [2]  Binance API retry + exponential backoff
//  [3]  Candle outlier sanitization (median ±15%)
//  [4]  Completed candle fix (slice -1, forming candle excluded)
//  [5]  calcADX — choppy market detection
//  [6]  Net scoring (bullScore − bearScore)
//  [7]  Weighted direction — BTC+Daily+Funding+h4+h1
//  [8]  findOrderBlock — explosive move + mitigation validated
//  [9]  Structure-aware SL (swing low/high + OB aware)
//  [10] HTF/LTF conflict detection + score penalty
//  [11] Per-user analysis throttle (30s cooldown)
//  [12] News blackout toggle (highImpactMode admin setting)
//  [13] In-memory state tracking + trend_flip WS broadcast
//  [14] Signal freshness flags (entryValid, signalTs) in response
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

// ── Admin Emails ─────────────────────────────────────────────
const ADMIN_EMAILS = [
  'cdilrukshi52@gmail.com',
];

// ── Global Platform Settings ──────────────────────────────────
const SETTINGS_DEFAULTS = {
  maintenance:        false,
  maintenanceMsg:     'We are making improvements. Please check back shortly.',
  allowRegistrations: true,
  highImpactMode:     false,   // [12]
  highImpactMsg:      'High impact news period — signals temporarily paused.',
};
let globalSettings = { ...SETTINGS_DEFAULTS };

async function loadSettingsFromDB() {
  try {
    const docs = await Settings.find({});
    docs.forEach(d => { globalSettings[d.key] = d.value; });
    console.log('⚙️  Platform settings loaded from DB');
  } catch(e) {
    console.warn('⚠️  Could not load settings from DB:', e.message);
  }
}

async function saveSettingToDB(key, value) {
  await Settings.findOneAndUpdate({ key }, { value }, { upsert: true, new: true });
}

// ── [1][2] Klines Cache + Retry ──────────────────────────────
const klinesCache = new Map();
const KLINES_TTL  = 5 * 60 * 1000; // 5 min

async function fetchKlinesCached(symbol, interval, limit = 200, retries = 3) {
  const key    = `${symbol}_${interval}_${limit}`;
  const cached = klinesCache.get(key);
  if (cached && Date.now() - cached.ts < KLINES_TTL) return cached.data;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const r   = await fetch(url);
      if (r.status === 429) {
        await new Promise(res => setTimeout(res, 1000 * Math.pow(2, attempt)));
        continue;
      }
      if (!r.ok) throw new Error(`Binance klines error ${r.status}`);
      const data = await r.json();
      klinesCache.set(key, { data, ts: Date.now() });
      return data;
    } catch(e) {
      if (attempt === retries - 1) throw e;
      await new Promise(res => setTimeout(res, 500 * (attempt + 1)));
    }
  }
  throw new Error(`fetchKlines failed after ${retries} retries: ${symbol} ${interval}`);
}

// ── [3] Candle Outlier Sanitization ─────────────────────────
function sanitizeCandles(klines) {
  if (!klines || klines.length < 10) return klines;
  const closes = klines.map(k => parseFloat(k[4])).sort((a, b) => a - b);
  const median = closes[Math.floor(closes.length / 2)];
  if (median <= 0) return klines;
  return klines.filter(k => Math.abs(parseFloat(k[4]) - median) / median < 0.15);
}

// ── [13] Analysis State Tracking ────────────────────────────
const analysisState    = new Map();

// ── [11] Per-user Throttle ───────────────────────────────────
const lastAnalysisTime = new Map();
const ANALYSIS_COOLDOWN = 30 * 1000;

// ── Express Setup ────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const allowedOrigin = process.env.ALLOWED_ORIGIN;
app.use(cors({
  origin: allowedOrigin
    ? (origin, cb) => { (!origin || origin === allowedOrigin) ? cb(null, true) : cb(new Error('CORS')); }
    : true,
  credentials: true
}));

app.use(express.json({ limit: '5mb' }));

// ── Rate Limiters ─────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 300,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' }
});
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 1000,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: 'Too many requests.' }
});
app.use('/api/admin/', adminLimiter);
app.use('/api/', apiLimiter);

const BLOCKED_STATIC = ['.env','serviceAccount.json','package.json','.gitignore','deploy.sh'];

// ── Auth Helpers ─────────────────────────────────────────────
async function ensureAdminPromotion(uid, emailFromToken) {
  try {
    let user = await User.findOne({ uid });
    const email = (emailFromToken || '').toLowerCase();
    const isAdminEmail = ADMIN_EMAILS.includes(email);
    if (!user) {
      let displayName = '';
      try { const fb = await admin.auth().getUser(uid); displayName = fb.displayName || ''; } catch(_) {}
      user = await User.create({ uid, email, displayName, role: isAdminEmail ? 'admin' : 'user', plan: 'free' });
    } else {
      if (isAdminEmail && user.role !== 'admin') {
        await User.updateOne({ uid }, { role: 'admin', email });
        user.role = 'admin';
      }
    }
    return user;
  } catch(e) { return null; }
}

async function verifyToken(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    const dbUser = await User.findOne({ uid: req.user.uid });
    if (dbUser && dbUser.suspended)
      return res.status(403).json({ success: false, error: 'Account suspended', reason: dbUser.suspendReason });
    req.dbUser = dbUser;
    next();
  } catch (e) { res.status(401).json({ success: false, error: 'Invalid token' }); }
}

async function verifyAdmin(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    const email = (req.user.email || '').toLowerCase();
    const u = await ensureAdminPromotion(req.user.uid, email);
    if (!u || u.role !== 'admin')
      return res.status(403).json({ success: false, error: 'Admin access required' });
    req.dbUser = u;
    next();
  } catch (e) { res.status(401).json({ success: false, error: 'Authentication failed' }); }
}

const PLAN_LEVEL = { free: 0, pro: 1, elite: 2, admin: 99 };
function planLevel(plan) { return PLAN_LEVEL[plan] ?? 0; }

// ============================================================
//  API ROUTES
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ok', time: new Date().toISOString() });
});

// ── Analysis — RSI/MACD/BB ────────────────────────────────────
app.get('/api/analysis', async (req, res) => {
  try {
    const pair  = (req.query.pair || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const tf    = (req.query.tf   || '1h').replace(/[^a-zA-Z0-9]/g, '');
    const url   = `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=${tf}&limit=100`;
    const response = await fetch(url);
    if (!response.ok) return res.status(502).json({ success: false, error: `Binance error: ${await response.text()}` });
    const klines = await response.json();
    if (!Array.isArray(klines) || klines.length < 15)
      return res.status(502).json({ success: false, error: 'Not enough candle data' });

    const closes = klines.map(k => parseFloat(k[4]));
    const period = 14;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) { const d = closes[i]-closes[i-1]; d>=0?gains+=d:losses-=d; }
    let ag = gains/period, al = losses/period;
    for (let i = period+1; i < closes.length; i++) {
      const d = closes[i]-closes[i-1];
      ag = (ag*(period-1)+(d>0?d:0))/period;
      al = (al*(period-1)+(d<0?-d:0))/period;
    }
    const rsi = parseFloat((100-100/(1+(al===0?100:ag/al))).toFixed(2));

    function ema(data, n) {
      const k=2/(n+1); let val=data.slice(0,n).reduce((a,b)=>a+b,0)/n; const out=[val];
      for (let i=n;i<data.length;i++){val=data[i]*k+val*(1-k);out.push(val);} return out;
    }
    const ema12=ema(closes,12), ema26=ema(closes,26);
    const macdLine=ema12.slice(ema12.length-ema26.length).map((v,i)=>v-ema26[i]);
    const signal9=ema(macdLine,9);
    const macd=parseFloat(macdLine[macdLine.length-1].toFixed(4));
    const macdSig=parseFloat(signal9[signal9.length-1].toFixed(4));
    const macdHist=parseFloat((macd-macdSig).toFixed(4));

    const bbP=20, bbC=closes.slice(-bbP);
    const bbMid=bbC.reduce((a,b)=>a+b,0)/bbP;
    const std=Math.sqrt(bbC.reduce((a,c)=>a+Math.pow(c-bbMid,2),0)/bbP);
    const currentPrice=closes[closes.length-1];

    res.json({ success:true, pair, tf, price:parseFloat(currentPrice.toFixed(4)), rsi,
      macd:{macd,signal:macdSig,histogram:macdHist},
      bb:{upper:parseFloat((bbMid+2*std).toFixed(2)),middle:parseFloat(bbMid.toFixed(2)),lower:parseFloat((bbMid-2*std).toFixed(2))},
      data:{rsi,macd,signal:macdSig,histogram:macdHist} });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Market Scanner ────────────────────────────────────────────
const STABLECOINS = new Set(['USDCUSDT','FDUSDUSDT','TUSDUSDT','BUSDUSDT','EURUSDT','DAIUSDT','USDPUSDT','AEURUSDT']);

app.get('/api/scan', async (req, res) => {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const response = await fetch('https://api.binance.com/api/v3/ticker/24hr', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`Binance error: ${response.status}`);
    const data = await response.json();
    const results = data
      .filter(c=>c.symbol.endsWith('USDT')&&!STABLECOINS.has(c.symbol))
      .filter(c=>parseFloat(c.quoteVolume)>=15_000_000&&parseInt(c.count)>=100_000)
      .filter(c=>{const ch=parseFloat(c.priceChangePercent);return ch>=3||ch<=-3;})
      .sort((a,b)=>parseFloat(b.quoteVolume)-parseFloat(a.quoteVolume))
      .slice(0,20)
      .map(c=>({symbol:c.symbol,change:parseFloat(c.priceChangePercent),volume:parseFloat(c.quoteVolume),price:parseFloat(c.lastPrice),trades:parseInt(c.count)}));
    res.json({ success: true, count: results.length, coins: results });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── User Status ──────────────────────────────────────────────
app.get('/api/user/status', verifyToken, async (req, res) => {
  try {
    const uid=req.user.uid, email=(req.user.email||'').toLowerCase();
    const user = await ensureAdminPromotion(uid, email);
    if (!user) return res.status(500).json({ success: false, error: 'Could not load user' });
    await User.updateOne({uid},{lastLogin:new Date()});
    const isMaintenance=globalSettings.maintenance||user.maintenance;
    res.json({ success:true, status:{
      role:user.role, plan:user.plan, suspended:user.suspended,
      suspendReason:user.suspendReason,
      maintenance:isMaintenance,
      maintenanceMsg:globalSettings.maintenance?globalSettings.maintenanceMsg:(user.maintenanceMsg||''),
      paperBalance:user.paperBalance
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Signals ───────────────────────────────────────────────────
app.get('/api/signals', verifyToken, async (req, res) => {
  try {
    const user=req.dbUser, userPlan=user?user.plan:'free', userRole=user?user.role:'user';
    const planFilter=userRole==='admin'?{}:{plan:{$in:Object.keys(PLAN_LEVEL).filter(p=>planLevel(p)<=planLevel(userPlan))}};
    const signals=await Signal.find({active:true,...planFilter}).sort({createdAt:-1}).limit(50);
    res.json({ success:true, signals, data:signals });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Announcement (public) ─────────────────────────────────────
app.get('/api/announcement', async (req, res) => {
  try {
    const now=new Date();
    const ann=await Announcement.findOne({active:true,showFrom:{$lte:now},$or:[{showUntil:null},{showUntil:{$gte:now}}]}).sort({createdAt:-1});
    res.json({ success:true, data:ann, announcement:ann });
  } catch (err) { res.json({ success:true, data:null, announcement:null }); }
});

// ── Paper Trades ──────────────────────────────────────────────
async function getPaperTrades(req, res) {
  try {
    const token=(req.headers.authorization||'').slice(7);
    if (!token) return res.status(401).json({ success:false });
    const decoded=await admin.auth().verifyIdToken(token);
    const dbUser=await User.findOne({uid:decoded.uid});
    if (dbUser&&dbUser.suspended) return res.status(403).json({ success:false, error:'Account suspended' });
    const trades=await PaperTrade.find({userUid:decoded.uid}).sort({openedAt:-1}).limit(100);
    res.json({ success:true, trades, data:trades });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
}
app.get('/api/paper-trades', getPaperTrades);
app.get('/api/paper/trades',  getPaperTrades);

app.get('/api/paper/balance', verifyToken, async (req, res) => {
  try {
    const user=await User.findOne({uid:req.user.uid});
    res.json({ success:true, balance:user?user.paperBalance:1000 });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.post('/api/paper/trade', verifyToken, async (req, res) => {
  try {
    const {signalId,size}=req.body;
    const tradeSize=parseFloat(size);
    if (!tradeSize||tradeSize<=0||tradeSize>100000||!isFinite(tradeSize))
      return res.status(400).json({ success:false, error:'Invalid trade size.' });
    const signal=await Signal.findById(signalId);
    if (!signal) return res.json({ success:false, error:'Signal not found' });
    const user=await User.findOne({uid:req.user.uid});
    if (user&&user.paperBalance<tradeSize) return res.json({ success:false, error:'Insufficient paper balance' });
    const trade=await PaperTrade.create({
      userUid:req.user.uid, signalId:signal._id, pair:signal.pair,
      direction:signal.direction, entry:signal.entry, tp1:signal.tp1,
      tp2:signal.tp2, sl:signal.sl, leverage:signal.leverage, size:tradeSize, status:'OPEN'
    });
    if (user) await User.updateOne({uid:req.user.uid},{$inc:{paperBalance:-tradeSize}});
    res.json({ success:true, trade });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.patch('/api/paper/trade/:id/close', verifyToken, async (req, res) => {
  try {
    const trade=await PaperTrade.findOne({_id:req.params.id,userUid:req.user.uid});
    if (!trade) return res.status(404).json({ success:false, error:'Trade not found' });
    if (trade.status!=='OPEN') return res.json({ success:false, error:'Trade is already closed' });
    const closePrice=parseFloat(req.body.closePrice);
    if (!closePrice||closePrice<=0||!isFinite(closePrice))
      return res.status(400).json({ success:false, error:'Invalid close price.' });
    const priceDiff=trade.direction==='LONG'?closePrice-trade.entry:trade.entry-closePrice;
    const pnlPct=(priceDiff/trade.entry)*trade.leverage*100;
    const pnl=parseFloat(((pnlPct/100)*trade.size).toFixed(2));
    const closedTrade=await PaperTrade.findByIdAndUpdate(trade._id,
      {status:'CLOSED',closePrice,closedAt:new Date(),pnl,pnlPct:parseFloat(pnlPct.toFixed(2))},{new:true});
    await User.updateOne({uid:req.user.uid},{$inc:{paperBalance:trade.size+pnl}});
    res.json({ success:true, trade:closedTrade });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

// ── Reports ───────────────────────────────────────────────────
app.post('/api/reports', async (req, res) => {
  try {
    const {category,message,context}=req.body;
    if (!category||!message||message.trim().length<3)
      return res.status(400).json({ success:false, error:'Category and message required' });
    if (!['signal_accuracy','technical_bug','inappropriate_content','other'].includes(category))
      return res.status(400).json({ success:false, error:'Invalid category' });
    let reporterUid='anonymous', reporterEmail='';
    const authH=req.headers.authorization||'';
    if (authH.startsWith('Bearer ')) {
      try { const d=await admin.auth().verifyIdToken(authH.slice(7)); reporterUid=d.uid||'anonymous'; reporterEmail=(d.email||'').toLowerCase(); } catch(_) {}
    }
    const report=await Report.create({category,message:message.trim().slice(0,2000),context:(context||'').slice(0,500),reporterUid,reporterEmail});
    broadcastToAll({type:'new_report',reportId:report._id,category:report.category});
    res.json({ success:true, message:'Report submitted. Thank you.' });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.get('/api/my-reports', verifyToken, async (req, res) => {
  try {
    const data=await Report.find({reporterUid:req.user.uid}).sort({createdAt:-1}).limit(20);
    res.json({ success:true, data });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

app.get('/api/registration-status', (req, res) => {
  res.json({ success:true, open:globalSettings.allowRegistrations!==false });
});

// ============================================================
//  ADMIN ROUTES
// ============================================================

app.get('/api/admin/stats', verifyAdmin, async (req, res) => {
  try {
    const todayStart=new Date(); todayStart.setHours(0,0,0,0);
    const [totalUsers,activeSignals,totalSignals,openTrades,proCount,eliteCount,adminCount,newUsersToday,closedSignals,openReports,suspendedCount]=await Promise.all([
      User.countDocuments(), Signal.countDocuments({active:true,status:'ACTIVE'}),
      Signal.countDocuments(), PaperTrade.countDocuments({status:'OPEN'}),
      User.countDocuments({plan:'pro'}), User.countDocuments({plan:'elite'}),
      User.countDocuments({role:'admin'}), User.countDocuments({createdAt:{$gte:todayStart}}),
      Signal.find({status:{$in:['TP1_HIT','TP2_HIT','SL_HIT']}}).select('status pnl').lean(),
      Report.countDocuments({status:'open'}), User.countDocuments({suspended:true}),
    ]);
    const wins=closedSignals.filter(s=>['TP1_HIT','TP2_HIT'].includes(s.status)).length;
    const losses=closedSignals.filter(s=>s.status==='SL_HIT').length;
    const total=wins+losses;
    res.json({ success:true, stats:{
      totalUsers,activeSignals,totalSignals,openTrades,proCount,eliteCount,adminCount,newUsersToday,
      wins,losses,winRate:total>0?((wins/total)*100).toFixed(1):0,
      openReports,bannedCount:suspendedCount,suspendedCount
    }});
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.get('/api/admin/users', verifyAdmin, async (req, res) => {
  try {
    const {skip=0,limit=200,plan,suspended}=req.query;
    const filter={};
    if (plan) filter.plan=plan;
    if (suspended==='true') filter.suspended=true;
    if (suspended==='false') filter.suspended={$ne:true};
    const [users,total]=await Promise.all([User.find(filter).sort({createdAt:-1}).skip(+skip).limit(+limit),User.countDocuments(filter)]);
    res.json({ success:true, users, total, data:users });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.patch('/api/admin/users/:uid', verifyAdmin, async (req, res) => {
  try {
    const allowed=['role','plan','suspended','suspendReason','maintenance','maintenanceMsg','paperBalance'];
    const update={};
    allowed.forEach(k=>{if(req.body[k]!==undefined)update[k]=req.body[k];});
    if (update.paperBalance!==undefined) {
      const bal=parseFloat(update.paperBalance);
      if (!isFinite(bal)||bal<0) return res.status(400).json({ success:false, error:'Invalid paperBalance.' });
      update.paperBalance=bal;
    }
    const user=await User.findOneAndUpdate({uid:req.params.uid},update,{new:true});
    if (!user) return res.json({ success:false, error:'User not found' });
    if (update.suspended!==undefined) { try { await admin.auth().updateUser(req.params.uid,{disabled:update.suspended}); } catch(_) {} }
    res.json({ success:true, user });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.delete('/api/admin/users/:uid', verifyAdmin, async (req, res) => {
  try {
    const deleted=await User.findOneAndDelete({uid:req.params.uid});
    if (!deleted) return res.status(404).json({ success:false, error:'User not found' });
    try { await admin.auth().deleteUser(req.params.uid); } catch(_) {}
    res.json({ success:true, message:'User deleted' });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

const SIGNAL_ALLOWED_FIELDS=['pair','direction','entry','tp1','tp2','sl','leverage','timeframe','notes','score','plan','status','pnl','winRate','active','closedAt'];
function pickSignalFields(body){const obj={};SIGNAL_ALLOWED_FIELDS.forEach(k=>{if(body[k]!==undefined)obj[k]=body[k];});return obj;}

app.post('/api/signals', verifyAdmin, async (req, res) => {
  try {
    const body=pickSignalFields(req.body);
    if (body.leverage) body.leverage=parseInt(String(body.leverage).replace(/[^0-9]/g,''))||10;
    const signal=await Signal.create(body);
    broadcastToAll({type:'new_signal',signal});
    res.json({ success:true, signal });
  } catch (err) { res.status(400).json({ success:false, error:err.message }); }
});

app.patch('/api/signals/:id', verifyAdmin, async (req, res) => {
  try {
    const update=pickSignalFields(req.body);
    const signal=await Signal.findByIdAndUpdate(req.params.id,update,{new:true});
    if (!signal) return res.status(404).json({ success:false, error:'Signal not found' });
    broadcastToAll({type:'signal_update',signal});
    res.json({ success:true, signal });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.delete('/api/signals/:id', verifyAdmin, async (req, res) => {
  try {
    await Signal.findByIdAndUpdate(req.params.id,{active:false});
    broadcastToAll({type:'signal_deleted',signalId:req.params.id});
    res.json({ success:true });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.get('/api/admin/settings', verifyAdmin, (req, res) => {
  res.json({ success:true, settings:globalSettings });
});

app.patch('/api/admin/settings', verifyAdmin, async (req, res) => {
  try {
    // [12] highImpactMode + highImpactMsg added
    const allowed=['maintenance','maintenanceMsg','allowRegistrations','highImpactMode','highImpactMsg'];
    const saves=[];
    allowed.forEach(k=>{
      if (req.body[k]!==undefined) { globalSettings[k]=req.body[k]; saves.push(saveSettingToDB(k,req.body[k])); }
    });
    await Promise.all(saves);
    if (req.body.maintenance!==undefined)
      broadcastToAll({type:'maintenance',active:globalSettings.maintenance,message:globalSettings.maintenanceMsg});
    res.json({ success:true, settings:globalSettings });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

const ANNOUNCEMENT_ALLOWED=['title','message','type','active','showFrom','showUntil','audience'];
function pickAnnouncementFields(body){const obj={};ANNOUNCEMENT_ALLOWED.forEach(k=>{if(body[k]!==undefined)obj[k]=body[k];});return obj;}

app.get('/api/admin/announcements', verifyAdmin, async (req, res) => {
  try { const data=await Announcement.find().sort({createdAt:-1}); res.json({ success:true, data }); }
  catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.post('/api/admin/announcements', verifyAdmin, async (req, res) => {
  try {
    const fields=pickAnnouncementFields(req.body);
    const ann=await Announcement.create({...fields,createdBy:req.dbUser.email||'admin'});
    if (ann.active) broadcastToAll({type:'announcement',data:ann});
    res.json({ success:true, data:ann });
  } catch (err) { res.status(400).json({ success:false, error:err.message }); }
});

app.put('/api/admin/announcements/:id', verifyAdmin, async (req, res) => {
  try {
    const ann=await Announcement.findByIdAndUpdate(req.params.id,pickAnnouncementFields(req.body),{new:true});
    if (!ann) return res.status(404).json({ success:false, error:'Not found' });
    res.json({ success:true, data:ann });
  } catch (err) { res.status(400).json({ success:false, error:err.message }); }
});

app.delete('/api/admin/announcements/:id', verifyAdmin, async (req, res) => {
  try { await Announcement.findByIdAndDelete(req.params.id); res.json({ success:true }); }
  catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.post('/api/admin/broadcast', verifyAdmin, async (req, res) => {
  try {
    const {subject,message,audience}=req.body;
    if (!message) return res.json({ success:false, error:'Message required' });
    const annTitle=subject||'Platform Announcement';
    broadcastToAll({type:'announcement',data:{title:annTitle,message,type:'info',audience:audience||'All Users'},time:new Date().toISOString()});
    await Announcement.create({title:annTitle,message,audience:audience||'All Users',active:true,createdBy:req.dbUser.email||'admin'});
    res.json({ success:true, message:'Broadcast sent' });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.get('/api/admin/reports/unread-count', verifyAdmin, async (req, res) => {
  try { const count=await Report.countDocuments({status:'open',readByAdmin:false}); res.json({ success:true, count }); }
  catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.get('/api/admin/reports', verifyAdmin, async (req, res) => {
  try {
    const {status,skip=0,limit=50}=req.query;
    const filter=status?{status}:{};
    const [data,total,openCount]=await Promise.all([
      Report.find(filter).sort({createdAt:-1}).skip(+skip).limit(+limit),
      Report.countDocuments(filter), Report.countDocuments({status:'open'})
    ]);
    res.json({ success:true, total, openCount, data });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.put('/api/admin/reports/:id', verifyAdmin, async (req, res) => {
  try {
    const {status,adminNote,adminReply,readByAdmin}=req.body;
    const update={};
    if (status) update.status=status;
    if (adminNote!==undefined) update.adminNote=adminNote;
    if (adminReply!==undefined) update.adminReply=adminReply;
    if (readByAdmin!==undefined) update.readByAdmin=readByAdmin;
    if (status==='resolved'||status==='dismissed') { update.resolvedBy=req.dbUser.email||'admin'; update.resolvedAt=new Date(); }
    const r=await Report.findByIdAndUpdate(req.params.id,update,{new:true});
    if (!r) return res.status(404).json({ success:false, error:'Not found' });
    res.json({ success:true, data:r });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.delete('/api/admin/reports/:id', verifyAdmin, async (req, res) => {
  try { await Report.findByIdAndDelete(req.params.id); res.json({ success:true }); }
  catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.get('/api/reports/activity', verifyAdmin, async (req, res) => {
  try { const trades=await PaperTrade.find({}).sort({openedAt:-1}).limit(100); res.json({ success:true, data:trades }); }
  catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

// ============================================================
//  DEEP ANALYSIS — 5-Level Confluence Engine (Upgraded v3)
// ============================================================
app.post('/api/deep-analysis', verifyToken, async (req, res) => {
  try {
    const {coin}=req.body;
    if (!coin||!/^[A-Z0-9]{2,20}$/.test(coin))
      return res.status(400).json({ success:false, error:'Invalid coin symbol' });
    const pair=coin.replace(/USDT$/i,'')+('USDT');

    // [11] Per-user throttle
    const uid=req.dbUser?._id?.toString()||req.user.uid;
    const lastTime=lastAnalysisTime.get(uid)||0;
    if (Date.now()-lastTime<ANALYSIS_COOLDOWN) {
      const waitSec=Math.ceil((ANALYSIS_COOLDOWN-(Date.now()-lastTime))/1000);
      return res.status(429).json({ success:false, error:`Please wait ${waitSec}s before next analysis`, code:'THROTTLED' });
    }
    lastAnalysisTime.set(uid,Date.now());

    // [12] News blackout
    if (globalSettings.highImpactMode)
      return res.status(503).json({ success:false, error:globalSettings.highImpactMsg||'High impact news period — signals paused.', code:'NEWS_BLACKOUT' });

    // ── [5] ADX ──────────────────────────────────────────────
    function calcADX(klines, period=14) {
      if (klines.length<period+2) return 15;
      const trs=[],plusDMs=[],minusDMs=[];
      for (let i=1;i<klines.length;i++) {
        const h=parseFloat(klines[i][2]),l=parseFloat(klines[i][3]);
        const ph=parseFloat(klines[i-1][2]),pl=parseFloat(klines[i-1][3]),pc=parseFloat(klines[i-1][4]);
        trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
        const up=h-ph, dn=pl-l;
        plusDMs.push(up>dn&&up>0?up:0);
        minusDMs.push(dn>up&&dn>0?dn:0);
      }
      const smooth=(arr,p)=>{
        let s=arr.slice(0,p).reduce((a,b)=>a+b,0); const out=[s];
        for (let i=p;i<arr.length;i++){s=s-s/p+arr[i];out.push(s);} return out;
      };
      const sTR=smooth(trs,period),sPDM=smooth(plusDMs,period),sMDM=smooth(minusDMs,period);
      const dxs=sTR.map((tr,i)=>{
        if(tr===0)return 0;
        const pdi=100*sPDM[i]/tr,mdi=100*sMDM[i]/tr,den=pdi+mdi;
        return den===0?0:100*Math.abs(pdi-mdi)/den;
      });
      const last=dxs.slice(-period);
      return last.reduce((a,b)=>a+b,0)/last.length;
    }

    // ── Indicator Helpers ─────────────────────────────────────
    function calcEMA(closes,n) {
      const k=2/(n+1); let val=closes.slice(0,n).reduce((a,b)=>a+b,0)/n;
      for (let i=n;i<closes.length;i++) val=closes[i]*k+val*(1-k); return val;
    }
    function calcEMAArr(closes,n) {
      const k=2/(n+1); let val=closes.slice(0,n).reduce((a,b)=>a+b,0)/n; const out=[val];
      for (let i=n;i<closes.length;i++){val=closes[i]*k+val*(1-k);out.push(val);} return out;
    }
    function calcRSI(closes,period=14) {
      let gains=0,losses=0;
      for (let i=1;i<=period;i++){const d=closes[i]-closes[i-1];d>=0?gains+=d:losses-=d;}
      let ag=gains/period,al=losses/period;
      for (let i=period+1;i<closes.length;i++){
        const d=closes[i]-closes[i-1];
        ag=(ag*(period-1)+(d>0?d:0))/period; al=(al*(period-1)+(d<0?-d:0))/period;
      }
      return al===0?100:parseFloat((100-100/(1+ag/al)).toFixed(2));
    }
    function calcRSIArr(closes,period=14,count=5) {
      const result=[];
      for (let offset=count-1;offset>=0;offset--) result.push(calcRSI(closes.slice(0,closes.length-offset),period));
      return result;
    }
    function calcMACD(closes) {
      const ema12=calcEMAArr(closes,12),ema26=calcEMAArr(closes,26);
      const macdLine=ema12.slice(ema12.length-ema26.length).map((v,i)=>v-ema26[i]);
      const signal9=calcEMAArr(macdLine,9);
      return {
        macd:macdLine[macdLine.length-1], signal:signal9[signal9.length-1],
        histogram:macdLine[macdLine.length-1]-signal9[signal9.length-1],
        prevHistogram:macdLine[macdLine.length-2]-signal9[signal9.length-2],
      };
    }
    function calcBB(closes,period=20) {
      const slice=closes.slice(-period), mid=slice.reduce((a,b)=>a+b,0)/period;
      const std=Math.sqrt(slice.reduce((a,c)=>a+Math.pow(c-mid,2),0)/period);
      return {upper:mid+2*std,middle:mid,lower:mid-2*std};
    }
    function calcATR(klines,period=14) {
      const trs=[];
      for (let i=1;i<klines.length;i++) {
        const h=parseFloat(klines[i][2]),l=parseFloat(klines[i][3]),pc=parseFloat(klines[i-1][4]);
        trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
      }
      return trs.slice(-period).reduce((a,b)=>a+b,0)/period;
    }
    function detectStructure(closes,highs,lows) {
      const len=closes.length;
      const rH=highs.slice(-20),rL=lows.slice(-20);
      const prevHigh=Math.max(...rH.slice(0,15)),prevLow=Math.min(...rL.slice(0,15));
      const lastHigh=highs[len-1],lastLow=lows[len-1],lastClose=closes[len-1];
      if (lastHigh>prevHigh) return 'BOS_BULLISH';
      if (lastLow<prevLow)   return 'BOS_BEARISH';
      const midHigh=Math.max(...rH.slice(5,12)),midLow=Math.min(...rL.slice(5,12));
      if (lastClose>midHigh) return 'CHOCH_BULLISH';
      if (lastClose<midLow)  return 'CHOCH_BEARISH';
      return 'NEUTRAL';
    }
    function detectDivergence(closes,rsiArr) {
      const priceUp=closes[closes.length-1]>closes[closes.length-3];
      const rsiUp=rsiArr[rsiArr.length-1]>rsiArr[rsiArr.length-3];
      if (priceUp&&!rsiUp)  return 'BEARISH_DIV';
      if (!priceUp&&rsiUp)  return 'BULLISH_DIV';
      if (priceUp&&rsiUp)   return 'HIDDEN_BEARISH';
      if (!priceUp&&!rsiUp) return 'HIDDEN_BULLISH';
      return 'NONE';
    }
    function detectFVG(klines) {
      const fvgs=[];
      for (let i=2;i<klines.length;i++) {
        const pH=parseFloat(klines[i-2][2]),cL=parseFloat(klines[i][3]);
        const pL=parseFloat(klines[i-2][3]),cH=parseFloat(klines[i][2]);
        if (cL>pH) fvgs.push({type:'BULL',high:cL,low:pH});
        if (cH<pL) fvgs.push({type:'BEAR',high:pL,low:cH});
      }
      return fvgs.slice(-3);
    }
    function detectVolumeSpike(volumes) {
      const avg=volumes.slice(-21,-1).reduce((a,b)=>a+b,0)/20;
      const last=volumes[volumes.length-1];
      return {ratio:parseFloat((last/avg).toFixed(2)),spike:last>avg*1.5};
    }
    function findSRLevels(highs,lows) {
      const all=[...highs.slice(-50),...lows.slice(-50)].sort((a,b)=>a-b);
      const clusters=[]; let i=0;
      while (i<all.length) {
        const base=all[i],cluster=all.filter(v=>Math.abs(v-base)/base<0.005);
        if (cluster.length>=2) clusters.push(parseFloat((cluster.reduce((a,b)=>a+b,0)/cluster.length).toFixed(4)));
        i+=Math.max(1,cluster.length);
      }
      return [...new Set(clusters)].slice(-6);
    }

    // [8] OB — Explosive Move + Mitigation Validated
    function findOrderBlock(klines) {
      for (let i=klines.length-5;i>=Math.max(0,klines.length-30);i--) {
        if (i+1>=klines.length) continue;
        const open=parseFloat(klines[i][1]),close=parseFloat(klines[i][4]);
        const high=parseFloat(klines[i][2]),low=parseFloat(klines[i][3]);
        const body=Math.abs(close-open),range=high-low;
        if (range===0||body/range<=0.6) continue;
        // Explosive move: next candle body >= 1.5x OB body
        const nO=parseFloat(klines[i+1][1]),nC=parseFloat(klines[i+1][4]);
        if (Math.abs(nC-nO)<body*1.5) continue;
        // Mitigation check
        const isBullOB=close>open;
        const subL=klines.slice(i+2).map(k=>parseFloat(k[3]));
        const subH=klines.slice(i+2).map(k=>parseFloat(k[2]));
        if (isBullOB&&subL.length>0&&Math.min(...subL)<low)  continue;
        if (!isBullOB&&subH.length>0&&Math.max(...subH)>high) continue;
        return {high,low,open,close,type:isBullOB?'BULL_OB':'BEAR_OB',explosive:true};
      }
      return null;
    }

    function detectCandlePattern(klines) {
      const last=klines[klines.length-1],prev=klines[klines.length-2];
      const o=parseFloat(last[1]),c=parseFloat(last[4]),h=parseFloat(last[2]),l=parseFloat(last[3]);
      const po=parseFloat(prev[1]),pc=parseFloat(prev[4]);
      const body=Math.abs(c-o),range=h-l;
      if (range===0) return 'NONE';
      const uw=h-Math.max(o,c),lw=Math.min(o,c)-l;
      if (lw>body*2&&uw<body*0.5) return 'PIN_BAR_BULL';
      if (uw>body*2&&lw<body*0.5) return 'PIN_BAR_BEAR';
      if (c>po&&o<pc&&c>po) return 'BULLISH_ENGULFING';
      if (c<po&&o>pc&&c<po) return 'BEARISH_ENGULFING';
      if (body/range<0.1)   return 'DOJI';
      if (c>o&&body/range>0.7) return 'STRONG_BULL';
      if (c<o&&body/range>0.7) return 'STRONG_BEAR';
      return 'NONE';
    }

    // [9] Structure-aware SL
    function calcStructureSL(isBullish,currentPrice,atr4h,h4OB,highs4h,lows4h) {
      const atrSL=isBullish?currentPrice-atr4h*1.5:currentPrice+atr4h*1.5;
      if (isBullish) {
        const swingLow=Math.min(...lows4h.slice(-8));
        const obFloor=(h4OB&&h4OB.type==='BULL_OB')?h4OB.low:null;
        let structSL=swingLow*0.998;
        if (obFloor!==null&&obFloor<structSL) structSL=obFloor*0.998;
        return parseFloat(Math.min(atrSL,structSL).toFixed(4));
      } else {
        const swingHigh=Math.max(...highs4h.slice(-8));
        const obCeil=(h4OB&&h4OB.type==='BEAR_OB')?h4OB.high:null;
        let structSL=swingHigh*1.002;
        if (obCeil!==null&&obCeil>structSL) structSL=obCeil*1.002;
        return parseFloat(Math.max(atrSL,structSL).toFixed(4));
      }
    }

    // [1][4] Fetch + Sanitize + Completed candles only
    const [rawK1d,rawK4h,rawK1h,rawK15m,rawBtcK1d,fundingRaw,oiRaw]=await Promise.all([
      fetchKlinesCached(pair,'1d',200),
      fetchKlinesCached(pair,'4h',200),
      fetchKlinesCached(pair,'1h',200),
      fetchKlinesCached(pair,'15m',200),
      fetchKlinesCached('BTCUSDT','1d',200),
      fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${pair}&limit=1`).then(r=>r.json()).catch(()=>[]),
      fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${pair}`).then(r=>r.json()).catch(()=>({})),
    ]);

    // [4] slice(0,-1) excludes forming candle  [3] sanitizeCandles removes spikes
    const k1d  = sanitizeCandles(rawK1d.slice(0,-1));
    const k4h  = sanitizeCandles(rawK4h.slice(0,-1));
    const k1h  = sanitizeCandles(rawK1h.slice(0,-1));
    const k15m = sanitizeCandles(rawK15m.slice(0,-1));
    const btcK1d = sanitizeCandles(rawBtcK1d.slice(0,-1));

    function parseKlines(klines) {
      return {
        opens:   klines.map(k=>parseFloat(k[1])),
        highs:   klines.map(k=>parseFloat(k[2])),
        lows:    klines.map(k=>parseFloat(k[3])),
        closes:  klines.map(k=>parseFloat(k[4])),
        volumes: klines.map(k=>parseFloat(k[5])),
      };
    }

    const d1=parseKlines(k1d),h4=parseKlines(k4h),h1=parseKlines(k1h);
    const m15=parseKlines(k15m),btc=parseKlines(btcK1d);
    const currentPrice=h1.closes[h1.closes.length-1];

    // ══ LEVEL 1 ══════════════════════════════════════════════
    const btcEma20=calcEMA(btc.closes,20),btcEma50=calcEMA(btc.closes,50),btcEma200=calcEMA(btc.closes,200);
    const btcClose=btc.closes[btc.closes.length-1];
    const btcTrend=btcClose>btcEma20&&btcEma20>btcEma50&&btcEma50>btcEma200?'STRONG_BULL':
      btcClose>btcEma50?'BULL':btcClose<btcEma200?'STRONG_BEAR':'BEAR';
    const fundingRate=fundingRaw[0]?.fundingRate?parseFloat(fundingRaw[0].fundingRate)*100:0;
    const fundingBias=fundingRate>0.05?'LONGS_PAYING':fundingRate<-0.01?'SHORTS_PAYING':'NEUTRAL';
    const openInterest=oiRaw?.openInterest?parseFloat(oiRaw.openInterest):null;

    // ══ LEVEL 2 ══════════════════════════════════════════════
    const d1Ema20=calcEMA(d1.closes,20),d1Ema50=calcEMA(d1.closes,50),d1Ema200=calcEMA(d1.closes,200);
    const d1Struct=detectStructure(d1.closes,d1.highs,d1.lows);
    const d1SR=findSRLevels(d1.highs,d1.lows),d1OB=findOrderBlock(k1d);
    const h4Ema20=calcEMA(h4.closes,20),h4Ema50=calcEMA(h4.closes,50),h4Ema200=calcEMA(h4.closes,200);
    const h4Struct=detectStructure(h4.closes,h4.highs,h4.lows);
    const h4SR=findSRLevels(h4.highs,h4.lows),h4OB=findOrderBlock(k4h);
    const h4FVGs=detectFVG(k4h);
    const h4RSIArr=calcRSIArr(h4.closes,14,5),h4RSI=h4RSIArr[h4RSIArr.length-1];
    const h4Div=detectDivergence(h4.closes,h4RSIArr);
    const prevDayHigh=Math.max(...h4.highs.slice(-6)),prevDayLow=Math.min(...h4.lows.slice(-6));

    // ══ LEVEL 3 ══════════════════════════════════════════════
    const h1Ema20=calcEMA(h1.closes,20),h1Ema50=calcEMA(h1.closes,50),h1Ema200=calcEMA(h1.closes,200);
    const h1Struct=detectStructure(h1.closes,h1.highs,h1.lows);
    const h1RSIArr=calcRSIArr(h1.closes,14,5),h1RSI=h1RSIArr[h1RSIArr.length-1];
    const h1Div=detectDivergence(h1.closes,h1RSIArr);
    const h1MACD=calcMACD(h1.closes),h1BB=calcBB(h1.closes),h1Vol=detectVolumeSpike(h1.volumes);
    const h1FVGs=detectFVG(k1h);
    const adx1h=calcADX(k1h,14),adx4h=calcADX(k4h,14);
    const marketCondition=adx1h>=25?'TRENDING':adx1h>=20?'WEAK_TREND':'CHOPPY';
    const isChoppy=adx1h<20&&adx4h<25;

    // ══ LEVEL 4 ══════════════════════════════════════════════
    const m15Ema20=calcEMA(m15.closes,20),m15Ema50=calcEMA(m15.closes,50);
    const m15Struct=detectStructure(m15.closes,m15.highs,m15.lows);
    const m15RSIArr=calcRSIArr(m15.closes,14,5),m15RSI=m15RSIArr[m15RSIArr.length-1];
    const m15Div=detectDivergence(m15.closes,m15RSIArr);
    const m15MACD=calcMACD(m15.closes),m15Vol=detectVolumeSpike(m15.volumes);
    const m15FVGs=detectFVG(k15m),m15Candle=detectCandlePattern(k15m);

    // ══ LEVEL 5 ══════════════════════════════════════════════
    const atr4h=calcATR(k4h,14),atr1h=calcATR(k1h,14);

    // [6][7] Net Scoring + Weighted Direction
    let bullScore=0,bearScore=0;
    if (btcTrend==='STRONG_BULL') bullScore+=3; else if (btcTrend==='BULL') bullScore+=2;
    else if (btcTrend==='STRONG_BEAR') bearScore+=3; else if (btcTrend==='BEAR') bearScore+=2;
    if (d1Struct==='BOS_BULLISH'||d1Struct==='CHOCH_BULLISH') bullScore+=2;
    else if (d1Struct==='BOS_BEARISH'||d1Struct==='CHOCH_BEARISH') bearScore+=2;
    if (h4Struct==='BOS_BULLISH'||h4Struct==='CHOCH_BULLISH') bullScore+=2;
    else if (h4Struct==='BOS_BEARISH'||h4Struct==='CHOCH_BEARISH') bearScore+=2;
    if (fundingBias==='SHORTS_PAYING') bullScore+=1; else if (fundingBias==='LONGS_PAYING') bearScore+=1;
    if (h1RSI<35) bullScore+=1; else if (h1RSI>65) bearScore+=1;
    const h1MacdFreshCross=(h1MACD.histogram>0)!==(h1MACD.prevHistogram>0);
    if (h1MacdFreshCross) { h1MACD.histogram>0?bullScore+=1:bearScore+=1; }
    if (h4Div==='BULLISH_DIV'||h1Div==='BULLISH_DIV') bullScore+=1;
    else if (h4Div==='BEARISH_DIV'||h1Div==='BEARISH_DIV') bearScore+=1;
    if (m15Struct==='BOS_BULLISH'||m15Struct==='CHOCH_BULLISH') bullScore+=1;
    else if (m15Struct==='BOS_BEARISH'||m15Struct==='CHOCH_BEARISH') bearScore+=1;
    if (m15Vol.spike) { m15MACD.histogram>0?bullScore+=1:bearScore+=1; }

    const netScore=bullScore-bearScore;
    const isBullish=netScore>0;
    const score=Math.max(0,Math.min(10,bullScore));

    // [10] HTF/LTF Conflict Detection
    const htfBull=['BOS_BULLISH','CHOCH_BULLISH'].includes(d1Struct)||['BOS_BULLISH','CHOCH_BULLISH'].includes(h4Struct);
    const htfBear=['BOS_BEARISH','CHOCH_BEARISH'].includes(d1Struct)||['BOS_BEARISH','CHOCH_BEARISH'].includes(h4Struct);
    const ltfBull=['BOS_BULLISH','CHOCH_BULLISH'].includes(h1Struct)||['BOS_BULLISH','CHOCH_BULLISH'].includes(m15Struct);
    const ltfBear=['BOS_BEARISH','CHOCH_BEARISH'].includes(h1Struct)||['BOS_BEARISH','CHOCH_BEARISH'].includes(m15Struct);
    const conflictDetected=(htfBull&&ltfBear)||(htfBear&&ltfBull);
    const conflictType=conflictDetected?(htfBull&&ltfBear?'HTF_BULL_LTF_BEAR':'HTF_BEAR_LTF_BULL'):'NONE';
    const adjustedNetScore=conflictDetected?Math.round(netScore*0.5):netScore;

    // [9] Entry + Structure-aware SL
    const entryLow  = parseFloat((currentPrice-atr1h*0.3).toFixed(4));
    const entryHigh = parseFloat((currentPrice+atr1h*0.3).toFixed(4));
    const sl        = calcStructureSL(isBullish,currentPrice,atr4h,h4OB,h4.highs,h4.lows);
    const riskAmt   = Math.abs(currentPrice-sl);
    const tp1 = parseFloat((isBullish?currentPrice+riskAmt*1.5:currentPrice-riskAmt*1.5).toFixed(4));
    const tp2 = parseFloat((isBullish?currentPrice+riskAmt*2.5:currentPrice-riskAmt*2.5).toFixed(4));
    const tp3 = parseFloat((isBullish?currentPrice+riskAmt*4.0:currentPrice-riskAmt*4.0).toFixed(4));

    // [14] Signal freshness
    const signalTs  = Date.now();
    const entryValid = currentPrice>=entryLow*0.998&&currentPrice<=entryHigh*1.002;

    // ── Groq Prompt ───────────────────────────────────────────
    const GROQ_KEY=process.env.GROQ_API_KEY;
    if (!GROQ_KEY) return res.status(500).json({ success:false, error:'AI key not configured' });

    const conflictNote=conflictDetected
      ?`⚠️ CONFLICT (${conflictType}): HTF and LTF structures opposing. Wait for alignment.`
      :'No structural conflict.';
    const choppyNote=isChoppy
      ?`⚠️ CHOPPY MARKET: ADX 1H=${adx1h.toFixed(1)}, ADX 4H=${adx4h.toFixed(1)}. False signals likely.`
      :`Trending market: ADX 1H=${adx1h.toFixed(1)}.`;

    const prompt=`You are a professional crypto futures trader and analyst. Analyze the following REAL calculated market data for ${pair} and provide a structured 5-level trade analysis.

=== REAL MARKET DATA ===
CURRENT PRICE: $${currentPrice}
NET CONFLUENCE: Bull ${bullScore} vs Bear ${bearScore} = Net ${adjustedNetScore>0?'+':''}${adjustedNetScore}
${conflictNote}
${choppyNote}

--- LEVEL 1: MACRO CONTEXT ---
BTC 1D Trend: ${btcTrend} (EMA20:${btcEma20.toFixed(2)}, EMA50:${btcEma50.toFixed(2)}, EMA200:${btcEma200.toFixed(2)})
BTC Price: $${btcClose.toFixed(2)}
Funding Rate: ${fundingRate.toFixed(4)}% (${fundingBias})
Open Interest: ${openInterest?openInterest.toFixed(2):'N/A'}

--- LEVEL 2: HTF STRUCTURE ---
Daily Structure: ${d1Struct}
Daily EMA20:${d1Ema20.toFixed(4)} EMA50:${d1Ema50.toFixed(4)} EMA200:${d1Ema200.toFixed(4)}
Daily S/R: ${d1SR.join(', ')}
Daily OB: ${d1OB?JSON.stringify(d1OB):'None'}
4H Structure: ${h4Struct}
4H EMA20:${h4Ema20.toFixed(4)} EMA50:${h4Ema50.toFixed(4)} EMA200:${h4Ema200.toFixed(4)}
4H RSI:${h4RSI} Divergence:${h4Div}
4H S/R: ${h4SR.join(', ')}
4H OB: ${h4OB?JSON.stringify(h4OB):'None'}
4H FVG: ${JSON.stringify(h4FVGs)}
Prev Day High/Low: ${prevDayHigh.toFixed(4)} / ${prevDayLow.toFixed(4)}

--- LEVEL 3: MOMENTUM (1H) ---
1H Structure: ${h1Struct}
1H EMA20:${h1Ema20.toFixed(4)} EMA50:${h1Ema50.toFixed(4)} EMA200:${h1Ema200.toFixed(4)}
1H RSI:${h1RSI} Divergence:${h1Div}
1H MACD:${h1MACD.macd.toFixed(4)} Signal:${h1MACD.signal.toFixed(4)} Hist:${h1MACD.histogram.toFixed(4)} FreshCross:${h1MacdFreshCross}
1H BB: Upper:${h1BB.upper.toFixed(4)} Mid:${h1BB.middle.toFixed(4)} Lower:${h1BB.lower.toFixed(4)}
1H Volume Spike:${h1Vol.spike} (${h1Vol.ratio}x avg)
1H FVG: ${JSON.stringify(h1FVGs)}
ADX 1H:${adx1h.toFixed(1)} (${marketCondition})

--- LEVEL 4: ENTRY TIMING (15m) ---
15m Structure: ${m15Struct}
15m EMA20:${m15Ema20.toFixed(4)} EMA50:${m15Ema50.toFixed(4)}
15m RSI:${m15RSI} Divergence:${m15Div}
15m MACD Hist:${m15MACD.histogram.toFixed(4)} FreshCross:${(m15MACD.histogram>0)!==(m15MACD.prevHistogram>0)}
15m Candle:${m15Candle}
15m Volume:${m15Vol.spike} (${m15Vol.ratio}x avg)
15m FVG: ${JSON.stringify(m15FVGs)}

--- LEVEL 5: TRADE SETUP ---
Direction: ${isBullish?'LONG':'SHORT'} (Bull:${bullScore} Bear:${bearScore} Net:${adjustedNetScore})
Entry Zone: $${entryLow} — $${entryHigh}
Stop Loss (Structure+ATR): $${sl}
TP1 (1:1.5): $${tp1}
TP2 (1:2.5): $${tp2}
TP3 (1:4.0): $${tp3}
ATR 4H:${atr4h.toFixed(4)} ATR 1H:${atr1h.toFixed(4)}
Confluence: ${score}/10 | Adjusted Net: ${adjustedNetScore}
Conflict: ${conflictType} | Market: ${marketCondition}

=== YOUR TASK ===
Respond ONLY in this JSON format (no markdown, no extra text):
{
  "overallBias":"LONG or SHORT or NEUTRAL",
  "confluenceScore":${score},
  "netScore":${adjustedNetScore},
  "grade":"S or A or B or C or D",
  "conflictWarning":"${conflictType}",
  "marketCondition":"${marketCondition}",
  "level1":{"btcTrend":"one sentence","fundingSignal":"one sentence","oiSignal":"one sentence","macroConclusion":"BULLISH or BEARISH or NEUTRAL"},
  "level2":{"dailyStructure":"one sentence","dailyEMA":"one sentence","h4Structure":"one sentence","h4EMA":"one sentence","h4Divergence":"one sentence","keyLevels":"key S/R","orderBlock":"OB interpretation","fvgZones":"FVG interpretation","structureConclusion":"BULLISH or BEARISH or NEUTRAL"},
  "level3":{"h1Structure":"one sentence","h1RSI":"one sentence","h1Divergence":"one sentence","macdSignal":"one sentence","bollingerSignal":"one sentence","volumeSignal":"one sentence","adxSignal":"one sentence","momentumConclusion":"STRONG_BULL or BULL or NEUTRAL or BEAR or STRONG_BEAR"},
  "level4":{"m15Structure":"one sentence","m15RSI":"one sentence","m15Divergence":"one sentence","macdCross":"one sentence","candlePattern":"one sentence","volumeConfirm":"one sentence","fvgEntry":"one sentence","sessionNote":"session timing note","entryConclusion":"CONFIRMED or WAIT or AVOID"},
  "level5":{"direction":"${isBullish?'LONG':'SHORT'}","entryZone":"$${entryLow} — $${entryHigh}","stopLoss":"$${sl}","tp1":"$${tp1}","tp2":"$${tp2}","tp3":"$${tp3}","invalidationLevel":"price that invalidates setup","leverage":"suggested range","positionSize":"sizing guidance","tradeManagement":"SL to BE and trail plan","reEntry":"re-entry conditions","riskNote":"risk assessment"},
  "summary":"2-3 sentence trade summary",
  "warning":"major risks — conflict, chop, news if applicable"
}`;

    const groqRes=await fetch('https://api.groq.com/openai/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${GROQ_KEY}`},
      body:JSON.stringify({model:'llama-3.3-70b-versatile',temperature:0.2,max_tokens:2000,messages:[{role:'user',content:prompt}]}),
    });
    if (!groqRes.ok) return res.status(502).json({ success:false, error:`AI error: ${await groqRes.text()}` });
    const groqData=await groqRes.json();
    const rawText=groqData.choices?.[0]?.message?.content||'';
    if (!rawText) return res.status(502).json({ success:false, error:'AI returned empty response' });
    let analysis;
    try { analysis=JSON.parse(rawText.replace(/```json|```/g,'').trim()); }
    catch(e) { return res.status(500).json({ success:false, error:'AI response parse failed', raw:rawText }); }

    // [13] State tracking + trend_flip broadcast
    const currentBias=isBullish?'LONG':'SHORT';
    const prevState=analysisState.get(pair);
    if (prevState&&prevState.bias!==currentBias) {
      broadcastToAll({type:'trend_flip',coin:pair,from:prevState.bias,to:currentBias,score:adjustedNetScore,ts:signalTs});
      console.log(`🔄 Trend flip: ${pair} ${prevState.bias} → ${currentBias}`);
    }
    analysisState.set(pair,{bias:currentBias,score:adjustedNetScore,ts:signalTs});

    res.json({
      success:true, coin:pair, price:currentPrice,
      confluenceScore:score, bullScore, bearScore, netScore:adjustedNetScore,
      marketCondition, adx1h:parseFloat(adx1h.toFixed(1)), adx4h:parseFloat(adx4h.toFixed(1)), isChoppy,
      conflictDetected, conflictType,
      signalTs, entryValid,
      rawData:{
        btcTrend,fundingRate,fundingBias,
        d1Struct,h4Struct,h1Struct,m15Struct,
        h4RSI,h1RSI,m15RSI, h4Div,h1Div,m15Div,
        h1MACD,m15MACD, h1BB,h1Vol,m15Vol,
        m15Candle,atr4h,atr1h,
        entryLow,entryHigh,sl,tp1,tp2,tp3,
        h1Ema20,h1Ema50,h1Ema200,
        h4Ema20,h4Ema50,h4Ema200,
        d1Ema20,d1Ema50,d1Ema200,
        h4SR,d1SR, h4FVGs,h1FVGs,m15FVGs,
        h4OB,d1OB, prevDayHigh,prevDayLow, openInterest,
      },
      analysis,
    });

  } catch (err) {
    console.error('/api/deep-analysis error:', err.message);
    res.status(500).json({ success:false, error:err.message });
  }
});

// ── Catch-all ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  const safeName=path.basename(req.path.replace('/','') || 'index.html');
  res.sendFile(path.join(__dirname,safeName), err=>{
    if (err) res.sendFile(path.join(__dirname,'index.html'));
  });
});

// ============================================================
//  HTTP + WebSocket SERVER
// ============================================================
const server=http.createServer(app);
const wss=new WebSocket.Server({server});

function broadcastToAll(data) {
  const msg=JSON.stringify(data);
  wss.clients.forEach(c=>{if(c.readyState===WebSocket.OPEN){try{c.send(msg);}catch(_){}}});
}

// ── Binance WebSocket ─────────────────────────────────────────
const BINANCE_STREAM='wss://fstream.binance.com/stream?streams='+
  ['btcusdt@ticker','ethusdt@ticker','bnbusdt@ticker','solusdt@ticker','xrpusdt@ticker','adausdt@ticker','dogeusdt@ticker','dotusdt@ticker'].join('/');

let binanceWs=null, binanceReconnectTimer=null;

function connectBinance() {
  if (binanceWs) { try{binanceWs.terminate();}catch(_){} }
  console.log('🔌 Connecting to Binance WebSocket...');
  binanceWs=new WebSocket(BINANCE_STREAM);
  binanceWs.on('open',()=>{
    console.log('✅ Binance WebSocket connected');
    if (binanceReconnectTimer){clearTimeout(binanceReconnectTimer);binanceReconnectTimer=null;}
  });
  binanceWs.on('message',raw=>{
    try {
      const d=JSON.parse(raw).data; if (!d) return;
      broadcastToAll({type:'market_update',ticker:[{
        symbol:d.s,price:parseFloat(d.c),change:parseFloat(d.P),high:parseFloat(d.h),low:parseFloat(d.l),volume:parseFloat(d.v)
      }]});
    } catch(_){}
  });
  binanceWs.on('close',()=>{
    console.log('⚠️  Binance WS closed — reconnect in 5s...');
    binanceReconnectTimer=setTimeout(connectBinance,5000);
  });
  binanceWs.on('error',err=>{console.error('Binance WS error:',err.message);try{binanceWs.terminate();}catch(_){}});
}

// ── Client WebSocket ──────────────────────────────────────────
wss.on('connection', async (ws, req) => {
  const urlParams=new URLSearchParams(req.url.replace(/^.*\?/,''));
  const wsToken=urlParams.get('token');
  let wsUser=null;
  if (wsToken) { try{wsUser=await admin.auth().verifyIdToken(wsToken);}catch(_){} }

  if (wsUser) {
    console.log('Authenticated WS client. Total:',wss.clients.size);
    try {
      const dbUser=await User.findOne({uid:wsUser.uid});
      const userPlan=dbUser?dbUser.plan:'free', userRole=dbUser?dbUser.role:'user';
      const planFilter=userRole==='admin'?{}:{plan:{$in:Object.keys(PLAN_LEVEL).filter(p=>planLevel(p)<=planLevel(userPlan))}};
      const signals=await Signal.find({active:true,...planFilter}).sort({createdAt:-1}).limit(20);
      ws.send(JSON.stringify({type:'signals_update',signals}));
      const now=new Date();
      const ann=await Announcement.findOne({active:true,showFrom:{$lte:now},$or:[{showUntil:null},{showUntil:{$gte:now}}]}).sort({createdAt:-1});
      if (ann) ws.send(JSON.stringify({type:'announcement',data:ann}));
    } catch(_){}
  } else {
    console.log('Unauthenticated WS client. Total:',wss.clients.size);
    try {
      const now=new Date();
      const ann=await Announcement.findOne({active:true,showFrom:{$lte:now},$or:[{showUntil:null},{showUntil:{$gte:now}}]}).sort({createdAt:-1});
      if (ann) ws.send(JSON.stringify({type:'announcement',data:ann}));
    } catch(_){}
  }
  ws.on('close',()=>console.log('WS disconnected. Total:',wss.clients.size));
  ws.on('error',()=>{});
});

// ── Static files ──────────────────────────────────────────────
app.use((req,res,next)=>{
  if (BLOCKED_STATIC.includes(path.basename(req.path)))
    return res.status(403).json({success:false,error:'Forbidden'});
  next();
});
app.use(express.static(path.join(__dirname)));

// ── Start ─────────────────────────────────────────────────────
const PORT=process.env.PORT||3000;
server.listen(PORT,()=>{
  console.log(`\n🚀 InvestySignals server running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}`);
  connectBinance();
});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('SIGINT', ()=>server.close(()=>process.exit(0)));
