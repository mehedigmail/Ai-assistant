const $ = id => document.getElementById(id);

let running = false;
let accessActive = false;
let selectedPair = null;
let countdownTimer = null;
let nextCheckTimer = null;
let requestController = null;
let currentAnalysis = null;

let weakCount = 0;
let errorCount = 0;
let scanBusy = false;

function setStatus(text, color = "yellow") {
  $("statusText").textContent = text;

  const dot = document.querySelector(".status-dot");
  if (dot) {
    dot.style.background =
      color === "green" ? "#20d99a" :
      color === "red" ? "#ff6178" :
      "#ffbd59";
  }
}

function setSignal(signal, subtitle = "") {
  const el = $("signal");
  el.textContent = signal || "WAIT";
  el.className = "signal-value " +
    (signal === "BUY" ? "call" :
     signal === "SELL" ? "put" : "wait");

  $("signalSubtitle").textContent = subtitle;
}

function formatPrice(value, pair) {
  if (value == null || !Number.isFinite(Number(value))) {
    return "--";
  }
  const digits = pair && pair.includes("JPY") ? 3 : 6;
  return Number(value).toFixed(digits);
}

function formatTime(date) {
  return new Date(date).toLocaleTimeString();
}

function showAccessExpiredModal(noteText = "এই ডিভাইসের ৪৮ ঘণ্টার ফ্রি ব্যবহারের সময় শেষ হয়েছে।") {
  accessActive = false;
  stopAnalysis();
  $("startAnalysis").disabled = true;
  $("stopAnalysis").disabled = true;

  const modal = $("accessExpiredModal");
  if (modal) {
    modal.hidden = false;
  }
  document.body.classList.add("access-expired");

  const note = $("accessCheckNote");
  if (note) {
    note.textContent = noteText;
  }

  setStatus("Access expired", "red");
}

function hideAccessExpiredModal() {
  const modal = $("accessExpiredModal");
  if (modal) {
    modal.hidden = true;
  }
  document.body.classList.remove("access-expired");
}

// -----------------------------
// API REQUEST
// -----------------------------

async function apiRequest(url, body = null) {
  const controller = new AbortController();
  requestController = controller;

  const timeout = setTimeout(() => controller.abort(), 180000);

  try {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json"
      },
      credentials: "same-origin",
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {
        success: false,
        message: "সার্ভার থেকে সঠিক তথ্য পাওয়া যায়নি।"
      };
    }

    if (!response.ok || data.success === false) {
      const error = new Error(
        data.message || "সার্ভারের সঙ্গে যোগাযোগ করা যায়নি।"
      );
      error.status = response.status;
      error.code = data.code || null;
      error.data = data;
      throw error;
    }

    return data;
  } finally {
    clearTimeout(timeout);
    if (requestController === controller) {
      requestController = null;
    }
  }
}

// -----------------------------
// SHOW ANALYSIS
// -----------------------------

function showAnalysis(result) {
  if (!result || result.dataStatus !== "VALID") {
    setSignal("WAIT", "যাচাইকৃত বাজারের তথ্য পাওয়া যায়নি");
    $("marketPrice").textContent = "--";
    $("confidence").textContent = "--%";
    $("analysisReason").textContent =
      result?.reason || "বাজারের তথ্য পাওয়া যায়নি।";
    $("priceStatus").textContent = "সঠিক তথ্যের অপেক্ষায়";
    return;
  }

  selectedPair = result.pair;
  currentAnalysis = result;

  $("selectedMarket").textContent = result.pair;
  $("marketPrice").textContent = formatPrice(result.price, result.pair);
  $("priceStatus").textContent = result.isPartialCandle ? "চলমান ক্যান্ডেলের লাইভ দাম (শেষের ১০ সেকেন্ড)" : "শেষ সম্পন্ন ক্যান্ডেলের দাম";

  let subtitle = "বাজার বিশ্লেষণ সম্পন্ন";
  if (result.signal === "BUY") {
    subtitle = "দাম বাড়ার পক্ষে সংকেত";
  } else if (result.signal === "SELL") {
    subtitle = "দাম কমার পক্ষে সংকেত";
  } else {
    subtitle = "এখন ভালো সুযোগ নেই";
  }

  setSignal(result.signal, subtitle);

  $("confidence").textContent =
    result.technicalScore != null ? result.technicalScore + "%" : "--%";
  $("analysisReason").textContent =
    result.reason || "বিশ্লেষণ সম্পন্ন হয়েছে।";
  $("analysisStatus").textContent = "বিশ্লেষণ সফলভাবে সম্পন্ন হয়েছে";
  $("lastAnalysisTime").textContent = formatTime(new Date());
  $("marketSelectionStatus").textContent =
    "স্বয়ংক্রিয়ভাবে নির্বাচিত: " + result.pair;
}

// -----------------------------
// SHOW ERROR & CLEAR
// -----------------------------

function showError(message) {
  setSignal("WAIT", "সংকেত যাচাই করা যায়নি");
  $("analysisReason").textContent = message;
  $("analysisStatus").textContent = "বিশ্লেষণ করা যায়নি";
  $("marketPrice").textContent = "--";
  $("confidence").textContent = "--%";
  $("priceStatus").textContent = "সঠিক তথ্যের অপেক্ষায়";
}

function chooseBestMarket(results) {
  const valid = (results || []).filter(item =>
    item.dataStatus === "VALID" &&
    (item.signal === "BUY" || item.signal === "SELL")
  );
  valid.sort((a, b) =>
    (b.technicalScore || 0) - (a.technicalScore || 0) ||
    Math.abs((b.buyScore || 0) - (b.sellScore || 0)) - Math.abs((a.buyScore || 0) - (a.sellScore || 0)) ||
    ((b.indicators?.adx || 0) - (a.indicators?.adx || 0))
  );
  return valid[0] || null;
}

function clearSelectedMarket(message) {
  selectedPair = null;
  currentAnalysis = null;
  $("selectedMarket").textContent = "কোনো উপযুক্ত মার্কেট নেই";
  $("marketPrice").textContent = "--";
  $("confidence").textContent = "--%";
  $("marketSelectionStatus").textContent = message;
  setSignal("WAIT", "ভালো সুযোগের অপেক্ষা চলছে");
}

// -----------------------------
// SCAN ALL MARKETS
// -----------------------------

async function scanAllMarkets() {
  if (!running || scanBusy) return;
  scanBusy = true;
  weakCount = 0;
  errorCount = 0;

  $("analysisStatus").textContent = "মার্কেট স্ক্যান করা হচ্ছে...";
  $("marketSelectionStatus").textContent = "সেরা সুযোগ খোঁজা হচ্ছে";
  setSignal("WAIT", "ভালো মার্কেট খোঁজা হচ্ছে");
  setStatus("Scanning markets", "yellow");

  try {
    const data = await apiRequest("/api/scan");
    if (!running) return;

    const best = data.selected || chooseBestMarket(data.results);

    if (!best) {
      clearSelectedMarket("সব যোগ্য মার্কেট পরীক্ষা করা হয়েছে");
      const validCount = data.validMarkets || 0;

      $("analysisReason").textContent =
        validCount > 0
          ? "এখন কোনো শক্তিশালী BUY বা SELL সুযোগ নেই। অপেক্ষা করুন।"
          : (data.message || "বাজারের তথ্যের অপেক্ষা করুন।");

      $("analysisStatus").textContent =
        `${validCount} টি যাচাইকৃত মার্কেট পাওয়া গেছে।`;
      $("lastAnalysisTime").textContent = formatTime(new Date());

      setStatus("Waiting for opportunity", "yellow");
      scheduleNextCheck();
      return;
    }

    // The closed-candle scan only selects a market. Never publish its BUY/SELL
    // result; the visible decision must come from the verified pre-close quote.
    showAnalysis({
      ...best,
      signal: "WAIT",
      reason: "ক্যান্ডেল শেষ হওয়ার ১০ সেকেন্ড আগের লাইভ যাচাইয়ের অপেক্ষা চলছে।"
    });
    setStatus("Best market selected", "green");
    $("analysisStatus").textContent = "মার্কেট নির্বাচিত; প্রি-ক্লোজ লাইভ যাচাইয়ের অপেক্ষা চলছে।";
    scheduleNextCheck();
  } catch (error) {
    if (!running) return;

    if (error.status === 403 || error.code === "ACCESS_EXPIRED") {
      showError(error.message);
      showAccessExpiredModal(error.message);
      return;
    }

    showError(error.message);
    setStatus("Connection error", "red");
    scheduleNextCheck();
  } finally {
    scanBusy = false;
  }
}

// -----------------------------
// RECHECK SELECTED MARKET
// -----------------------------

async function recheckSelectedMarket() {
  if (!running) return;

  if (!selectedPair) {
    await scanAllMarkets();
    return;
  }

  const pairToCheck = selectedPair;
  $("analysisStatus").textContent = "নির্বাচিত মার্কেট আবার পরীক্ষা করা হচ্ছে...";

  try {
    const data = await apiRequest(
      "/api/analyze?pair=" + encodeURIComponent(pairToCheck) + "&mode=preclose"
    );

    if (!running || selectedPair !== pairToCheck) return;

    const result = data.result;
    if (!result || result.dataStatus !== "VALID") {
      throw new Error("যাচাইকৃত তথ্য পাওয়া যায়নি।");
    }

    errorCount = 0;
    showAnalysis(result);

    if (result.signal === "BUY" || result.signal === "SELL") {
      weakCount = 0;
      setStatus("Market signal verified", "green");
      $("analysisStatus").textContent = "নির্বাচিত মার্কেটে সংকেত যাচাই হয়েছে";
    } else {
      weakCount++;
      setStatus("Market becoming weak", "yellow");
      $("analysisStatus").textContent = `মার্কেট দুর্বল পাওয়া গেছে (${weakCount}/2)।`;
      $("analysisReason").textContent =
        result.reason + " অন্য মার্কেটের সুযোগও পরীক্ষা করা হবে।";

      if (weakCount >= 2) {
        await scanAllMarkets();
        return;
      }
    }
  } catch (error) {
    if (!running) return;

    if (error.status === 403 || error.code === "ACCESS_EXPIRED") {
      showError(error.message);
      showAccessExpiredModal(error.message);
      return;
    }

    errorCount++;
    weakCount++;

    setSignal("WAIT", "সংকেত যাচাই করা যায়নি");
    $("analysisReason").textContent =
      "নির্বাচিত মার্কেটের নতুন তথ্য পাওয়া যায়নি। আবার পরীক্ষা করা হবে।";
    $("analysisStatus").textContent = "মার্কেট ডাটা যাচাই ব্যর্থ";
    setStatus("Recheck error", "red");

    if (errorCount >= 2 || weakCount >= 2) {
      await scanAllMarkets();
      return;
    }
  }

  if (running) {
    scheduleNextCheck();
  }
}

// -----------------------------
// COUNTDOWN
// -----------------------------

function getSecondsUntilCheck() {
  const now = new Date();
  const target = new Date(now);

  target.setSeconds(50, 0);
  if (target.getTime() - now.getTime() < 2000) {
    target.setMinutes(target.getMinutes() + 1);
  }

  return Math.max(0, target.getTime() - now.getTime());
}

function updateCountdown() {
  if (!running) return;

  const remaining = getSecondsUntilCheck();
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  $("nextSignalCheck").textContent =
    String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0");
}

function scheduleNextCheck() {
  clearInterval(countdownTimer);
  clearTimeout(nextCheckTimer);

  if (!running) return;

  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 250);

  const delay = getSecondsUntilCheck();
  nextCheckTimer = setTimeout(async () => {
    if (!running) return;
    clearInterval(countdownTimer);
    await recheckSelectedMarket();
  }, delay);
}

// -----------------------------
// START & STOP
// -----------------------------

async function startAnalysis() {
  if (running || !accessActive) return;

  running = true;
  weakCount = 0;
  errorCount = 0;

  $("startAnalysis").disabled = true;
  $("stopAnalysis").disabled = false;

  selectedPair = null;
  currentAnalysis = null;

  $("selectedMarket").textContent = "Searching...";
  $("marketPrice").textContent = "--";
  $("confidence").textContent = "--%";

  setSignal("WAIT", "সেরা মার্কেট খোঁজা হচ্ছে");
  $("analysisReason").textContent = "ছয়টি Forex পেয়ার পরীক্ষা করা হচ্ছে...";
  $("analysisStatus").textContent = "মার্কেট স্ক্যান চলছে";

  await scanAllMarkets();
}

function stopAnalysis() {
  running = false;

  clearInterval(countdownTimer);
  clearTimeout(nextCheckTimer);

  if (requestController) {
    requestController.abort();
  }

  $("startAnalysis").disabled = !accessActive;
  $("stopAnalysis").disabled = true;

  $("analysisStatus").textContent = "বিশ্লেষণ বন্ধ করা হয়েছে";
  $("nextSignalCheck").textContent = "--";

  if (accessActive) {
    setStatus("Stopped", "yellow");
  }
}

// -----------------------------
// ACCESS & BACKEND HEALTH
// -----------------------------

async function initializeApp() {
  try {
    const access = await apiRequest("/api/access/status");

    if (!access.active) {
      showAccessExpiredModal("আপনার ৪৮ ঘণ্টার ফ্রি ব্যবহারের সময় শেষ হয়েছে।");
      return;
    }

    accessActive = true;

    // ===== START: DEVELOPER EXTRA GLOBAL LOCK SYSTEM =====
    document.body.classList.remove("developer-global-locked");
    // ===== END: DEVELOPER EXTRA GLOBAL LOCK SYSTEM =====

    hideAccessExpiredModal();

    const health = await apiRequest("/api/health");
    if (health.twelveDataConfigured) {
      setStatus("Backend connected", "green");
      $("startAnalysis").disabled = false;
      $("analysisStatus").textContent = "System ready";
    } else {
      setStatus("API key missing", "red");
      $("startAnalysis").disabled = true;
      $("analysisReason").textContent = "সার্ভারে TWELVE_DATA_API_KEY সেট করা নেই।";
      $("analysisStatus").textContent = "API key অনুপস্থিত";
    }
  } catch (error) {
    accessActive = false;

    // ===== START: DEVELOPER EXTRA GLOBAL LOCK SYSTEM =====
    document.body.classList.remove("developer-global-locked");
    // ===== END: DEVELOPER EXTRA GLOBAL LOCK SYSTEM =====

    hideAccessExpiredModal();
    $("startAnalysis").disabled = true;
    setStatus("Backend disconnected", "red");
    $("analysisReason").textContent =
      error.message || "সার্ভারের সঙ্গে সংযোগ করা যাচ্ছে না।";
    $("analysisStatus").textContent = "সংযোগ ব্যর্থ";
  }
}

$("startAnalysis").addEventListener("click", startAnalysis);
$("stopAnalysis").addEventListener("click", stopAnalysis);
window.addEventListener("beforeunload", () => {
  stopAnalysis();
});

initializeApp();
