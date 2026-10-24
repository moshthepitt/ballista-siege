import { C, PART_NAMES } from '../src/rules/constants.js';
import {
  cellOf,
  enemies,
  offers,
  partAt,
  play as simulatePlay,
  survey,
  type WaveEvent,
} from '../src/rules/sim.js';
import { LocalBackend, dayFromSearch, type GameBackend } from './backend.js';
import { ChainBackend, type BurnerStorage } from './chain-backend.js';

const letters = ['·', 'B', 'C', 'F', 'W', 'Q', 'P'];
const effects = [
  '',
  `${C.BALLISTA_DMG} ST in its lane.`,
  `${C.CAULDRON_DMG} AOE to every enemy in its lane.`,
  `Adjacent Ballistas get +${C.FORGE_ST} ST; Cauldrons get +${C.FORGE_AOE} AOE.`,
  `Ballistas in the same row get +${C.WATCH_BONUS} ST.`,
  `${C.QUARRY_GOLD} gold each wave, +${C.QUARRY_ADJ} per adjacent Quarry.`,
  `${C.PALISADE_SHIELD} SHIELD in its lane.`,
];

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing UI element: ${selector}`);
  return found;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function mountGame(backend: GameBackend, options: { label?: string; notice?: string } = {}): Promise<void> {
  const app = element<HTMLElement>('#game');
  app.innerHTML = `
    <header>
      <div><p class="eyebrow" id="backend-label"></p><h1>Ballista Defence</h1></div>
      <button id="restart" type="button">Restart</button>
    </header>
    <p id="backend-notice" class="backend-notice" role="status" hidden></p>
    <p id="transaction-status" class="transaction-status" role="status" aria-live="polite"></p>
    <p id="chain-mismatch" role="alert" hidden></p>
    <div class="stats" aria-label="Run state">
      <div><span>Day</span><strong id="day">—</strong></div>
      <div><span>Wave</span><strong id="wave">0/${C.WAVES}</strong></div>
      <div><span>Walls</span><strong id="walls">—</strong></div>
      <div><span>Gold</span><strong id="gold">0</strong></div>
      <div><span>Score</span><strong id="score">0</strong></div>
    </div>
    <p id="error" role="alert" hidden></p>
    <section id="result" aria-labelledby="result-title" hidden>
      <h2 id="result-title" tabindex="-1"></h2>
      <p id="result-score"></p>
      <label for="share">Share your run</label>
      <div class="share"><input id="share" readonly /><button id="copy" type="button">Copy</button></div>
      <button id="retry" type="button">Play again</button>
    </section>
    <section aria-label="Choose a part">
      <p class="section-label">1. Choose a part <span>keys 1 / 2 / 3</span></p>
      <div id="offers" class="offers"></div>
      <p id="selected-effect" class="hint">Choose one of the three parts.</p>
    </section>
    <section aria-label="Siege board">
      <p class="section-label">2. Place in any square <span>replaces its part</span></p>
      <p id="preview" class="preview" role="status" aria-live="polite">Hover or focus a square to preview the wave.</p>
      <p id="incoming-title" class="board-label"></p>
      <div id="incoming" class="four-columns"></div>
      <p class="edge-label">Row 0 · front · enemies enter from above ↓</p>
      <div class="board-wrap">
        <div id="board" class="board" role="group" aria-label="4 lanes by 4 rows"></div>
        <div id="animation" class="animation" aria-hidden="true"></div>
      </div>
      <p class="edge-label back">Row 3 · back · walls</p>
      <p id="survey-title" class="board-label">Lane survey</p>
      <div id="survey" class="four-columns"></div>
      <div id="lane-results" class="four-columns lane-results" aria-label="Last wave per lane"></div>
      <p id="wave-result" class="wave-result" role="status" aria-live="polite">Survive ${C.WAVES} waves. Every placement starts the next wave.</p>
    </section>
    <details>
      <summary>Parts & rules</summary>
      <p>AOE hits every enemy first. ST kills Brutes before Swarm. SHIELD absorbs leaked damage. Gold adds to your score.</p>
      <p>Forge adjacency means shared edges. Watchtower bonuses do not stack in a row. Parts work across the whole lane; row position only changes bonuses.</p>
      <div class="legend">${PART_NAMES.slice(1).map((name, index) => `
        <div><span class="part-key part-${index + 1}">${letters[index + 1]}</span><p><strong>${name}</strong> ${effects[index + 1]}</p></div>
      `).join('')}</div>
      <p>Same UTC day, same offers and waves. Restart to try another placement.</p>
    </details>
  `;
  element('#backend-label').textContent = `Daily siege · ${options.label ?? 'local simulation'}`;

  let selected: bigint | null = null;
  let hovered: bigint | null = null;
  let busy = false;
  let ready = false;
  let lastEvent: WaveEvent | null = null;
  let lastMessage = `Survive ${C.WAVES} waves. Every placement starts the next wave.`;

  const offerButtons = Array.from({ length: 3 }, (_, pick) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.pick = String(pick);
    button.addEventListener('click', () => choose(BigInt(pick)));
    element('#offers').append(button);
    return button;
  });

  const cells = new Map<bigint, HTMLButtonElement>();
  for (let row = 0n; row < 4n; row++) {
    for (let lane = 0n; lane < 4n; lane++) {
      const cell = cellOf(lane, row);
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.cell = String(cell);
      button.addEventListener('pointerenter', () => preview(cell));
      button.addEventListener('focus', () => preview(cell));
      button.addEventListener('pointerleave', () => { if (hovered === cell) preview(null); });
      button.addEventListener('blur', () => { if (hovered === cell) preview(null); });
      button.addEventListener('click', () => { void place(cell); });
      element('#board').append(button);
      cells.set(cell, button);
    }
  }

  function choose(pick: bigint): void {
    if (!ready || busy || backend.state().done) return;
    selected = pick;
    render();
  }

  function preview(cell: bigint | null): void {
    if (busy || !ready) return;
    hovered = cell;
    render();
  }

  function render(): void {
    const state = backend.state();
    const status = backend.status?.();
    const waveEvent = status?.optimisticEvent ?? lastEvent;
    const locked = !ready || busy || Boolean(status?.pending || status?.mismatch) || state.done;
    const wave = busy && waveEvent ? waveEvent.w : state.done ? state.wave : state.wave + 1n;
    const parts = offers(state.day, wave);
    const incoming = enemies(state.day, wave);
    let proposed = null;
    if (!locked && selected !== null && hovered !== null) {
      proposed = simulatePlay(state, state.wave, selected, hovered);
    }
    const laneSurvey = survey(proposed?.state.grid ?? state.grid);

    for (const key of ['day', 'walls', 'gold', 'score'] as const) element(`#${key}`).textContent = String(state[key]);
    element('#wave').textContent = `${state.wave}/${C.WAVES}`;
    element('#walls').classList.toggle('danger', state.walls === 0n);
    element<HTMLButtonElement>('#restart').disabled = busy;
    app.setAttribute('aria-busy', String(busy));
    const notice = [options.notice, status?.warning].filter(Boolean).join(' ');
    element('#backend-notice').textContent = notice;
    element('#backend-notice').hidden = !notice;
    element('#transaction-status').textContent = status
      ? [status.phase, status.signature ? `tx ${status.signature}` : '', status.computeUnits === undefined ? '' : `${status.computeUnits} CU`].filter(Boolean).join(' · ')
      : 'Local simulation · no chain transactions';
    element('#chain-mismatch').textContent = status?.mismatch ?? '';
    element('#chain-mismatch').hidden = !status?.mismatch;

    offerButtons.forEach((button, pick) => {
      const part = Number(parts[pick]);
      button.className = `offer part-${part}`;
      button.innerHTML = `<span class="offer-shortcut">${pick + 1}</span><span class="offer-letter">${letters[part]}</span><span class="offer-name">${PART_NAMES[part]}</span>`;
      button.setAttribute('aria-pressed', String(selected === BigInt(pick)));
      button.setAttribute('aria-label', `Offer ${pick + 1}: ${PART_NAMES[part]}. ${effects[part]}`);
      button.title = effects[part];
      button.disabled = locked;
    });
    element('#selected-effect').textContent = state.done ? 'Run finished. Restart to play again.'
      : selected === null ? 'Choose one of the three parts.'
      : `${PART_NAMES[Number(parts[Number(selected)])]}: ${effects[Number(parts[Number(selected)])]}`;

    for (const [cell, button] of cells) {
      const currentPart = Number(partAt(state.grid, cell));
      const ghost = proposed !== null && hovered === cell;
      const part = ghost ? Number(parts[Number(selected)]) : currentPart;
      button.className = `cell part-${part}${ghost ? ' ghost' : ''}`;
      button.textContent = letters[part];
      button.disabled = locked;
      button.setAttribute('aria-label', `Lane ${cell / 4n}, row ${cell % 4n}: ${PART_NAMES[currentPart]}${ghost ? `; preview ${PART_NAMES[part]}` : ''}`);
      button.title = `Lane ${cell / 4n}, row ${cell % 4n}: ${PART_NAMES[currentPart]}`;
    }

    element('#preview').textContent = proposed
      ? `After wave ${wave}: walls ${proposed.state.walls} (−${state.walls - proposed.state.walls}) · gold ${proposed.state.gold} (+${proposed.event.goldGain})${proposed.state.done ? proposed.state.won ? ' · WIN' : ' · RUN OVER' : ''}`
      : busy ? status?.optimisticEvent ? `Predicted wave ${wave}: walls ${state.walls} · gold ${state.gold}. Awaiting chain…` : `Resolving wave ${wave}…`
      : state.done ? `Final walls ${state.walls} · gold ${state.gold}`
      : selected === null ? 'Choose a part, then hover or focus a square to preview.'
      : 'Hover or focus a square to preview. Click to place and fight.';
    element('#incoming-title').textContent = `${state.done && !busy ? 'Final' : busy ? 'Fighting' : 'Incoming'} wave ${wave}/${C.WAVES}`;
    element('#incoming').innerHTML = Array.from({ length: 4 }, (_, lane) => `
      <div class="incoming-lane"><strong>Lane ${lane}</strong>
        <span>Swarm</span><b>${incoming.swarm[lane]} × ${incoming.swarmHp}hp</b>
        <span>Brute</span><b>${incoming.brute[lane]} × ${incoming.bruteHp}hp</b>
      </div>`).join('');
    element('#survey-title').textContent = `Lane survey${proposed ? ' · placement preview' : ''}`;
    element('#survey').innerHTML = Array.from({ length: 4 }, (_, lane) => `
      <div class="survey-lane"><span>ST <b>${laneSurvey.st[lane]}</b></span><span>AOE <b>${laneSurvey.aoe[lane]}</b></span><span>SHIELD <b>${laneSurvey.shield[lane]}</b></span></div>`).join('');
    element('#lane-results').innerHTML = waveEvent ? waveEvent.lanes.map((lane) => `
      <div><span>Dead ${lane.sk + lane.bk}</span><span>Leak ${lane.swarm + lane.brute - lane.sk - lane.bk}</span><span>Hit ${lane.hit}</span></div>`).join('') : '';
    element('#wave-result').textContent = status?.optimisticEvent ? `${waveMessage(status.optimisticEvent)} · predicted, awaiting chain` : lastMessage;

    const finished = state.done && !busy;
    element('#result').hidden = !finished;
    if (finished) {
      element('#result-title').textContent = state.won ? 'Won · walls held' : 'Lost · walls fell';
      element('#result-score').textContent = `Score ${state.score} · wave ${state.wave}/${C.WAVES} · best today ${state.bestScore}`;
      element<HTMLInputElement>('#share').value = `Ballista Defence day ${state.day}: wave ${state.wave}/${C.WAVES}, score ${state.score}`;
    }
  }

  function waveMessage(event: WaveEvent): string {
    const dead = event.lanes.reduce((sum, lane) => sum + lane.sk + lane.bk, 0n);
    const leaked = event.lanes.reduce((sum, lane) => sum + lane.swarm + lane.brute - lane.sk - lane.bk, 0n);
    const hit = event.lanes.reduce((sum, lane) => sum + lane.hit, 0n);
    return `Wave ${event.w}: ${dead} dead · ${leaked} leaked · ${hit} wall damage · +${event.goldGain} gold`;
  }

  async function animate(event: WaveEvent): Promise<void> {
    const layer = element('#animation');
    const height = element('#board').getBoundingClientRect().height;
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 120 : 1_000;
    const motions: Animation[] = [];
    event.lanes.forEach((lane, laneIndex) => {
      const column = document.createElement('div');
      column.className = 'animation-lane';
      layer.append(column);
      for (const kind of ['swarm', 'brute'] as const) {
        const count = lane[kind];
        const killed = kind === 'swarm' ? lane.sk : lane.bk;
        // Cap only the visual dots. All exact counts remain visible below the board.
        const dots = Number(count > 48n ? 48n : count);
        for (let index = 0; index < dots; index++) {
          const dead = BigInt(index) * count / BigInt(dots) < killed;
          const dot = document.createElement('i');
          dot.className = `enemy ${kind}${dead ? ' killed' : ' leaked'}`;
          dot.style.left = `${12 + (index * 23 + (kind === 'brute' ? 13 : 0)) % 72}%`;
          column.append(dot);
          const travel = dead ? height * (0.3 + (index % 5) * 0.1) : height + 12;
          motions.push(dot.animate([
            { transform: 'translateY(-12px)', opacity: 1, offset: 0 },
            { transform: `translateY(${travel}px)`, opacity: 1, offset: dead ? 0.7 : 0.94 },
            { transform: `translateY(${travel}px) scale(${dead ? 0 : 1})`, opacity: 0, offset: 1 },
          ], { duration, easing: 'linear', fill: 'forwards' }));
        }
      }
    });
    try {
      await Promise.all(motions.length ? motions.map((motion) => motion.finished) : [new Promise((resolve) => setTimeout(resolve, duration))]);
    } finally {
      motions.forEach((motion) => motion.cancel());
      layer.replaceChildren();
    }
  }

  async function place(cell: bigint): Promise<void> {
    if (!ready || busy || backend.state().done || backend.status?.().mismatch) return;
    if (selected === null) {
      element('#preview').textContent = 'Choose a part first: click an offer or press 1, 2, or 3.';
      return;
    }
    busy = true;
    hovered = null;
    element('#error').hidden = true;
    render();
    try {
      lastEvent = await backend.play(selected, cell);
      selected = null;
      lastMessage = waveMessage(lastEvent);
      render();
      await animate(lastEvent);
    } catch (error) {
      element('#error').textContent = message(error);
      element('#error').hidden = false;
    } finally {
      busy = false;
      render();
      if (backend.state().done) element('#result-title').focus({ preventScroll: true });
    }
  }

  async function restart(): Promise<void> {
    if (busy) return;
    busy = true;
    ready = false;
    element('#error').hidden = true;
    element<HTMLButtonElement>('#restart').disabled = true;
    element<HTMLButtonElement>('#retry').disabled = true;
    try {
      await backend.start();
      selected = null;
      hovered = null;
      lastEvent = null;
      lastMessage = `Survive ${C.WAVES} waves. Every placement starts the next wave.`;
      element('#copy').textContent = 'Copy';
      ready = true;
    } catch (error) {
      element('#error').textContent = message(error);
      element('#error').hidden = false;
    } finally {
      busy = false;
      element<HTMLButtonElement>('#retry').disabled = false;
      render();
    }
  }

  element('#restart').addEventListener('click', () => { void restart(); });
  element('#retry').addEventListener('click', () => { void restart(); });
  element('#copy').addEventListener('click', async () => {
    const input = element<HTMLInputElement>('#share');
    try {
      await navigator.clipboard.writeText(input.value);
      element('#copy').textContent = 'Copied';
    } catch {
      input.focus();
      input.select();
      element('#copy').textContent = 'Select & copy';
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable)) return;
    if (/^[123]$/.test(event.key)) {
      event.preventDefault();
      choose(BigInt(Number(event.key) - 1));
    }
  });
  backend.subscribe?.(() => render());
  render();
  await restart();
}

try {
  const params = new URLSearchParams(location.search);
  const mode = params.get('backend');
  if (mode !== null && mode !== 'chain' && mode !== 'local') throw new Error('Use ?backend=chain or ?backend=local.');
  let deployment: unknown;
  let fallbackNotice = '';
  if (mode !== 'local') {
    try {
      const response = await fetch('/deployment.json', { cache: 'no-store', signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`deployment.json returned HTTP ${response.status}`);
      deployment = await response.json();
    } catch (error) {
      if (mode === 'chain') throw new Error(`Chain unavailable: ${message(error)}. Run pnpm deploy:local.`);
      fallbackNotice = `Local simulation: ${message(error)}. Run pnpm deploy:local to play on-chain.`;
    }
  }
  if (deployment !== undefined) {
    let storage: BurnerStorage | undefined;
    try { storage = window.localStorage; } catch { /* Storage-disabled browsers use a session burner. */ }
    const backend = await ChainBackend.create(deployment, { storage });
    const notice = params.has('day') ? '?day only applies to local simulation. Chain start uses validator UTC day.' : undefined;
    await mountGame(backend, { label: 'Ballista chain', notice });
  } else {
    await mountGame(new LocalBackend({ day: dayFromSearch(location.search) }), {
      label: 'local simulation', notice: fallbackNotice || 'Local simulation selected. Use ?backend=chain for Ballista transactions.',
    });
  }
} catch (error) {
  const app = element('#game');
  const problem = document.createElement('p');
  problem.setAttribute('role', 'alert');
  problem.textContent = message(error);
  const reset = document.createElement('a');
  reset.href = `${location.pathname}?backend=chain`;
  reset.textContent = 'Retry chain';
  const local = document.createElement('a');
  local.href = `${location.pathname}?backend=local`;
  local.textContent = 'Play local simulation';
  app.replaceChildren(problem, reset, document.createTextNode(' · '), local);
}
