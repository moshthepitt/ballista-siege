import { fight, type RunState } from '../src/v1/sim.js';
/** Branch result replaces one wave; future points use no more purchases. */
export function branchWallCurve(prefix: readonly { wave: bigint; walls: bigint }[], result: RunState) {
  const points = prefix.filter(p => p.wave < result.wave).map(p => ({ ...p }));
  let state = { ...result };
  points.push({ wave: state.wave, walls: state.walls });
  while (!state.done) { state = fight(state).state; points.push({ wave: state.wave, walls: state.walls }); }
  return points;
}
