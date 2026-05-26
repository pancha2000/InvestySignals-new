// ============================================================
//  InvestySignals — Backend Server (Upgraded v4)
//  Node.js + Express + MongoDB + Firebase Admin + WebSocket
//
//  v4 FIXES (all bugs resolved):
//  [F1]  BOS detection — close-based confirmation (no fake wick BOS)
//  [F2]  Entry zone — direction-aware (LONG=pullback zone, SHORT=push zone)
//  [F3]  currentPrice — live Binance ticker price (not stale 1H close)
//  [F4]  FVG — unmitigated only (filled FVGs excluded)
//  [F5]  RSI Divergence — proper swing pivot comparison (10-candle lookback)
//  [F6]  Score display — netScore (bull-bear) not just bullScore
//  [F7]  SL swing lookback — 8→15 candles for proper structure
//  [F8]  BTC context — 4H structure added alongside 1D EMA
//  [F9]  ATR entry — 15m ATR used for 15m entry zone refinement
//  [F10] TP levels — nearest S/R level aware (avoid placing TP inside SR)
//  [F11] Stochastic RSI added (1H, 15m) for overbought/oversold timing
//  [F12] CVD proxy — volume-weighted direction for entry confirmation
//
//  v3 UPGRADES (from previous version):
//  [1]  Klines cache (5-min TTL)
//  [2]  Binance API retry + exponential backoff
//  [3]  Candle outlier sanitization (median ±15%)
//  [4]  Completed candle fix (forming candle excluded)
//  [5]  calcADX — choppy market detection
//  [6]  Net scoring (bullScore − bearScore)
//  [7]  Weighted direction
//  [8]  findOrderBlock — explosive move + mitigation validated
//  [9]  Structure-aware SL
//  [10] HTF/LTF conflict detection
//  [11] Per-user throttle (30s)
//  [12] News blackout toggle
//  [13] State tracking + trend_flip WS broadcast
//  [14] Signal freshness flags
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

const Signal       = require('./models/Signal');
const User         = require('./models/User');
const PaperTrade   = require('./models/PaperTrade');
const Settings     = require('./models/Settings');
const Announcement = require('./models/Announcement');
const Report       = require('./models/Report');

// ── Firebase ─────────────────────────────────────────────────
try {
  const serviceAccount = require('./serviceAccount.json');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log('✅ Firebase Admin initialized');
} catch (err) {
  console.error('❌ Firebase Admin init failed:', err.message);
  process.exit(1);
}

// ── MongoDB ───────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/investysignals')
  .then(async () => { console.log('✅ MongoDB connected'); await loadSettingsFromDB(); })
  .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

const ADMIN_EMAILS = ['cdilrukshi52@gmail.com'];

const SETTINGS_DEFAULTS = {
  maintenance: false,
  maintenanceMsg: 'We are making improvements. Please check back shortly.',
  allowRegistrations: true,
  highImpactMode: false,
  highImpactMsg: 'High impact news period — signals temporarily paused.',
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

// ── [1][2] Klines Cache + Retry ──────────────────────────────
const klinesCache   = new Map();
const KLINES_TTL    = 5 * 60 * 1000;

async function fetchKlinesCached(symbol, interval, limit = 200, retries = 3) {
  const key    = `${symbol}_${interval}_${limit}`;
  const cached = klinesCache.get(key);
  if (cached && Date.now() - cached.ts < KLINES_TTL) return cached.data;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const url  = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const r    = await fetch(url);
      if (r.status === 429) { await new Promise(res => setTimeout(res, 1000 * Math.pow(2, attempt))); continue; }
      if (!r.ok) throw new Error(`Binance klines error ${r.status}`);
      const data = await r.json();
      klinesCache.set(key, { data, ts: Date.now() });
      return data;
    } catch(e) {
      if (attempt === retries - 1) throw e;
      await new Promise(res => setTimeout(res, 500 * (attempt + 1)));
    }
  }
  throw new Error(`fetchKlines failed: ${symbol} ${interval}`);
}

// ── [F3] Live price cache ────────────────────────────────────
const priceCache = new Map();
const PRICE_TTL  = 10 * 1000; // 10 seconds

async function getLivePrice(symbol) {
  const cached = priceCache.get(symbol);
  if (cached && Date.now() - cached.ts < PRICE_TTL) return cached.price;
  try {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
    if (!r.ok) return null;
    const d = await r.json();
    const price = parseFloat(d.price);
    priceCache.set(symbol, { price, ts: Date.now() });
    return price;
  } catch(e) { return null; }
}

// ── [3] Outlier Sanitization ─────────────────────────────────
function sanitizeCandles(klines) {
  if (!klines || klines.length < 10) return klines;
  const closes = klines.map(k => parseFloat(k[4])).sort((a, b) => a - b);
  const median = closes[Math.floor(closes.length / 2)];
  if (median <= 0) return klines;
  return klines.filter(k => Math.abs(parseFloat(k[4]) - median) / median < 0.15);
}

// ── [13] State + [11] Throttle ───────────────────────────────
const analysisState    = new Map();
const lastAnalysisTime = new Map();
const ANALYSIS_COOLDOWN = 30 * 1000;

// ── Express ───────────────────────────────────────────────────
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

const apiLimiter   = rateLimit({ windowMs: 15*60*1000, max: 300, standardHeaders: true, legacyHeaders: false, message: { success: false, error: 'Too many requests.' } });
const adminLimiter = rateLimit({ windowMs: 15*60*1000, max: 1000, standardHeaders: true, legacyHeaders: false, message: { success: false, error: 'Too many requests.' } });
app.use('/api/admin/', adminLimiter);
app.use('/api/', apiLimiter);

const BLOCKED_STATIC = ['.env','serviceAccount.json','package.json','.gitignore','deploy.sh'];

// ── Auth ──────────────────────────────────────────────────────
async function ensureAdminPromotion(uid, emailFromToken) {
  try {
    let user = await User.findOne({ uid });
    const email = (emailFromToken || '').toLowerCase();
    const isAdminEmail = ADMIN_EMAILS.includes(email);
    if (!user) {
      let displayName = '';
      try { const fb = await admin.auth().getUser(uid); displayName = fb.displayName || ''; } catch(_) {}
      user = await User.create({ uid, email, displayName, role: isAdminEmail ? 'admin' : 'user', plan: 'free' });
    } else if (isAdminEmail && user.role !== 'admin') {
      await User.updateOne({ uid }, { role: 'admin', email });
      user.role = 'admin';
    }
    return user;
  } catch(e) { return null; }
}

async function verifyToken(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    const dbUser = await User.findOne({ uid: req.user.uid });
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
//  STANDARD API ROUTES
// ============================================================

app.get('/api/health', (req, res) => res.json({ success: true, status: 'ok', time: new Date().toISOString() }));

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
    function ema(data,n){const k=2/(n+1);let v=data.slice(0,n).reduce((a,b)=>a+b,0)/n;const o=[v];for(let i=n;i<data.length;i++){v=data[i]*k+v*(1-k);o.push(v);}return o;}
    const e12=ema(closes,12),e26=ema(closes,26);
    const ml=e12.slice(e12.length-e26.length).map((v,i)=>v-e26[i]),s9=ema(ml,9);
    const macd=parseFloat(ml[ml.length-1].toFixed(4)),sig=parseFloat(s9[s9.length-1].toFixed(4));
    const bbC=closes.slice(-20),bbM=bbC.reduce((a,b)=>a+b,0)/20;
    const std=Math.sqrt(bbC.reduce((a,c)=>a+Math.pow(c-bbM,2),0)/20);
    res.json({ success:true, pair, tf, price:parseFloat(closes[closes.length-1].toFixed(4)), rsi,
      macd:{macd,signal:sig,histogram:parseFloat((macd-sig).toFixed(4))},
      bb:{upper:parseFloat((bbM+2*std).toFixed(2)),middle:parseFloat(bbM.toFixed(2)),lower:parseFloat((bbM-2*std).toFixed(2))} });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

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

app.get('/api/announcement', async (req, res) => {
  try {
    const now=new Date();
    const ann=await Announcement.findOne({active:true,showFrom:{$lte:now},$or:[{showUntil:null},{showUntil:{$gte:now}}]}).sort({createdAt:-1});
    res.json({ success:true, data:ann, announcement:ann });
  } catch(err) { res.json({ success:true, data:null, announcement:null }); }
});

async function getPaperTrades(req, res) {
  try {
    const token=(req.headers.authorization||'').slice(7);
    if (!token) return res.status(401).json({ success:false });
    const decoded=await admin.auth().verifyIdToken(token);
    const dbUser=await User.findOne({uid:decoded.uid});
    if (dbUser?.suspended) return res.status(403).json({ success:false, error:'Account suspended' });
    const trades=await PaperTrade.find({userUid:decoded.uid}).sort({openedAt:-1}).limit(100);
    res.json({ success:true, trades, data:trades });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
}
app.get('/api/paper-trades', getPaperTrades);
app.get('/api/paper/trades',  getPaperTrades);

app.get('/api/paper/balance', verifyToken, async (req, res) => {
  try { const u=await User.findOne({uid:req.user.uid}); res.json({ success:true, balance:u?u.paperBalance:1000 }); }
  catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

app.post('/api/paper/trade', verifyToken, async (req, res) => {
  try {
    const {signalId,size}=req.body;
    const ts=parseFloat(size);
    if (!ts||ts<=0||ts>100000||!isFinite(ts)) return res.status(400).json({ success:false, error:'Invalid trade size.' });
    const signal=await Signal.findById(signalId);
    if (!signal) return res.json({ success:false, error:'Signal not found' });
    const u=await User.findOne({uid:req.user.uid});
    if (u&&u.paperBalance<ts) return res.json({ success:false, error:'Insufficient paper balance' });
    const trade=await PaperTrade.create({userUid:req.user.uid,signalId:signal._id,pair:signal.pair,direction:signal.direction,entry:signal.entry,tp1:signal.tp1,tp2:signal.tp2,sl:signal.sl,leverage:signal.leverage,size:ts,status:'OPEN'});
    if (u) await User.updateOne({uid:req.user.uid},{$inc:{paperBalance:-ts}});
    res.json({ success:true, trade });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

app.patch('/api/paper/trade/:id/close', verifyToken, async (req, res) => {
  try {
    const trade=await PaperTrade.findOne({_id:req.params.id,userUid:req.user.uid});
    if (!trade) return res.status(404).json({ success:false, error:'Trade not found' });
    if (trade.status!=='OPEN') return res.json({ success:false, error:'Already closed' });
    const cp=parseFloat(req.body.closePrice);
    if (!cp||cp<=0||!isFinite(cp)) return res.status(400).json({ success:false, error:'Invalid close price.' });
    const pd=trade.direction==='LONG'?cp-trade.entry:trade.entry-cp;
    const pnlPct=(pd/trade.entry)*trade.leverage*100;
    const pnl=parseFloat(((pnlPct/100)*trade.size).toFixed(2));
    const closed=await PaperTrade.findByIdAndUpdate(trade._id,{status:'CLOSED',closePrice:cp,closedAt:new Date(),pnl,pnlPct:parseFloat(pnlPct.toFixed(2))},{new:true});
    await User.updateOne({uid:req.user.uid},{$inc:{paperBalance:trade.size+pnl}});
    res.json({ success:true, trade:closed });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

app.post('/api/reports', async (req, res) => {
  try {
    const {category,message,context}=req.body;
    if (!category||!message||message.trim().length<3) return res.status(400).json({ success:false, error:'Category and message required' });
    if (!['signal_accuracy','technical_bug','inappropriate_content','other'].includes(category)) return res.status(400).json({ success:false, error:'Invalid category' });
    let reporterUid='anonymous',reporterEmail='';
    const ah=req.headers.authorization||'';
    if (ah.startsWith('Bearer ')) { try { const d=await admin.auth().verifyIdToken(ah.slice(7)); reporterUid=d.uid||'anonymous'; reporterEmail=(d.email||'').toLowerCase(); } catch(_){} }
    const report=await Report.create({category,message:message.trim().slice(0,2000),context:(context||'').slice(0,500),reporterUid,reporterEmail});
    broadcastToAll({type:'new_report',reportId:report._id,category:report.category});
    res.json({ success:true, message:'Report submitted.' });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

app.get('/api/my-reports', verifyToken, async (req, res) => {
  try { const data=await Report.find({reporterUid:req.user.uid}).sort({createdAt:-1}).limit(20); res.json({ success:true, data }); }
  catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

app.get('/api/registration-status', (req, res) => res.json({ success:true, open:globalSettings.allowRegistrations!==false }));

// ============================================================
//  ADMIN ROUTES
// ============================================================

app.get('/api/admin/stats', verifyAdmin, async (req, res) => {
  try {
    const t=new Date(); t.setHours(0,0,0,0);
    const [tu,as,ts,ot,pc,ec,ac,nu,cs,or2,sc]=await Promise.all([
      User.countDocuments(),Signal.countDocuments({active:true,status:'ACTIVE'}),Signal.countDocuments(),PaperTrade.countDocuments({status:'OPEN'}),
      User.countDocuments({plan:'pro'}),User.countDocuments({plan:'elite'}),User.countDocuments({role:'admin'}),User.countDocuments({createdAt:{$gte:t}}),
      Signal.find({status:{$in:['TP1_HIT','TP2_HIT','SL_HIT']}}).select('status pnl').lean(),
      Report.countDocuments({status:'open'}),User.countDocuments({suspended:true}),
    ]);
    const wins=cs.filter(s=>['TP1_HIT','TP2_HIT'].includes(s.status)).length;
    const losses=cs.filter(s=>s.status==='SL_HIT').length;
    const total=wins+losses;
    res.json({ success:true, stats:{totalUsers:tu,activeSignals:as,totalSignals:ts,openTrades:ot,proCount:pc,eliteCount:ec,adminCount:ac,newUsersToday:nu,wins,losses,winRate:total>0?((wins/total)*100).toFixed(1):0,openReports:or2,bannedCount:sc,suspendedCount:sc}});
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

app.get('/api/admin/users', verifyAdmin, async (req, res) => {
  try {
    const {skip=0,limit=200,plan,suspended}=req.query;
    const f={};
    if (plan) f.plan=plan;
    if (suspended==='true') f.suspended=true;
    if (suspended==='false') f.suspended={$ne:true};
    const [users,total]=await Promise.all([User.find(f).sort({createdAt:-1}).skip(+skip).limit(+limit),User.countDocuments(f)]);
    res.json({ success:true, users, total, data:users });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

app.patch('/api/admin/users/:uid', verifyAdmin, async (req, res) => {
  try {
    const allowed=['role','plan','suspended','suspendReason','maintenance','maintenanceMsg','paperBalance'];
    const update={};
    allowed.forEach(k=>{if(req.body[k]!==undefined)update[k]=req.body[k];});
    if (update.paperBalance!==undefined){const b=parseFloat(update.paperBalance);if(!isFinite(b)||b<0)return res.status(400).json({success:false,error:'Invalid paperBalance.'});update.paperBalance=b;}
    const user=await User.findOneAndUpdate({uid:req.params.uid},update,{new:true});
    if (!user) return res.json({ success:false, error:'User not found' });
    if (update.suspended!==undefined){try{await admin.auth().updateUser(req.params.uid,{disabled:update.suspended});}catch(_){}}
    res.json({ success:true, user });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

app.delete('/api/admin/users/:uid', verifyAdmin, async (req, res) => {
  try {
    const del=await User.findOneAndDelete({uid:req.params.uid});
    if (!del) return res.status(404).json({ success:false, error:'User not found' });
    try{await admin.auth().deleteUser(req.params.uid);}catch(_){}
    res.json({ success:true, message:'User deleted' });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

const SIG_FIELDS=['pair','direction','entry','tp1','tp2','sl','leverage','timeframe','notes','score','plan','status','pnl','winRate','active','closedAt'];
function pickSig(body){const o={};SIG_FIELDS.forEach(k=>{if(body[k]!==undefined)o[k]=body[k];});return o;}

app.post('/api/signals', verifyAdmin, async (req, res) => {
  try{const b=pickSig(req.body);if(b.leverage)b.leverage=parseInt(String(b.leverage).replace(/[^0-9]/g,''))||10;const s=await Signal.create(b);broadcastToAll({type:'new_signal',signal:s});res.json({success:true,signal:s});}
  catch(err){res.status(400).json({success:false,error:err.message});}
});
app.patch('/api/signals/:id', verifyAdmin, async (req, res) => {
  try{const s=await Signal.findByIdAndUpdate(req.params.id,pickSig(req.body),{new:true});if(!s)return res.status(404).json({success:false,error:'Not found'});broadcastToAll({type:'signal_update',signal:s});res.json({success:true,signal:s});}
  catch(err){res.status(500).json({success:false,error:err.message});}
});
app.delete('/api/signals/:id', verifyAdmin, async (req, res) => {
  try{await Signal.findByIdAndUpdate(req.params.id,{active:false});broadcastToAll({type:'signal_deleted',signalId:req.params.id});res.json({success:true});}
  catch(err){res.status(500).json({success:false,error:err.message});}
});

app.get('/api/admin/settings', verifyAdmin, (req, res) => res.json({ success:true, settings:globalSettings }));
app.patch('/api/admin/settings', verifyAdmin, async (req, res) => {
  try {
    const allowed=['maintenance','maintenanceMsg','allowRegistrations','highImpactMode','highImpactMsg'];
    const saves=[];
    allowed.forEach(k=>{if(req.body[k]!==undefined){globalSettings[k]=req.body[k];saves.push(saveSettingToDB(k,req.body[k]));}});
    await Promise.all(saves);
    if (req.body.maintenance!==undefined) broadcastToAll({type:'maintenance',active:globalSettings.maintenance,message:globalSettings.maintenanceMsg});
    res.json({ success:true, settings:globalSettings });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

const ANN_FIELDS=['title','message','type','active','showFrom','showUntil','audience'];
function pickAnn(body){const o={};ANN_FIELDS.forEach(k=>{if(body[k]!==undefined)o[k]=body[k];});return o;}
app.get('/api/admin/announcements',  verifyAdmin, async (req,res)=>{try{res.json({success:true,data:await Announcement.find().sort({createdAt:-1})});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.post('/api/admin/announcements', verifyAdmin, async (req,res)=>{try{const a=await Announcement.create({...pickAnn(req.body),createdBy:req.dbUser.email||'admin'});if(a.active)broadcastToAll({type:'announcement',data:a});res.json({success:true,data:a});}catch(e){res.status(400).json({success:false,error:e.message});}});
app.put('/api/admin/announcements/:id',  verifyAdmin, async (req,res)=>{try{const a=await Announcement.findByIdAndUpdate(req.params.id,pickAnn(req.body),{new:true});if(!a)return res.status(404).json({success:false,error:'Not found'});res.json({success:true,data:a});}catch(e){res.status(400).json({success:false,error:e.message});}});
app.delete('/api/admin/announcements/:id',verifyAdmin, async (req,res)=>{try{await Announcement.findByIdAndDelete(req.params.id);res.json({success:true});}catch(e){res.status(500).json({success:false,error:e.message});}});

app.post('/api/admin/broadcast', verifyAdmin, async (req, res) => {
  try {
    const {subject,message,audience}=req.body;
    if (!message) return res.json({ success:false, error:'Message required' });
    const t=subject||'Platform Announcement';
    broadcastToAll({type:'announcement',data:{title:t,message,type:'info',audience:audience||'All Users'},time:new Date().toISOString()});
    await Announcement.create({title:t,message,audience:audience||'All Users',active:true,createdBy:req.dbUser.email||'admin'});
    res.json({ success:true, message:'Broadcast sent' });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

app.get('/api/admin/reports/unread-count',verifyAdmin,async(req,res)=>{try{res.json({success:true,count:await Report.countDocuments({status:'open',readByAdmin:false})});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/admin/reports',verifyAdmin,async(req,res)=>{try{const{status,skip=0,limit=50}=req.query;const f=status?{status}:{};const[data,total,oc]=await Promise.all([Report.find(f).sort({createdAt:-1}).skip(+skip).limit(+limit),Report.countDocuments(f),Report.countDocuments({status:'open'})]);res.json({success:true,total,openCount:oc,data});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.put('/api/admin/reports/:id',verifyAdmin,async(req,res)=>{try{const{status,adminNote,adminReply,readByAdmin}=req.body;const u={};if(status)u.status=status;if(adminNote!==undefined)u.adminNote=adminNote;if(adminReply!==undefined)u.adminReply=adminReply;if(readByAdmin!==undefined)u.readByAdmin=readByAdmin;if(status==='resolved'||status==='dismissed'){u.resolvedBy=req.dbUser.email||'admin';u.resolvedAt=new Date();}const r=await Report.findByIdAndUpdate(req.params.id,u,{new:true});if(!r)return res.status(404).json({success:false,error:'Not found'});res.json({success:true,data:r});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.delete('/api/admin/reports/:id',verifyAdmin,async(req,res)=>{try{await Report.findByIdAndDelete(req.params.id);res.json({success:true});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/reports/activity',verifyAdmin,async(req,res)=>{try{res.json({success:true,data:await PaperTrade.find({}).sort({openedAt:-1}).limit(100)});}catch(e){res.status(500).json({success:false,error:e.message});}});

// ============================================================
//  DEEP ANALYSIS v4 — All bugs fixed
// ============================================================
app.post('/api/deep-analysis', verifyToken, async (req, res) => {
  try {
    const {coin}=req.body;
    if (!coin||!/^[A-Z0-9]{2,20}$/.test(coin)) return res.status(400).json({ success:false, error:'Invalid coin symbol' });
    const pair=coin.replace(/USDT$/i,'')+'USDT';

    // [11] Throttle
    const uid=req.dbUser?._id?.toString()||req.user.uid;
    const lastTime=lastAnalysisTime.get(uid)||0;
    if (Date.now()-lastTime<ANALYSIS_COOLDOWN) {
      const ws=Math.ceil((ANALYSIS_COOLDOWN-(Date.now()-lastTime))/1000);
      return res.status(429).json({ success:false, error:`Please wait ${ws}s`, code:'THROTTLED' });
    }
    lastAnalysisTime.set(uid,Date.now());

    // [12] News blackout
    if (globalSettings.highImpactMode)
      return res.status(503).json({ success:false, error:globalSettings.highImpactMsg||'Signals paused.', code:'NEWS_BLACKOUT' });

    // ===========================================================
    //  INDICATOR FUNCTIONS — v5 (Phase 1+2 upgrades)
    // ===========================================================

    // [NEW] Liquidity Zones — Equal Highs / Equal Lows detection
    // Price always hunts liquidity before reversing
    function findLiquidityZones(highs, lows, tolerance=0.003) {
      const buyLiq  = []; // equal highs = buy-side liquidity (stops above)
      const sellLiq = []; // equal lows  = sell-side liquidity (stops below)
      const h = highs.slice(-50), l = lows.slice(-50);
      for (let i = 0; i < h.length - 1; i++) {
        for (let j = i + 1; j < h.length; j++) {
          if (Math.abs(h[i] - h[j]) / h[i] < tolerance) {
            const zone = parseFloat(((h[i] + h[j]) / 2).toFixed(4));
            if (!buyLiq.some(z => Math.abs(z - zone) / zone < tolerance)) buyLiq.push(zone);
          }
        }
      }
      for (let i = 0; i < l.length - 1; i++) {
        for (let j = i + 1; j < l.length; j++) {
          if (Math.abs(l[i] - l[j]) / l[i] < tolerance) {
            const zone = parseFloat(((l[i] + l[j]) / 2).toFixed(4));
            if (!sellLiq.some(z => Math.abs(z - zone) / zone < tolerance)) sellLiq.push(zone);
          }
        }
      }
      return { buyLiq: buyLiq.slice(-5), sellLiq: sellLiq.slice(-5) };
    }

    // [NEW] Premium / Discount Zones
    // Equilibrium = 50% of range. Discount < 50% (good to buy), Premium > 50% (good to sell)
    function calcPremiumDiscount(highs, lows, currentPrice, lookback=20) {
      const rangeHigh = Math.max(...highs.slice(-lookback));
      const rangeLow  = Math.min(...lows.slice(-lookback));
      const rangeSize = rangeHigh - rangeLow;
      if (rangeSize === 0) return { zone: 'EQUILIBRIUM', pct: 50, rangeHigh, rangeLow };
      const pct = ((currentPrice - rangeLow) / rangeSize) * 100;
      const zone = pct >= 75 ? 'PREMIUM' : pct <= 25 ? 'DISCOUNT' : pct >= 55 ? 'UPPER_EQ' : pct <= 45 ? 'LOWER_EQ' : 'EQUILIBRIUM';
      return { zone, pct: parseFloat(pct.toFixed(1)), rangeHigh, rangeLow, equilibrium: parseFloat(((rangeHigh + rangeLow) / 2).toFixed(4)) };
    }

    // [NEW] Fibonacci Retracement Levels from recent swing
    function calcFibLevels(highs, lows, isBullish, lookback=50) {
      const h = Math.max(...highs.slice(-lookback));
      const l = Math.min(...lows.slice(-lookback));
      const range = h - l;
      if (range === 0) return null;
      // Key fib levels
      const fibs = isBullish
        ? { // In uptrend: retracement from high to low (buy zones)
            fib236: parseFloat((h - range * 0.236).toFixed(4)),
            fib382: parseFloat((h - range * 0.382).toFixed(4)),
            fib500: parseFloat((h - range * 0.500).toFixed(4)),
            fib618: parseFloat((h - range * 0.618).toFixed(4)),
            fib705: parseFloat((h - range * 0.705).toFixed(4)),
            fib786: parseFloat((h - range * 0.786).toFixed(4)),
          }
        : { // In downtrend: retracement from low to high (sell zones)
            fib236: parseFloat((l + range * 0.236).toFixed(4)),
            fib382: parseFloat((l + range * 0.382).toFixed(4)),
            fib500: parseFloat((l + range * 0.500).toFixed(4)),
            fib618: parseFloat((l + range * 0.618).toFixed(4)),
            fib705: parseFloat((l + range * 0.705).toFixed(4)),
            fib786: parseFloat((l + range * 0.786).toFixed(4)),
          };
      return { ...fibs, swingHigh: h, swingLow: l };
    }

    // [NEW] Nearest Fibonacci zone to current price
    function nearestFib(fibLevels, currentPrice) {
      if (!fibLevels) return null;
      const levels = ['fib236','fib382','fib500','fib618','fib705','fib786'];
      let nearest = null, minDist = Infinity;
      for (const key of levels) {
        const dist = Math.abs(fibLevels[key] - currentPrice);
        if (dist < minDist) { minDist = dist; nearest = { level: key, price: fibLevels[key] }; }
      }
      const pct = minDist / currentPrice * 100;
      return { ...nearest, distPct: parseFloat(pct.toFixed(2)), withinZone: pct < 0.5 };
    }

    // [NEW] VWAP calculation
    function calcVWAP(klines) {
      let cumTPV = 0, cumVol = 0;
      for (const k of klines) {
        const h=parseFloat(k[2]),l=parseFloat(k[3]),c=parseFloat(k[4]),v=parseFloat(k[5]);
        const tp = (h + l + c) / 3;
        cumTPV += tp * v;
        cumVol += v;
      }
      return cumVol > 0 ? parseFloat((cumTPV / cumVol).toFixed(4)) : null;
    }

    // [NEW] Trading Session High/Low (UTC based)
    // Asia: 00:00-08:00, London: 07:00-16:00, NY: 12:00-21:00
    function getSessionContext(klines) {
      const now = new Date();
      const utcHour = now.getUTCHours();
      let currentSession = utcHour >= 0 && utcHour < 8 ? 'ASIA'
        : utcHour >= 7 && utcHour < 16 ? 'LONDON' : 'NEW_YORK';
      // Find session high/low from 1H klines (last 24H)
      const last24 = klines.slice(-24);
      const asiaK    = klines.slice(-24).filter((_,i)=>{ const h=new Date(parseFloat(klines[klines.length-24+i][0])).getUTCHours(); return h>=0&&h<8; });
      const londonK  = klines.slice(-24).filter((_,i)=>{ const h=new Date(parseFloat(klines[klines.length-24+i][0])).getUTCHours(); return h>=7&&h<16; });
      const nyK      = klines.slice(-24).filter((_,i)=>{ const h=new Date(parseFloat(klines[klines.length-24+i][0])).getUTCHours(); return h>=12&&h<21; });
      const getHL = k => k.length > 0 ? { high: Math.max(...k.map(c=>parseFloat(c[2]))), low: Math.min(...k.map(c=>parseFloat(c[3]))) } : null;
      return {
        current: currentSession,
        asia:    getHL(asiaK),
        london:  getHL(londonK),
        ny:      getHL(nyK),
        prevDayH: Math.max(...last24.map(c=>parseFloat(c[2]))),
        prevDayL: Math.min(...last24.map(c=>parseFloat(c[3]))),
      };
    }

    // [NEW] Breaker Block detection — failed OB that becomes opposing zone
    function findBreakerBlock(klines) {
      const breakers = [];
      for (let i = klines.length - 5; i >= Math.max(0, klines.length - 60); i--) {
        if (i + 2 >= klines.length) continue;
        const op = parseFloat(klines[i][1]), cl = parseFloat(klines[i][4]);
        const hi = parseFloat(klines[i][2]), lo = parseFloat(klines[i][3]);
        const body = Math.abs(cl - op), range = hi - lo;
        if (range === 0 || body / range <= 0.6) continue;
        const isBull = cl > op;
        // Check if subsequent price broke through this OB (mitigated it)
        const subL = klines.slice(i + 1).map(k => parseFloat(k[3]));
        const subH = klines.slice(i + 1).map(k => parseFloat(k[2]));
        const wasMitigated = isBull
          ? subL.some(l => l < lo)   // Bull OB broken by price going below
          : subH.some(h => h > hi);  // Bear OB broken by price going above
        if (wasMitigated) {
          // Failed OB = Breaker Block (now acts as opposite zone)
          breakers.push({ high: hi, low: lo, type: isBull ? 'BEAR_BREAKER' : 'BULL_BREAKER', index: i });
        }
      }
      return breakers.slice(-2); // Return last 2 breakers
    }

    // [NEW] OI Change Direction (previous vs current)
    async function getOIChange(symbol) {
      try {
        const r = await fetch(`https://fapi.binance.com/fapi/v1/openInterestHist?symbol=${symbol}&period=1h&limit=3`);
        if (!r.ok) return { change: 'UNKNOWN', pct: 0 };
        const data = await r.json();
        if (!data || data.length < 2) return { change: 'UNKNOWN', pct: 0 };
        const prev = parseFloat(data[data.length - 2].sumOpenInterest);
        const curr = parseFloat(data[data.length - 1].sumOpenInterest);
        const pct  = parseFloat(((curr - prev) / prev * 100).toFixed(3));
        return { change: pct > 0.1 ? 'INCREASING' : pct < -0.1 ? 'DECREASING' : 'STABLE', pct, prev, curr };
      } catch(e) { return { change: 'UNKNOWN', pct: 0 }; }
    }

    // [UPGRADED] Candle Pattern — now includes more patterns + scoring weight
    function detectCandlePattern(klines) {
      if (klines.length < 3) return { pattern: 'NONE', strength: 0, bullish: null };
      const c0 = klines[klines.length-1]; // current
      const c1 = klines[klines.length-2]; // prev
      const c2 = klines[klines.length-3]; // prev prev
      const o0=parseFloat(c0[1]),c0c=parseFloat(c0[4]),h0=parseFloat(c0[2]),l0=parseFloat(c0[3]);
      const o1=parseFloat(c1[1]),c1c=parseFloat(c1[4]),h1=parseFloat(c1[2]),l1=parseFloat(c1[3]);
      const o2=parseFloat(c2[1]),c2c=parseFloat(c2[4]);
      const body0=Math.abs(c0c-o0),range0=h0-l0;
      const body1=Math.abs(c1c-o1);
      if (range0 === 0) return { pattern: 'NONE', strength: 0, bullish: null };
      const uw0=h0-Math.max(o0,c0c), lw0=Math.min(o0,c0c)-l0;
      // Strength 3 = very strong, 2 = strong, 1 = moderate
      if (lw0>body0*2.5&&uw0<body0*0.3&&range0>0) return { pattern:'HAMMER', strength:3, bullish:true };
      if (uw0>body0*2.5&&lw0<body0*0.3&&range0>0) return { pattern:'SHOOTING_STAR', strength:3, bullish:false };
      if (c0c>h1&&o0<c1c&&body0>body1) return { pattern:'BULLISH_ENGULFING', strength:3, bullish:true };
      if (c0c<l1&&o0>c1c&&body0>body1) return { pattern:'BEARISH_ENGULFING', strength:3, bullish:false };
      // Piercing / Dark Cloud
      if (c1c<o1&&o0<l1&&c0c>=(o1+c1c)/2&&c0c<o1) return { pattern:'PIERCING', strength:2, bullish:true };
      if (c1c>o1&&o0>h1&&c0c<=(o1+c1c)/2&&c0c>o1) return { pattern:'DARK_CLOUD', strength:2, bullish:false };
      // Morning / Evening Star (3-candle)
      const doji1=body1/Math.max(h1-l1,0.0001)<0.15;
      if (c2c<o2&&doji1&&c0c>o0&&c0c>(o2+c2c)/2) return { pattern:'MORNING_STAR', strength:3, bullish:true };
      if (c2c>o2&&doji1&&c0c<o0&&c0c<(o2+c2c)/2) return { pattern:'EVENING_STAR', strength:3, bullish:false };
      // Doji / Spinning top
      if (body0/range0<0.1) return { pattern:'DOJI', strength:1, bullish:null };
      if (c0c>o0&&body0/range0>0.7) return { pattern:'STRONG_BULL', strength:2, bullish:true };
      if (c0c<o0&&body0/range0>0.7) return { pattern:'STRONG_BEAR', strength:2, bullish:false };
      if (lw0>body0*2&&uw0<body0) return { pattern:'PIN_BAR_BULL', strength:2, bullish:true };
      if (uw0>body0*2&&lw0<body0) return { pattern:'PIN_BAR_BEAR', strength:2, bullish:false };
      return { pattern:'NONE', strength:0, bullish:null };
    }

    // [UPGRADED] Structure-aware SL v5 — Liquidity + Fib + Breaker aware
    function calcStructureSLv5(isBullish, currentPrice, atr4h, h4OB, highs4h, lows4h, srLevels, liquidityZones, fibLevels, breakers) {
      const atrSL = isBullish ? currentPrice - atr4h * 1.5 : currentPrice + atr4h * 1.5;
      if (isBullish) {
        const swingLow   = Math.min(...lows4h.slice(-15));
        const obFloor    = (h4OB && h4OB.type==='BULL_OB') ? h4OB.low : null;
        const srBelow    = srLevels.filter(l => l < currentPrice * 0.997).pop() || null;
        // Sell-side liquidity below = natural SL target for stop hunts
        const liqBelow   = liquidityZones.sellLiq.filter(l => l < currentPrice * 0.997).pop() || null;
        // Fibonacci support nearby (618 / 786 = golden zone)
        const fibSupport = fibLevels ? [fibLevels.fib618, fibLevels.fib786].filter(f => f < currentPrice * 0.997).pop() : null;
        // Breaker block below (BULL_BREAKER = support)
        const breakerFloor = breakers.filter(b => b.type==='BULL_BREAKER' && b.low < currentPrice * 0.997).map(b=>b.low).pop() || null;
        // Gather all structural candidates
        const candidates = [
          swingLow * 0.998,
          obFloor  ? obFloor * 0.997  : null,
          srBelow  ? srBelow * 0.997  : null,
          liqBelow ? liqBelow * 0.997 : null,
          fibSupport ? fibSupport * 0.998 : null,
          breakerFloor ? breakerFloor * 0.997 : null,
          atrSL,
        ].filter(v => v !== null && v > 0 && Math.abs(currentPrice - v) / currentPrice < 0.10);
        // Pick lowest (widest protection), max 10% from entry
        return parseFloat(Math.min(...candidates).toFixed(4));
      } else {
        const swingHigh  = Math.max(...highs4h.slice(-15));
        const obCeil     = (h4OB && h4OB.type==='BEAR_OB') ? h4OB.high : null;
        const srAbove    = srLevels.filter(l => l > currentPrice * 1.003)[0] || null;
        const liqAbove   = liquidityZones.buyLiq.filter(l => l > currentPrice * 1.003)[0] || null;
        const fibResist  = fibLevels ? [fibLevels.fib618, fibLevels.fib786].filter(f => f > currentPrice * 1.003)[0] : null;
        const breakerCeil = breakers.filter(b => b.type==='BEAR_BREAKER' && b.high > currentPrice * 1.003).map(b=>b.high)[0] || null;
        const candidates = [
          swingHigh * 1.002,
          obCeil    ? obCeil * 1.003     : null,
          srAbove   ? srAbove * 1.003    : null,
          liqAbove  ? liqAbove * 1.003   : null,
          fibResist ? fibResist * 1.002  : null,
          breakerCeil ? breakerCeil * 1.003 : null,
          atrSL,
        ].filter(v => v !== null && v > 0 && Math.abs(currentPrice - v) / currentPrice < 0.10);
        return parseFloat(Math.max(...candidates).toFixed(4));
      }
    }

    // [UPGRADED] TP v5 — Liquidity + Fib + Breaker target aware
    // Day-trader optimized: TP1 realistic, TP2 at next liquidity, TP3 at next major SR
    function calcTPv5(isBullish, entry, sl, srLevels, liquidityZones, fibLevels, breakers) {
      const riskAmt = Math.abs(entry - sl);
      // Raw RR targets
      const raw1 = isBullish ? entry + riskAmt * 1.5 : entry - riskAmt * 1.5;
      const raw2 = isBullish ? entry + riskAmt * 2.5 : entry - riskAmt * 2.5;
      const raw3 = isBullish ? entry + riskAmt * 4.0 : entry - riskAmt * 4.0;

      // Structural targets in direction of trade
      const structTargets = isBullish
        ? [
            ...srLevels.filter(l => l > entry * 1.003),
            ...liquidityZones.buyLiq.filter(l => l > entry * 1.003),    // buy-side liq = natural target
            ...breakers.filter(b=>b.type==='BEAR_BREAKER'&&b.low>entry*1.003).map(b=>b.low),
            ...(fibLevels ? [fibLevels.fib236, fibLevels.fib382].filter(f=>f>entry*1.003) : []),
          ].sort((a,b) => a - b)
        : [
            ...srLevels.filter(l => l < entry * 0.997),
            ...liquidityZones.sellLiq.filter(l => l < entry * 0.997),   // sell-side liq = natural target
            ...breakers.filter(b=>b.type==='BULL_BREAKER'&&b.high<entry*0.997).map(b=>b.high),
            ...(fibLevels ? [fibLevels.fib236, fibLevels.fib382].filter(f=>f<entry*0.997) : []),
          ].sort((a,b) => b - a);

      // Snap TP to nearest structural target if within 2% of raw RR
      const snap = (raw, targets) => {
        for (const t of targets) {
          if (Math.abs(t - raw) / raw < 0.02) {
            const adjusted = isBullish ? t * 0.997 : t * 1.003; // just before the level
            if (isBullish && adjusted > entry) return parseFloat(adjusted.toFixed(4));
            if (!isBullish && adjusted < entry) return parseFloat(adjusted.toFixed(4));
          }
        }
        return parseFloat(raw.toFixed(4));
      };

      const tp1 = snap(raw1, structTargets);
      const tp2 = snap(raw2, structTargets);
      const tp3 = snap(raw3, structTargets);

      // Ensure TP1 < TP2 < TP3 (LONG) or TP1 > TP2 > TP3 (SHORT)
      const ordered = isBullish
        ? [tp1, tp2, tp3].sort((a, b) => a - b)
        : [tp1, tp2, tp3].sort((a, b) => b - a);

      // Ensure all TPs are on correct side of entry
      const valid = ordered.filter(t => isBullish ? t > entry : t < entry);
      if (valid.length === 0) return {
        tp1: parseFloat(raw1.toFixed(4)),
        tp2: parseFloat(raw2.toFixed(4)),
        tp3: parseFloat(raw3.toFixed(4))
      };
      return {
        tp1: valid[0] || parseFloat(raw1.toFixed(4)),
        tp2: valid[1] || parseFloat(raw2.toFixed(4)),
        tp3: valid[2] || parseFloat(raw3.toFixed(4)),
      };
    }

    // [5] ADX(14) — Wilder smoothed
    function calcADX(klines, period=14) {
      if (klines.length<period+5) return 15;
      const trs=[],pDMs=[],mDMs=[];
      for (let i=1;i<klines.length;i++) {
        const h=parseFloat(klines[i][2]),l=parseFloat(klines[i][3]);
        const ph=parseFloat(klines[i-1][2]),pl=parseFloat(klines[i-1][3]),pc=parseFloat(klines[i-1][4]);
        trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
        const up=h-ph,dn=pl-l;
        pDMs.push(up>dn&&up>0?up:0);
        mDMs.push(dn>up&&dn>0?dn:0);
      }
      const ws=(arr,p)=>{let s=arr.slice(0,p).reduce((a,b)=>a+b,0);const o=[s];for(let i=p;i<arr.length;i++){s=s-s/p+arr[i];o.push(s);}return o;};
      const sTR=ws(trs,period),sPDM=ws(pDMs,period),sMDM=ws(mDMs,period);
      const dxs=sTR.map((tr,i)=>{if(tr===0)return 0;const pd=100*sPDM[i]/tr,md=100*sMDM[i]/tr,de=pd+md;return de===0?0:100*Math.abs(pd-md)/de;});
      return dxs.slice(-period).reduce((a,b)=>a+b,0)/period;
    }

    function calcEMA(closes,n) {
      const k=2/(n+1);let v=closes.slice(0,n).reduce((a,b)=>a+b,0)/n;
      for (let i=n;i<closes.length;i++) v=closes[i]*k+v*(1-k);return v;
    }
    function calcEMAArr(closes,n) {
      const k=2/(n+1);let v=closes.slice(0,n).reduce((a,b)=>a+b,0)/n;const o=[v];
      for (let i=n;i<closes.length;i++){v=closes[i]*k+v*(1-k);o.push(v);}return o;
    }

    function calcRSI(closes,period=14) {
      let g=0,l=0;
      for (let i=1;i<=period;i++){const d=closes[i]-closes[i-1];d>=0?g+=d:l-=d;}
      let ag=g/period,al=l/period;
      for (let i=period+1;i<closes.length;i++){
        const d=closes[i]-closes[i-1];
        ag=(ag*(period-1)+(d>0?d:0))/period;al=(al*(period-1)+(d<0?-d:0))/period;
      }
      return al===0?100:parseFloat((100-100/(1+ag/al)).toFixed(2));
    }
    function calcRSIArr(closes,period=14,count=10) {
      const r=[];
      for (let o=count-1;o>=0;o--) r.push(calcRSI(closes.slice(0,closes.length-o),period));
      return r;
    }

    // [F11] Stochastic RSI
    function calcStochRSI(closes,rsiPeriod=14,stochPeriod=14,kSmooth=3,dSmooth=3) {
      const rsiArr=calcRSIArr(closes,rsiPeriod,rsiPeriod+stochPeriod+kSmooth+dSmooth+5);
      const stochK=[];
      for (let i=stochPeriod;i<rsiArr.length;i++) {
        const slice=rsiArr.slice(i-stochPeriod,i);
        const lo=Math.min(...slice),hi=Math.max(...slice);
        stochK.push(hi===lo?50:(rsiArr[i]-lo)/(hi-lo)*100);
      }
      const smooth=(arr,n)=>{const o=[];for(let i=n-1;i<arr.length;i++)o.push(arr.slice(i-n+1,i+1).reduce((a,b)=>a+b,0)/n);return o;};
      const k=smooth(stochK,kSmooth);
      const d=smooth(k,dSmooth);
      return { k:parseFloat((k[k.length-1]||50).toFixed(2)), d:parseFloat((d[d.length-1]||50).toFixed(2)) };
    }

    function calcMACD(closes) {
      const e12=calcEMAArr(closes,12),e26=calcEMAArr(closes,26);
      const ml=e12.slice(e12.length-e26.length).map((v,i)=>v-e26[i]);
      const s9=calcEMAArr(ml,9);
      const prevH2=ml.length>=2&&s9.length>=2?ml[ml.length-2]-s9[s9.length-2]:0;
      return { macd:ml[ml.length-1], signal:s9[s9.length-1],
        histogram:ml[ml.length-1]-s9[s9.length-1],
        prevHistogram:prevH2 };
    }

    function calcBB(closes,period=20) {
      const sl=closes.slice(-period),mid=sl.reduce((a,b)=>a+b,0)/period;
      const std=Math.sqrt(sl.reduce((a,c)=>a+Math.pow(c-mid,2),0)/period);
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

    // [F1] BOS/CHoCH — close-based confirmation (no fake wick BOS)
    function detectStructure(closes,highs,lows) {
      const len=closes.length;
      const rH=highs.slice(-20),rL=lows.slice(-20);
      // Use closes[-1] for BOS, not wick high/low
      const prevHigh=Math.max(...rH.slice(0,15));
      const prevLow =Math.min(...rL.slice(0,15));
      const lastClose=closes[len-1];
      const lastHigh =highs[len-1];
      const lastLow  =lows[len-1];
      // BOS: close must break above/below, not just wick
      if (lastClose>prevHigh) return 'BOS_BULLISH';
      if (lastClose<prevLow)  return 'BOS_BEARISH';
      // CHoCH: price breaks opposing structure midpoint
      // Use independent range — older candles (10-18) not overlapping BOS range (0-15)
      const rH2=highs.slice(-30),rL2=lows.slice(-30);
      const midHigh=Math.max(...rH2.slice(15,25));  // older highs zone
      const midLow =Math.min(...rL2.slice(15,25));  // older lows zone
      if (lastClose>midHigh&&lastClose<prevHigh) return 'CHOCH_BULLISH';
      if (lastClose<midLow &&lastClose>prevLow)  return 'CHOCH_BEARISH';
      // Wick-based secondary BOS (weaker signal — close must be ≥99.8% of level)
      if (lastHigh>prevHigh&&lastClose>prevHigh*0.998) return 'BOS_BULLISH';
      if (lastLow<prevLow  &&lastClose<prevLow *1.002) return 'BOS_BEARISH';
      return 'NEUTRAL';
    }

    // [F5-fix] RSI Divergence — proper swing pivot comparison
    // Compare first half vs second half of 10-candle window
    function detectDivergence(closes,rsiArr) {
      if (closes.length<10||rsiArr.length<10) return 'NONE';
      const pSlice=closes.slice(-10);
      const rSlice=rsiArr.slice(-10);
      // Split into two halves for swing comparison
      const half=Math.floor(pSlice.length/2);
      // First half: "previous" swing
      const prevPriceHigh=Math.max(...pSlice.slice(0,half));
      const prevPriceLow =Math.min(...pSlice.slice(0,half));
      const prevRSIHigh  =Math.max(...rSlice.slice(0,half));
      const prevRSILow   =Math.min(...rSlice.slice(0,half));
      // Second half: "current" swing
      const currPriceHigh=Math.max(...pSlice.slice(half));
      const currPriceLow =Math.min(...pSlice.slice(half));
      const currRSIHigh  =Math.max(...rSlice.slice(half));
      const currRSILow   =Math.min(...rSlice.slice(half));
      // Regular Bullish: price lower low, RSI higher low
      if (currPriceLow<prevPriceLow&&currRSILow>prevRSILow) return 'BULLISH_DIV';
      // Regular Bearish: price higher high, RSI lower high
      if (currPriceHigh>prevPriceHigh&&currRSIHigh<prevRSIHigh) return 'BEARISH_DIV';
      // Hidden Bullish: price higher low (uptrend), RSI lower low
      if (currPriceLow>prevPriceLow&&currRSILow<prevRSILow) return 'HIDDEN_BULLISH';
      // Hidden Bearish: price lower high (downtrend), RSI higher high
      if (currPriceHigh<prevPriceHigh&&currRSIHigh>prevRSIHigh) return 'HIDDEN_BEARISH';
      return 'NONE';
    }

    // [F4-fix] FVG — Unmitigated only, O(n) performance with forward min/max tracking
    function detectFVG(klines, currentP) {
      if (klines.length < 3) return [];
      // Pre-compute forward min lows and max highs from each index onwards (O(n))
      const n = klines.length;
      const fwdMinLow  = new Array(n).fill(Infinity);
      const fwdMaxHigh = new Array(n).fill(-Infinity);
      fwdMinLow[n-1]  = parseFloat(klines[n-1][3]);
      fwdMaxHigh[n-1] = parseFloat(klines[n-1][2]);
      for (let j = n-2; j >= 0; j--) {
        fwdMinLow[j]  = Math.min(parseFloat(klines[j][3]), fwdMinLow[j+1]);
        fwdMaxHigh[j] = Math.max(parseFloat(klines[j][2]), fwdMaxHigh[j+1]);
      }
      const fvgs = [];
      for (let i = 2; i < n - 1; i++) {
        const pH = parseFloat(klines[i-2][2]);  // candle[i-2] high
        const pL = parseFloat(klines[i-2][3]);  // candle[i-2] low
        const cH = parseFloat(klines[i][2]);    // candle[i] high
        const cL = parseFloat(klines[i][3]);    // candle[i] low
        // Bull FVG: gap between candle[i-2] high and candle[i] low
        if (cL > pH) {
          const mitigated = fwdMinLow[i+1] <= cL; // O(1) lookup
          if (!mitigated) fvgs.push({ type:'BULL', high:cL, low:pH });
        }
        // Bear FVG: gap between candle[i] high and candle[i-2] low
        if (cH < pL) {
          const mitigated = fwdMaxHigh[i+1] >= cH; // O(1) lookup
          if (!mitigated) fvgs.push({ type:'BEAR', high:pL, low:cH });
        }
      }
      return fvgs.slice(-3);
    }

    function detectVolumeSpike(volumes) {
      const avg=volumes.slice(-21,-1).reduce((a,b)=>a+b,0)/20;
      const last=volumes[volumes.length-1];
      return {ratio:parseFloat((last/avg).toFixed(2)),spike:last>avg*1.5};
    }

    function findSRLevels(highs, lows) {
      const all = [...highs.slice(-50), ...lows.slice(-50)].sort((a, b) => a - b);
      const clusters = [];
      let i = 0;
      while (i < all.length) {
        const base = all[i];
        const cl = all.filter(v => Math.abs(v - base) / base < 0.005);
        if (cl.length >= 2) {
          const avg = parseFloat((cl.reduce((a,b) => a+b, 0) / cl.length).toFixed(4));
          // Only add if not already close to an existing cluster
          const isDup = clusters.some(c => Math.abs(c - avg) / avg < 0.005);
          if (!isDup) clusters.push(avg);
        }
        i += Math.max(1, cl.length);
      }
      return clusters.slice(-8);
    }

    // [8] OB — Explosive Move + Mitigation Validated
    function findOrderBlock(klines) {
      for (let i=klines.length-5;i>=Math.max(0,klines.length-40);i--) {
        if (i+1>=klines.length) continue;
        const op=parseFloat(klines[i][1]),cl=parseFloat(klines[i][4]);
        const hi=parseFloat(klines[i][2]),lo=parseFloat(klines[i][3]);
        const body=Math.abs(cl-op),range=hi-lo;
        if (range===0||body/range<=0.6) continue;
        const nO=parseFloat(klines[i+1][1]),nC=parseFloat(klines[i+1][4]);
        if (Math.abs(nC-nO)<body*1.5) continue;
        const isBull=cl>op;
        const subL=klines.slice(i+2).map(k=>parseFloat(k[3]));
        const subH=klines.slice(i+2).map(k=>parseFloat(k[2]));
        if (isBull&&subL.length>0&&Math.min(...subL)<lo) continue;
        if (!isBull&&subH.length>0&&Math.max(...subH)>hi) continue;
        return {high:hi,low:lo,open:op,close:cl,type:isBull?'BULL_OB':'BEAR_OB',explosive:true};
      }
      return null;
    }


    // [F12] CVD Proxy — volume-weighted bull/bear pressure
    function calcCVDProxy(klines,lookback=20) {
      let bullVol=0,bearVol=0;
      const slice=klines.slice(-lookback);
      for (const k of slice) {
        const o=parseFloat(k[1]),c=parseFloat(k[4]),v=parseFloat(k[5]);
        if (c>o) bullVol+=v; else bearVol+=v;
      }
      const total=bullVol+bearVol;
      return {
        bullPct:total>0?parseFloat((bullVol/total*100).toFixed(1)):50,
        bearPct:total>0?parseFloat((bearVol/total*100).toFixed(1)):50,
        bias:bullVol>bearVol*1.2?'BULL':bearVol>bullVol*1.2?'BEAR':'NEUTRAL'
      };
    }

    // [9][F7] Structure-aware SL — 15 candle lookback
    function calcStructureSL(isBullish,currentPrice,atr4h,h4OB,highs4h,lows4h,srLevels) {
      const atrSL=isBullish?currentPrice-atr4h*1.5:currentPrice+atr4h*1.5;
      if (isBullish) {
        // [F7] Extended lookback: 15 candles
        const swingLow=Math.min(...lows4h.slice(-15));
        const obFloor=(h4OB&&h4OB.type==='BULL_OB')?h4OB.low:null;
        // Find nearest SR below current price as additional reference
        const srBelow=srLevels.filter(l=>l<currentPrice*0.998).pop()||null;
        let structSL=swingLow*0.998;
        if (obFloor!==null&&obFloor<currentPrice&&obFloor<structSL) structSL=obFloor*0.998;
        if (srBelow&&srBelow<structSL) structSL=srBelow*0.997;
        // Pick the one furthest from price (most protected) but not more than 8% away
        const candidates=[atrSL,structSL].filter(v=>v>0&&Math.abs(currentPrice-v)/currentPrice<0.08);
        return parseFloat((candidates.length>0?Math.min(...candidates):atrSL).toFixed(4));
      } else {
        const swingHigh=Math.max(...highs4h.slice(-15));
        const obCeil=(h4OB&&h4OB.type==='BEAR_OB')?h4OB.high:null;
        const srAbove=srLevels.filter(l=>l>currentPrice*1.002)[0]||null;
        let structSL=swingHigh*1.002;
        if (obCeil!==null&&obCeil>currentPrice&&obCeil>structSL) structSL=obCeil*1.002;
        if (srAbove&&srAbove>structSL) structSL=srAbove*1.003;
        const candidates=[atrSL,structSL].filter(v=>v>0&&Math.abs(currentPrice-v)/currentPrice<0.08);
        return parseFloat((candidates.length>0?Math.max(...candidates):atrSL).toFixed(4));
      }
    }

    // [F10-fix] SR-aware TP with entry validation
    function calcSRAwareTP(isBullish,entry,riskAmt,srLevels,ratio) {
      const raw=isBullish?entry+riskAmt*ratio:entry-riskAmt*ratio;
      let adjusted=raw;
      // Adjust if raw TP lands inside an SR cluster (±0.3%)
      for (const sr of srLevels) {
        if (Math.abs(adjusted-sr)/sr<0.003) {
          adjusted=isBullish?sr*0.997:sr*1.003;
          break;
        }
      }
      // Safety: TP must always be on correct side of entry
      if (isBullish&&adjusted<=entry) adjusted=raw;   // revert to raw if adjusted wrong
      if (!isBullish&&adjusted>=entry) adjusted=raw;
      return parseFloat(adjusted.toFixed(4));
    }

    // [F2-fix] Direction-aware entry zone with minimum width guarantee
    function calcEntryZone(isBullish,currentPrice,atr1h,atr15m) {
      // Use smaller ATR but guarantee minimum width of 0.2% of price
      const atrBuffer=Math.max(Math.min(atr1h,atr15m*3), currentPrice*0.002);
      if (isBullish) {
        // LONG: pullback zone below current price
        return {
          entryLow:  parseFloat((currentPrice-atrBuffer*0.6).toFixed(4)),
          entryHigh: parseFloat((currentPrice-atrBuffer*0.1).toFixed(4))
        };
      } else {
        // SHORT: push zone above current price
        return {
          entryLow:  parseFloat((currentPrice+atrBuffer*0.1).toFixed(4)),
          entryHigh: parseFloat((currentPrice+atrBuffer*0.6).toFixed(4))
        };
      }
    }

    // ===========================================================
    //  FETCH DATA
    // ===========================================================
    const [rawK1d,rawK4h,rawK1h,rawK15m,rawBtcK1d,rawBtcK4h,fundingRaw,oiRaw,livePrice,oiChange]=await Promise.all([
      fetchKlinesCached(pair,'1d',200),
      fetchKlinesCached(pair,'4h',200),
      fetchKlinesCached(pair,'1h',200),
      fetchKlinesCached(pair,'15m',200),
      fetchKlinesCached('BTCUSDT','1d',200),
      fetchKlinesCached('BTCUSDT','4h',100),
      fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${pair}&limit=1`).then(r=>r.json()).catch(()=>[]),
      fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${pair}`).then(r=>r.json()).catch(()=>({})),
      getLivePrice(pair),
      getOIChange(pair),  // [NEW] OI change direction
    ]);

    // [4] Exclude forming candle  [3] Sanitize outliers
    const k1d   = sanitizeCandles(rawK1d.slice(0,-1));
    const k4h   = sanitizeCandles(rawK4h.slice(0,-1));
    const k1h   = sanitizeCandles(rawK1h.slice(0,-1));
    const k15m  = sanitizeCandles(rawK15m.slice(0,-1));
    const btcK1d= sanitizeCandles(rawBtcK1d.slice(0,-1));
    const btcK4h= sanitizeCandles(rawBtcK4h.slice(0,-1));

    function pk(klines){return{opens:klines.map(k=>parseFloat(k[1])),highs:klines.map(k=>parseFloat(k[2])),lows:klines.map(k=>parseFloat(k[3])),closes:klines.map(k=>parseFloat(k[4])),volumes:klines.map(k=>parseFloat(k[5]))};}

    const d1=pk(k1d),h4=pk(k4h),h1=pk(k1h),m15=pk(k15m);
    const btc1d=pk(btcK1d),btc4h=pk(btcK4h);

    // [F3] Use live price; fallback to last completed 1H close
    const currentPrice = livePrice || h1.closes[h1.closes.length-1];

    // ===========================================================
    //  LEVEL 1 — MACRO
    // ===========================================================
    const btcEma20=calcEMA(btc1d.closes,20),btcEma50=calcEMA(btc1d.closes,50),btcEma200=calcEMA(btc1d.closes,200);
    const btcClose1d=btc1d.closes[btc1d.closes.length-1];
    const btcTrend1d=btcClose1d>btcEma20&&btcEma20>btcEma50&&btcEma50>btcEma200?'STRONG_BULL':
      btcClose1d>btcEma50?'BULL':btcClose1d<btcEma200?'STRONG_BEAR':'BEAR';
    // [F8] BTC 4H structure
    const btcStruct4h=detectStructure(btc4h.closes,btc4h.highs,btc4h.lows);
    // [F8-fix] BTC 4H pullback in strong 1D trend = still BULL/BEAR (not reversal)
    // 1D trend is the anchor — 4H only upgrades to STRONG or confirms, never overrides
    const btcTrend=(()=>{
      const bullish1d=btcTrend1d==='STRONG_BULL'||btcTrend1d==='BULL';
      const bearish1d=btcTrend1d==='STRONG_BEAR'||btcTrend1d==='BEAR';
      const h4Bull=['BOS_BULLISH','CHOCH_BULLISH'].includes(btcStruct4h);
      const h4Bear=['BOS_BEARISH','CHOCH_BEARISH'].includes(btcStruct4h);
      // STRONG only when both 1D and 4H agree
      if (btcTrend1d==='STRONG_BULL'&&h4Bull) return 'STRONG_BULL';
      if (btcTrend1d==='STRONG_BEAR'&&h4Bear) return 'STRONG_BEAR';
      // 1D STRONG + 4H pullback = still strong (pullback not reversal)
      if (btcTrend1d==='STRONG_BULL'&&!h4Bear) return 'STRONG_BULL';
      if (btcTrend1d==='STRONG_BEAR'&&!h4Bull) return 'STRONG_BEAR';
      // 1D BULL + 4H confirms
      if (bullish1d&&h4Bull) return 'BULL';
      if (bearish1d&&h4Bear) return 'BEAR';
      // 1D BULL + 4H bearish = pullback, stay with 1D
      return btcTrend1d;
    })();

    const fundingRate=fundingRaw[0]?.fundingRate?parseFloat(fundingRaw[0].fundingRate)*100:0;
    const fundingBias=fundingRate>0.05?'LONGS_PAYING':fundingRate<-0.01?'SHORTS_PAYING':'NEUTRAL';
    const openInterest=oiRaw?.openInterest?parseFloat(oiRaw.openInterest):null;

    // ===========================================================
    //  LEVEL 2 — HTF STRUCTURE
    // ===========================================================
    const d1Ema20=calcEMA(d1.closes,20),d1Ema50=calcEMA(d1.closes,50),d1Ema200=calcEMA(d1.closes,200);
    const d1Struct=detectStructure(d1.closes,d1.highs,d1.lows);
    const d1SR=findSRLevels(d1.highs,d1.lows),d1OB=findOrderBlock(k1d);

    const h4Ema20=calcEMA(h4.closes,20),h4Ema50=calcEMA(h4.closes,50),h4Ema200=calcEMA(h4.closes,200);
    const h4Struct=detectStructure(h4.closes,h4.highs,h4.lows);
    const h4SR=findSRLevels(h4.highs,h4.lows),h4OB=findOrderBlock(k4h);
    const h4FVGs=detectFVG(k4h,currentPrice);
    const h4RSIArr=calcRSIArr(h4.closes,14,10),h4RSI=h4RSIArr[h4RSIArr.length-1];
    const h4Div=detectDivergence(h4.closes,h4RSIArr);
    const prevDayHigh=Math.max(...h4.highs.slice(-6)),prevDayLow=Math.min(...h4.lows.slice(-6));
    const allSR=[...new Set([...d1SR,...h4SR])].sort((a,b)=>a-b);

    // [NEW] Phase 1+2 HTF additions
    const h4Liq      = findLiquidityZones(h4.highs, h4.lows);
    const d1Liq      = findLiquidityZones(d1.highs, d1.lows, 0.004);
    const allLiq     = { buyLiq:[...new Set([...h4Liq.buyLiq,...d1Liq.buyLiq])].slice(-5), sellLiq:[...new Set([...h4Liq.sellLiq,...d1Liq.sellLiq])].slice(-5) };
    const h4PD       = calcPremiumDiscount(h4.highs, h4.lows, currentPrice, 30);
    const d1PD       = calcPremiumDiscount(d1.highs, d1.lows, currentPrice, 20);
    const h4Breakers = findBreakerBlock(k4h);
    const d1Breakers = findBreakerBlock(k1d);
    const allBreakers= [...h4Breakers, ...d1Breakers];

    // ===========================================================
    //  LEVEL 3 — MOMENTUM (1H)
    // ===========================================================
    const h1Ema20=calcEMA(h1.closes,20),h1Ema50=calcEMA(h1.closes,50),h1Ema200=calcEMA(h1.closes,200);
    const h1Struct=detectStructure(h1.closes,h1.highs,h1.lows);
    const h1RSIArr=calcRSIArr(h1.closes,14,10),h1RSI=h1RSIArr[h1RSIArr.length-1];
    const h1Div=detectDivergence(h1.closes,h1RSIArr);
    const h1MACD=calcMACD(h1.closes),h1BB=calcBB(h1.closes);
    const h1Vol=detectVolumeSpike(h1.volumes);
    const h1FVGs=detectFVG(k1h,currentPrice);
    const h1StochRSI=calcStochRSI(h1.closes);     // [F11]
    const h1CVD=calcCVDProxy(k1h,20);             // [F12]
    const adx1h=calcADX(k1h,14),adx4h=calcADX(k4h,14);
    const marketCondition=adx1h>=25?'TRENDING':adx1h>=20?'WEAK_TREND':'CHOPPY';
    const isChoppy=adx1h<20&&adx4h<25;

    // [NEW] VWAP
    const vwap1h = calcVWAP(k1h.slice(-24));
    const vwap4h = calcVWAP(k4h.slice(-42));
    const vwapBias = vwap1h ? (currentPrice > vwap1h ? 'ABOVE_VWAP' : 'BELOW_VWAP') : 'UNKNOWN';

    // [NEW] Session context
    const sessionCtx = getSessionContext(k1h);

    // ===========================================================
    //  LEVEL 4 — ENTRY TIMING (15m)
    // ===========================================================
    const m15Ema20=calcEMA(m15.closes,20),m15Ema50=calcEMA(m15.closes,50);
    const m15Struct=detectStructure(m15.closes,m15.highs,m15.lows);
    const m15RSIArr=calcRSIArr(m15.closes,14,10),m15RSI=m15RSIArr[m15RSIArr.length-1];
    const m15Div=detectDivergence(m15.closes,m15RSIArr);
    const m15MACD=calcMACD(m15.closes),m15Vol=detectVolumeSpike(m15.volumes);
    const m15FVGs=detectFVG(k15m,currentPrice);
    const m15Candle=detectCandlePattern(k15m);    // [UPGRADED] now returns {pattern,strength,bullish}
    const m15StochRSI=calcStochRSI(m15.closes);   // [F11]
    const m15CVD=calcCVDProxy(k15m,20);            // [F12]

    // ===========================================================
    //  LEVEL 5 — TRADE SETUP (Net Scoring)
    // ===========================================================
    const atr4h=calcATR(k4h,14);
    const atr1h=calcATR(k1h,14);
    const atr15m=calcATR(k15m,14);   // [F9]

    // Preliminary direction for fib calculation (use 4H+1H structure)
    const prelimBull = ['BOS_BULLISH','CHOCH_BULLISH'].includes(h4Struct) || ['BOS_BULLISH','CHOCH_BULLISH'].includes(h1Struct);
    // [NEW] Fibonacci levels
    const h4Fib   = calcFibLevels(h4.highs, h4.lows, prelimBull, 60);
    const nearFib = nearestFib(h4Fib, currentPrice);

    // [6][7] Net Scoring — Weighted Direction
    let bullScore=0,bearScore=0;

    // BTC macro (weight 3/2)
    if (btcTrend==='STRONG_BULL') bullScore+=3; else if (btcTrend==='BULL') bullScore+=2;
    else if (btcTrend==='STRONG_BEAR') bearScore+=3; else if (btcTrend==='BEAR') bearScore+=2;

    // Daily structure (weight 2)
    if (d1Struct==='BOS_BULLISH'||d1Struct==='CHOCH_BULLISH') bullScore+=2;
    else if (d1Struct==='BOS_BEARISH'||d1Struct==='CHOCH_BEARISH') bearScore+=2;

    // 4H structure (weight 2)
    if (h4Struct==='BOS_BULLISH'||h4Struct==='CHOCH_BULLISH') bullScore+=2;
    else if (h4Struct==='BOS_BEARISH'||h4Struct==='CHOCH_BEARISH') bearScore+=2;

    // Funding rate (weight 1)
    if (fundingBias==='SHORTS_PAYING') bullScore+=1; else if (fundingBias==='LONGS_PAYING') bearScore+=1;

    // 1H RSI extreme — standard 30/70 thresholds (was too strict at 35/65)
    if (h1RSI<30) bullScore+=1; else if (h1RSI>70) bearScore+=1;

    // 1H StochRSI crossover (weight 1)
    if (h1StochRSI.k<20&&h1StochRSI.k>h1StochRSI.d) bullScore+=1;
    else if (h1StochRSI.k>80&&h1StochRSI.k<h1StochRSI.d) bearScore+=1;

    // 1H MACD fresh cross (weight 1)
    const h1MacdFreshCross=(h1MACD.histogram>0)!==(h1MACD.prevHistogram>0);
    if (h1MacdFreshCross){h1MACD.histogram>0?bullScore+=1:bearScore+=1;}

    // 1H Bollinger Bands — price position scoring (weight 1)
    if (currentPrice<=h1BB.lower*1.001) bullScore+=1;       // price at/below lower band
    else if (currentPrice>=h1BB.upper*0.999) bearScore+=1;  // price at/above upper band

    // RSI Divergence (weight 1)
    if (h4Div==='BULLISH_DIV'||h1Div==='BULLISH_DIV') bullScore+=1;
    else if (h4Div==='BEARISH_DIV'||h1Div==='BEARISH_DIV') bearScore+=1;

    // 15m structure (weight 1)
    if (m15Struct==='BOS_BULLISH'||m15Struct==='CHOCH_BULLISH') bullScore+=1;
    else if (m15Struct==='BOS_BEARISH'||m15Struct==='CHOCH_BEARISH') bearScore+=1;

    // Volume spike — standalone + CVD refined (weight 1)
    if (m15Vol.spike) {
      // Volume spike alone gives 0.5 weight, CVD confirmation raises to 1
      if (m15CVD.bias==='BULL') bullScore+=1;
      else if (m15CVD.bias==='BEAR') bearScore+=1;
      else {
        // Volume spike without CVD — use MACD direction as tiebreaker
        if (m15MACD.histogram>0) bullScore+=1;
        else bearScore+=1;
      }
    }

    // H4 Order Block proximity — price near valid OB (weight 1)
    if (h4OB) {
      const obMid=(h4OB.high+h4OB.low)/2;
      const distPct=Math.abs(currentPrice-obMid)/currentPrice;
      if (distPct<0.015) {
        if (h4OB.type==='BULL_OB') bullScore+=1;
        else bearScore+=1;
      }
    }

    // [NEW] OI change direction — confirms or warns (weight 1)
    if (oiChange.change === 'INCREASING') {
      // OI increasing + price direction = new money entering
      if (h4Struct.includes('BULLISH') || h1Struct.includes('BULLISH')) bullScore += 1;
      else bearScore += 1;
    } else if (oiChange.change === 'DECREASING') {
      // OI decreasing = positions closing, trend may exhaust
      // No score — signal quality reduced
    }

    // [NEW] VWAP position (weight 1)
    if (vwap1h) {
      if (currentPrice > vwap1h * 1.002) bullScore += 1;  // above VWAP = bullish bias
      else if (currentPrice < vwap1h * 0.998) bearScore += 1;
    }

    // [NEW] Premium/Discount zone scoring (weight 1)
    // Best LONG entry = Discount zone, Best SHORT entry = Premium zone
    if (h4PD.zone === 'DISCOUNT' || h4PD.zone === 'LOWER_EQ') bullScore += 1;
    else if (h4PD.zone === 'PREMIUM' || h4PD.zone === 'UPPER_EQ') bearScore += 1;

    // [NEW] Fibonacci golden zone proximity (618/786) (weight 1)
    if (nearFib && nearFib.withinZone && (nearFib.level === 'fib618' || nearFib.level === 'fib786')) {
      if (prelimBull) bullScore += 1;  // price at fib support in uptrend
      else bearScore += 1;             // price at fib resistance in downtrend
    }

    // [NEW] Candle pattern scoring — strength-weighted (weight 1-2)
    if (m15Candle.strength >= 2 && m15Candle.bullish !== null) {
      if (m15Candle.bullish) bullScore += m15Candle.strength === 3 ? 2 : 1;
      else bearScore += m15Candle.strength === 3 ? 2 : 1;
    }

    // [NEW] Breaker Block proximity — price near breaker zone (weight 1)
    for (const b of allBreakers) {
      const bMid = (b.high + b.low) / 2;
      if (Math.abs(currentPrice - bMid) / currentPrice < 0.01) {
        if (b.type === 'BULL_BREAKER') bullScore += 1;  // price at support breaker
        else bearScore += 1;                             // price at resistance breaker
        break;
      }
    }

    // [NEW] Liquidity proximity — price near equal highs/lows (weight 1)
    // Price sweeping sell-side liq below = bullish reversal incoming
    const nearSellLiq = allLiq.sellLiq.some(l => Math.abs(currentPrice - l) / currentPrice < 0.005);
    const nearBuyLiq  = allLiq.buyLiq.some(l => Math.abs(currentPrice - l) / currentPrice < 0.005);
    if (nearSellLiq) bullScore += 1;  // sweeping lows = likely bullish reversal
    if (nearBuyLiq)  bearScore += 1;  // sweeping highs = likely bearish reversal

    const netScore=bullScore-bearScore;
    const isBullish=netScore>0;
    // Max possible bullScore ≈ 22 (3+2+2+1+1+1+1+1+1+1+1+1+1+1+2+1+1) → normalize to 0-10
    const score=Math.max(0,Math.min(10,Math.round((netScore+22)/4.4)));

    // [10] HTF/LTF Conflict
    const htfBull=['BOS_BULLISH','CHOCH_BULLISH'].includes(d1Struct)||['BOS_BULLISH','CHOCH_BULLISH'].includes(h4Struct);
    const htfBear=['BOS_BEARISH','CHOCH_BEARISH'].includes(d1Struct)||['BOS_BEARISH','CHOCH_BEARISH'].includes(h4Struct);
    const ltfBull=['BOS_BULLISH','CHOCH_BULLISH'].includes(h1Struct)||['BOS_BULLISH','CHOCH_BULLISH'].includes(m15Struct);
    const ltfBear=['BOS_BEARISH','CHOCH_BEARISH'].includes(h1Struct)||['BOS_BEARISH','CHOCH_BEARISH'].includes(m15Struct);
    const conflictDetected=(htfBull&&ltfBear)||(htfBear&&ltfBull);
    const conflictType=conflictDetected?(htfBull&&ltfBear?'HTF_BULL_LTF_BEAR':'HTF_BEAR_LTF_BULL'):'NONE';
    const adjustedNetScore=conflictDetected?Math.round(netScore*0.5):netScore;

    // [F2] Direction-aware entry zone
    const {entryLow,entryHigh}=calcEntryZone(isBullish,currentPrice,atr1h,atr15m);

    // [v5] Structure SL — Liquidity + Fib + Breaker aware
    const sl=calcStructureSLv5(isBullish,currentPrice,atr4h,h4OB,h4.highs,h4.lows,allSR,allLiq,h4Fib,allBreakers);
    const riskAmt=Math.abs(currentPrice-sl);

    // [v5] TP — Liquidity + Fib + Breaker target aware, day-trader optimized
    const {tp1,tp2,tp3}=calcTPv5(isBullish,currentPrice,sl,allSR,allLiq,h4Fib,allBreakers);

    // [14] Signal freshness
    const signalTs=Date.now();
    const entryValid=isBullish
      ?(currentPrice>=entryLow&&currentPrice<=entryHigh)||(currentPrice>entryHigh&&currentPrice<entryHigh*1.005)
      :(currentPrice>=entryLow&&currentPrice<=entryHigh)||(currentPrice<entryLow&&currentPrice>entryLow*0.995);

    // ===========================================================
    //  GROQ PROMPT
    // ===========================================================
    const GROQ_KEY=process.env.GROQ_API_KEY;
    if (!GROQ_KEY) return res.status(500).json({ success:false, error:'AI key not configured' });

    const conflictNote=conflictDetected
      ?`⚠️ CONFLICT (${conflictType}): HTF and LTF structures opposing — wait for alignment before entry.`
      :'No structural conflict detected.';
    const choppyNote=isChoppy
      ?`⚠️ CHOPPY MARKET: ADX 1H=${adx1h.toFixed(1)}, 4H=${adx4h.toFixed(1)}. Oscillator signals unreliable.`
      :`Trending market: ADX 1H=${adx1h.toFixed(1)}, 4H=${adx4h.toFixed(1)}.`;

    const riskPct = parseFloat((Math.abs(currentPrice-sl)/currentPrice*100).toFixed(2));
    const rrTp1   = riskAmt > 0 ? parseFloat((Math.abs(tp1-currentPrice)/riskAmt).toFixed(2)) : 0;
    const rrTp2   = riskAmt > 0 ? parseFloat((Math.abs(tp2-currentPrice)/riskAmt).toFixed(2)) : 0;
    const rrTp3   = riskAmt > 0 ? parseFloat((Math.abs(tp3-currentPrice)/riskAmt).toFixed(2)) : 0;

    const prompt=`You are a professional crypto futures analyst. Analyze this REAL data for ${pair} and respond ONLY in the exact JSON below. No markdown, no extra text.

LIVE PRICE: $${currentPrice}
SCORE: Bull ${bullScore} vs Bear ${bearScore} → Net ${adjustedNetScore>0?'+':''}${adjustedNetScore} | ${score}/10
${conflictNote}
${choppyNote}

=== LEVEL 1: MACRO ===
BTC 1D: ${btcTrend1d} | 4H: ${btcStruct4h} | Combined: ${btcTrend}
BTC Price: $${btcClose1d.toFixed(2)} | EMA20:${btcEma20.toFixed(0)} EMA50:${btcEma50.toFixed(0)} EMA200:${btcEma200.toFixed(0)}
Funding: ${fundingRate.toFixed(4)}% (${fundingBias}) | OI: ${openInterest?openInterest.toFixed(0):'N/A'} | OI Change: ${oiChange.change} (${oiChange.pct}%)

=== LEVEL 2: HTF STRUCTURE ===
Daily: ${d1Struct} | EMA20:${d1Ema20.toFixed(2)} EMA50:${d1Ema50.toFixed(2)} EMA200:${d1Ema200.toFixed(2)}
Daily SR: ${d1SR.join(', ')} | OB: ${d1OB?`${d1OB.type} H:${d1OB.high.toFixed(2)} L:${d1OB.low.toFixed(2)}`:'None'}
4H: ${h4Struct} | EMA20:${h4Ema20.toFixed(2)} EMA50:${h4Ema50.toFixed(2)} EMA200:${h4Ema200.toFixed(2)}
4H RSI:${h4RSI} Div:${h4Div} | SR: ${h4SR.join(', ')}
4H OB: ${h4OB?`${h4OB.type} H:${h4OB.high.toFixed(2)} L:${h4OB.low.toFixed(2)}`:'None'}
4H FVG: ${JSON.stringify(h4FVGs)} | PrevDay H:${prevDayHigh.toFixed(2)} L:${prevDayLow.toFixed(2)}
Buy-side Liq: ${allLiq.buyLiq.join(', ')||'None'} | Sell-side Liq: ${allLiq.sellLiq.join(', ')||'None'}
Breakers: ${allBreakers.length>0?allBreakers.map(b=>`${b.type} H:${b.high.toFixed(2)} L:${b.low.toFixed(2)}`).join(' | '):'None'}
Premium/Discount 4H: ${h4PD.zone} (${h4PD.pct}%) | Daily: ${d1PD.zone} (${d1PD.pct}%)
Fibonacci: ${h4Fib?`618:${h4Fib.fib618} 786:${h4Fib.fib786} SwHi:${h4Fib.swingHigh} SwLo:${h4Fib.swingLow}`:'N/A'}
Nearest Fib: ${nearFib?`${nearFib.level} @ ${nearFib.price} (${nearFib.distPct}% away${nearFib.withinZone?' IN ZONE':''})`: 'N/A'}

=== LEVEL 3: MOMENTUM 1H ===
Structure: ${h1Struct} | EMA20:${h1Ema20.toFixed(2)} EMA50:${h1Ema50.toFixed(2)} EMA200:${h1Ema200.toFixed(2)}
RSI:${h1RSI} Div:${h1Div} | StochRSI K:${h1StochRSI.k} D:${h1StochRSI.d}
MACD:${h1MACD.macd.toFixed(4)} Sig:${h1MACD.signal.toFixed(4)} Hist:${h1MACD.histogram.toFixed(4)} FreshCross:${h1MacdFreshCross}
BB Upper:${h1BB.upper.toFixed(2)} Mid:${h1BB.middle.toFixed(2)} Lower:${h1BB.lower.toFixed(2)}
Volume:${h1Vol.spike} (${h1Vol.ratio}x) | CVD:${h1CVD.bias} Bull:${h1CVD.bullPct}% Bear:${h1CVD.bearPct}%
VWAP 1H:${vwap1h?vwap1h.toFixed(2):'N/A'} (${vwapBias}) | VWAP 4H:${vwap4h?vwap4h.toFixed(2):'N/A'}
ADX:${adx1h.toFixed(1)} (${marketCondition}) | 1H FVG: ${JSON.stringify(h1FVGs)}
Session: ${sessionCtx.current} | Asia:${sessionCtx.asia?`${sessionCtx.asia.high.toFixed(2)}/${sessionCtx.asia.low.toFixed(2)}`:'N/A'} London:${sessionCtx.london?`${sessionCtx.london.high.toFixed(2)}/${sessionCtx.london.low.toFixed(2)}`:'N/A'} NY:${sessionCtx.ny?`${sessionCtx.ny.high.toFixed(2)}/${sessionCtx.ny.low.toFixed(2)}`:'N/A'}

=== LEVEL 4: ENTRY TIMING 15m ===
Structure: ${m15Struct} | EMA20:${m15Ema20.toFixed(2)} EMA50:${m15Ema50.toFixed(2)}
RSI:${m15RSI} Div:${m15Div} | StochRSI K:${m15StochRSI.k} D:${m15StochRSI.d}
MACD Hist:${m15MACD.histogram.toFixed(4)} FreshCross:${(m15MACD.histogram>0)!==(m15MACD.prevHistogram>0)}
Candle: ${m15Candle.pattern} (strength:${m15Candle.strength}/3${m15Candle.bullish!==null?','+(m15Candle.bullish?'BULL':'BEAR'):''})
Volume:${m15Vol.spike} (${m15Vol.ratio}x) | CVD:${m15CVD.bias} | 15m FVG: ${JSON.stringify(m15FVGs)}
ATR 4H:${atr4h.toFixed(4)} 1H:${atr1h.toFixed(4)} 15m:${atr15m.toFixed(4)}

=== LEVEL 5: TRADE SETUP ===
Direction: ${isBullish?'LONG':'SHORT'} | Bull:${bullScore} Bear:${bearScore} Net:${adjustedNetScore}
Entry Zone (${isBullish?'pullback':'push'}): $${entryLow}–$${entryHigh}
Stop Loss: $${sl} | Risk: ${riskPct}%
TP1:$${tp1} (RR:${rrTp1}) | TP2:$${tp2} (RR:${rrTp2}) | TP3:$${tp3} (RR:${rrTp3})
Zone quality: ${h4PD.zone} — ${h4PD.zone==='DISCOUNT'&&isBullish?'IDEAL LONG':h4PD.zone==='PREMIUM'&&!isBullish?'IDEAL SHORT':'SUBOPTIMAL'}
Conflict:${conflictType} | Market:${marketCondition} | Score:${score}/10

Respond ONLY in this JSON (no markdown):
{"overallBias":"LONG or SHORT or NEUTRAL","confluenceScore":${score},"netScore":${adjustedNetScore},"grade":"S or A or B or C or D","conflictWarning":"${conflictType}","marketCondition":"${marketCondition}","level1":{"btcTrend":"one sentence","fundingSignal":"one sentence","oiChange":"interpret OI change — new money or closing?","macroConclusion":"BULLISH or BEARISH or NEUTRAL"},"level2":{"dailyStructure":"one sentence","h4Structure":"one sentence","keyLevels":"key SR levels to watch","orderBlock":"OB analysis","breakerBlocks":"breaker block analysis if any","fvgZones":"FVG analysis","liquidityZones":"buy/sell liquidity targets — where price may hunt","fibonacci":"fib zone analysis — is price at golden zone 618/786?","premiumDiscount":"zone quality for this trade direction","structureConclusion":"BULLISH or BEARISH or NEUTRAL"},"level3":{"h1Structure":"one sentence","rsiSignal":"RSI+StochRSI combined","divergence":"divergence type and meaning","macdSignal":"one sentence","bollingerSignal":"one sentence","vwapSignal":"VWAP position analysis","volumeCVD":"volume+CVD analysis","sessionContext":"current session risk and key session levels","adxSignal":"trend strength","momentumConclusion":"STRONG_BULL or BULL or NEUTRAL or BEAR or STRONG_BEAR"},"level4":{"m15Structure":"one sentence","entryTiming":"RSI+StochRSI+candle combined","candleAnalysis":"${m15Candle.pattern} pattern significance","macdCross":"one sentence","volumeConfirm":"volume+CVD","fvgEntry":"nearest FVG entry zone","entryConclusion":"CONFIRMED or WAIT or AVOID"},"level5":{"direction":"${isBullish?'LONG':'SHORT'}","entryZone":"$${entryLow}–$${entryHigh}","stopLoss":"$${sl}","slLogic":"why this SL is safe — structure+liq below/above","tp1":"$${tp1} (RR:${rrTp1})","tp2":"$${tp2} (RR:${rrTp2})","tp3":"$${tp3} (RR:${rrTp3})","tpLogic":"TP targets reasoning — liq/fib/SR levels used","invalidationLevel":"exact price that invalidates setup","leverage":"specific range e.g. 3-5x","positionSize":"1-2% account risk sizing guidance","tradeManagement":"SL to BE plan + trail + partial close","reEntry":"conditions for valid re-entry if stopped","riskNote":"full risk — conflict, session trap, liquidity hunt, news"},"summary":"2-3 sentence day-trader summary","warning":"specific risks this setup faces"}`;

    const groqRes=await fetch('https://api.groq.com/openai/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${GROQ_KEY}`},
      body:JSON.stringify({model:'llama-3.3-70b-versatile',temperature:0.15,max_tokens:2000,messages:[{role:'user',content:prompt}]}),
    });
    if (!groqRes.ok) return res.status(502).json({ success:false, error:`AI error: ${await groqRes.text()}` });
    const groqData=await groqRes.json();
    const rawText=groqData.choices?.[0]?.message?.content||'';
    if (!rawText) return res.status(502).json({ success:false, error:'AI empty response' });
    let analysis;
    try{analysis=JSON.parse(rawText.replace(/```json|```/g,'').trim());}
    catch(e){return res.status(500).json({success:false,error:'AI parse failed',raw:rawText});}

    // [13] State tracking + trend_flip broadcast
    const currentBias=isBullish?'LONG':'SHORT';
    const prevState=analysisState.get(pair);
    if (prevState&&prevState.bias!==currentBias) {
      broadcastToAll({type:'trend_flip',coin:pair,from:prevState.bias,to:currentBias,score:adjustedNetScore,ts:signalTs});
      console.log(`🔄 Trend flip: ${pair} ${prevState.bias}→${currentBias}`);
    }
    analysisState.set(pair,{bias:currentBias,score:adjustedNetScore,ts:signalTs});

    res.json({
      success:true, coin:pair, price:currentPrice,
      // [F6] Full scoring breakdown
      confluenceScore:score, bullScore, bearScore, netScore:adjustedNetScore,
      marketCondition, adx1h:parseFloat(adx1h.toFixed(1)), adx4h:parseFloat(adx4h.toFixed(1)), isChoppy,
      conflictDetected, conflictType,
      signalTs, entryValid,
      rawData:{
        btcTrend,btcTrend1d,btcStruct4h,
        fundingRate,fundingBias,openInterest,
        d1Struct,h4Struct,h1Struct,m15Struct,
        h4RSI,h1RSI,m15RSI,
        h4Div,h1Div,m15Div,
        h1MACD,m15MACD,
        h1BB,h1Vol,m15Vol,
        h1StochRSI,m15StochRSI,
        h1CVD,m15CVD,
        m15Candle,atr4h,atr1h,atr15m,
        entryLow,entryHigh,sl,tp1,tp2,tp3,
        riskPct:parseFloat((Math.abs(currentPrice-sl)/currentPrice*100).toFixed(2)),
        h1Ema20,h1Ema50,h1Ema200,
        h4Ema20,h4Ema50,h4Ema200,
        d1Ema20,d1Ema50,d1Ema200,
        h4SR,d1SR,allSR,
        h4FVGs,h1FVGs,m15FVGs,
        h4OB,d1OB,
        prevDayHigh,prevDayLow,
      },
      analysis,
    });

  } catch(err) {
    console.error('/api/deep-analysis error:',err.message);
    res.status(500).json({ success:false, error:err.message });
  }
});

// ── Catch-all ─────────────────────────────────────────────────
app.get('*',(req,res)=>{
  const safe=path.basename(req.path.replace('/','') || 'index.html');
  res.sendFile(path.join(__dirname,safe),err=>{if(err)res.sendFile(path.join(__dirname,'index.html'));});
});

// ============================================================
//  WebSocket + Server
// ============================================================
const server=http.createServer(app);
const wss=new WebSocket.Server({server});

function broadcastToAll(data){
  const msg=JSON.stringify(data);
  wss.clients.forEach(c=>{if(c.readyState===WebSocket.OPEN){try{c.send(msg);}catch(_){}}});
}

const BINANCE_STREAM='wss://fstream.binance.com/stream?streams='+
  ['btcusdt@ticker','ethusdt@ticker','bnbusdt@ticker','solusdt@ticker','xrpusdt@ticker','adausdt@ticker','dogeusdt@ticker','dotusdt@ticker'].join('/');
let binanceWs=null,binanceReconnectTimer=null;

function connectBinance(){
  if(binanceWs){try{binanceWs.terminate();}catch(_){}}
  console.log('🔌 Connecting Binance WS...');
  binanceWs=new WebSocket(BINANCE_STREAM);
  binanceWs.on('open',()=>{console.log('✅ Binance WS connected');if(binanceReconnectTimer){clearTimeout(binanceReconnectTimer);binanceReconnectTimer=null;}});
  binanceWs.on('message',raw=>{try{const d=JSON.parse(raw).data;if(!d)return;broadcastToAll({type:'market_update',ticker:[{symbol:d.s,price:parseFloat(d.c),change:parseFloat(d.P),high:parseFloat(d.h),low:parseFloat(d.l),volume:parseFloat(d.v)}]});}catch(_){}});
  binanceWs.on('close',()=>{console.log('⚠️ Binance WS closed — reconnect 5s');binanceReconnectTimer=setTimeout(connectBinance,5000);});
  binanceWs.on('error',err=>{console.error('Binance WS error:',err.message);try{binanceWs.terminate();}catch(_){}});
}

wss.on('connection',async(ws,req)=>{
  const up=new URLSearchParams(req.url.replace(/^.*\?/,''));
  const wsToken=up.get('token');
  let wsUser=null;
  if(wsToken){try{wsUser=await admin.auth().verifyIdToken(wsToken);}catch(_){}}
  if(wsUser){
    console.log('Auth WS. Total:',wss.clients.size);
    try{
      const dbUser=await User.findOne({uid:wsUser.uid});
      const uPlan=dbUser?dbUser.plan:'free',uRole=dbUser?dbUser.role:'user';
      const pf=uRole==='admin'?{}:{plan:{$in:Object.keys(PLAN_LEVEL).filter(p=>planLevel(p)<=planLevel(uPlan))}};
      const signals=await Signal.find({active:true,...pf}).sort({createdAt:-1}).limit(20);
      ws.send(JSON.stringify({type:'signals_update',signals}));
      const now=new Date();
      const ann=await Announcement.findOne({active:true,showFrom:{$lte:now},$or:[{showUntil:null},{showUntil:{$gte:now}}]}).sort({createdAt:-1});
      if(ann)ws.send(JSON.stringify({type:'announcement',data:ann}));
    }catch(_){}
  }else{
    console.log('Unauth WS. Total:',wss.clients.size);
    try{const now=new Date();const ann=await Announcement.findOne({active:true,showFrom:{$lte:now},$or:[{showUntil:null},{showUntil:{$gte:now}}]}).sort({createdAt:-1});if(ann)ws.send(JSON.stringify({type:'announcement',data:ann}));}catch(_){}
  }
  ws.on('close',()=>console.log('WS disc. Total:',wss.clients.size));
  ws.on('error',()=>{});
});

app.use((req,res,next)=>{if(BLOCKED_STATIC.includes(path.basename(req.path)))return res.status(403).json({success:false,error:'Forbidden'});next();});
app.use(express.static(path.join(__dirname)));

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>{
  console.log(`\n🚀 InvestySignals v4 running on port ${PORT}`);
  connectBinance();
});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('SIGINT', ()=>server.close(()=>process.exit(0)));
