# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/rezasgimang/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/rezasgimang/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Build the best token launch radar. It reads a sealed snapshot of every protocol DefiLlama tracks, works out which ones still record no token and are not a wrapped or staked product of one that trades, and ranks them by what their launch would be worth — then hands in a web dashboard that shows the board, a detail view for each protocol and the steps to farm it.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

`main.ts` (Node 22, standard library only) reads the snapshot, fits the value curve on the traded comparables, writes the ranked board to `board.json`, the dashboard's data to `data.js`, copies `dashboard/` and `screenshots/` to the output, and writes `dossier.json` with the vendored make.fun library.

## The model

A fitted curve, not a flat multiple: `log10(market cap) = a + b × log10(seasoned TVL)`, fitted by least squares on the traded protocols that carry both a market cap and a TVL. The TVL is seasoned by its week's growth first — hot money is read at last week's size. The dashboard prints the fitted coefficients, the leave-one-out and walk-forward blind tests, a model-comparison table, and the P10–P25–P75–P90 range on every implied value. Age as a term was tested and dropped: the blind tests did not keep it.

Every row carries a costed farm plan at a $1,000 deposit (the dashboard toggles to $10,000): the slice if the token launches, gas plus the yield given up, the break-even launch odds, the expected net per hour, and a FARM / MARGINAL / SKIP verdict. The best farms are small and young — a big TVL thins the slice.

## The dashboard

`dashboard/` is a static page that renders with no network. It shows the KPI strip, the full coverage accounting (every protocol in the snapshot, ranked or set aside with its reason), the fitted curve on a scatter plot, the model table, and the sortable, filterable board with a detail view per protocol.

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
