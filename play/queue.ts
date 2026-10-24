import { applyAction, type Action, type RunState } from '../src/v1/sim.js';
import { LIMITS } from '../src/v1/constants.js';

export type ActionResult = { ok: true } | { ok: false; reason: string };
export const rebuild = (start: RunState, actions: readonly Action[]): RunState =>
  actions.reduce((state, action) => applyAction(state, action), { ...start });

export function actionReason(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Action unavailable';
  const reasons: Record<string, string> = {
    'not enough gold': 'Not enough gold. Sell a part or choose a cheaper offer.',
    'cell occupied': 'Cell occupied. Choose an empty cell.',
    'offer sold': 'That offer is sold. Choose another card or reroll.',
    'too many actions': `Max ${LIMITS.ACTIONS} actions this turn. Undo an action or fight.`,
    'cannot upgrade': `Select a part below tier ${LIMITS.TIERS} to upgrade.`,
    'cannot sell': 'Select a placed part to sell.',
    'run is over': 'This siege is over. Retry or start a new seed.',
    'overclock needs tier-three weapon or Palisade': `Requires a tier ${LIMITS.TIERS} Ballista, Cauldron or Palisade.`,
    'already overclocked': 'Already charged for this wave. Resets after battle.',
  };
  return reasons[message] ?? message;
}

export class BuildQueue {
  readonly start: RunState;
  private commands: Action[] = [];
  private undoFloor = 0;
  private built: RunState;
  constructor(start: RunState) { this.start = { ...start }; this.built = { ...start }; }
  get state(): RunState { return { ...this.built }; }
  get actions(): readonly Action[] { return this.commands.map(a => ({ ...a })); }
  get canUndo(): boolean { return this.commands.length > this.undoFloor; }
  get locked(): number { return this.undoFloor; }
  attempt(action: Action): ActionResult {
    try {
      const actions = [...this.commands, action];
      const next = rebuild(this.start, actions);
      this.commands = actions;
      this.built = next;
      // Keep revealed shop information committed, including the paid reroll.
      if (action.type === 'reroll') this.undoFloor = actions.length;
      return { ok: true };
    } catch (error) { return { ok: false, reason: actionReason(error) }; }
  }
  undo(): ActionResult {
    if (!this.canUndo) return { ok: false, reason: this.undoFloor
      ? 'Reroll committed earlier actions. Only later actions can be undone.' : 'No actions to undo.' };
    this.commands.pop();
    this.built = rebuild(this.start, this.commands);
    return { ok: true };
  }
}
