require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_API_KEY;

const PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "AUD/USD",
  "USD/CAD",
  "EUR/GBP"
];

const INTERVAL = "1min";
const OUTPUT_SIZE = 250;
const CACHE_TTL = 45000;
const SCAN_CACHE_TTL = 20000;
const REQUEST_GAP = Number(process.env.REQUEST_GAP_MS || 8000);

// ===== START: PRIVATE USER STATISTICS (ADDITIVE ONLY) =====
// Uses a local JSON file. For persistence across Render restarts/redeploys,
// configure a Render Persistent Disk and set STATS_FILE to its mount path.
const ADMIN_STATS_KEY = process.env.ADMIN_STATS_KEY || "";
const STATS_FILE = process.env.STATS_FILE || path.join(__dirname, "user-stats.json");
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function readStats() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
    if (parsed && parsed.users && parsed.days) return parsed;
  } catch (_) {}
  return { users: {}, days: {} };
}
let userStats = readStats();
let statsWriteTimer = null;
function saveStats() {
  try {
    const dir = path.dirname(STATS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const tempFile = STATS_FILE + ".tmp";
    fs.writeFileSync(tempFile, JSON.stringify(userStats));
    fs.renameSync(tempFile, STATS_FILE);
  } catch (error) {
    console.error("User statistics save failed:", error.message);
  }
}
function todayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}
function getDay(key) {
  if (!userStats.days[key]) {
    userStats.days[key] = { visitors: {}, signalUsers: {}, signals: 0, signalEvents: {} };
  }
  return userStats.days[key];
}
function validClientId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{12,80}$/.test(value);
}
function recordVisit(clientId) {
  const now = Date.now();
  const dayKey = todayKey();
  if (!userStats.users[clientId]) {
    userStats.users[clientId] = { firstSeen: now, lastSeen: now, signalDays: {} };
  }
  userStats.users[clientId].lastSeen = now;
  getDay(dayKey).visitors[clientId] = 1;
  saveStats();
}
function recordSignal(clientId, pair, signal, candleTime) {
  const now = Date.now();
  const dayKey = todayKey();
  if (!userStats.users[clientId]) {
    userStats.users[clientId] = { firstSeen: now, lastSeen: now, signalDays: {} };
  }
  const user = userStats.users[clientId];
  user.lastSeen = now;
  const day = getDay(dayKey);
  day.visitors[clientId] = 1;
  day.signalUsers[clientId] = 1;
  const signalDay = user.signalDays[dayKey] || { count: 0 };
  const eventKey = `${clientId}|${String(pair).slice(0, 20)}|${signal}|${String(candleTime || Math.floor(now / 60000)).slice(0, 40)}`;
  if (!day.signalEvents[eventKey]) {
    day.signalEvents[eventKey] = 1;
    day.signals += 1;
    signalDay.count += 1;
  }
  user.signalDays[dayKey] = signalDay;
  saveStats();
}
function adminAuthorized(req) {
  const supplied = String(req.query.key || req.get("x-admin-key") || "");
  return Boolean(ADMIN_STATS_KEY && supplied && supplied === ADMIN_STATS_KEY);
}

app.post("/api/stats/heartbeat", (req, res) => {
  const clientId = req.get("x-client-id");
  if (!validClientId(clientId)) return res.status(400).json({ success: false });
  recordVisit(clientId);
  res.json({ success: true });
});

app.post("/api/stats/signal", (req, res) => {
  const clientId = req.get("x-client-id");
  const { pair, signal, candleTime } = req.body || {};
  if (!validClientId(clientId) || !PAIRS.includes(pair) || !["BUY", "SELL"].includes(signal)) {
    return res.status(400).json({ success: false });
  }
  recordSignal(clientId, pair, signal, candleTime);
  res.json({ success: true });
});

app.get("/api/admin/stats", (req, res) => {
  if (!adminAuthorized(req)) return res.status(404).json({ success: false });
  res.set("Cache-Control", "no-store");
  const now = Date.now();
  const today = todayKey();
  const users = Object.values(userStats.users);
  const activeUsers = users.filter(u => now - u.lastSeen <= ACTIVE_WINDOW_MS).length;
  const weeklyUsers = users.filter(u => now - u.lastSeen <= WEEK_MS).length;
  const inactiveUsers = users.length - weeklyUsers;
  const daily = Object.entries(userStats.days)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 30)
    .map(([date, d]) => ({
      date,
      visitors: Object.keys(d.visitors || {}).length,
      signalUsers: Object.keys(d.signalUsers || {}).length,
      signals: Number(d.signals || 0)
    }));
  res.json({ success: true, today, totalUsers: users.length, activeUsers, weeklyUsers, inactiveUsers, todayData: daily.find(d => d.date === today) || { visitors: 0, signalUsers: 0, signals: 0 }, daily });
});

app.get("/developer-stats", (req, res) => {
  if (!adminAuthorized(req)) return res.status(404).send("Not Found");
  res.set("Cache-Control", "no-store");
  res.type("html").send(`<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ব্যবহারকারী পরিসংখ্যান</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f4f6fa;color:#172033;font-family:Arial,'Noto Sans Bengali',sans-serif;padding:22px}.wrap{max-width:900px;margin:auto}h1{font-size:24px;margin:0 0 6px}.muted{color:#667085;font-size:13px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:22px 0}.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:18px;box-shadow:0 2px 8px #1018280a}.num{font-size:30px;font-weight:700;margin:9px 0 3px}.label{font-size:13px;color:#667085}.section{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:16px;overflow:auto}table{border-collapse:collapse;width:100%;min-width:520px;margin-top:10px}th,td{text-align:left;padding:11px 9px;border-bottom:1px solid #edf0f4;font-size:13px}th{color:#667085;background:#f8fafc}.top{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}button{border:0;background:#172033;color:white;border-radius:9px;padding:10px 14px;font-weight:600}@media(min-width:650px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
  </style></head><body><main class="wrap"><div class="top"><div><h1>ব্যবহারকারী পরিসংখ্যান</h1><div class="muted">শুধু আপনার জন্য · সময়: বাংলাদেশ</div></div><button onclick="loadStats()">রিফ্রেশ</button></div><section class="grid"><div class="card"><div class="label">এখন সক্রিয়</div><div class="num" id="active">—</div><div class="muted">শেষ ২ মিনিটে ব্যবহার করেছে</div></div><div class="card"><div class="label">আজ সিগন্যাল নেওয়া ইউজার</div><div class="num" id="todayUsers">—</div><div class="muted">আজ অন্তত একটি BUY/SELL পেয়েছে</div></div><div class="card"><div class="label">আজ মোট সিগন্যাল</div><div class="num" id="todaySignals">—</div><div class="muted">একই ক্যান্ডেলের পুনরাবৃত্তি বাদ</div></div><div class="card"><div class="label">গত ৭ দিনে ব্যবহারকারী</div><div class="num" id="weekly">—</div></div><div class="card"><div class="label">নিষ্ক্রিয় পরিচিত ইউজার</div><div class="num" id="inactive">—</div><div class="muted">গত ৭ দিনে আসেনি</div></div><div class="card"><div class="label">মোট আলাদা ব্রাউজার</div><div class="num" id="total">—</div></div></section><section class="section"><div class="top"><strong>দৈনিক ব্যবহার ও সিগন্যাল</strong><span class="muted" id="updated">লোড হচ্ছে…</span></div><table><thead><tr><th>তারিখ</th><th>ভিজিটর</th><th>সিগন্যাল নেওয়া ইউজার</th><th>সিগন্যাল</th></tr></thead><tbody id="rows"><tr><td colspan="4">তথ্য লোড হচ্ছে…</td></tr></tbody></table></section></main><script>
  const key=new URLSearchParams(location.search).get('key')||'';
  async function loadStats(){const r=await fetch('/api/admin/stats?key='+encodeURIComponent(key),{cache:'no-store'});if(!r.ok){document.getElementById('rows').innerHTML='<tr><td colspan="4">অনুমতি পাওয়া যায়নি</td></tr>';return}const d=await r.json();document.getElementById('active').textContent=d.activeUsers;document.getElementById('todayUsers').textContent=d.todayData.signalUsers;document.getElementById('todaySignals').textContent=d.todayData.signals;document.getElementById('weekly').textContent=d.weeklyUsers;document.getElementById('inactive').textContent=d.inactiveUsers;document.getElementById('total').textContent=d.totalUsers;document.getElementById('rows').innerHTML=d.daily.map(x=>'<tr><td>'+x.date+'</td><td>'+x.visitors+'</td><td>'+x.signalUsers+'</td><td>'+x.signals+'</td></tr>').join('')||'<tr><td colspan="4">এখনো কোনো তথ্য নেই</td></tr>';document.getElementById('updated').textContent='আপডেট: '+new Date().toLocaleTimeString('bn-BD');}
  loadStats();setInterval(loadStats,30000);
  </script></body></html>`);
});
// ===== END: PRIVATE USER STATISTICS =====


let lastScan = null;
let lastScanAt = 0;
let activeScanPromise = null;
let lastRequestAt = 0;
let requestQueue = Promise.resolve();

const cache = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isFreshCandles(candles, now = Date.now()) {
  if (!Array.isArray(candles) || candles.length < 60) return false;
  const latest = candles[candles.length - 1];
  return Number.isFinite(latest.time) && (now - (latest.time + 60000) <= 5 * 60000);
}

// -----------------------------
// TWELVE DATA REQUEST
// -----------------------------

function queuedFetch(url) {
  const task = requestQueue.then(async () => {
    const wait = REQUEST_GAP - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);

    lastRequestAt = Date.now();
    let response = await fetch(url);
    let data = await response.json();

    if (response.status === 429 || data.code === 429) {
      await sleep(15000);
      lastRequestAt = Date.now();
      response = await fetch(url);
      data = await response.json();
    }

    if (!response.ok || data.status === "error" || data.code) {
      const error = new Error(
        data.message || `Twelve Data Error: ${response.status}`
      );
      error.status = (data.code === 429 || response.status === 429) ? 429 : response.status;
      throw error;
    }

    return data;
  });

  requestQueue = task.catch(() => {});
  return task;
}

// -----------------------------
// MARKET DATA
// -----------------------------

async function getMarketData(pair, force = false) {
  if (!API_KEY) {
    throw new Error("Twelve Data API Key সেট করা নেই।");
  }

  const now = Date.now();
  const cached = cache.get(pair);

  if (
    !force &&
    cached &&
    (now - cached.time < CACHE_TTL) &&
    isFreshCandles(cached.candles, now)
  ) {
    return cached.candles;
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(pair)}` +
    `&interval=${INTERVAL}` +
    `&outputsize=${OUTPUT_SIZE}` +
    `&timezone=UTC` +
    `&apikey=${encodeURIComponent(API_KEY)}`;

  const data = await queuedFetch(url);

  if (!Array.isArray(data.values)) {
    throw new Error("Twelve Data থেকে ক্যান্ডেল পাওয়া যায়নি।");
  }

  const fetchNow = Date.now();

  const candles = data.values
    .map(item => ({
      time: Date.parse(item.datetime + " UTC"),
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close)
    }))
    .filter(c =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.time + 60000 <= fetchNow
    )
    .sort((a, b) => a.time - b.time);

  if (candles.length < 60) {
    throw new Error("পর্যাপ্ত বন্ধ ক্যান্ডেল পাওয়া যায়নি।");
  }

  if (!isFreshCandles(candles, fetchNow)) {
    throw new Error("মার্কেট ডাটা পুরোনো।");
  }

  cache.set(pair, {
    time: fetchNow,
    candles
  });

  return candles;
}

// -----------------------------
// INDICATORS
// -----------------------------

function calculateEMA(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }
  return ema;
}

function calculateRSI(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let gains = 0;
  let losses = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function calculateMACD(values) {
  if (values.length < 35) return null;
  const macdValues = [];

  for (let i = 25; i < values.length; i++) {
    const slice = values.slice(0, i + 1);
    const shortEMA = calculateEMA(slice, 12);
    const longEMA = calculateEMA(slice, 26);
    macdValues.push(shortEMA - longEMA);
  }

  if (macdValues.length < 9) return null;
  const value = macdValues[macdValues.length - 1];
  const signal = calculateEMA(macdValues, 9);

  return {
    value,
    signal,
    histogram: value - signal
  };
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];

  for (let i = candles.length - period; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    trs.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }

  return trs.reduce((a, b) => a + b, 0) / period;
}

function calculateADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;
  const trs = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const up = c.high - p.high;
    const down = p.low - c.low;

    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);

    trs.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    ));
  }

  const dx = [];

  for (let i = period - 1; i < trs.length; i++) {
    const start = i - period + 1;
    const tr = trs.slice(start, i + 1).reduce((a, b) => a + b, 0);
    const plus = plusDM.slice(start, i + 1).reduce((a, b) => a + b, 0);
    const minus = minusDM.slice(start, i + 1).reduce((a, b) => a + b, 0);

    if (tr === 0) continue;
    const plusDI = 100 * plus / tr;
    const minusDI = 100 * minus / tr;
    const denominator = plusDI + minusDI;
    if (denominator === 0) continue;

    dx.push(100 * Math.abs(plusDI - minusDI) / denominator);
  }

  if (dx.length < period) return null;
  return dx.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// -----------------------------
// FIVE MINUTE TREND
// -----------------------------

function buildFiveMinuteCandles(candles) {
  const groups = new Map();

  for (const candle of candles) {
    const bucket = Math.floor(candle.time / 300000) * 300000;
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(candle);
  }

  const result = [];

  for (const [time, group] of groups) {
    group.sort((a, b) => a.time - b.time);
    if (group.length !== 5) continue;

    let consecutive = true;
    for (let i = 1; i < group.length; i++) {
      if (group[i].time - group[i - 1].time !== 60000) {
        consecutive = false;
        break;
      }
    }
    if (!consecutive) continue;

    result.push({
      time,
      open: group[0].open,
      high: Math.max(...group.map(c => c.high)),
      low: Math.min(...group.map(c => c.low)),
      close: group[4].close
    });
  }

  return result.sort((a, b) => a.time - b.time);
}

// -----------------------------
// MARKET ANALYSIS (BALANCED FAST)
// -----------------------------

function analyzeCandles(pair, candles) {
  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const rsi = calculateRSI(candles);
  const macd = calculateMACD(closes);
  const atr = calculateATR(candles);
  const adx = calculateADX(candles);

  const fiveCandles = buildFiveMinuteCandles(candles);
  const fiveCloses = fiveCandles.map(c => c.close);
  const fiveEMA9 = calculateEMA(fiveCloses, 9);
  const fiveEMA21 = calculateEMA(fiveCloses, 21);

  if (
    ema9 === null || ema21 === null ||
    rsi === null || !macd ||
    atr === null || adx === null
  ) {
    throw new Error("ইন্ডিকেটর হিসাব করার মতো ডাটা নেই।");
  }

  const higherTrendBuy = fiveEMA9 !== null && fiveEMA21 !== null && fiveEMA9 > fiveEMA21;
  const higherTrendSell = fiveEMA9 !== null && fiveEMA21 !== null && fiveEMA9 < fiveEMA21;

  const support = Math.min(...candles.slice(-30).map(c => c.low));
  const resistance = Math.max(...candles.slice(-30).map(c => c.high));

  const emaBuy = ema9 > ema21;
  const emaSell = ema9 < ema21;

  const macdBuy = macd.histogram > 0;
  const macdSell = macd.histogram < 0;

  const candleBuy = last.close > last.open;
  const candleSell = last.close < last.open;

  const buyHasRoom = resistance - last.close > atr * 0.5;
  const sellHasRoom = last.close - support > atr * 0.5;

  let buyScore = 0;
  let sellScore = 0;

  if (emaBuy) buyScore += 2;
  if (emaSell) sellScore += 2;

  if (macdBuy) buyScore += 2;
  if (macdSell) sellScore += 2;

  if (rsi >= 48 && rsi <= 70) buyScore += 1;
  if (rsi >= 30 && rsi <= 52) sellScore += 1;

  if (candleBuy) buyScore += 1;
  if (candleSell) sellScore += 1;

  if (higherTrendBuy) buyScore += 1;
  if (higherTrendSell) sellScore += 1;

  if (adx >= 12) {
    buyScore += 1;
    sellScore += 1;
  }

  if (buyHasRoom) buyScore += 1;
  if (sellHasRoom) sellScore += 1;

  let signal = "WAIT";
  let reason = "এখনো যথেষ্ট শক্তিশালী সেটআপ নেই।";

  if (
    adx >= 12 &&
    buyScore >= 6 &&
    buyScore - sellScore >= 1 &&
    emaBuy &&
    macdBuy &&
    rsi >= 48 &&
    rsi <= 70 &&
    candleBuy &&
    buyHasRoom &&
    (!higherTrendSell)
  ) {
    signal = "BUY";
    reason = "EMA ও MACD ঊর্ধ্বমুখী, RSI অনুকূলে এবং ক্যান্ডেল BUY-এর পক্ষে।";
  } else if (
    adx >= 12 &&
    sellScore >= 6 &&
    sellScore - buyScore >= 1 &&
    emaSell &&
    macdSell &&
    rsi >= 30 &&
    rsi <= 52 &&
    candleSell &&
    sellHasRoom &&
    (!higherTrendBuy)
  ) {
    signal = "SELL";
    reason = "EMA ও MACD নিম্নমুখী, RSI অনুকূলে এবং ক্যান্ডেল SELL-এর পক্ষে।";
  }

  return {
    pair,
    signal,
    reason,
    technicalScore: Math.round((Math.max(buyScore, sellScore) / 9) * 100),
    buyScore,
    sellScore,
    dataStatus: "VALID",
    price: last.close,
    indicators: {
      rsi: Number(rsi.toFixed(2)),
      ema9: Number(ema9.toFixed(6)),
      ema21: Number(ema21.toFixed(6)),
      macd: Number(macd.value.toFixed(6)),
      macdSignal: Number(macd.signal.toFixed(6)),
      macdHistogram: Number(macd.histogram.toFixed(6)),
      adx: Number(adx.toFixed(2)),
      atr: Number(atr.toFixed(6)),
      support: Number(support.toFixed(6)),
      resistance: Number(resistance.toFixed(6)),
      fiveMinuteTrend: higherTrendBuy ? "UP" : higherTrendSell ? "DOWN" : "SIDEWAYS"
    },
    analysisTime: new Date().toISOString(),
    expiry: "1 Minute"
  };
}

async function scanPair(pair) {
  const candles = await getMarketData(pair);
  return analyzeCandles(pair, candles);
}

// Build a pre-close analysis from the current, still-forming 1-minute quote.
// Historical candles remain the completed candles already obtained by /time_series.
function parseProviderTimestamp(value) {
  if (value == null) return NaN;
  if (typeof value === "number" || /^\\d+(\\.\\d+)?$/.test(String(value))) {
    const numeric = Number(value);
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

async function getPreCloseMarketData(pair) {
  const now = Date.now();
  const currentMinuteStart = Math.floor(now / 60000) * 60000;
  const secondsRemaining = (currentMinuteStart + 60000 - now) / 1000;

  if (secondsRemaining > 15 || secondsRemaining <= 0) {
    throw new Error("ক্যান্ডেল শেষ হওয়ার আগের নির্ধারিত সময়সীমা নেই। WAIT করুন।");
  }

  const cached = cache.get(pair);
  if (!cached || !Array.isArray(cached.candles) || cached.candles.length < 60) {
    throw new Error("প্রয়োজনীয় পূর্ববর্তী ক্যান্ডেল ক্যাশে নেই। নতুন তথ্যের অপেক্ষায় WAIT।");
  }

  const history = cached.candles;
  const lastCompleted = history[history.length - 1];
  const historyAge = currentMinuteStart - lastCompleted.time;

  // REST time_series candles can be delayed. Do not bridge a large data gap.
  if (
    !Number.isFinite(lastCompleted.time) ||
    lastCompleted.time >= currentMinuteStart ||
    historyAge > 180000 ||
    historyAge < 60000
  ) {
    throw new Error("Twelve Data-এর পূর্ববর্তী ক্যান্ডেল পুরোনো বা অসম্পূর্ণ। WAIT করুন।");
  }

  const url =
    "https://api.twelvedata.com/quote" +
    `?symbol=${encodeURIComponent(pair)}` +
    `&interval=1min` +
    `&include_ohlc=true` +
    `&timezone=UTC` +
    `&apikey=${encodeURIComponent(API_KEY)}`;

  const quote = await queuedFetch(url);
  const receivedAt = Date.now();
  const liveCandleTime = parseProviderTimestamp(quote.timestamp);
  const lastUpdateAt = parseProviderTimestamp(quote.last_update_at);

  if (!Number.isFinite(liveCandleTime) || liveCandleTime !== currentMinuteStart) {
    throw new Error("Twelve Data-এর লাইভ ক্যান্ডেল বর্তমান মিনিটের নয়। WAIT করুন।");
  }

  // A candle timestamp identifies its opening time, not the freshness of its price.
  if (
    !Number.isFinite(lastUpdateAt) ||
    receivedAt - lastUpdateAt < -5000 ||
    receivedAt - lastUpdateAt > 15000
  ) {
    throw new Error("লাইভ মার্কেট ডেটা আপডেট নেই বা পুরোনো। WAIT করুন।");
  }

  const live = {
    time: liveCandleTime,
    open: Number(quote.open),
    high: Number(quote.high),
    low: Number(quote.low),
    close: Number(quote.close)
  };

  if (
    !Number.isFinite(live.open) ||
    !Number.isFinite(live.high) ||
    !Number.isFinite(live.low) ||
    !Number.isFinite(live.close) ||
    live.high < Math.max(live.open, live.close) ||
    live.low > Math.min(live.open, live.close) ||
    live.high < live.low
  ) {
    throw new Error("লাইভ অসম্পূর্ণ ক্যান্ডেলের OHLC তথ্য সঠিক নয়। WAIT করুন।");
  }

  const finalRemaining = (currentMinuteStart + 60000 - receivedAt) / 1000;
  if (finalRemaining <= 0 || finalRemaining > 15) {
    throw new Error("লাইভ ডেটা নির্ধারিত প্রি-ক্লোজ সময়ের বাইরে এসেছে। WAIT করুন।");
  }

  return {
    candles: [...history.filter(c => c.time < currentMinuteStart), live],
    liveCandleTime,
    lastUpdateAt,
    secondsRemaining: finalRemaining
  };
}

// -----------------------------
// PUBLIC FRONTEND FILES ONLY
// -----------------------------

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/style.css", (req, res) => {
  res.sendFile(path.join(__dirname, "style.css"));
});

app.get("/script.js", (req, res) => {
  res.sendFile(path.join(__dirname, "script.js"));
});

// -----------------------------
// DEVICE ACCESS STATUS
// -----------------------------

app.get("/api/access/status", (req, res) => {
  res.json({ success: true, active: true, unlimited: true });
});

// -----------------------------
// HEALTH
// -----------------------------

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Auto Best Market Signal Engine running",
    twelveDataConfigured: Boolean(API_KEY),
    analysisEngine: "Rule-Based JavaScript",
    aiApiUsed: false,
    pairs: PAIRS,
    timeframe: "1 Minute",
    requestGapMs: REQUEST_GAP
  });
});

// -----------------------------
// SCAN ALL MARKETS
// -----------------------------

app.get("/api/scan", async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      success: false,
      message: "Twelve Data API Key সেট করা নেই।"
    });
  }

  const now = Date.now();
  if (
    !activeScanPromise &&
    lastScan &&
    !lastScan.rateLimited &&
    lastScan.validMarkets > 0 &&
    (now - lastScanAt < SCAN_CACHE_TTL)
  ) {
    return res.json(lastScan);
  }

  try {
    if (!activeScanPromise) {
      activeScanPromise = (async () => {
        const results = [];
        let rateLimited = false;

        for (const pair of PAIRS) {
          try {
            const result = await scanPair(pair);
            results.push(result);
          } catch (error) {
            if (error.status === 429) rateLimited = true;
            results.push({
              pair,
              signal: "WAIT",
              technicalScore: null,
              dataStatus: error.status === 429 ? "RATE_LIMITED" : "ERROR",
              reason: error.message || "মার্কেট বিশ্লেষণ করা যায়নি।"
            });
            if (rateLimited) break;
          }
        }

        const checked = new Set(results.map(r => r.pair));
        for (const pair of PAIRS) {
          if (!checked.has(pair)) {
            results.push({
              pair,
              signal: "WAIT",
              technicalScore: null,
              dataStatus: "NOT_CHECKED",
              reason: "API সীমার কারণে পরীক্ষা করা যায়নি।"
            });
          }
        }

        const validMarkets = results.filter(r => r.dataStatus === "VALID").length;

        const candidates = results
          .filter(r =>
            r.dataStatus === "VALID" &&
            (r.signal === "BUY" || r.signal === "SELL")
          )
          .sort((a, b) =>
            b.technicalScore - a.technicalScore ||
            Math.abs(b.buyScore - b.sellScore) - Math.abs(a.buyScore - a.sellScore) ||
            b.indicators.adx - a.indicators.adx
          );

        const selected = candidates.length ? candidates[0] : null;

        lastScan = {
          success: true,
          selected,
          results,
          validMarkets,
          rateLimited,
          scanTime: new Date().toISOString(),
          message: selected
            ? "সেরা উপযুক্ত সিগন্যাল পাওয়া গেছে।"
            : "এখন উপযুক্ত সেটআপ নেই। WAIT করুন।"
        };
        lastScanAt = Date.now();

        return lastScan;
      })().finally(() => {
        activeScanPromise = null;
      });
    }

    const scanResult = await activeScanPromise;
    res.json(scanResult);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "স্ক্যান ব্যর্থ হয়েছে।"
    });
  }
});

// -----------------------------
// ANALYZE SELECTED MARKET
// -----------------------------

app.get("/api/analyze", async (req, res) => {
  const pair = req.query.pair;

  if (!PAIRS.includes(pair)) {
    return res.status(400).json({
      success: false,
      message: "সঠিক Forex pair নির্বাচন করুন।"
    });
  }

  try {
    if (req.query.mode === "preclose") {
      const liveData = await getPreCloseMarketData(pair);
      const result = analyzeCandles(pair, liveData.candles);
      result.isPartialCandle = true;
      result.candleTime = new Date(liveData.liveCandleTime).toISOString();
      result.dataUpdatedAt = new Date(liveData.lastUpdateAt).toISOString();
      result.secondsUntilCandleClose = Number(liveData.secondsRemaining.toFixed(1));
      result.analysisMode = "PRE_CLOSE_10_SECONDS";
      res.json({ success: true, result });
      return;
    }

    const candles = await getMarketData(pair);
    const result = analyzeCandles(pair, candles);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "বিশ্লেষণ করা যায়নি।"
    });
  }
});

// -----------------------------
// LAST SCAN
// -----------------------------

app.get("/api/last-scan", (req, res) => {
  res.json(lastScan || {
    success: true,
    selected: null,
    results: [],
    message: "এখনো কোনো স্ক্যান করা হয়নি।"
  });
});

// -----------------------------
// START SERVER
// -----------------------------

async function startServer() {
  try {
    app.listen(PORT, () => {
      console.log(`Auto Best Market Signal running on port ${PORT}`);
      console.log("Unlimited public access enabled; no 48-hour access restriction.");
    });
  } catch (error) {
    console.error("Startup blocked:", error.message);
    process.exit(1);
  }
}

startServer();
