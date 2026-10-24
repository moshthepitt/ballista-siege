# Rules v0

The exact rules of one run. The TypeScript sim (`src/rules/`) and the on-chain templates (`src/chain/`) must produce identical state and events for every input; any difference is a bug in whichever side departs from this file. Numbers named in CAPS live in `src/rules/constants.ts`, the single source both sides import. Tuning changes those numbers only. A change to a formula's shape is a rules change: update this file first.

## Arithmetic

All values are unsigned 64-bit integers. Division floors. An operation that would overflow or go below zero is a bug in the rules, never a wrap: the sim throws where the chain would fail the transaction.

## Board

- 4 lanes (0 to 3, left to right) and 4 rows (0 is the front, where enemies arrive; 3 is the back).
- Cell index `i = lane * 4 + row`.
- The grid is one u64. Nibble `i` (bits `4i` to `4i+3`) holds the part code of cell `i`.
- Two cells are adjacent when they share an edge: same lane and rows differ by 1, or same row and lanes differ by 1.

| Code | Part | Effect |
| ---: | --- | --- |
| 0 | empty | |
| 1 | Ballista | Single-target damage in its lane |
| 2 | Cauldron | Damage to every enemy in its lane |
| 3 | Forge | Boosts adjacent Ballistas and Cauldrons |
| 4 | Watchtower | Boosts every Ballista in its row |
| 5 | Quarry | Gold each wave; more next to other Quarries |
| 6 | Palisade | Absorbs leaked damage in its lane |

## Run state

`day, wave, walls, gold, grid, score, done, won, bestDay, bestScore`

`wave` counts resolved waves (0 to WAVES).

## Randomness

Everyone who plays the same day sees the same offers and waves. There is no hidden information.

```
xorshift(x):            // 64-bit, shifts that drop bits are masked first
  x = x ^ ((x & (2^51 - 1)) << 13)
  x = x ^ (x >> 7)
  x = x ^ ((x & (2^47 - 1)) << 17)
  return x

roll(day, w, salt) = xorshift(xorshift(0x9E3779B97F4A7C15 ^ (day * 2654435761 + w * 40503 + salt)))
```

`day` is `floor(unix_timestamp / 86400)`, so `day * 2654435761` stays far below 2^64.

**Offers for wave `w`** (1-based): `x = roll(day, w, 0)`. Offer `k` (k = 0, 1, 2) is `(OFFER_TABLE >> (4 * ((x >> (16k)) & 0xF))) & 0xF`. `OFFER_TABLE` is a u64 of 16 part codes; repeating a code raises its odds. Offers can repeat.

**Enemies for wave `w`**: `y = roll(day, w, 1)`, `heavy = (y >> 32) & 3`. For lane `l`, with `b = (y >> (8l)) & 0xFF`:

```
swarm[l] = SWARM_BASE + SWARM_NUM * w / SWARM_DEN + b % (w + SWARM_SPREAD) + (l == heavy ? HEAVY_NUM * w / HEAVY_DEN : 0)
brute[l] = (w >= BRUTE_FROM_WAVE ? (b >> 5) % (w / BRUTE_DIV + 1) : 0) + (l == heavy && w >= HEAVY_BRUTE_FROM_WAVE ? 1 : 0)
swarmHp  = SWARM_HP_BASE + w / SWARM_HP_STEP
bruteHp  = BRUTE_HP_BASE + BRUTE_HP_PER_WAVE * w
```

## Actions

### start

Sets `day` from the clock and resets the run: `grid = STARTING_GRID, wave = 0, walls = WALLS_START, gold = 0, score = 0, done = false, won = false`. `bestDay` and `bestScore` survive. Allowed at any time, so a restart is always one action away.

### play(expectedWave, pick, cell)

Fails unless `done == false`, `expectedWave == wave`, `pick <= 2` and `cell <= 15`. Then, with `w = wave + 1`:

1. **Place.** `part = offer pick of wave w`. Cell `cell` becomes `part`, replacing whatever was there.
2. **Survey** the new grid. For each lane `l`:
   - `ST[l]` = sum over Ballistas in lane `l` of `BALLISTA_DMG + FORGE_ST * (adjacent Forges) + (WATCH_BONUS if any Watchtower is in the Ballista's row, else 0)`
   - `AOE[l]` = sum over Cauldrons in lane `l` of `CAULDRON_DMG + FORGE_AOE * (adjacent Forges)`
   - `SHIELD[l]` = `PALISADE_SHIELD * (Palisades in lane l)`

   And over the whole grid: `goldGain` = sum over Quarries of `QUARRY_GOLD + QUARRY_ADJ * (adjacent Quarries)`.
3. **Fight** each lane. AoE lands first, then single-target damage kills Brutes before Swarm:

   ```
   sEff = swarmHp - min(AOE[l], swarmHp)
   bEff = bruteHp - min(AOE[l], bruteHp)
   bk   = bEff == 0 ? brute[l] : min(brute[l], ST[l] / bEff)
   rest = ST[l] - bk * bEff
   sk   = sEff == 0 ? swarm[l] : min(swarm[l], rest / sEff)
   leak = BRUTE_LEAK * (brute[l] - bk) + SWARM_LEAK * (swarm[l] - sk)
   hit[l] = leak - min(leak, SHIELD[l])
   ```
4. **Settle.**

   ```
   walls = walls - min(walls, hit[0] + hit[1] + hit[2] + hit[3])
   gold  = gold + goldGain
   wave  = w
   done  = walls == 0 || w == WAVES
   won   = walls > 0 && w == WAVES
   score = 100 * (walls > 0 ? w : w - 1) + 10 * walls + gold
   ```

   When `done`: if `bestDay == day`, `bestScore = max(bestScore, score)`; otherwise `bestDay = day, bestScore = score`.
5. **Emit** one event for the client to animate: `w`, `pick`, `cell`, `part`, `walls`, `gold`, `goldGain`, `score`, `done`, `won`, and for each lane `swarm, brute, sk, bk, hit`.

## Starting constants

Tuning may change these values. The fun report (`reports/fun.md`) records why each one moved.

```
WAVES 10                WALLS_START 20
BALLISTA_DMG 4          FORGE_ST 3          WATCH_BONUS 2
CAULDRON_DMG 1          FORGE_AOE 1         PALISADE_SHIELD 2
QUARRY_GOLD 1           QUARRY_ADJ 1
SWARM_HP_BASE 1         SWARM_HP_STEP 3     SWARM_LEAK 1
BRUTE_HP_BASE 8         BRUTE_HP_PER_WAVE 2 BRUTE_LEAK 3
BRUTE_FROM_WAVE 3       HEAVY_BRUTE_FROM_WAVE 5  BRUTE_DIV 3
SWARM_BASE 0            SWARM_NUM 1         SWARM_DEN 1         SWARM_SPREAD 2
HEAVY_NUM 1             HEAVY_DEN 1
STARTING_GRID 0
OFFER_TABLE 0x6655443322111654   (each of parts 1 to 6 appears at least twice)
```

Products such as `SWARM_NUM * w` are computed before the division, in that order.
