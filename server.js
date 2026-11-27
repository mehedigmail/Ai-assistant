require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");

const app = express();

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_API_KEY;

// ===== START: DEVELOPER EXTRA GLOBAL LOCK SYSTEM =====
// true  = show the existing 48-hour expired popup to every visitor.
// false = remove this global lock and return to the normal 48-hour access system.
const GLOBAL_LOCK = true;
// ===== END: DEVELOPER EXTRA GLOBAL LOCK SYSTEM =====

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

// Persistent, password-free device access. Render PostgreSQL is required.
const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
}) : null;

const DEVICE_COOKIE = "rm_device";
const ACCESS_HOURS = 48;
const ACCESS_MS = ACCESS_HOURS * 60 * 60 * 1000;
const COOKIE_MS = 400 * 24 * 60 * 60 * 1000;

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); }
      catch { return null; }
    }
  }
  return null;
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function setDeviceCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie",
    `${DEVICE_COOKIE}=${encodeURIComponent(token)}; Max-Age=${Math.floor(COOKIE_MS / 1000)}; Path=/; HttpOnly; SameSite=Lax${secure}`
  );
}

async function initDatabase() {
  if (!pool) throw new Error("Render PostgreSQL DATABASE_URL সেট করা নেই।");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_access (
      id BIGSERIAL PRIMARY KEY,
      token_hash CHAR(64) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS device_access_expires_idx ON device_access (expires_at)`);
}

async function registerOrReadDevice(req, res) {
  if (!pool) throw new Error("DATABASE_URL_MISSING");
  let token = readCookie(req, DEVICE_COOKIE);
  if (token && token.length >= 40 && token.length <= 200) {
    const found = await pool.query(
      `SELECT id, created_at, expires_at, (expires_at > NOW()) AS active FROM device_access WHERE token_hash=$1`,
      [tokenHash(token)]
    );
    if (found.rows.length) {
      await pool.query(`UPDATE device_access SET last_seen_at=NOW() WHERE id=$1`, [found.rows[0].id]);
      return found.rows[0];
    }
  }

  token = crypto.randomBytes(32).toString("base64url");
  const created = await pool.query(
    `INSERT INTO device_access (token_hash, expires_at) VALUES ($1, NOW() + INTERVAL '48 hours') RETURNING id, created_at, expires_at, TRUE AS active`,
    [tokenHash(token)]
  );
  setDeviceCookie(res, token);
  return created.rows[0];
}

async function requireActiveDevice(req, res, next) {
  try {
    if (!pool) return res.status(503).json({ success: false, code: "DATABASE_REQUIRED", message: "Access database সেটআপ করা হয়নি।" });
    const token = readCookie(req, DEVICE_COOKIE);
    if (!token) return res.status(403).json({ success: false, code: "ACCESS_EXPIRED", message: "এই ডিভাইসের অ্যাক্সেস নেই।" });
    const result = await pool.query(
      `SELECT id, expires_at, (expires_at > NOW()) AS active FROM device_access WHERE token_hash=$1`,
      [tokenHash(token)]
    );
    if (!result.rows.length || !result.rows[0].active) {
      return res.status(403).json({ success: false, code: "ACCESS_EXPIRED", message: "এই ডিভাইসের ৪৮ ঘণ্টার অ্যাক্সেস শেষ হয়েছে।" });
    }
    req.deviceAccess = result.rows[0];
    await pool.query(`UPDATE device_access SET last_seen_at=NOW() WHERE id=$1`, [req.deviceAccess.id]);
    next();
  } catch (error) {
    console.error("Device access check failed:", error.message);
    res.status(503).json({ success: false, code: "ACCESS_CHECK_FAILED", message: "অ্যাক্সেস যাচাই করা যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।" });
  }
}

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

app.get("/api/access/status", async (req, res) => {
  // ===== START: DEVELOPER EXTRA GLOBAL LOCK SYSTEM =====
  if (GLOBAL_LOCK) {
    return res.json({
      success: true,
      active: false,
      globalLocked: true,
      expiresAt: null,
      remainingMs: 0
    });
  }
  // ===== END: DEVELOPER EXTRA GLOBAL LOCK SYSTEM =====

  try {
    const device = await registerOrReadDevice(req, res);
    const expiresAt = new Date(device.expires_at);
    const remainingMs = Math.max(0, expiresAt.getTime() - Date.now());
    res.json({ success: true, active: Boolean(device.active), expiresAt: expiresAt.toISOString(), remainingMs });
  } catch (error) {
    console.error("Access status error:", error.message);
    res.status(503).json({ success: false, code: "DATABASE_REQUIRED", message: "অ্যাক্সেস সিস্টেম চালু করতে Render PostgreSQL DATABASE_URL সেট করুন।" });
  }
});

// ===== START: DEVELOPER EXTRA GLOBAL LOCK SYSTEM =====
// This middleware blocks direct API access as well as normal frontend requests.
app.use("/api", (req, res, next) => {
  if (GLOBAL_LOCK) {
    return res.status(403).json({
      success: false,
      code: "ACCESS_EXPIRED",
      message: "আপনার ৪৮ ঘণ্টার ফ্রি ব্যবহারের সময় শেষ হয়েছে।"
    });
  }
  next();
});
// ===== END: DEVELOPER EXTRA GLOBAL LOCK SYSTEM =====

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

app.get("/api/scan", requireActiveDevice, async (req, res) => {
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

app.get("/api/analyze", requireActiveDevice, async (req, res) => {
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

app.get("/api/last-scan", requireActiveDevice, (req, res) => {
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
    await initDatabase();
    app.listen(PORT, () => {
      console.log(`Auto Best Market Signal running on port ${PORT}`);
      console.log("Device access database connected; 48-hour access enabled.");
    });
  } catch (error) {
    console.error("Startup blocked:", error.message);
    process.exit(1);
  }
}

startServer();
