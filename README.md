[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/maezageryan-del/pump-fun-paper-sprint-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/maezageryan-del/pump-fun-paper-sprint-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Breakout Rider + Scout — pump.fun paper bot

A paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
(make.fun bounty `u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b`): one
TypeScript program, `main.ts`, that speaks `agent-fun/replay/v2` on
stdin/stdout. The house replays it on 6 hours of real pump.fun data after
entries close; highest net PnL wins. No real money, no entry fee.

## Strategy

Two tiers share one exit machine:

- **Rider (PnL tier):** buys only coins up **>=130% over their last 10
  trades**, within 3% of that window's high, with >= 3 SOL real reserve.
  Stake **0.05 SOL** per coin. This tier hunts the rare runners that pay for
  the whole window; winners stay open under a trailing stop, never a fixed
  take-profit.
- **Scout (breadth tier):** buys coins up **>=45% over their last 20
  trades**, within 5% of the window high, with >= 2 SOL real reserve. Stake
  **0.012 SOL** — just above the 0.01 SOL round-trip bar. This tier exists
  to buy breadth cheaply: the guardrail needs 20 distinct round-tripped
  mints inside a 6-hour final window, and a selective rider alone trades
  only 4–5 coins in a quiet 6h stretch. The scout's bleed is capped by its
  tiny stake and by a 500-slot re-entry cooldown after any exit.

**Exits** (whole position, first trigger wins, both tiers): hard stop **-5%**
vs cost net of fees, trailing stop **-10%** from the position's peak value,
time exit after 300 trades held (rider) / 150 trades (scout).

**Latency discipline:** orders decided on slot s fill at s+2, by which time a
hot coin has often peaked, so buys carry a **200 bps slippage cap** and the
stops are tight. At most 5 open positions, at most 16 orders per reply, buys
capped at 1% of a coin's real SOL reserve per reply.

Deterministic: a pure function of the hello line and the batches — exact
bigint price math, no clock, no environment, no randomness. stdout carries
replies only; diagnostics go to stderr.

## Measured results (grade-local, DEV window — honest numbers)

Run with the kit grader on the 24h dev window (process driver; the server's
docker sandbox records a different `result_sha256` because it runs Node
v26.13.1 vs local v24.22.1):

| | |
|---|---|
| Net PnL (DEV) | **-0.1109 SOL** (return -1.11%) |
| 90% interval | -0.2623 … +0.0216 SOL |
| Round trips | 186 over 156 coins, win rate 28.0% |
| Max drawdown | 1.57% |
| Fees | 0.0654 SOL curve + 0.0398 SOL tx; at 2x fees net PnL -0.2144 SOL |
| Top 3 coins | 30% of the gains; without them net PnL is -0.18 SOL |
| Guardrails | met (156 coins with a round trip >= 0.01 SOL, drawdown ok) |
| Determinism | L1 regrade reproduced byte for byte |

The DEV number is negative, like 7 of the 8 graded field entries (best
visible field score: +0.0335 SOL) and like the best measured single-tier
config from the sibling bounty (-0.087 SOL). The final window is different
coins, so this is a bet on the shape — guardrail-safe breadth plus
uncapped runner upside — not a promise of a positive final score. What the
sweep proved, over 9 grade-local configs: the rider alone is profitable on
dev (+0.0126 SOL) but trades only 13 coins and **fails the guardrail**;
the scout tier is what buys the 20-coin bar, at ~0.10 SOL of dev bleed;
a 500-slot re-entry cooldown is worth ~0.08 SOL (without it: -0.2333);
and a tighter 200 bps slippage cap beats 500 bps (-0.0768 vs -0.0849 on
the +50% scout).

## Files

- `main.ts` — the bot (entrypoint, run as `node main.ts` on Node 22).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored as the kit
  instructs (kept out of authorship counts).
- `.makefun/owner.json` — payout wallet claim file.
- `LICENSE` — MIT.

## Run it locally

```sh
# from the kit directory:
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --worktree
```
