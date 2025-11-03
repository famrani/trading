// trading-bot.ts
// Bucketed streak strategy with RULE exits (X,Y) + TAKE-AMT exits,
// duplicate-order prevention, RESUME support, startup reconciliation
// (cancel only legacy open orders), periodic position watcher,
// optional Telegram notifications, and colored logs for uPnL.
//
// Changes:
// - Entries use simple consecutive streaks:
//     * LONG entry when downStreak >= x
//     * SHORT entry when upStreak  >= y
// - RULE exits:
//     * LONG exit when upStreak >= y AND profit >= 10 EUR
//     * SHORT exit when downStreak >= y AND profit >= 10 EUR
//   (If allowUnprofitableRuleExit is true, the 10 EUR restriction is ignored)
// - TAKE-AMT exits:
//     * Trigger when PnL >= max(10 EUR, takeAmt)
// - Extra safety: 15s cooldown between ENTRY orders (per process, per symbol).
//
// Example:
//   npx ts-node trading-bot.ts \
//     --symbol AMZN --capital 60000 --multiple 1 --mode long \
//     --x 4 --y 2 --bucketMins 1 --eodClose false \
//     --takeAmt 75 \
//     --tz America/New_York --txDir ./out --account P --clientId 103 \
//     --resetState false --resetRuns false --resetEquity false --allowUnprofitableRuleExit
//
// Dependencies:
//   npm i @stoqey/ib
//
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { IBApi, EventName, ErrorCode, Contract, OrderState } from "@stoqey/ib";

// ---------- CLI ----------
function arg(key: string, def?: string) {
  const i = process.argv.indexOf(`--${key}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function numArg(key: string, def: number) { return Number(arg(key, String(def))); }
function parseBool(s: string | undefined, def: boolean) {
  if (s === undefined) return def;
  const v = s.toLowerCase();
  if (["true", "1", "yes", "y"].includes(v)) return true;
  if (["false", "0", "no", "n"].includes(v)) return false;
  return def;
}

// ---------- Types ----------
type SideMode = "long" | "short";
type TxRecord = {
  symbol: string;
  side: "BUY" | "SELL";
  datetime: string;
  price: number;
  shares: number;
  profit: number;
  profitUSD?: string;
  newCapital: number;
  newCapitalUSD?: string;
  tradeIndex: number;
  reason?: "RULE" | "STOP" | "EOD" | "TAKE";
  day?: string;
};
type TrackedOrder = {
  side: "BUY" | "SELL";
  role: "ENTRY" | "EXIT";
  reason: "RULE" | "STOP" | "EOD" | "TAKE";
  qty: number;
  cumQty: number;
  oca?: string;
};
type BotState = {
  version: number;
  symbol: string;
  mode: SideMode;
  equity: number;
  entryPrice: number;
  shares: number;             // long > 0, short < 0, 0 when flat
  tradeCounter: number;
  takeAmt?: number;
  pendingExitQty: number;
  currentOcaGroup: string;

  params: {
    x: number;
    y: number;
    multiple: number;
    bucketMins: number;
    tickSize: number;
    eodClose: boolean;
    tz: string;
    allowUnprofitableRuleExit: boolean;
  };
};

// ---------- Params ----------
const symbol = (arg("symbol") || "NVDA").toUpperCase();
const capital = numArg("capital", 10000);
const multiple = Math.max(1, Math.min(2, numArg("multiple", 1)));
const mode = (arg("mode", "long")!.toLowerCase() as SideMode); // long|short
const x = numArg("x", 2);
const y = numArg("y", 2);
const bucketMins = Math.max(0.1, numArg("bucketMins", 1));
const takeAmt = arg("takeAmt") ? Number(arg("takeAmt")) : undefined;   // USD target (optional)
const eodClose = parseBool(arg("eodClose"), false); // default false for live bot
const tz = arg("tz", "America/New_York")!;
const txDir = arg("txDir", ".")!;
const tickSize = numArg("tickSize", 0.01);
const allowUnprofitableRuleExit = !!arg("allowUnprofitableRuleExit");

// IB account & client
const accountFlag = (arg("account", "S") || "S").toUpperCase();
const clientId = numArg("clientId", 22);

// Reset flags
const resetState = parseBool(arg("resetState"), false);
const resetRuns  = parseBool(arg("resetRuns"),  false);
const resetEquity= parseBool(arg("resetEquity"),false);

// Telegram (optional)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// Validate
if (!fs.existsSync(txDir)) fs.mkdirSync(txDir, { recursive: true });
if (!(capital > 0)) throw new Error("--capital must be > 0");
if (!(multiple >= 1 && multiple <= 2)) throw new Error("--multiple must be in [1,2]");
if (!["long", "short"].includes(mode)) throw new Error("--mode must be 'long' or 'short'");
if (!(x > 0 && Number.isInteger(x))) throw new Error("--x must be positive integer");
if (!(y > 0 && Number.isInteger(y))) throw new Error("--y must be positive integer");
if (!(tickSize > 0)) throw new Error("--tickSize must be > 0");
if (takeAmt !== undefined && !(takeAmt > 0)) throw new Error("--takeAmt must be > 0");

// ---------- IB Connection ----------
let ibAccount = "DUH673915";
let ibPort = 7497;
switch (accountFlag) {
  case "P": ibAccount = "U7648331"; ibPort = 7496; break;
  case "A": ibAccount = "U7914923"; ibPort = 7496; break;
  case "S": ibAccount = "DUH673915"; ibPort = 7497; break;
  case "F": ibAccount = "U11743275"; ibPort = 7496; break;
  case "I": ibAccount = "U6466931"; ibPort = 7496; break;
}
const ib = new IBApi({ host: "127.0.0.1", port: ibPort, clientId });

// ---------- Files ----------
const stateFile = path.join(txDir, `${symbol}_state.json`);
const txFile = path.join(txDir, `${symbol}_transactions.json`);
const dailyFile = path.join(txDir, `${symbol}_daily_pnl.json`);

// ---------- Live state ----------
let equity = capital;
let inPosition = false;
let entryPrice = 0;
let shares = 0; // long > 0, short < 0
let tradeCounter = 0;

let lastPrice = 0;          // LAST
let bidPrice = 0;           // BID
let askPrice = 0;           // ASK
let prevSamplePrice = 0;    // previous bucket sample
let haveFirstSample = false;

// Streak counters over bucketed samples (consecutive logic)
let downStreak = 0;
let upStreak = 0;

let nextOrderId = -1;
let orderPending = false;
let lastOrderTime = 0;
const ORDER_COOLDOWN_MS = 300;

// Extra: ENTRY cooldown
const ENTRY_COOLDOWN_MS = 15000; // 15 seconds between ENTRY orders
let lastEntryAttemptMs = 0;

let openEntryOrderId: number | null = null; // only one entry working
const openExitOrderIds = new Set<number>(); // possibly multiple exits
let pendingExitQty = 0;                     // shares already covered by working exits
let currentOcaGroup = "";                   // OCA for exits of current position

const orders = new Map<number, TrackedOrder>();

const txLog: TxRecord[] = [];
const dailyAgg = new Map<string, { profit: number; capital: number; lastTs: number }>();

const mktDataTickerId = 9101;

// ---- Position polling buffer ----
let posBuffer: { symbol: string; pos: number; avgCost: number }[] = [];

// ---------- Helpers ----------
const ansi = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  dim: "\x1b[2m",
};
function colorPnL(v: number): string {
  const s = v.toFixed(2);
  return v >= 0 ? `${ansi.green}${s}${ansi.reset}` : `${ansi.red}${s}${ansi.reset}`;
}
function ibStockContract(sym: string): Contract {
  return { symbol: sym, secType: "STK", exchange: "SMART", currency: "USD" } as Contract;
}
function fmtDay(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}
function pad2(n: number) { return String(n).padStart(2, "0"); }
function hhmmss(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? "0");
  return `${pad2(get("hour"))}:${pad2(get("minute"))}:${pad2(get("second"))}`;
}
function usd(n: number): string {
  const s = (Number.isFinite(n) ? n : 0).toFixed(2);
  return `$${s}`;
}
function writeTxAndDaily() {
  try { fs.writeFileSync(txFile, JSON.stringify(txLog, null, 2), "utf8"); } catch { }
  const rows = Array.from(dailyAgg.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, v]) => ({ date, profit: v.profit, profitUSD: usd(v.profit), capital: v.capital, capitalUSD: usd(v.capital) }));
  try { fs.writeFileSync(dailyFile, JSON.stringify(rows, null, 2), "utf8"); } catch { }
}
function saveState() {
  const state: BotState = {
    version: 9,
    symbol,
    mode,
    equity,
    entryPrice,
    shares,
    tradeCounter,
    takeAmt,
    pendingExitQty,
    currentOcaGroup,
    params: { x, y, multiple, bucketMins, tickSize, eodClose, tz, allowUnprofitableRuleExit }
  };
  try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8"); } catch { }
}
function loadStateIfAny() {
  if (!fs.existsSync(stateFile)) return;
  try {
    const s: BotState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (s.symbol !== symbol) return;
    if (s.mode !== mode) {
      console.log(`ℹ️ State file mode (${s.mode}) != current mode (${mode}); keeping current mode.`);
    }
    equity       = (resetEquity ? capital : (s.equity ?? equity));
    entryPrice   = s.entryPrice ?? 0;
    shares       = s.shares ?? 0;
    tradeCounter = s.tradeCounter ?? 0;
    pendingExitQty   = s.pendingExitQty ?? 0;
    currentOcaGroup  = s.currentOcaGroup ?? "";
    inPosition   = shares !== 0;

    if (resetRuns) {
      upStreak = 0; downStreak = 0;
    }

    console.log(`💾 Loaded state: equity=${equity.toFixed(2)} shares=${shares} entry=${(entryPrice || 0).toFixed(4)} inPosition=${inPosition}`);
  } catch (e) {
    console.warn("⚠️ Failed to load state; continuing fresh.", e);
  }
}
function recordFlat(profit: number, price: number, reason: TxRecord["reason"], when: Date) {
  equity += profit;
  const iso = when.toISOString();
  const day = fmtDay(when);
  txLog.push({
    symbol, side: mode === "long" ? "SELL" : "BUY", datetime: iso, price, shares, profit,
    profitUSD: usd(profit),
    newCapital: equity, newCapitalUSD: usd(equity),
    tradeIndex: tradeCounter, reason, day
  });

  const ts = Date.parse(iso);
  const prev = dailyAgg.get(day);
  const newProfit = (prev?.profit ?? 0) + profit;
  const cap = !prev || ts >= prev.lastTs ? equity : prev.capital;
  const lastTs = !prev || ts >= prev.lastTs ? ts : prev.lastTs;
  dailyAgg.set(day, { profit: newProfit, capital: cap, lastTs });

  inPosition = false;
  entryPrice = 0;
  shares = 0;
  pendingExitQty = 0;
  Array.from(openExitOrderIds).forEach((id) => { try { ib.cancelOrder(id); } catch { } });
  openExitOrderIds.clear();
  currentOcaGroup = "";

  upStreak = 0;
  downStreak = 0;

  writeTxAndDaily();
  saveState();
}
function ensureNoFlip() {
  if (mode === "long" && shares < 0) {
    console.error(`🚫 SAFETY: short position detected in LONG mode; forcing state flat.`);
    shares = 0; inPosition = false; pendingExitQty = 0;
    Array.from(openExitOrderIds).forEach((id) => { try { ib.cancelOrder(id); } catch { } });
    openExitOrderIds.clear(); currentOcaGroup = "";
    upStreak = 0; downStreak = 0;
    saveState();
  }
  if (mode === "short" && shares > 0) {
    console.error(`🚫 SAFETY: long position detected in SHORT mode; forcing state flat.`);
    shares = 0; inPosition = false; pendingExitQty = 0;
    Array.from(openExitOrderIds).forEach((id) => { try { ib.cancelOrder(id); } catch { } });
    openExitOrderIds.clear(); currentOcaGroup = "";
    upStreak = 0; downStreak = 0;
    saveState();
  }
}

// LIMIT helpers (prefer Bid/Ask)
function chooseSellLimitForLong(bid: number, entry: number, fallback: number): number {
  const minProfitable = entry + tickSize;
  const base = (bid > 0 ? bid : fallback);
  return Math.max(base, minProfitable);
}
function chooseCoverLimitForShort(ask: number, entry: number, fallback: number): number {
  const minProfitable = entry - tickSize;
  const base = (ask > 0 ? ask : fallback);
  return Math.min(base, minProfitable);
}

// Telegram notify (optional)
function notifyTelegram(text: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const payload = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true });
  const opts: https.RequestOptions = {
    hostname: "api.telegram.org",
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
  };
  const req = https.request(opts, (res) => { res.on("data", () => { }); });
  req.on("error", () => { });
  req.write(payload);
  req.end();
}

// ---------- Timers ----------
function startBucketTimer() {
  const intervalMs = Math.max(1000, Math.round(bucketMins * 60_000));
  console.log(`⏱️  Bucket timer: every ${bucketMins} min(s) (~${Math.round(intervalMs / 1000)}s)`);

  const tick = () => {
    const now = new Date();
    if (lastPrice <= 0) {
      console.log(`[${hhmmss(now)}] ${symbol} (bucket) no price yet; skipping sample`);
      return;
    }

    const sample = lastPrice;
    if (!haveFirstSample) {
      haveFirstSample = true;
      prevSamplePrice = sample;
      console.log(`[${hhmmss(now)}] ${symbol} (bucket) init sample=${sample.toFixed(4)} | mode=${mode} | holding=${inPosition ? shares : 0}`);
      return;
    }

    // Update consecutive streaks
    if (sample < prevSamplePrice) {
      downStreak += 1;
      upStreak = 0;
    } else if (sample > prevSamplePrice) {
      upStreak += 1;
      downStreak = 0;
    } else {
      // equal → reset both (no ongoing streak)
      upStreak = 0;
      downStreak = 0;
    }

    const arrow = sample > prevSamplePrice ? "▲" : sample < prevSamplePrice ? "▼" : "=";
    const uPnL = inPosition ? (sample - entryPrice) * shares : 0;
    const extra = inPosition ? ` | entry=${entryPrice.toFixed(4)} | uPnL=${colorPnL(uPnL)} | pendingExitQty=${pendingExitQty}` : "";
    console.log(
      `[${hhmmss(now)}] ${symbol} (bucket) sampled=${sample.toFixed(4)} ${arrow} (down=${downStreak}, up=${upStreak}) `
      + `| mode=${mode} | holding=${inPosition ? shares : 0}${extra}`
    );

    // RULE EXIT first (act on new sample)
    maybeExitOnSample(sample).catch(() => { });

    // Then ENTRY (only if flat)
    if (!inPosition) {
      maybeEnterOnSample(sample).catch(() => { });
    }

    prevSamplePrice = sample;
  };

  setInterval(tick, intervalMs);
}

// ---------- Duplicate-order prevention ----------
function hasOutstandingOrders(): boolean {
  if (openEntryOrderId !== null) return true;
  if (openExitOrderIds.size > 0) return true;
  const now = Date.now();
  if (orderPending && now - lastOrderTime < ORDER_COOLDOWN_MS) return true;
  return false;
}
function placeOrderSafe(
  contract: Contract,
  order: any,
  side: "BUY" | "SELL",
  role: "ENTRY" | "EXIT",
  reason: TrackedOrder["reason"],
  qty: number,
  oca?: string
): number {
  if (nextOrderId < 0) throw new Error("nextValidId not received yet");
  if (hasOutstandingOrders()) {
    console.log("⏳ Skipping order: outstanding order or cooldown");
    return -1;
  }
  const orderId = nextOrderId++;
  order.orderId = orderId;
  if (oca) { order.ocaGroup = oca; order.ocaType = 1; }

  orders.set(orderId, { side, role, reason, qty, cumQty: 0, oca });

  if (role === "ENTRY") openEntryOrderId = orderId; else openExitOrderIds.add(orderId);

  orderPending = true;
  lastOrderTime = Date.now();
  ib.placeOrder(orderId, contract, order);
  return orderId;
}

// ---------- Strategy (bucket sample decisions) ----------
async function maybeEnterOnSample(samplePrice: number) {
  if (inPosition) return; // cannot enter if position != 0
  if (hasOutstandingOrders()) { console.log("➤ NO ENTRY: outstanding order present"); return; }

  const nowMs = Date.now();
  if (nowMs - lastEntryAttemptMs < ENTRY_COOLDOWN_MS) {
    const msLeft = ENTRY_COOLDOWN_MS - (nowMs - lastEntryAttemptMs);
    console.log(`⏳ ENTRY COOLDOWN: skipping entry, ${Math.ceil(msLeft / 1000)}s remaining`);
    return;
  }

  const positionValue = equity * multiple;
  const qty = Math.floor(positionValue / samplePrice);
  if (qty <= 0) {
    console.log(`➤ NO ENTRY (size=0) | sampled=${samplePrice.toFixed(4)} | equity=${equity} | multiple=${multiple}x`);
    return;
  }

  if (mode === "long") {
    if (downStreak >= x) {
      const order: any = { action: "BUY", totalQuantity: qty, orderType: "LMT", lmtPrice: samplePrice, tif: "DAY", transmit: true };
      const oid = placeOrderSafe(ibStockContract(symbol), order, "BUY", "ENTRY", "RULE", qty);
      if (oid < 0) return;

      lastEntryAttemptMs = nowMs;
      // reset streaks on entry
      upStreak = 0; downStreak = 0;

      console.log(`🟢 BUY LMT ORDER id=${oid} ${qty} ${symbol} @ ${samplePrice.toFixed(4)} | trigger: downStreak>=${x} | equity=${equity.toFixed(2)}`);
      notifyTelegram(`🟢 BUY LMT ${symbol} qty=${qty} @ ${samplePrice.toFixed(2)} | downStreak>=${x}`);
      saveState();
    }
  } else {
    if (upStreak >= y) {
      const order: any = { action: "SELL", totalQuantity: qty, orderType: "LMT", lmtPrice: samplePrice, tif: "DAY", transmit: true };
      const oid = placeOrderSafe(ibStockContract(symbol), order, "SELL", "ENTRY", "RULE", qty);
      if (oid < 0) return;

      lastEntryAttemptMs = nowMs;
      upStreak = 0; downStreak = 0;

      console.log(`🟥 SHORT LMT ORDER id=${oid} ${qty} ${symbol} @ ${samplePrice.toFixed(4)} | trigger: upStreak>=${y} | equity=${equity.toFixed(2)}`);
      notifyTelegram(`🟥 SHORT LMT ${symbol} qty=${qty} @ ${samplePrice.toFixed(2)} | upStreak>=${y}`);
      saveState();
    }
  }
}

async function maybeExitOnSample(samplePrice: number) {
  if (!inPosition) return;
  if (hasOutstandingOrders()) return;

  const pnlNow = (samplePrice - entryPrice) * shares;
  const minProfitEUR = 10; // global minimum profit to allow close

  let shouldExit = false;
  if (mode === "long") {
    if (upStreak >= y) {
      if (allowUnprofitableRuleExit) {
        shouldExit = true;
      } else {
        shouldExit = pnlNow >= minProfitEUR;
      }
    }
  } else {
    if (downStreak >= y) {
      if (allowUnprofitableRuleExit) {
        shouldExit = true;
      } else {
        shouldExit = pnlNow >= minProfitEUR;
      }
    }
  }
  if (!shouldExit) return;

  const qtyToExit = Math.max(0, Math.abs(shares) - pendingExitQty);
  if (qtyToExit <= 0) return;

  if (!currentOcaGroup) currentOcaGroup = `POS_${symbol}_${Date.now()}`;

  if (mode === "long") {
    const lmt = chooseSellLimitForLong(bidPrice, entryPrice, samplePrice);
    const order: any = { action: "SELL", totalQuantity: qtyToExit, orderType: "LMT", lmtPrice: lmt, tif: "DAY", transmit: true, ocaGroup: currentOcaGroup, ocaType: 1 };
    const oid = placeOrderSafe(ibStockContract(symbol), order, "SELL", "EXIT", "RULE", qtyToExit, currentOcaGroup);
    if (oid < 0) return;
    pendingExitQty += qtyToExit;
    console.log(`↘️ RULE SELL LMT id=${oid} ${qtyToExit}/${shares} ${symbol} @ ${lmt.toFixed(4)} | upStreak=${upStreak}≥${y} | uPnL=${colorPnL(pnlNow)} (minProfit=${usd(minProfitEUR)})`);
    notifyTelegram(`↘️ RULE SELL LMT ${symbol} qty=${qtyToExit} @ ${lmt.toFixed(2)} | upStreak=${upStreak} | uPnL=${usd(pnlNow)} (minProfit=${usd(minProfitEUR)})`);
    saveState();
  } else {
    const lmt = chooseCoverLimitForShort(askPrice, entryPrice, samplePrice);
    const order: any = { action: "BUY", totalQuantity: qtyToExit, orderType: "LMT", lmtPrice: lmt, tif: "DAY", transmit: true, ocaGroup: currentOcaGroup, ocaType: 1 };
    const oid = placeOrderSafe(ibStockContract(symbol), order, "BUY", "EXIT", "RULE", qtyToExit, currentOcaGroup);
    if (oid < 0) return;
    pendingExitQty += qtyToExit;
    console.log(`↗️ RULE COVER LMT id=${oid} ${qtyToExit}/${Math.abs(shares)} ${symbol} @ ${lmt.toFixed(4)} | downStreak=${downStreak}≥${y} | uPnL=${colorPnL(pnlNow)} (minProfit=${usd(minProfitEUR)})`);
    notifyTelegram(`↗️ RULE COVER LMT ${symbol} qty=${qtyToExit} @ ${lmt.toFixed(2)} | downStreak=${downStreak} | uPnL=${usd(pnlNow)} (minProfit=${usd(minProfitEUR)})`);
    saveState();
  }
}

// ---------- TAKE-AMT on tick ----------
async function checkTakeOnTick() {
  if (!inPosition) return;
  if (hasOutstandingOrders()) return;
  if (takeAmt === undefined) return;

  const price = lastPrice;
  if (!(price > 0)) return;

  const pnlNow = (price - entryPrice) * shares;

  const minProfitEUR = 10;
  const target = Math.max(minProfitEUR, takeAmt); // must reach both 10 EUR and configured takeAmt

  if (pnlNow < target) return;

  const qtyToExit = Math.max(0, Math.abs(shares) - pendingExitQty);
  if (qtyToExit <= 0) return;

  if (!currentOcaGroup) currentOcaGroup = `POS_${symbol}_${Date.now()}`;

  if (mode === "long") {
    const lmt = chooseSellLimitForLong(bidPrice, entryPrice, price);
    const order: any = { action: "SELL", totalQuantity: qtyToExit, orderType: "LMT", lmtPrice: lmt, tif: "DAY", transmit: true, ocaGroup: currentOcaGroup, ocaType: 1 };
    const oid = placeOrderSafe(ibStockContract(symbol), order, "SELL", "EXIT", "TAKE", qtyToExit, currentOcaGroup);
    if (oid < 0) return;
    pendingExitQty += qtyToExit;
    console.log(`🎯 TAKE SELL LMT id=${oid} ${qtyToExit}/${shares} ${symbol} @ ${lmt.toFixed(4)} | uPnL=${colorPnL(pnlNow)} | target=${usd(target)} (takeAmt=${usd(takeAmt)})`);
    notifyTelegram(`🎯 TAKE SELL LMT ${symbol} qty=${qtyToExit} @ ${lmt.toFixed(2)} | uPnL=${usd(pnlNow)} | target=${usd(target)} (takeAmt=${usd(takeAmt)})`);
    saveState();
  } else {
    const lmt = chooseCoverLimitForShort(askPrice, entryPrice, price);
    const order: any = { action: "BUY", totalQuantity: qtyToExit, orderType: "LMT", lmtPrice: lmt, tif: "DAY", transmit: true, ocaGroup: currentOcaGroup, ocaType: 1 };
    const oid = placeOrderSafe(ibStockContract(symbol), order, "BUY", "EXIT", "TAKE", qtyToExit, currentOcaGroup);
    if (oid < 0) return;
    pendingExitQty += qtyToExit;
    console.log(`🎯 TAKE COVER LMT id=${oid} ${qtyToExit}/${Math.abs(shares)} ${symbol} @ ${lmt.toFixed(4)} | uPnL=${colorPnL(pnlNow)} | target=${usd(target)} (takeAmt=${usd(takeAmt)})`);
    notifyTelegram(`🎯 TAKE COVER LMT ${symbol} qty=${qtyToExit} @ ${lmt.toFixed(2)} | uPnL=${usd(pnlNow)} | target=${usd(target)} (takeAmt=${usd(takeAmt)})`);
    saveState();
  }
}

// ---------- Position polling / reconciliation ----------
function pollPositionsOnce() {
  posBuffer = [];
  ib.reqPositions();
}
function startPositionWatcher(intervalMs = 10_000) {
  setInterval(() => {
    try { pollPositionsOnce(); } catch { }
  }, intervalMs);
  try { pollPositionsOnce(); } catch { }
}

// ---------- main ----------
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function main() {
  // Resets
  if (resetState) {
    try { if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile); } catch { }
    try { if (fs.existsSync(txFile)) fs.unlinkSync(txFile); } catch { }
    try { if (fs.existsSync(dailyFile)) fs.unlinkSync(dailyFile); } catch { }
    console.log("🧹 resetState: cleared state and logs on disk.");
  }

  loadStateIfAny();

  ib.on(EventName.error, (err: Error, code: ErrorCode, reqId: number) => {
    console.error(`❌ IB Error ${err?.message} code=${code} reqId=${reqId}`);
  });

  ib.on(EventName.nextValidId, (oid) => {
    nextOrderId = oid;
    firstLocalOrderIdStart = oid;     // anything >= this is our new order
    console.log(`✅ Connected. nextValidId = ${oid} | mode=${mode.toUpperCase()} (startup reconciliation ON)`);

    // Subscribe mkt data (LAST/BID/ASK)
    ib.reqMktData(mktDataTickerId, ibStockContract(symbol), "", false, false);

    // Reconcile with live world
    beginOpenOrderReconciliation();
    requestPositionsAndAdopt();
    startPositionWatcher(10_000);

    // Start timers
    startBucketTimer();
  });

  // Cancel ONLY legacy open orders (startup reconciliation)
  ib.on(EventName.openOrder, (orderId: number, contract: Contract, _order: any, _orderState: OrderState) => {
    if ((contract?.symbol || "").toUpperCase() !== symbol) return;
    if (!reconcilingOpenOrders) return;
    if (firstLocalOrderIdStart >= 0 && orderId >= firstLocalOrderIdStart) return;
    if (cancelledOnce.has(orderId)) return;

    cancelledOnce.add(orderId);
    try {
      ib.cancelOrder(orderId);
      console.log(`🧹 Cancelled legacy open order id=${orderId} ${symbol}`);
    } catch (e) {
      console.log(`🧹 Cancel attempt failed id=${orderId}:`, e);
    }
  });

  ib.on("openOrderEnd" as any, () => {
    if (reconcilingOpenOrders) {
      reconcilingOpenOrders = false;
      console.log("✅ Open-order reconciliation complete; normal trading resumed.");
    }
  });

  // Positions: gather snapshot rows during poll
  ib.on(EventName.position, (_account, contract, pos, avgCost) => {
    const sym = (contract?.symbol || "").toUpperCase();
    if (sym) posBuffer.push({ symbol: sym, pos, avgCost: Number(avgCost) || 0 });
  });

  // Snapshot end → reconcile
  ib.on("positionEnd" as any, () => {
    const row = posBuffer.find(r => r.symbol === symbol);
    const exchangeSaysPos = row?.pos ?? 0;
    const exchangeAvgCost = row?.avgCost ?? 0;

    if (inPosition && exchangeSaysPos === 0) {
      console.log(`🧹 Detected external flat for ${symbol}. Clearing local state.`);
      Array.from(openExitOrderIds).forEach((id) => { try { ib.cancelOrder(id); } catch { } });
      openExitOrderIds.clear();
      pendingExitQty = 0;
      currentOcaGroup = "";

      inPosition = false;
      shares = 0;
      entryPrice = 0;

      txLog.push({
        symbol,
        side: mode === "long" ? "SELL" : "BUY",
        datetime: new Date().toISOString(),
        price: lastPrice || 0,
        shares: 0,
        profit: 0,
        profitUSD: usd(0),
        newCapital: equity,
        newCapitalUSD: usd(equity),
        tradeIndex: tradeCounter,
        reason: "RULE",
      });

      upStreak = 0; downStreak = 0;
      writeTxAndDaily();
      saveState();
      return;
    }

    if (!inPosition && exchangeSaysPos !== 0) {
      const adoptShares = exchangeSaysPos;
      let ok = true;
      if (mode === "long" && adoptShares < 0) { console.log(`⚠️ Exchange shows SHORT ${adoptShares} but mode=long. Ignoring; staying flat.`); ok = false; }
      if (mode === "short" && adoptShares > 0) { console.log(`⚠️ Exchange shows LONG +${adoptShares} but mode=short. Ignoring; staying flat.`); ok = false; }
      if (ok) {
        inPosition = true;
        shares = adoptShares;
        entryPrice = exchangeAvgCost || entryPrice;
        pendingExitQty = 0;
        openEntryOrderId = null;
        openExitOrderIds.clear();
        currentOcaGroup = `POS_${symbol}_${Date.now()}`;

        console.log(`🧭 Adopted live position from IB: shares=${shares}, entry=${entryPrice.toFixed(4)}`);
        notifyTelegram(`🧭 Adopted ${symbol} position: shares=${shares}, entry=${entryPrice.toFixed(4)}`);
        saveState();
      }
    }

    if (inPosition && exchangeSaysPos !== 0 && exchangeSaysPos !== shares) {
      console.log(`🔄 Position size changed externally for ${symbol}: ${shares} → ${exchangeSaysPos}. Syncing.`);
      shares = exchangeSaysPos;
      if (exchangeAvgCost > 0) entryPrice = exchangeAvgCost;

      pendingExitQty = 0;
      openExitOrderIds.clear();
      currentOcaGroup = `POS_${symbol}_${Date.now()}`;
      saveState();
    }
  });

  // Order status / fills
  ib.on(EventName.orderStatus, (orderId, status, filled, remaining, avgFillPrice) => {
    const meta = orders.get(orderId);
    if (!meta) return;

    if (typeof filled === "number") meta.cumQty = filled;

    if (status === "Cancelled") {
      if (orderId === openEntryOrderId) openEntryOrderId = null;
      if (openExitOrderIds.has(orderId)) openExitOrderIds.delete(orderId);
      if (meta.role === "EXIT") {
        const unfilled = Math.max(0, meta.qty - (meta.cumQty || 0));
        pendingExitQty = Math.max(0, pendingExitQty - unfilled);
      }
      orders.delete(orderId);
      orderPending = false;
      saveState();
      try { pollPositionsOnce(); } catch { }
      return;
    }

    if (status === "Filled" || remaining === 0) {
      if (orderId === openEntryOrderId) openEntryOrderId = null;
      if (openExitOrderIds.has(orderId)) openExitOrderIds.delete(orderId);
      orderPending = false;

      if (meta.role === "ENTRY") {
        tradeCounter += 1;
        inPosition = true;
        entryPrice = avgFillPrice;

        if (mode === "long") {
          shares = meta.qty;
          console.log(`🟢 BUY FILLED id=${orderId} ${shares} ${symbol} @ ${entryPrice.toFixed(4)}`);
          notifyTelegram(`🟢 BUY FILLED ${symbol} qty=${shares} @ ${entryPrice.toFixed(4)}`);
        } else {
          shares = -meta.qty;
          console.log(`🟥 SHORT FILLED id=${orderId} ${meta.qty} ${symbol} @ ${entryPrice.toFixed(4)}`);
          notifyTelegram(`🟥 SHORT FILLED ${symbol} qty=${meta.qty} @ ${entryPrice.toFixed(4)}`);
        }

        pendingExitQty = 0;
        openExitOrderIds.clear();
        currentOcaGroup = `POS_${symbol}_${Date.now()}`;

        upStreak = 0; downStreak = 0;

        txLog.push({
          symbol,
          side: mode === "long" ? "BUY" : "SELL",
          datetime: new Date().toISOString(),
          price: entryPrice,
          shares,
          profit: 0,
          profitUSD: usd(0),
          newCapital: equity,
          newCapitalUSD: usd(equity),
          tradeIndex: tradeCounter,
          reason: meta.reason
        });

        ensureNoFlip();
        saveState();
      } else {
        const exitQty = meta.qty;
        const exitPrice = avgFillPrice;
        pendingExitQty = Math.max(0, pendingExitQty - exitQty);

        let realized = 0;
        if (mode === "long") {
          realized = exitQty * (exitPrice - entryPrice);
          shares -= exitQty;
        } else {
          realized = exitQty * (entryPrice - exitPrice);
          shares += exitQty;
        }

        ensureNoFlip();

        if (shares === 0) {
          recordFlat(realized, exitPrice, meta.reason, new Date());
          console.log(
            `✅ ${mode === "long" ? "SELL" : "COVER"} FILLED id=${orderId} ALL ${symbol} @ ${exitPrice.toFixed(4)} | reason=${meta.reason} | P&L=${colorPnL(realized)} | equity=${equity.toFixed(2)}`
          );
          notifyTelegram(`✅ ${mode === "long" ? "SELL" : "COVER"} FILLED ${symbol} ALL @ ${exitPrice.toFixed(4)} | P&L=${usd(realized)} | equity=${usd(equity)}`);
        } else {
          equity += realized;
          console.log(
            `✅ PARTIAL ${mode === "long" ? "SELL" : "COVER"} id=${orderId} ${exitQty} ${symbol} @ ${exitPrice.toFixed(4)} | reason=${meta.reason} | Realized=${colorPnL(realized)} | equity=${equity.toFixed(2)} | remaining=${Math.abs(shares)}`
          );
          notifyTelegram(`✅ PARTIAL ${mode === "long" ? "SELL" : "COVER"} ${symbol} qty=${exitQty} @ ${exitPrice.toFixed(4)} | Realized=${usd(realized)} | equity=${usd(equity)} | rem=${Math.abs(shares)}`);
          saveState();
        }
      }

      orders.delete(orderId);
      try { pollPositionsOnce(); } catch { }
      return;
    }
  });

  // Ticks
  ib.on(EventName.tickPrice, async (tickerId, field, price) => {
    if (tickerId !== mktDataTickerId) return;
    if (!(price > 0)) return;

    if (field === 1) bidPrice = price;        // BID
    else if (field === 2) askPrice = price;   // ASK
    else if (field === 4) {                   // LAST
      lastPrice = price;

      const now = new Date();
      const t = hhmmss(now);
      const uPnL = inPosition ? ((lastPrice - entryPrice) * shares) : 0;

      console.log(
        `[${t}] ${symbol} bid=${bidPrice ? bidPrice.toFixed(4) : "0"} ask=${askPrice ? askPrice.toFixed(4) : "0"} last=${lastPrice.toFixed(4)} | mode=${mode} | holding=${inPosition ? shares : 0}`
        + (inPosition ? ` | entry=${entryPrice.toFixed(4)} | uPnL=${colorPnL(uPnL)} | pendingExitQty=${pendingExitQty} | entryOrd=${openEntryOrderId ?? "none"} | exitOrds=${openExitOrderIds.size}` : "")
        + ` | streaks(d=${downStreak},u=${upStreak})`
      );

      try { await checkTakeOnTick(); } catch { }
    }
  });

  // Connect
  try {
    await ib.connect();
  } catch (e) {
    console.error("IB connect error:", e);
  }

  // Persist logs + state on exit
  const persist = () => {
    try { writeTxAndDaily(); } catch { }
    try { saveState(); } catch { }
    try { ib.disconnect(); } catch { }
    process.exit(0);
  };
  process.on("SIGINT", persist);
  process.on("SIGTERM", persist);
}

// ---------- Startup reconciliation helpers ----------
let reconcilingOpenOrders = false;
let firstLocalOrderIdStart = -1;
const cancelledOnce = new Set<number>();

function beginOpenOrderReconciliation() {
  reconcilingOpenOrders = true;
  cancelledOnce.clear();
  ib.reqOpenOrders();
}
function requestPositionsAndAdopt() {
  pollPositionsOnce(); // immediate at startup
}
