// trading-bot.ts
// Bucketed streak strategy with RULE exits (X,Y) gated by takeAmt/takePct,
// duplicate-order prevention, RESUME support, startup reconciliation
// (cancel only legacy open orders), periodic position watcher,
// optional Telegram notifications, and colored logs for uPnL.
//
// Behavior:
// - Entries (bucketed consecutive logic):
//     * LONG:  enter when downStreak >= x
//     * SHORT: enter when upStreak  >= y
//
// - Exits (only when streak Y reached):
//     * LONG exit candidate when upStreak >= y
//     * SHORT exit candidate when downStreak >= y
//     * THEN require profit >= exitThreshold, unless --allowUnprofitableRuleExit.
//       exitThreshold is based on takeAmt / takePct of invested capital:
//
//       invested = |shares| * entryPrice
//       amtCond   = takeAmt            (if provided)
//       pctCond   = takePct% * invested (if provided)
//       target    = max(amtCond, pctCond) over those defined
//
//       If neither takeAmt nor takePct is set:
//         - default: require PnL >= 0 (never exit at loss) unless allowUnprofitableRuleExit.
//
// - No standalone TAKE-on-tick. Profit targets are enforced
//   together with Y streak.
//
// - LIMIT prices are snapped to tickSize to avoid IB 110 errors.
// - 15s cooldown between entry orders.
//
// Example:
//   npx ts-node trading-bot.ts \
//     --symbol AMZN --capital 60000 --multiple 1 --mode long \
//     --x 4 --y 2 --bucketMins 1 \
//     --takeAmt 75 --takePct 0.5 \
//     --tz America/New_York --txDir ./out --account S --clientId 103
//
//   => Exit only when upStreak>=2 AND PnL >= max(75$, 0.5% of invested)
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
type ExitReason = "RULE" | "STOP" | "EOD" | "TAKE";

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
  reason?: ExitReason;
  day?: string;
};
type TrackedOrder = {
  side: "BUY" | "SELL";
  role: "ENTRY" | "EXIT";
  reason: ExitReason;
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
  takePct?: number;
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
const takeAmt = arg("takeAmt") ? Number(arg("takeAmt")) : undefined;
const takePct = arg("takePct") ? Number(arg("takePct")) : undefined; // % of invested capital
const eodClose = parseBool(arg("eodClose"), false); // usually false
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

// ---------- Validate ----------
if (!fs.existsSync(txDir)) fs.mkdirSync(txDir, { recursive: true });
if (!(capital > 0)) throw new Error("--capital must be > 0");
if (!(multiple >= 1 && multiple <= 2)) throw new Error("--multiple must be in [1,2]");
if (!["long", "short"].includes(mode)) throw new Error("--mode must be 'long' or 'short'");
if (!(x > 0 && Number.isInteger(x))) throw new Error("--x must be positive integer");
if (!(y > 0 && Number.isInteger(y))) throw new Error("--y must be positive integer");
if (!(tickSize > 0)) throw new Error("--tickSize must be > 0");
if (takeAmt !== undefined && !(takeAmt > 0)) throw new Error("--takeAmt must be > 0");
if (takePct !== undefined && !(takePct > 0 && takePct < 100)) {
  throw new Error("--takePct must be in (0,100)");
}

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

let downStreak = 0;
let upStreak = 0;

let nextOrderId = -1;
let orderPending = false;
let lastOrderTime = 0;
const ORDER_COOLDOWN_MS = 300;

// ENTRY cooldown
const ENTRY_COOLDOWN_MS = 15000;
let lastEntryAttemptMs = 0;

let openEntryOrderId: number | null = null;
const openExitOrderIds = new Set<number>();
let pendingExitQty = 0;
let currentOcaGroup = "";

const orders = new Map<number, TrackedOrder>();

const txLog: TxRecord[] = [];
const dailyAgg = new Map<string, { profit: number; capital: number; lastTs: number }>();

const mktDataTickerId = 9101;

// Position polling
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

// Tick rounding (avoid IB 110)
function roundToTick(v: number, tick = tickSize): number {
  const n = Math.round((v + 1e-9) / tick);
  return Number((n * tick).toFixed(6));
}
function roundUpToTick(v: number, tick = tickSize): number {
  const n = Math.ceil((v - 1e-9) / tick);
  return Number((n * tick).toFixed(6));
}
function roundDownToTick(v: number, tick = tickSize): number {
  const n = Math.floor((v + 1e-9) / tick);
  return Number((n * tick).toFixed(6));
}

// Compute profit target from takeAmt / takePct
function computeProfitTarget(positionCost: number): number {
  let target = 0;
  if (takeAmt !== undefined) {
    target = Math.max(target, takeAmt);
  }
  if (takePct !== undefined) {
    const pctVal = (takePct / 100) * positionCost;
    target = Math.max(target, pctVal);
  }
  return target;
}

// Shared exit gate:
// - If allowUnprofitableRuleExit => ignore thresholds.
// - Else if have takeAmt/takePct => require pnl >= target.
// - Else => require pnl >= 0 (no-loss exit).
function exitAllowedGivenPnL(pnlNow: number, positionCost: number): boolean {
  if (allowUnprofitableRuleExit) return true;

  const target = computeProfitTarget(positionCost);
  if (target > 0) {
    return pnlNow >= target;
  }
  // No explicit thresholds: don't exit losers by default
  return pnlNow >= 0;
}

function writeTxAndDaily() {
  try { fs.writeFileSync(txFile, JSON.stringify(txLog, null, 2), "utf8"); } catch { }
  const rows = Array.from(dailyAgg.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, v]) => ({
      date,
      profit: v.profit,
      profitUSD: usd(v.profit),
      capital: v.capital,
      capitalUSD: usd(v.capital)
    }));
  try { fs.writeFileSync(dailyFile, JSON.stringify(rows, null, 2), "utf8"); } catch { }
}
function saveState() {
  const state: BotState = {
    version: 11,
    symbol,
    mode,
    equity,
    entryPrice,
    shares,
    tradeCounter,
    takeAmt,
    takePct,
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
function recordFlat(profit: number, price: number, reason: ExitReason, when: Date) {
  equity += profit;
  const iso = when.toISOString();
  const day = fmtDay(when);
  txLog.push({
    symbol,
    side: mode === "long" ? "SELL" : "BUY",
    datetime: iso,
    price,
    shares,
    profit,
    profitUSD: usd(profit),
    newCapital: equity,
    newCapitalUSD: usd(equity),
    tradeIndex: tradeCounter,
    reason,
    day
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
    console.error("🚫 SAFETY: short position detected in LONG mode; forcing state flat.");
    shares = 0; inPosition = false; pendingExitQty = 0;
    Array.from(openExitOrderIds).forEach(id => { try { ib.cancelOrder(id); } catch { } });
    openExitOrderIds.clear(); currentOcaGroup = "";
    upStreak = 0; downStreak = 0;
    saveState();
  }
  if (mode === "short" && shares > 0) {
    console.error("🚫 SAFETY: long position detected in SHORT mode; forcing state flat.");
    shares = 0; inPosition = false; pendingExitQty = 0;
    Array.from(openExitOrderIds).forEach(id => { try { ib.cancelOrder(id); } catch { } });
    openExitOrderIds.clear(); currentOcaGroup = "";
    upStreak = 0; downStreak = 0;
    saveState();
  }
}

// LIMIT helpers (with ticks)
function chooseSellLimitForLong(bid: number, entry: number, fallback: number): number {
  const minProfitable = entry + tickSize;
  const base = (bid > 0 ? bid : fallback);
  const want = Math.max(base, minProfitable);
  return roundDownToTick(want);
}
function chooseCoverLimitForShort(ask: number, entry: number, fallback: number): number {
  const minProfitable = entry - tickSize;
  const base = (ask > 0 ? ask : fallback);
  const want = Math.min(base, minProfitable);
  return roundUpToTick(want);
}

// Telegram notify (optional)
function notifyTelegram(text: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const payload = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true });
  const opts: https.RequestOptions = {
    hostname: "api.telegram.org",
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload)
    }
  };
  const req = https.request(opts, (res) => { res.on("data", () => { }); });
  req.on("error", () => { });
  req.write(payload);
  req.end();
}

// ---------- Timers ----------
function startBucketTimer() {
  const intervalMs = Math.max(1000, Math.round(bucketMins * 60_000));
  console.log(`⏱️  Bucket timer: every ${bucketMins} min(s)`);

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
      console.log(
        `[${hhmmss(now)}] ${symbol} (bucket) init sample=${sample.toFixed(4)} `
        + `| mode=${mode} | holding=${inPosition ? shares : 0}`
      );
      return;
    }

    // Update streaks
    if (sample < prevSamplePrice) {
      downStreak += 1;
      upStreak = 0;
    } else if (sample > prevSamplePrice) {
      upStreak += 1;
      downStreak = 0;
    } else {
      upStreak = 0;
      downStreak = 0;
    }

    const arrow = sample > prevSamplePrice ? "▲" : sample < prevSamplePrice ? "▼" : "=";
    const uPnL = inPosition ? (sample - entryPrice) * shares : 0;
    const extra = inPosition
      ? ` | entry=${entryPrice.toFixed(4)} | uPnL=${colorPnL(uPnL)} | pendingExitQty=${pendingExitQty}`
      : "";

    console.log(
      `[${hhmmss(now)}] ${symbol} (bucket) sampled=${sample.toFixed(4)} ${arrow} `
      + `(down=${downStreak}, up=${upStreak}) | mode=${mode} `
      + `| holding=${inPosition ? shares : 0}${extra}`
    );

    // First check exits (Y + thresholds)
    if (inPosition) {
      maybeExitOnSample(sample).catch(() => {});
    }

    // Then entries (if flat)
    if (!inPosition) {
      maybeEnterOnSample(sample).catch(() => {});
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
  reason: ExitReason,
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

  if (role === "ENTRY") openEntryOrderId = orderId;
  else openExitOrderIds.add(orderId);

  orderPending = true;
  lastOrderTime = Date.now();
  ib.placeOrder(orderId, contract, order);
  return orderId;
}

// ---------- Strategy: ENTRY ----------
async function maybeEnterOnSample(samplePrice: number) {
  if (inPosition) return;
  if (hasOutstandingOrders()) {
    console.log("➤ NO ENTRY: outstanding order present");
    return;
  }

  const nowMs = Date.now();
  if (nowMs - lastEntryAttemptMs < ENTRY_COOLDOWN_MS) {
    const msLeft = ENTRY_COOLDOWN_MS - (nowMs - lastEntryAttemptMs);
    console.log(`⏳ ENTRY COOLDOWN: skipping entry, ${Math.ceil(msLeft / 1000)}s remaining`);
    return;
  }

  if (mode === "long") {
    if (downStreak >= x) {
      const lmt = roundUpToTick(samplePrice);
      const positionValue = equity * multiple;
      const qty = Math.floor(positionValue / lmt);
      if (qty <= 0) {
        console.log(`➤ NO ENTRY (size=0) | lmt=${lmt.toFixed(4)} | equity=${equity}`);
        return;
      }
      const order: any = {
        action: "BUY",
        totalQuantity: qty,
        orderType: "LMT",
        lmtPrice: lmt,
        tif: "DAY",
        transmit: true
      };
      const oid = placeOrderSafe(ibStockContract(symbol), order, "BUY", "ENTRY", "RULE", qty);
      if (oid < 0) return;

      lastEntryAttemptMs = nowMs;
      upStreak = 0; downStreak = 0;

      console.log(`🟢 BUY LMT ORDER id=${oid} ${qty} ${symbol} @ ${lmt.toFixed(4)} | downStreak>=${x}`);
      notifyTelegram(`🟢 BUY LMT ${symbol} qty=${qty} @ ${lmt.toFixed(2)} | downStreak>=${x}`);
      saveState();
    }
  } else {
    if (upStreak >= y) {
      const lmt = roundDownToTick(samplePrice);
      const positionValue = equity * multiple;
      const qty = Math.floor(positionValue / lmt);
      if (qty <= 0) {
        console.log(`➤ NO ENTRY (size=0) | lmt=${lmt.toFixed(4)} | equity=${equity}`);
        return;
      }
      const order: any = {
        action: "SELL",
        totalQuantity: qty,
        orderType: "LMT",
        lmtPrice: lmt,
        tif: "DAY",
        transmit: true
      };
      const oid = placeOrderSafe(ibStockContract(symbol), order, "SELL", "ENTRY", "RULE", qty);
      if (oid < 0) return;

      lastEntryAttemptMs = nowMs;
      upStreak = 0; downStreak = 0;

      console.log(`🟥 SHORT LMT ORDER id=${oid} ${qty} ${symbol} @ ${lmt.toFixed(4)} | upStreak>=${y}`);
      notifyTelegram(`🟥 SHORT LMT ${symbol} qty=${qty} @ ${lmt.toFixed(2)} | upStreak>=${y}`);
      saveState();
    }
  }
}

// ---------- Strategy: EXIT (Y + thresholds) ----------
async function maybeExitOnSample(samplePrice: number) {
  if (!inPosition) return;
  if (hasOutstandingOrders()) return;

  const positionCost = Math.abs(shares) * entryPrice;
  if (positionCost <= 0) return;

  const pnlNow = (samplePrice - entryPrice) * shares;

  // Check Y condition first
  let yHit = false;
  if (mode === "long" && upStreak >= y) yHit = true;
  if (mode === "short" && downStreak >= y) yHit = true;
  if (!yHit) return;

  // Then check PnL requirement
  if (!exitAllowedGivenPnL(pnlNow, positionCost)) {
    const target = computeProfitTarget(positionCost);
    console.log(
      `✋ Y reached but profit below target: PnL=${usd(pnlNow)} `
      + (target > 0 ? `target=${usd(target)}` : "target>=0")
    );
    return;
  }

  const qtyToExit = Math.max(0, Math.abs(shares) - pendingExitQty);
  if (qtyToExit <= 0) return;

  if (!currentOcaGroup) currentOcaGroup = `POS_${symbol}_${Date.now()}`;

  // Use reason "TAKE" if thresholds are configured; else "RULE"
  const reason: ExitReason =
    (takeAmt !== undefined || takePct !== undefined) ? "TAKE" : "RULE";

  if (mode === "long") {
    const lmt = chooseSellLimitForLong(bidPrice, entryPrice, samplePrice);
    const order: any = {
      action: "SELL",
      totalQuantity: qtyToExit,
      orderType: "LMT",
      lmtPrice: lmt,
      tif: "DAY",
      transmit: true,
      ocaGroup: currentOcaGroup,
      ocaType: 1
    };
    const oid = placeOrderSafe(ibStockContract(symbol), order, "SELL", "EXIT", reason, qtyToExit, currentOcaGroup);
    if (oid < 0) return;
    pendingExitQty += qtyToExit;

    const target = computeProfitTarget(positionCost);
    console.log(
      `↘️ EXIT ${reason} SELL LMT id=${oid} ${qtyToExit}/${shares} ${symbol} @ ${lmt.toFixed(4)} `
      + `| upStreak=${upStreak}≥${y} | PnL=${colorPnL(pnlNow)}`
      + (target > 0 ? ` | target=${usd(target)}` : "")
    );
    notifyTelegram(
      `↘️ EXIT ${reason} SELL LMT ${symbol} qty=${qtyToExit} @ ${lmt.toFixed(2)} | PnL=${usd(pnlNow)}`
    );
    saveState();
  } else {
    const lmt = chooseCoverLimitForShort(askPrice, entryPrice, samplePrice);
    const order: any = {
      action: "BUY",
      totalQuantity: qtyToExit,
      orderType: "LMT",
      lmtPrice: lmt,
      tif: "DAY",
      transmit: true,
      ocaGroup: currentOcaGroup,
      ocaType: 1
    };
    const oid = placeOrderSafe(ibStockContract(symbol), order, "BUY", "EXIT", reason, qtyToExit, currentOcaGroup);
    if (oid < 0) return;
    pendingExitQty += qtyToExit;

    const target = computeProfitTarget(positionCost);
    console.log(
      `↗️ EXIT ${reason} COVER LMT id=${oid} ${qtyToExit}/${Math.abs(shares)} ${symbol} @ ${lmt.toFixed(4)} `
      + `| downStreak=${downStreak}≥${y} | PnL=${colorPnL(pnlNow)}`
      + (target > 0 ? ` | target=${usd(target)}` : "")
    );
    notifyTelegram(
      `↗️ EXIT ${reason} COVER LMT ${symbol} qty=${qtyToExit} @ ${lmt.toFixed(2)} | PnL=${usd(pnlNow)}`
    );
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
    firstLocalOrderIdStart = oid;
    console.log(`✅ Connected. nextValidId = ${oid} | mode=${mode.toUpperCase()} (startup reconciliation ON)`);

    ib.reqMktData(mktDataTickerId, ibStockContract(symbol), "", false, false);

    beginOpenOrderReconciliation();
    requestPositionsAndAdopt();
    startPositionWatcher(10_000);

    startBucketTimer();
  });

  // Startup reconciliation: cancel legacy open orders for this symbol only
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

  // Positions snapshot
  ib.on(EventName.position, (_account, contract, pos, avgCost) => {
    const sym = (contract?.symbol || "").toUpperCase();
    if (sym) posBuffer.push({ symbol: sym, pos, avgCost: Number(avgCost) || 0 });
  });

  ib.on("positionEnd" as any, () => {
    const row = posBuffer.find(r => r.symbol === symbol);
    const exchangeSaysPos = row?.pos ?? 0;
    const exchangeAvgCost = row?.avgCost ?? 0;

    if (inPosition && exchangeSaysPos === 0) {
      console.log(`🧹 Detected external flat for ${symbol}. Clearing local state.`);
      Array.from(openExitOrderIds).forEach(id => { try { ib.cancelOrder(id); } catch { } });
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
      if (mode === "long" && adoptShares < 0) { console.log(`⚠️ SHORT ${adoptShares} but mode=long. Ignoring.`); ok = false; }
      if (mode === "short" && adoptShares > 0) { console.log(`⚠️ LONG +${adoptShares} but mode=short. Ignoring.`); ok = false; }
      if (ok) {
        inPosition = true;
        shares = adoptShares;
        entryPrice = exchangeAvgCost || entryPrice;
        pendingExitQty = 0;
        openEntryOrderId = null;
        openExitOrderIds.clear();
        currentOcaGroup = `POS_${symbol}_${Date.now()}`;

        console.log(`🧭 Adopted live position: shares=${shares}, entry=${entryPrice.toFixed(4)}`);
        notifyTelegram(`🧭 Adopted ${symbol} position: shares=${shares}, entry=${entryPrice.toFixed(4)}`);
        saveState();
      }
    }

    if (inPosition && exchangeSaysPos !== 0 && exchangeSaysPos !== shares) {
      console.log(`🔄 External position change: ${shares} → ${exchangeSaysPos}. Syncing.`);
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
            `✅ ${mode === "long" ? "SELL" : "COVER"} FILLED id=${orderId} ALL @ ${exitPrice.toFixed(4)} `
            + `| reason=${meta.reason} | P&L=${colorPnL(realized)} | equity=${equity.toFixed(2)}`
          );
          notifyTelegram(
            `✅ ${mode === "long" ? "SELL" : "COVER"} FILLED ${symbol} ALL @ ${exitPrice.toFixed(4)} `
            + `| P&L=${usd(realized)} | equity=${usd(equity)}`
          );
        } else {
          equity += realized;
          console.log(
            `✅ PARTIAL ${mode === "long" ? "SELL" : "COVER"} id=${orderId} ${exitQty} @ ${exitPrice.toFixed(4)} `
            + `| reason=${meta.reason} | Realized=${colorPnL(realized)} | equity=${equity.toFixed(2)} `
            + `| remaining=${Math.abs(shares)}`
          );
          notifyTelegram(
            `✅ PARTIAL ${mode === "long" ? "SELL" : "COVER"} ${symbol} qty=${exitQty} @ ${exitPrice.toFixed(4)} `
            + `| Realized=${usd(realized)} | equity=${usd(equity)} | rem=${Math.abs(shares)}`
          );
          saveState();
        }
      }

      orders.delete(orderId);
      try { pollPositionsOnce(); } catch { }
      return;
    }
  });

  // Ticks (ONLY used for logging + bucket sampling source)
  ib.on(EventName.tickPrice, async (tickerId, field, price) => {
    if (tickerId !== mktDataTickerId) return;
    if (!(price > 0)) return;

    if (field === 1) bidPrice = price;
    else if (field === 2) askPrice = price;
    else if (field === 4) {
      lastPrice = price;

      const now = new Date();
      const t = hhmmss(now);
      const uPnL = inPosition ? ((lastPrice - entryPrice) * shares) : 0;

      console.log(
        `[${t}] ${symbol} bid=${bidPrice ? bidPrice.toFixed(4) : "0"} `
        + `ask=${askPrice ? askPrice.toFixed(4) : "0"} last=${lastPrice.toFixed(4)} `
        + `| mode=${mode} | holding=${inPosition ? shares : 0}`
        + (inPosition
          ? ` | entry=${entryPrice.toFixed(4)} | uPnL=${colorPnL(uPnL)} `
            + `| pendingExitQty=${pendingExitQty} | entryOrd=${openEntryOrderId ?? "none"} `
            + `| exitOrds=${openExitOrderIds.size}`
          : "")
        + ` | streaks(d=${downStreak},u=${upStreak})`
      );
    }
  });

  try {
    await ib.connect();
  } catch (e) {
    console.error("IB connect error:", e);
  }

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
  pollPositionsOnce();
}
