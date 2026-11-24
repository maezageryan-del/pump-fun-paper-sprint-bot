// Breakout Rider + Scout — a paper-trading bot for pump.fun replays.
//
// Two tiers share one exit machine on the agent-fun/replay/v2 harness:
//   - RIDER: buys only coins that jumped >=130% over their last 10 trades
//     and sit within 3% of that window's high, with >= 3 SOL real reserve.
//     Stake 0.05 SOL. This tier hunts the rare runners that pay for the
//     whole window; winners stay open under a trailing stop, never a fixed
//     take-profit.
//   - SCOUT: buys coins up >=45% over their last 20 trades, within 5% of
//     the window high, with >= 2 SOL real reserve. Stake 0.012 SOL — just
//     above the 0.01 SOL round-trip bar. This tier exists to buy breadth
//     cheaply: the guardrail needs 20 distinct round-tripped mints inside
//     a 6-hour final window, and a selective rider alone trades only 4-5
//     coins in a quiet 6h stretch. The scout's bleed is capped by its tiny
//     stake and by a 500-slot re-entry cooldown after any exit.
//
// Exits (whole position, first trigger wins, both tiers): hard stop -5% vs
// cost net of fees, trailing stop -10% from the position's peak value, time
// exit after 300 trades held (rider) / 150 trades (scout).
//
// Latency is the enemy: orders decided on slot s fill at s+2, by which time
// a hot coin has often peaked, so buys carry a 200 bps slippage cap and the
// stops are tight. Deterministic: a pure function of the hello line and the
// batches — exact bigint price math, no clock, no environment, no randomness.
// stdout carries replies only; diagnostics go to stderr.

import { runBot, LAMPORTS_PER_SOL, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

const LAMPORTS = LAMPORTS_PER_SOL;
const BPS = 10_000n;
/** Curve fee each way, in bps (95 protocol + 30 creator). */
const FEE_BPS = 125n;
/** A buy must clear the 0.01 SOL round-trip bar. */
const MIN_BUY_LAMPORTS = 10_000_000n;
/** How many trade prices to remember per coin (covers the 20-trade window). */
const MAX_HISTORY = 25;
/** Max slippage a fill may suffer vs the decision-time price, in bps. */
const MAX_SLIPPAGE_BPS = 200;

interface Tier {
  /** Minimum rise over the window, in bps (13000 = +130%). */
  riseBps: bigint;
  /** Trades back the rise is measured over. */
  windowTrades: number;
  /** Price must sit within this of the window high, in bps. */
  nearHighBps: bigint;
  /** Minimum real SOL reserve, in lamports. */
  minRealLamports: bigint;
  /** Target stake per coin, in lamports. */
  stakeLamports: bigint;
  /** Hard stop vs cost, in bps. */
  stopBps: bigint;
  /** Trailing stop vs peak value, in bps. */
  trailBps: bigint;
  /** Time exit after this many trades held. */
  holdTrades: number;
  /** Max concurrent positions of this tier (buys pending included). */
  maxConcurrent: number;
  /** Slots to wait after an exit on a coin before re-entering it. */
  cooldownSlots: number;
}

const RIDER: Tier = {
  riseBps: 13_000n,
  windowTrades: 10,
  nearHighBps: 300n,
  minRealLamports: 3n * LAMPORTS,
  stakeLamports: 50_000_000n,
  stopBps: 500n,
  trailBps: 1_000n,
  holdTrades: 300,
  maxConcurrent: 5,
  cooldownSlots: 0,
};

const SCOUT: Tier = {
  riseBps: 4_500n,
  windowTrades: 20,
  nearHighBps: 500n,
  minRealLamports: 2n * LAMPORTS,
  stakeLamports: 12_000_000n,
  stopBps: 500n,
  trailBps: 1_000n,
  holdTrades: 150,
  maxConcurrent: 2,
  cooldownSlots: 500,
};

const TIERS: Tier[] = [RIDER, SCOUT];

interface PricePoint {
  vsol: bigint;
  vtok: bigint;
}

interface CoinTrack {
  /** Last trade prices, oldest first, capped at MAX_HISTORY. */
  prices: PricePoint[];
  /** Latest real SOL reserve, in lamports. */
  realSolLamports: bigint;
  /** Trades seen on this coin. */
  trades: number;
  /** Its CompleteEvent arrived: no more orders. */
  complete: boolean;
}

interface Held {
  /** Index into TIERS. */
  tier: number;
  /** Tokens held, as last reported by the account. */
  tokens: bigint;
  /** SOL spent on the tokens still held, fees included. */
  costLamports: bigint;
  /** Highest net-of-fee value the position has reached, in lamports. */
  peakLamports: bigint;
  /** Trade count on the coin when the position opened. */
  entryTrades: number;
}

/** priceA >= priceB, as ratios vsol/vtok, without floats. */
function priceGte(a: PricePoint, b: PricePoint): boolean {
  return a.vsol * b.vtok >= b.vsol * a.vtok;
}

/** priceNow >= priceThen * (BPS + riseBps) / BPS — a rise of at least riseBps. */
function roseBy(now: PricePoint, then: PricePoint, riseBps: bigint): boolean {
  return now.vsol * then.vtok * BPS >= then.vsol * now.vtok * (BPS + riseBps);
}

/** priceNow >= high * (BPS - nearHighBps) / BPS — within nearHighBps of the high. */
function nearHigh(now: PricePoint, high: PricePoint, nearHighBps: bigint): boolean {
  return now.vsol * high.vtok * BPS >= high.vsol * now.vtok * (BPS - nearHighBps);
}

/** Net-of-fee value of `tokens` at `price`, in lamports. */
function netValueLamports(tokens: bigint, price: PricePoint): bigint {
  if (price.vtok === 0n) return 0n;
  return (tokens * price.vsol * (BPS - FEE_BPS)) / (price.vtok * BPS);
}

const tracks = new Map<string, CoinTrack>();
const held = new Map<string, Held>();
const lastExitSlot = new Map<string, number>();
const pendingTier = new Map<string, number>();
let clientCounter = 0;
let batchesAnswered = 0;

function trackOf(mint: string): CoinTrack {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = { prices: [], realSolLamports: 0n, trades: 0, complete: false };
    tracks.set(mint, t);
  }
  return t;
}

function tierCount(tier: number, state: BotState, extraBuys: number): number {
  let n = 0;
  for (const h of held.values()) if (h.tier === tier) n++;
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy' && pendingTier.get(p.order.client_id) === tier) n++;
  }
  return n + extraBuys;
}

async function main(): Promise<void> {
  await runBot({
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      batchesAnswered++;

      // 1. Fold this batch's fills into the bookkeeping. The tier of a buy
      // is the one recorded when its order was issued (pendingTier); a
      // rider buy capped at 1% of reserve can be smaller than a scout
      // stake, so the tier must never be guessed from the amount spent.
      for (const fill of batch.fills) {
        const fillTier = pendingTier.get(fill.client_id);
        pendingTier.delete(fill.client_id);
        if (fill.status !== 'filled') continue;
        if (fill.side === 'buy') {
          const tokens = BigInt(fill.token_amount);
          const cost = BigInt(fill.quote_lamports);
          const track = tracks.get(fill.mint);
          const price = track !== undefined && track.prices.length > 0
            ? track.prices[track.prices.length - 1]
            : null;
          const existing = held.get(fill.mint);
          if (existing !== undefined) {
            existing.tokens += tokens;
            existing.costLamports += cost;
            if (price !== null) {
              const value = netValueLamports(existing.tokens, price);
              if (value > existing.peakLamports) existing.peakLamports = value;
            }
          } else {
            const value = price !== null ? netValueLamports(tokens, price) : cost;
            held.set(fill.mint, {
              tier: fillTier ?? 0,
              tokens,
              costLamports: cost,
              peakLamports: value,
              entryTrades: track !== undefined ? track.trades : 0,
            });
          }
        } else {
          // A sell fill — ours or a harness close — ends the position.
          held.delete(fill.mint);
          lastExitSlot.set(fill.mint, state.slot);
        }
      }

      // 2. Fold this batch's events into the per-coin tracks.
      const touched: string[] = [];
      const seenTouched = new Set<string>();
      for (const event of batch.events) {
        const track = trackOf(event.mint);
        if (event.event === 'TradeEvent') {
          const vsol = BigInt(event.virtual_sol_reserves);
          const vtok = BigInt(event.virtual_token_reserves);
          if (vsol > 0n && vtok > 0n) {
            track.prices.push({ vsol, vtok });
            if (track.prices.length > MAX_HISTORY) track.prices.shift();
          }
          track.realSolLamports = BigInt(event.real_sol_reserves);
          track.trades++;
          if (!seenTouched.has(event.mint)) {
            seenTouched.add(event.mint);
            touched.push(event.mint);
          }
        } else if (event.event === 'CreateEvent') {
          track.realSolLamports = 0n;
        } else {
          track.complete = true;
        }
      }

      // 3. Refresh peaks from the latest prices, then decide exits.
      const orders: OrderInput[] = [];
      const busy = new Set<string>();
      for (const p of state.pending.values()) busy.add(p.order.mint);
      const txFee = state.txFeeLamports();
      for (const [mint, h] of held) {
        const track = tracks.get(mint);
        if (track === undefined || track.prices.length === 0) continue;
        const price = track.prices[track.prices.length - 1];
        const holding = state.positions.get(mint);
        if (holding !== undefined) h.tokens = holding.token_amount;
        const value = netValueLamports(h.tokens, price);
        if (value > h.peakLamports) h.peakLamports = value;
        if (busy.has(mint)) continue;
        const tier = TIERS[h.tier];
        const stopAt = (h.costLamports * (BPS - tier.stopBps)) / BPS;
        const trailAt = (h.peakLamports * (BPS - tier.trailBps)) / BPS;
        const heldTrades = track.trades - h.entryTrades;
        if (value <= stopAt || value <= trailAt || heldTrades >= tier.holdTrades) {
          orders.push({
            side: 'sell',
            client_id: `s${++clientCounter}`,
            mint,
            token_amount: h.tokens,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          busy.add(mint);
        }
      }

      // 4. Decide entries on coins that traded in this batch.
      let newBuys = 0;
      for (const mint of touched) {
        if (orders.length >= 16) break;
        if (held.has(mint) || busy.has(mint)) continue;
        const track = tracks.get(mint);
        if (track === undefined || track.complete) continue;
        const lastExit = lastExitSlot.get(mint);
        for (let ti = 0; ti < TIERS.length; ti++) {
          const tier = TIERS[ti];
          if (state.committedPositionCount() + newBuys >= 5) break;
          if (tierCount(ti, state, 0) >= tier.maxConcurrent) continue;
          if (lastExit !== undefined && state.slot - lastExit < tier.cooldownSlots) continue;
          if (track.prices.length < tier.windowTrades + 1) continue;
          if (track.realSolLamports < tier.minRealLamports) continue;
          const n = track.prices.length;
          const now = track.prices[n - 1];
          const then = track.prices[n - 1 - tier.windowTrades];
          if (!roseBy(now, then, tier.riseBps)) continue;
          let high = then;
          for (let j = n - 1 - tier.windowTrades; j < n; j++) {
            if (priceGte(track.prices[j], high)) high = track.prices[j];
          }
          if (!nearHigh(now, high, tier.nearHighBps)) continue;
          const cap = state.maxBuyLamports(mint);
          const spend = tier.stakeLamports < cap ? tier.stakeLamports : cap;
          if (spend < MIN_BUY_LAMPORTS) continue;
          if (state.freeCashLamports() < spend + txFee * BigInt(newBuys + 1)) continue;
          const clientId = `b${++clientCounter}`;
          pendingTier.set(clientId, ti);
          orders.push({
            side: 'buy',
            client_id: clientId,
            mint,
            quote_lamports: spend,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          busy.add(mint);
          newBuys++;
          break;
        }
      }

      return orders;
    },

    onDone(state: BotState): void {
      console.error(
        `done after ${batchesAnswered} batches: cash=${state.cash} lamports, ` +
          `open positions=${state.positions.size}`,
      );
    },
  });
}

await main();
