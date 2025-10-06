// trading-bot.ts
// Bucketed streak strategy with LIMIT-only entries, MARKET take-profit exits,
// duplicate-order prevention, RESUME support, startup reconciliation, and position watcher.

import * as fs from "fs";
import * as path from "path";
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
  newCapital: number;
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
  stopPct?: number;
  takePct?: number;
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
  };
};

// ---------- Params ----------
const symbol = (arg("symbol") || "NVDA").toUpperCase();

// Track whether user supplied --capital and make it override saved state
const capitalArgRaw = arg("capital");
const capital = capitalArgRaw ? Number(capitalArgRaw) : 10000;

const multiple = Math.max(1, Math.min(2, numArg("multiple", 1)));
const mode = (arg("mode", "long")!.toLowerCase() as SideMode);
const x = numArg("x", 2);
const y = numArg("y", 2);
const bucketMins = Math.max(1, numArg("bucketMins", 1));
const stopPct = arg("stopPct") ? Number(arg("stopPct")) : undefined;

// TAKE-PROFIT inputs; triggers when PnL ≥ min(positionCost * pct, takeAmt)
const takePct = arg("takePct") ? Number(arg("takePct")) : undefined;
const takeAmt = arg("takeAmt") ? Number(arg("takeAmt")) : undefined;

const eodClose = parseBool(arg("eodClose"), false);
const tz = arg("tz", "America/New_York")!;
const txDir = arg("txDir", ".")!;
const tickSize = numArg("tickSize", 0.01);
const accountFlag = (arg("account", "S") || "S").toUpperCase();
const clientId = numArg("clientId", 22);

if (!fs.existsSync(txDir)) fs.mkdirSync(txDir, { recursive: true });
if (!(capital > 0)) throw new Error("--capital must be > 0");
if (!(multiple >= 1 && multiple <= 2)) throw new Error("--multiple must be in [1,2]");
if (!["long", "short"].includes(mode)) throw new Error("--mode must be 'long' or 'short'");
if (!(x > 0 && Number.isInteger(x))) throw new Error("--x must be positive integer");
if (!(y > 0 && Number.isInteger(y))) throw new Error("--y must be positive integer");
if (stopPct !== undefined && (!(stopPct > 0) || stopPct >= 100)) throw new Error("--stopPct must be in (0,100)");
if (takePct !== undefined && (!(takePct > 0) || takePct >= 100)) throw new Error("--takePct must be in (0,100)");
if (takeAmt !== undefined && !(takeAmt > 0)) throw new Error("--takeAmt must be > 0");
if (!(tickSize > 0)) throw new Error("--tickSize must be > 0");

// ---------- IB Connection ----------
let ibAccount = "DUH673915";
let ibPort = 7497;
switch (accountFlag) {
  case "P": ibAccount = "U7648331"; ibPort = 7496; break;
  case "A": ibAccount = "U7914923"; ibPort = 7496; break;
  case "S": ibAccount = "DUH673915"; ibPort = 7497; break;
  case "F": ibAccount = "U11743275"; ibPort = 7496; break;
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
let stopLevel = Number.NaN;

let lastPrice = 0;
let prevSamplePrice = 0;
let haveFirstSample = false;

let downStreak = 0;
let upStreak = 0;

let nextOrderId = -1;
let orderPending = false;
let lastOrderTime = 0;
const ORDER_COOLDOWN_MS = 300;

let openEntryOrderId: number | null = null;
const openExitOrderIds = new Set<number>();
let pendingExitQty = 0;
let currentOcaGroup = "";

const orders = new Map<number, TrackedOrder>();

const txLog: TxRecord[] = [];
const dailyAgg = new Map<string, { profit: number; capital: number; lastTs: number }>();

const mktDataTickerId = 9101;

// ---- Startup reconciliation controls ----
let reconcilingOpenOrders = false;
let firstLocalOrderIdStart = -1;
const cancelledOnce = new Set<number>();

// ---- Position polling snapshot ----
let posSnapshotActive = false;
let posBuffer: { symbol: string; pos: number; avgCost: number }[] = [];

// ---- Bucket debounce ----
let lastBucketKey = "";

// ---------- Helpers ----------
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
function bucketKey(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  }).format(d);
  return parts; // "YYYY-MM-DD, HH:MM"
}
function writeTxAndDaily() {
  try { fs.writeFileSync(txFile, JSON.stringify(txLog, null, 2), "utf8"); } catch {}
  const rows = Array.from(dailyAgg.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, v]) => ({ date, profit: v.profit, capital: v.capital }));
  try { fs.writeFileSync(dailyFile, JSON.stringify(rows, null, 2), "utf8"); } catch {}
}
function saveState() {
  const state: BotState = {
    version: 3,
    symbol,
    mode,
    equity,
    entryPrice,
    shares,
    tradeCounter,
    stopPct,
    takePct,
    takeAmt,
    pendingExitQty,
    currentOcaGroup,
    params: { x, y, multiple, bucketMins, tickSize, eodClose, tz }
  };
  try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8"); } catch {}
}
function loadStateIfAny() {
  if (!fs.existsSync(stateFile)) return;
  try {
    const s: BotState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (s.symbol !== symbol) return;
    if (s.mode !== mode) {
      console.log(`ℹ️ State file mode (${s.mode}) != current mode (${mode}); keeping current mode.`);
    }
    equity = s.equity ?? equity;
    entryPrice = s.entryPrice ?? 0;
    shares = s.shares ?? 0;
    tradeCounter = s.tradeCounter ?? 0;
    pendingExitQty = s.pendingExitQty ?? 0;
    currentOcaGroup = s.currentOcaGroup ?? "";
    inPosition = shares !== 0;
    console.log(`💾 Loaded state: equity=${equity.toFixed(2)} shares=${shares} entry=${(entryPrice||0).toFixed(4)} inPosition=${inPosition}`);
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
    newCapital: equity, tradeIndex: tradeCounter, reason, day
  });

  const ts = Date.parse(iso);
  const prev = dailyAgg.get(day);
  const newProfit = (prev?.profit ?? 0) + profit;
  const cap = !prev || ts >= prev.lastTs ? equity : prev.capital;
  const lastTs = !prev || ts >= prev.lastTs ? ts : prev.lastTs;
  dailyAgg.set(day, { profit: newProfit, capital: cap, lastTs });

  // reset
  inPosition = false;
  entryPrice = 0;
  shares = 0;
  stopLevel = Number.NaN;
  pendingExitQty = 0;
  Array.from(openExitOrderIds).forEach((id) => { try { ib.cancelOrder(id); } catch {} });
  openExitOrderIds.clear();
  currentOcaGroup = "";

  writeTxAndDaily();
  saveState();
}
function profitableSellLimit(current: number, entry: number): number {
  return Math.max(current, entry + tickSize);
}
function profitableCoverLimit(current: number, entry: number): number {
  return Math.min(current, entry - tickSize);
}
function ensureNoFlip() {
  if (mode === "long" && shares < 0) {
    console.error(`🚫 SAFETY: short position detected in LONG mode; forcing state flat.`);
    shares = 0; inPosition = false; pendingExitQty = 0;
    Array.from(openExitOrderIds).forEach((id) => { try { ib.cancelOrder(id); } catch {} });
    openExitOrderIds.clear(); currentOcaGroup = "";
    saveState();
  }
  if (mode === "short" && shares > 0) {
    console.error(`🚫 SAFETY: long position detected in SHORT mode; forcing state flat.`);
    shares = 0; inPosition = false; pendingExitQty = 0;
    Array.from(openExitOrderIds).forEach((id) => { try { ib.cancelOrder(id); } catch {} });
    openExitOrderIds.clear(); currentOcaGroup = "";
    saveState();
  }
}

// ---------- Timers ----------
function alignToNextBucketMs(now: Date, minutes: number): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? "0");
  const sec = get("second");
  const min = get("minute");

  let minsToAdd = (minutes - (min % minutes)) % minutes;
  if (minsToAdd === 0) minsToAdd = minutes;
  const msToBoundary = (minsToAdd * 60 - sec) * 1000;
  return Math.max(500, msToBoundary);
}

function startBucketTimer() {
  const kickoff = () => {
    const now = new Date();
    const key = bucketKey(now);
    if (key === lastBucketKey) { scheduleNext(); return; }
    lastBucketKey = key;

    const t = hhmmss(now);

    if (lastPrice <= 0) {
      console.log(`[${t}] ${symbol} (bucket) no price yet; skipping sample`);
      scheduleNext();
      return;
    }

    const sample = lastPrice;
    if (!haveFirstSample) {
      haveFirstSample = true;
      prevSamplePrice = sample;
      console.log(`[${t}] ${symbol} (bucket) init sample=${sample.toFixed(4)} | mode=${mode} | holding=${inPosition ? shares : 0}`);
      scheduleNext();
      return;
    }

    if (sample < prevSamplePrice) {
      downStreak += 1; upStreak = 0;
    } else if (sample > prevSamplePrice) {
      upStreak += 1; downStreak = 0;
    } else {
      downStreak = 0; upStreak = 0;
    }

    const arrow = sample > prevSamplePrice ? "▲" : sample < prevSamplePrice ? "▼" : "=";
    const extra = inPosition ? ` | entry=${entryPrice.toFixed(4)} | uPnL=${((sample - entryPrice) * shares).toFixed(2)} | pendingExitQty=${pendingExitQty}` : "";
    console.log(`[${t}] ${symbol} (bucket) sampled=${sample.toFixed(4)} ${arrow} (d=${downStreak}, u=${upStreak}) | mode=${mode} | holding=${inPosition ? shares : 0}${extra}`);

    maybeExitOnSample(sample, now).catch(() => {});
    maybeEnterOnSample(sample, now).catch(() => {});

    prevSamplePrice = sample;
    scheduleNext();
  };

  const scheduleNext = () => {
    const ms = alignToNextBucketMs(new Date(), bucketMins);
    setTimeout(kickoff, ms);
  };

  const firstMs = alignToNextBucketMs(new Date(), bucketMins);
  console.log(`⏱️  Bucket timer: every ${bucketMins} min(s), next in ~${Math.round(firstMs/1000)}s`);
  setTimeout(kickoff, firstMs);
}

// ---------- EOD ----------
async function eodLiquidationIfNeeded(now: Date) {
  if (!eodClose || !inPosition) return;
  if (hasOutstandingOrders()) { console.log("🌙 EOD skip: outstanding order present"); return; }

  if (mode === "long") {
    if (!(lastPrice > entryPrice)) {
      console.log(`🌙 EOD HOLD (not profitable, long): last=${lastPrice.toFixed(4)} ≤ entry=${entryPrice.toFixed(4)}`);
      return;
    }
    const qtyToExit = Math.max(0, Math.abs(shares) - pendingExitQty);
    if (qtyToExit <= 0) { console.log(`🌙 EOD SELL skipped: pending exits already cover`); return; }
    const lmt = profitableSellLimit(lastPrice, entryPrice);
    if (!currentOcaGroup) currentOcaGroup = `POS_${symbol}_${Date.now()}`;
    const order: any = { action: "SELL", totalQuantity: qtyToExit, orderType: "LMT", lmtPrice: lmt, tif: "DAY", transmit: true, ocaGroup: currentOcaGroup, ocaType: 1 };
    const oid = placeOrderSafe(ibStockContract(symbol), order, "SELL", "EXIT", "EOD", qtyToExit, currentOcaGroup);
    if (oid < 0) return;
    pendingExitQty += qtyToExit;
    console.log(`🌙 EOD SELL LMT ORDER id=${oid} ${qtyToExit}/${shares} ${symbol} @ ${lmt.toFixed(4)}`);
  } else {
    if (!(lastPrice < entryPrice)) {
      console.log(`🌙 EOD HOLD (not profitable, short): last=${lastPrice.toFixed(4)} ≥ entry=${entryPrice.toFixed(4)}`);
      return;
    }
    const qtyToExit = Math.max(0, Math.abs(shares) - pendingExitQty);
    if (qtyToExit <= 0) { console.log(`🌙 EOD COVER skipped: pending exits already cover short`); return; }
    const lmt = profitableCoverLimit(lastPrice, entryPrice);
    if (!currentOcaGroup) currentOcaGroup = `POS_${symbol}_${Date.now()}`;
    const order: any = { action: "BUY", totalQuantity: qtyToExit, orderType: "LMT", lmtPrice: lmt, tif: "DAY", transmit: true, ocaGroup: currentOcaGroup, ocaType: 1 };
    const oid = placeOrderSafe(ibStockContract(symbol), order, "BUY", "EXIT", "EOD", qtyToExit, currentOcaGroup);
    if (oid < 0) return;
    pendingExitQty += qtyToExit;
    console.log(`🌙 EOD COVER LMT ORDER id=${oid} ${qtyToExit}/${Math.abs(shares)} ${symbol} @ ${lmt.toFixed(4)}`);
  }
}
function startEODTimer() {
  if (!eodClose) return;
  setInterval(async () => {
    const now = new Date();
    const hm = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit"
    }).format(now);
    if (hm === "15:59") {
      await eodLiquidationIfNeeded(now);
    }
  }, 15_000);
}

// ---- Duplicate-order prevention ----
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
  oca?: string,
  opts?: { force?: boolean }   // << allow TAKE to bypass outstanding order/cooldown checks
): number {
  if (nextOrderId < 0) throw new Error("nextValidId not received yet");
  if (!opts?.force && hasOutstandingOrders()) {
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
async function maybeEnterOnSample(samplePrice: number, when: Date) {
  if (inPosition) return;
  if (hasOutstandingOrders()) { console.log("➤ NO ENTRY: outstanding order present"); return; }

  const positionValue = equity * multiple;
  const qty = Math.floor(positionValue / samplePrice);
  if (qty <= 0) {
    console.log(`➤ NO ENTRY (size=0) | sampled=${samplePrice.toFixed(4)} | equity=${equity} | multiple=${multiple}x`);
    return;
  }

  if (mode === "long") {
    if (downStreak === x) {
      const order: any = { action: "BUY", totalQuantity: qty, orderType: "LMT", lmtPrice: samplePrice, tif: "DAY", transmit: true };
      const oid = placeOrderSafe(ibStockContract(symbol), order, "BUY", "ENTRY", "RULE", qty);
      if (oid < 0) return;
      downStreak = 0; upStreak = 0;
      console.log(`🟢 BUY LMT ORDER id=${oid} ${qty} ${symbol} @ ${samplePrice.toFixed(4)} | trigger: downStreak==X(${x}) | equity=${equity.toFixed(2)}`);
      saveState();
    }
  } else {
    if (upStreak === y) {
      const order: any = { action: "SELL", totalQuantity: qty, orderType: "LMT", lmtPrice: samplePrice, tif: "DAY", transmit: true };
      const oid = placeOrderSafe(ibStockContract(symbol), order, "SELL", "ENTRY", "RULE", qty);
      if (oid < 0) return;
      downStreak = 0; upStreak = 0;
      console.log(`🟥 SHORT (SELL) LMT ORDER id=${oid} ${qty} ${symbol} @ ${samplePrice.toFixed(4)} | trigger: upStreak==Y(${y}) | equity=${equity.toFixed(2)}`);
      saveState();
    }
  }
}

async function maybeExitOnSample(samplePrice: number, when: Date) {
  if (!inPosition) return;
  if (hasOutstandingOrders()) { console.log("➤ NO EXIT: outstanding order present"); return; }

  if (mode === "long") {
    if (!(upStreak === y && samplePrice > entryPrice)) return;
    const qtyToExit = Math.max(0, Math.abs(shares) - pendingExitQty);
    if (qtyToExit <= 0) { console.log(`➤ SKIP SELL: pending exits already cover position`); return; }

    const lmt = profitableSellLimit(samplePrice, entryPrice);
    if (!currentOcaGroup) currentOcaGroup = `POS_${symbol}_${Date.now()}`;
    const order: any = { action: "SELL", totalQuantity: qtyToExit, orderType: "LMT", lmtPrice: lmt, tif: "DAY", transmit: true, ocaGroup: currentOcaGroup, ocaType: 1 };
    const oid = placeOrderSafe(ibStockContract(symbol), order, "SELL", "EXIT", "RULE", qtyToExit, currentOcaGroup);
    if (oid < 0) return;
    pendingExitQty += qtyToExit;
    downStreak = 0; upStreak = 0;
    console.log(`🔴 SELL LMT ORDER id=${oid} ${qtyToExit}/${shares} ${symbol} @ ${lmt.toFixed(4)} | trigger: upStreak==Y(${y}) & sampled>entry`);
    saveState();
  } else {
    if (!(downStreak === x && samplePrice < entryPrice)) return;
    const qtyToExit = Math.max(0, Math.abs(shares) - pendingExitQty);
    if (qtyToExit <= 0) { console.log(`➤ SKIP COVER: pending exits already cover short`); return; }

    const lmt = profitableCoverLimit(samplePrice, entryPrice);
    if (!currentOcaGroup) currentOcaGroup = `POS_${symbol}_${Date.now()}`;
    const order: any = { action: "BUY", totalQuantity: qtyToExit, orderType: "LMT", lmtPrice: lmt, tif: "DAY", transmit: true, ocaGroup: currentOcaGroup, ocaType: 1 };
    const oid = placeOrderSafe(ibStockContract(symbol), order, "BUY", "EXIT", "RULE", qtyToExit, currentOcaGroup);
    if (oid < 0) return;
    pendingExitQty += qtyToExit;
    downStreak = 0; upStreak = 0;
    console.log(`🟩 COVER LMT ORDER id=${oid} ${qtyToExit}/${Math.abs(shares)} ${symbol} @ ${lmt.toFixed(4)} | trigger: downStreak==X(${x}) & sampled<entry`);
    saveState();
  }
}

// ---------- TAKE-PROFIT: now MARKET and bypasses outstanding order checks ----------
async function checkTakeOnTick(price: number, when: Date) {
  if (!inPosition || (takePct === undefined && takeAmt === undefined)) return;

  const pnlNow = (price - entryPrice) * shares;   // positive if profitable (handles long/short)
  if (pnlNow <= 0) return;

  const candidates: number[] = [];
  const positionCost = Math.abs(entryPrice * shares); // total cost at entry

  if (takePct !== undefined) candidates.push(positionCost * (takePct / 100));
  if (takeAmt !== undefined) candidates.push(takeAmt);
  if (candidates.length === 0) return;

  const dollarGoal = Math.min(...candidates);
  if (pnlNow < dollarGoal) return;

  const qtyToExit = Math.max(0, Math.abs(shares) - pendingExitQty);
  if (qtyToExit <= 0) return;

  if (!currentOcaGroup) currentOcaGroup = `POS_${symbol}_${Date.now()}`;

  if (mode === "long") {
    // SELL at MARKET to take profit
    const order: any = { action: "SELL", totalQuantity: qtyToExit, orderType: "MKT", tif: "DAY", transmit: true, ocaGroup: currentOcaGroup, ocaType: 1 };
    const oid = placeOrderSafe(ibStockContract(symbol), order, "SELL", "EXIT", "TAKE", qtyToExit, currentOcaGroup, { force: true });
    if (oid < 0) return;
    pendingExitQty += qtyToExit;
    console.log(`🎯 TAKE-PROFIT SELL MKT id=${oid} ${qtyToExit}/${shares} ${symbol} | pnlNow=${pnlNow.toFixed(2)} | goal=${dollarGoal.toFixed(2)} (posCost=${positionCost.toFixed(2)}, pct=${takePct ?? "-"}, amt=${takeAmt ?? "-"})`);
    saveState();
  } else {
    // BUY (cover) at MARKET to take profit
    const order: any = { action: "BUY", totalQuantity: qtyToExit, orderType: "MKT", tif: "DAY", transmit: true, ocaGroup: currentOcaGroup, ocaType: 1 };
    const oid = placeOrderSafe(ibStockContract(symbol), order, "BUY", "EXIT", "TAKE", qtyToExit, currentOcaGroup, { force: true });
    if (oid < 0) return;
    pendingExitQty += qtyToExit;
    console.log(`🎯 TAKE-PROFIT COVER MKT id=${oid} ${qtyToExit}/${Math.abs(shares)} ${symbol} | pnlNow=${pnlNow.toFixed(2)} | goal=${dollarGoal.toFixed(2)} (posCost=${positionCost.toFixed(2)}, pct=${takePct ?? "-"}, amt=${takeAmt ?? "-"})`);
    saveState();
  }
}

// ---------- Optional profit-only stop (still LIMIT) ----------
async function checkStopOnTick(price: number, when: Date) {
  if (!inPosition || !stopPct) return;
  if (hasOutstandingOrders()) return;

  if (mode === "long") {
    if (!(price > entryPrice)) return;
    const currStop = entryPrice * (1 - stopPct / 100);
    if (!Number.isNaN(currStop) && price <= currStop) {
      const qtyToExit = Math.max(0, Math.abs(shares) - pendingExitQty);
      if (qtyToExit <= 0) return;
      const lmt = profitableSellLimit(price, entryPrice);
      if (!currentOcaGroup) currentOcaGroup = `POS_${symbol}_${Date.now()}`;
      const order: any = { action: "SELL", totalQuantity: qtyToExit, orderType: "LMT", lmtPrice: lmt, tif: "DAY", transmit: true, ocaGroup: currentOcaGroup, ocaType: 1 };
      const oid = placeOrderSafe(ibStockContract(symbol), order, "SELL", "EXIT", "STOP", qtyToExit, currentOcaGroup);
      if (oid < 0) return;
      pendingExitQty += qtyToExit;
      console.log(`⛔ STOP SELL LMT ORDER id=${oid} ${qtyToExit}/${shares} ${symbol} @ ${lmt.toFixed(4)} | price=${price.toFixed(4)} <= stop=${currStop.toFixed(4)}`);
      saveState();
    }
  } else {
    if (!(price < entryPrice)) return;
    const currStop = entryPrice * (1 + stopPct / 100);
    if (!Number.isNaN(currStop) && price >= currStop) {
      const qtyToExit = Math.max(0, Math.abs(shares) - pendingExitQty);
      if (qtyToExit <= 0) return;
      const lmt = profitableCoverLimit(price, entryPrice);
      if (!currentOcaGroup) currentOcaGroup = `POS_${symbol}_${Date.now()}`;
      const order: any = { action: "BUY", totalQuantity: qtyToExit, orderType: "LMT", lmtPrice: lmt, tif: "DAY", transmit: true, ocaGroup: currentOcaGroup, ocaType: 1 };
      const oid = placeOrderSafe(ibStockContract(symbol), order, "BUY", "EXIT", "STOP", qtyToExit, currentOcaGroup);
      if (oid < 0) return;
      pendingExitQty += qtyToExit;
      console.log(`⛔ STOP COVER LMT ORDER id=${oid} ${qtyToExit}/${Math.abs(shares)} ${symbol} @ ${lmt.toFixed(4)} | price=${price.toFixed(4)} >= stop=${currStop.toFixed(4)}`);
      saveState();
    }
  }
}

// ---------- Position polling / reconciliation ----------
function pollPositionsOnce() {
  posSnapshotActive = true;
  posBuffer = [];
  ib.reqPositions();
}
function startPositionWatcher(intervalMs = 10_000) {
  setInterval(() => {
    try { pollPositionsOnce(); } catch {}
  }, intervalMs);
  try { pollPositionsOnce(); } catch {}
}

// ---------- main ----------
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function main() {
  loadStateIfAny();

  // If the user passed --capital, force it to override saved state
  if (capitalArgRaw !== undefined) {
    equity = capital;
    console.log(`⚙️ Using CLI --capital=${equity} (overrides saved state)`);
    saveState();
  }

  ib.on(EventName.error, (err: Error, code: ErrorCode, reqId: number) => {
    console.error(`❌ IB Error ${err?.message} code=${code} reqId=${reqId}`);
  });

  ib.on(EventName.nextValidId, (oid) => {
    nextOrderId = oid;
    firstLocalOrderIdStart = oid;
    console.log(`✅ Connected. nextValidId = ${oid} | mode=${mode.toUpperCase()} (startup reconciliation ON)`);

    ib.reqMktData(mktDataTickerId, ibStockContract(symbol), "", false, false);

    beginOpenOrderReconciliation();
    requestPositionsAndAdopt();
    startPositionWatcher(10_000);

    startBucketTimer();
    startEODTimer();
  });

  ib.on(EventName.openOrder, (orderId: number, contract: Contract) => {
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

  ib.on(EventName.position, (_account, contract, pos, avgCost) => {
    if (!posSnapshotActive) return;
    const sym = (contract?.symbol || "").toUpperCase();
    if (sym) posBuffer.push({ symbol: sym, pos, avgCost: Number(avgCost) || 0 });
  });

  ib.on("positionEnd" as any, () => {
    if (!posSnapshotActive) return;
    posSnapshotActive = false;

    const row = posBuffer.find(r => r.symbol === symbol);
    const exchangeSaysPos = row?.pos ?? 0;
    const exchangeAvgCost = row?.avgCost ?? 0;

    if (inPosition && exchangeSaysPos === 0) {
      console.log(`🧹 Detected external flat for ${symbol}. Clearing local state.`);
      Array.from(openExitOrderIds).forEach((id) => { try { ib.cancelOrder(id); } catch {} });
      openExitOrderIds.clear();
      pendingExitQty = 0;
      currentOcaGroup = "";

      inPosition = false;
      shares = 0;
      entryPrice = 0;
      stopLevel = Number.NaN;

      txLog.push({
        symbol,
        side: mode === "long" ? "SELL" : "BUY",
        datetime: new Date().toISOString(),
        price: lastPrice || 0,
        shares: 0,
        profit: 0,
        newCapital: equity,
        tradeIndex: tradeCounter,
        reason: "RULE",
      });

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
        stopLevel = (stopPct && inPosition)
          ? (mode === "long" ? entryPrice * (1 - stopPct / 100) : entryPrice * (1 + stopPct / 100))
          : Number.NaN;
        pendingExitQty = 0;
        openEntryOrderId = null;
        openExitOrderIds.clear();
        currentOcaGroup = `POS_${symbol}_${Date.now()}`;

        console.log(`🧭 Adopted live position from IB: shares=${shares}, entry=${entryPrice.toFixed(4)}, stop=${isNaN(stopLevel) ? "none" : stopLevel.toFixed(4)}`);
        saveState();
      }
    }

    if (inPosition && exchangeSaysPos !== 0 && exchangeSaysPos !== shares) {
      console.log(`🔄 Position size changed externally for ${symbol}: ${shares} → ${exchangeSaysPos}. Syncing.`);
      shares = exchangeSaysPos;
      if (exchangeAvgCost > 0) entryPrice = exchangeAvgCost;
      stopLevel = (stopPct && inPosition)
        ? (mode === "long" ? entryPrice * (1 - stopPct / 100) : entryPrice * (1 + stopPct / 100))
        : Number.NaN;

      pendingExitQty = 0;
      openExitOrderIds.clear();
      currentOcaGroup = `POS_${symbol}_${Date.now()}`;
      saveState();
    }
  });

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
      try { pollPositionsOnce(); } catch {}
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
          stopLevel = stopPct ? entryPrice * (1 - stopPct / 100) : Number.NaN;
          console.log(`🟢 BUY FILLED id=${orderId} ${shares} ${symbol} @ ${entryPrice.toFixed(4)} | stop=${isNaN(stopLevel) ? "none" : stopLevel.toFixed(4)}`);
        } else {
          shares = -meta.qty;
          stopLevel = stopPct ? entryPrice * (1 + stopPct / 100) : Number.NaN;
          console.log(`🟥 SHORT FILLED id=${orderId} ${meta.qty} ${symbol} @ ${entryPrice.toFixed(4)} | stop=${isNaN(stopLevel) ? "none" : stopLevel.toFixed(4)}`);
        }

        pendingExitQty = 0;
        openExitOrderIds.clear();
        currentOcaGroup = `POS_${symbol}_${Date.now()}`;

        txLog.push({
          symbol,
          side: mode === "long" ? "BUY" : "SELL",
          datetime: new Date().toISOString(),
          price: entryPrice,
          shares,
          profit: 0,
          newCapital: equity,
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
          console.log(`${meta.reason === "TAKE" ? "🎯" : meta.reason === "STOP" ? "⛔" : meta.reason === "EOD" ? "🌙" : (mode === "long" ? "🔴" : "🟩")} ${mode === "long" ? "SELL" : "COVER"} FILLED id=${orderId} ALL ${symbol} @ ${exitPrice.toFixed(4)} | reason=${meta.reason} | P&L=${realized.toFixed(2)} | equity=${equity.toFixed(2)}`);
        } else {
          equity += realized;
          console.log(`${mode === "long" ? "🔴 SELL" : "🟩 COVER"} FILLED id=${orderId} ${exitQty} ${symbol} @ ${exitPrice.toFixed(4)} | reason=${meta.reason} | Realized=${realized.toFixed(2)} | equity=${equity.toFixed(2)} | remaining=${Math.abs(shares)}`);
          saveState();
        }
      }

      orders.delete(orderId);
      try { pollPositionsOnce(); } catch {}
      return;
    }
  });

  ib.on(EventName.tickPrice, async (tickerId, field, price) => {
    if (tickerId !== mktDataTickerId) return;
    if (field !== 4 || price <= 0) return; // LAST
    lastPrice = price;

    const now = new Date();
    const t = hhmmss(now);
    const uPnL = inPosition ? ((price - entryPrice) * shares).toFixed(2) : undefined;
    console.log(
      `[${t}] ${symbol} last=${price.toFixed(4)} | mode=${mode} | holding=${inPosition ? shares : 0}`
      + (inPosition ? ` | entry=${entryPrice.toFixed(4)} | uPnL=${uPnL} | pendingExitQty=${pendingExitQty} | entryOrd=${openEntryOrderId ?? "none"} | exitOrds=${openExitOrderIds.size}` : "")
      + ` | streaks(d=${downStreak},u=${upStreak})`
    );

    try { await checkTakeOnTick(price, now); } catch {}
    try { await checkStopOnTick(price, now); } catch {}
  });

  try {
    await ib.connect();
  } catch (e) {
    console.error("IB connect error:", e);
  }

  const persist = () => {
    try { writeTxAndDaily(); } catch {}
    try { saveState(); } catch {}
    try { ib.disconnect(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", persist);
  process.on("SIGTERM", persist);
}

// ---------- Startup reconciliation helpers ----------
function beginOpenOrderReconciliation() {
  reconcilingOpenOrders = true;
  cancelledOnce.clear();
  ib.reqOpenOrders();
}
function requestPositionsAndAdopt() {
  pollPositionsOnce();
}
