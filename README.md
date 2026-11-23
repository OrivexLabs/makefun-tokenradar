# makefun-tokenradar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/OrivexLabs/makefun-tokenradar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/OrivexLabs/makefun-tokenradar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar built from a sealed DefiLlama snapshot of 758 protocols. A self-taught valuation model — category mcap/TVL multiples learned from the snapshot's already-traded protocols, shrunk toward the global median, with growth, tokenless-age and multi-chain factors — ranks 198 early protocols by implied value. Every row carries a 7-step farm plan with cost and time estimates, and the board ships as a dark dashboard with sorting, category/watchlist filters and a per-protocol detail panel. Output is deterministic: two runs are byte-identical, including the dossier.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=silver-beacon-98-6815&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
