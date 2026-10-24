import { performance } from 'node:perf_hooks';
import { C, PART_NAMES } from '../src/rules/constants.js';
import { runBot, type BotName, type BotRun } from '../src/bots/index.js';
import { adjacent, boardOf, legalMoves, partAt, positionOf, prepareDay, step } from '../src/bots/kernel.js';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const days = Number(arg('--days', '300')), firstDay = BigInt(arg('--start', '20000'));
const width = Number(arg('--width', '80'));
const bots = arg('--bots', 'random,greedy,heuristic,expert').split(',') as BotName[];
if (!Number.isInteger(days) || days < 1 || !Number.isInteger(width) || width < 1 ||
    bots.some(b => !['random', 'greedy', 'heuristic', 'expert'].includes(b))) throw new Error('Invalid funtest arguments');
const percentile = (xs: number[], q: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : 0;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const round = (n: number) => Math.round(n * 100) / 100;
const summaries: Record<string, unknown> = {};
const runs = new Map(bots.map(b => [b, [] as BotRun[]]));
const picks = Array(7).fill(0) as number[];
let samples = 0, combosForge = 0, combosWatch = 0, combosQuarry = 0, winningBoards = 0;
let quarryPicks = 0, quarryImmediateWallSacrifices = 0, replacements = 0, anyWin = 0;
const distinct: number[] = [], gaps: number[] = [], wallGaps: number[] = [];
const expertFailures: string[] = [], started = performance.now();
for (let i = 0; i < days; i++) {
  const day = firstDay + BigInt(i), d = prepareDay(day);
  let won = false;
  for (const bot of bots) {
    const run = runBot(day, bot, { width }, d);
    runs.get(bot)!.push(run); won ||= run.state.won;
    if (bot !== 'expert') continue;
    if (!run.state.won) expertFailures.push(day.toString());
    run.events.forEach((event, w) => {
      picks[Number(event.part)]++;
      const before = positionOf(run.states[w]);
      if (partAt(before, run.moves[w].cell) !== 0) replacements++;
      if (event.part === 5n) {
        quarryPicks++;
        const bestWalls = Math.max(...legalMoves(d, w).map(m => step(before, w, m, d).walls));
        if (Number(event.walls) < bestWalls) quarryImmediateWallSacrifices++;
      }
      // At most 600 states, distributed across days and waves. All 48 actions,
      // including duplicate offers. Distinct outcomes omit grid identity.
      if (i % Math.max(1, Math.ceil(days / 60)) === 0) {
        const outcomes = legalMoves(d, w, false).map(m => step(before, w, m, d));
        distinct.push(new Set(outcomes.map(n => `${n.walls}:${n.gold}`)).size);
        const scores = outcomes.map(n => 100 * (n.walls > 0 ? w + 1 : w) + 10 * n.walls + n.gold);
        gaps.push(Math.max(...scores) - Math.min(...scores));
        wallGaps.push(Math.max(...outcomes.map(n => n.walls)) - Math.min(...outcomes.map(n => n.walls)));
        samples++;
      }
    });
    if (run.state.won) {
      winningBoards++;
      const board = boardOf(run.state.grid), watched = new Set<number>();
      for (let cell = 0; cell < 16; cell++) if (partAt(board, cell) === 4) watched.add(cell % 4);
      let forge = false, watch = false, quarry = false;
      for (let cell = 0; cell < 16; cell++) {
        const part = partAt(board, cell);
        if ((part === 1 || part === 2) && adjacent[cell].some(n => partAt(board, n) === 3)) forge = true;
        if (part === 1 && watched.has(cell % 4)) watch = true;
        if (part === 5 && adjacent[cell].some(n => partAt(board, n) === 5)) quarry = true;
      }
      combosForge += +forge; combosWatch += +watch; combosQuarry += +quarry;
    }
  }
  anyWin += +won;
  if ((i + 1) % 50 === 0) process.stderr.write(`${i + 1}/${days} days, ${round((performance.now() - started) / 1000)}s\n`);
}
for (const [bot, results] of runs) {
  const deathHistogram: Record<string, number> = {};
  for (const r of results) if (!r.state.won) {
    const key = r.state.wave.toString(); deathHistogram[key] = (deathHistogram[key] ?? 0) + 1;
  }
  const scores = results.map(r => Number(r.state.score)), winners = results.filter(r => r.state.won);
  const deaths = results.filter(r => !r.state.won).map(r => Number(r.state.wave));
  summaries[bot] = {
    wins: winners.length, winPct: round(winners.length * 100 / days), deathWaveHistogram: deathHistogram,
    medianDeathWave: percentile(deaths, 0.5),
    score: { min: Math.min(...scores), p10: percentile(scores, 0.1), median: percentile(scores, 0.5), p90: percentile(scores, 0.9), max: Math.max(...scores) },
    meanGold: round(mean(results.map(r => Number(r.state.gold)))),
    meanGoldScorePct: round(mean(results.map(r => Number(r.state.gold) * 100 / Number(r.state.score || 1n)))),
    winningMeanWalls: round(mean(winners.map(r => Number(r.state.walls)))),
    winningMeanGold: round(mean(winners.map(r => Number(r.state.gold)))),
  };
}
const pickTotal = picks.reduce((a, b) => a + b, 0);
console.log(JSON.stringify({
  days, firstDay: firstDay.toString(), lastDay: (firstDay + BigInt(days - 1)).toString(), width,
  seconds: round((performance.now() - started) / 1000),
  constants: Object.fromEntries(Object.entries(C).map(([key, value]) =>
    [key, key === 'STARTING_GRID' || key === 'OFFER_TABLE' ? `0x${value.toString(16)}` : Number(value)])),
  bots: summaries,
  expertPickSharePct: Object.fromEntries(PART_NAMES.slice(1).map((name, i) => [name, round(picks[i + 1] * 100 / (pickTotal || 1))])),
  expertFailedWinSearchPct: round(expertFailures.length * 100 / days), expertFailedDays: expertFailures,
  noBotFoundWinPct: round((days - anyWin) * 100 / days),
  // Both are search failure rates, not proofs of unwinnability.
  decisionSpread: { samples, meanDistinctSettlementsOf48: round(mean(distinct)), medianDistinct: percentile(distinct, 0.5),
    meanBestWorstScoreGap: round(mean(gaps)), medianScoreGap: percentile(gaps, 0.5), meanWallGap: round(mean(wallGaps)) },
  expertWinningBoardCombos: { boards: winningBoards, forgeAdjacencyPct: round(combosForge * 100 / (winningBoards || 1)),
    watchedBallistaRowPct: round(combosWatch * 100 / (winningBoards || 1)), quarryClusterPct: round(combosQuarry * 100 / (winningBoards || 1)) },
  expertQuarryPicks: quarryPicks, expertQuarryImmediateWallSacrifices: quarryImmediateWallSacrifices,
  expertReplacementPct: round(replacements * 100 / (pickTotal || 1)),
}, (_, v) => typeof v === 'bigint' ? `0x${v.toString(16)}` : v, 2));
