import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fight, forecast, newRun, withPart, type EnemyGroup, type RunState, type TickFrame } from '../src/v1/sim.js';
import { PART as P } from '../src/v1/constants.js';
import { cellGroupLayout, cellSlots, enemyBodySize, type BodySpec } from './cell-groups.js';
import { hitDamageText, hitReadouts, CHIP_KEY } from './ui/model.js';
import { frameLog } from './ui/battle.js';
import { blockEffects, bigMomentHolds } from './battle-effects.js';
import { makeTimeline, BITE_MS, BITE_CONTACT_MS, WALL_LOSS_READ_MS, fenceBreakHold } from './replay.js';
import { battleSounds } from './audio/game.js';
import { BuildPlans, planValues } from './plans.js';
import { branchWallCurve } from './experiment.js';
import { saveBest, renderEnd } from './ui/screens.js';
import { cardRule } from './ui/shop.js';
import { scoutMarkup } from './ui/scout.js';
import { renderHud, renderBanner } from './ui/hud.js';
import { inspectorMarkup } from './ui/inspector.js';
const recording = JSON.parse(readFileSync(new URL('./audio/fixtures/seed13.json', import.meta.url), 'utf8'), (_k,v) => typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0,-1)) : v) as { built: RunState; frames: TickFrame[] }[];
afterEach(() => vi.unstubAllGlobals());
describe('RD10 fixed bodies', () => {
  const kinds = ['swarm','brute','boss'] as const;
  it.each([[1920,950,228,120],[1366,650,195,90],[390,844,77,88],[900,1200,206,130]])('keeps sizes through 1–4 occupants, parts and arrival at %i×%i', (vw,vh,width,height) => {
    for (const kind of kinds) for (const count of [1,2,3,4]) for (const part of [0,16]) {
      const groups = Array.from({ length: count }, (_,i) => ({ id: BigInt(i), order: BigInt(i) }));
      const specs = new Map<bigint,BodySpec>(groups.map((g,i) => [g.id, { kind: i===count-1?kind:'swarm', count: 4, size: enemyBodySize(i===count-1?kind:'swarm',vw,vh) }]));
      const layout = cellGroupLayout(width,height,cellSlots(groups),part,0,new Set(),specs).get(BigInt(count-1))!;
      // A representative and every body in a fitting formation use the same side.
      const size = enemyBodySize(kind,vw,vh);
      expect(layout.body.width % size).toBe(0); expect((layout.body.height-4)%size).toBe(0);
      if (count>1) { expect(layout.body.width).toBe(size); expect(layout.body.height-4).toBe(size); }
    }
    const step = makeTimeline(recording[4].built,recording[4].frames)[3];
    const brute = step.before.find(g=>g.lane===3n&&g.kind==='brute')!, boss = step.before.find(g=>g.kind==='boss')!;
    for(const g of [brute,boss]) {
      const before = enemyBodySize(g.kind,vw,vh), after = enemyBodySize(step.frame.groups.find(n=>n.id===g.id)!.kind,vw,vh);
      expect(after).toBe(before);
    }
  });
  it('packs the 1024×640 four-group strip without changing body sizes', () => {
    const specs = new Map<bigint, BodySpec>(['swarm','brute','swarm','brute'].map((kind,i) => [BigInt(i), {kind: kind as EnemyGroup['kind'], count: 5, size: enemyBodySize(kind as EnemyGroup['kind'],1024,640)}]));
    const layout = [...cellGroupLayout(134,60,new Map([[0n,0],[1n,1],[2n,2],[3n,3]]),16,14,new Set(),specs).values()];
    expect(layout.every(l => l.tight)).toBe(true);
    for (const [i,a] of layout.entries()) {
      expect(a.body.width).toBe(specs.get(BigInt(i))!.size);
      expect(a.body.top + a.body.height).toBeLessThanOrEqual(44);
      for (const b of layout.slice(i+1)) expect(a.body.left < b.body.left+b.body.width && a.body.left+a.body.width > b.body.left && a.body.top < b.body.top+b.body.height && a.body.top+a.body.height > b.body.top).toBe(false);
    }
  });
  it('meets desktop and phone floors and packs four mixed groups over a part',()=> {
    expect(kinds.map(k=>enemyBodySize(k,1920,950))).toEqual([28,44,64]);
    expect(kinds.map(k=>enemyBodySize(k,390,844))).toEqual([12,18,28]);
    for(const [vw,vh,w,h] of [[1920,950,228,120],[390,844,77,88]]) {
      const specs = new Map<bigint,BodySpec>(['swarm','brute','swarm','boss'].map((kind,i)=>[BigInt(i), {kind:kind as EnemyGroup['kind'],count:4,size:enemyBodySize(kind as EnemyGroup['kind'],vw,vh)}]));
      const layout = [...cellGroupLayout(w,h,new Map([[0n,0],[1n,1],[2n,2],[3n,3]]),16,14,new Set([3n]),specs).values()];
      const boxes=layout.flatMap(l=>[l.body,l.label]);
      for(const [i,a] of boxes.entries()) {
        expect(a.left+a.width).toBeLessThanOrEqual(w); expect(a.top+a.height).toBeLessThanOrEqual(h-16);
        for(const b of boxes.slice(i+1)) expect(a.left<b.left+b.width&&a.left+a.width>b.left&&a.top<b.top+b.height&&a.top+a.height>b.top).toBe(false);
      }
    }
  });
});
describe('RD10 HP lost',()=> {
  const run = (kind: 'bolt'|'splash', tier: bigint, wave=9n, brute=false) => {
    const built = withPart({...newRun(13n,'practice'),wave},brute?13n:1n,kind==='bolt'?P.BALLISTA:P.CAULDRON,tier);
    return makeTimeline(built,fight(built).frames);
  };
  it('caps bolt overkill at actual HP, while the log retains damage dealt',()=> {
    const step=run('bolt',3n).find(s=>hitReadouts(s).some(h=>h.bolt>h.applied&&h.applied>0n))!;
    const hit=hitReadouts(step).find(h=>h.bolt>h.applied&&h.applied>0n)!, g=step.before.find(g=>g.id===hit.group)!;
    expect(hitDamageText(hit,g)).toBe(`−${hit.applied}`);
    expect(frameLog(step).some(l=>l.value===`${hit.bolt-hit.blockedBolt} dmg`)).toBe(true);
  });
  it('caps splash per unit, including a wounded front',()=> {
    const base={group:0n,cell:0n,applied:16n,bolt:0n,splash:31n,blockedBolt:0n,blockedSplash:0n,kills:4n,bounty:0n};
    expect(hitDamageText(base,{count:4n,hp:4n,bodyHp:4n})).toBe('−4×4');
    expect(hitDamageText({...base,applied:14n},{count:4n,hp:2n,bodyHp:4n})).toBe('−2 + 4×3');
    const step=run('splash',3n).find(s=>hitReadouts(s).some(h=>h.splash&&h.kills))!;
    for(const hit of hitReadouts(step).filter(h=>h.splash&&!h.bolt)) {
      const g=step.before.find(g=>g.id===hit.group)!;
      expect(hit.applied).toBeLessThanOrEqual(g.hp+(g.count-1n)*g.bodyHp);
      if(g.hp===g.bodyHp&&g.count>1n) expect(hitDamageText(hit,g)).toBe(`−${hit.applied/g.count}×${g.count}`);
    }
  });
  it('retains armour shields on fully blocked and overkill splashes',()=> {
    const steps=run('splash',1n,4n,true), blocked=steps.find(s=>hitReadouts(s).some(h=>h.blockedSplash&&h.applied===0n))!;
    expect(blockEffects(blocked).some(e=>e.kind==='armour')).toBe(true);
    expect(frameLog(blocked).some(l=>l.value==='Blocked')).toBe(true);
  });
});
describe('RD10 big moments',()=> {
  it('holds only recorded fence breaks, caps growth at 300ms per wave, keeps sound at contact',()=> {
    for(const turn of recording) {
      const timeline=makeTimeline(turn.built,turn.frames);
      let added=0;
      for(const step of timeline) {
        const { fenceBreak: hold, wallLoss }=bigMomentHolds(step); added+=Math.max(0,step.phases.bite-BITE_MS);
        expect(wallLoss).toBe(step.frame.leaks.length ? 800 : 0);
        expect(hold).toBe(fenceBreakHold(step.frame));
        if(hold) expect(hold).toBe(100);
        for(const sound of battleSounds(step,'bite')) expect(sound.delay).toBe(BITE_CONTACT_MS);
        if(!fenceBreakHold(step.frame)) expect(hold).toBe(0);
      }
      expect(added).toBeLessThanOrEqual(300);
    }
    const base=makeTimeline(recording[4].built,recording[4].frames).find(s=>fenceBreakHold(s.frame))!;
    expect(bigMomentHolds({...base, phases:{...base.phases,bite:BITE_MS}}).fenceBreak).toBe(100);
    expect(WALL_LOSS_READ_MS).toBe(800);
  });
});
describe('RD10 experiments',()=> {
  it('restores independent action queues and reroll undo floors exactly',()=> {
    const plans=new BuildPlans(newRun(13n,'practice'));
    plans.current.attempt({type:'buy',slot:0n,cell:0n}); const a=plans.current.state;
    plans.switch('B').attempt({type:'buy',slot:1n,cell:4n}); plans.current.attempt({type:'reroll'});
    const b=plans.current.state, actions=plans.current.actions;
    expect(plans.switch('A').state).toEqual(a); expect(plans.current.canUndo).toBe(true);
    plans.current.undo(); expect(plans.switch('B').state).toEqual(b); expect(plans.current.actions).toEqual(actions); expect(plans.current.canUndo).toBe(false);
  });
  it('compares wall losses for this wave and the next two against sequential sim results',()=> {
    for(const start of [newRun(13n,'practice'),recording[4].built,recording[9].built]) {
      const v=planValues(start), first=fight(start).state; let last=first;
      for(let i=0;i<2&&!last.done;i++) last=fight(last).state;
      expect(v).toMatchObject({loss:start.walls-first.walls,nextTwoLoss:first.walls-last.walls,gold:start.gold,actions:start.actionsUsed,throughWave:last.wave});
    }
  });
  it('keeps branch scores out of best storage and preserves the original wall curve',()=> {
    const write=vi.fn(); vi.stubGlobal('localStorage',{getItem:()=>null,setItem:write});
    const original=recording.map(t=>({wave:t.built.wave+1n,walls:t.frames.at(-1)!.walls})), frozen=structuredClone(original);
    const branch=fight(recording[2].built).state, curve=branchWallCurve(original,branch);
    const best={score:1500n,wave:10n,won:true,current:true};
    expect(saveBest({...branch,score:9999n},best)).toEqual(best); expect(write).not.toHaveBeenCalled();
    expect(curve.find(p=>p.wave===branch.wave)?.walls).toBe(branch.walls); expect(original).toEqual(frozen);
  });
});
it('keeps the chip key and a rule for all six supply cards',()=> {
  expect(scoutMarkup(newRun(13n,'practice'))).toContain(CHIP_KEY);
  expect(cardRule(P.BALLISTA)).toBe('Own lane · 2 cells ahead');
  expect(cardRule(P.CAULDRON)).toBe('Own cell + 2 ahead'); expect(cardRule(P.FORGE)).toBe('Adjacent weapons');
  for(let part=1n;part<=6n;part++) expect(cardRule(part).length).toBeGreaterThan(10);
});

it('labels HUD counts, names the opening goal and separates the formula result', () => {
  const nodes = new Map<string, { innerHTML: string }>();
  vi.stubGlobal('document', { querySelector: (key: string) => { if (!nodes.has(key)) nodes.set(key, { innerHTML: '' }); return nodes.get(key); } });
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const state = newRun(13n, 'practice');
  renderHud(state, 'build', false); renderBanner('build', state, 0n, 0n);
  for (const label of ['Wave','Walls','Gold']) expect(nodes.get('#hud')!.innerHTML).toContain(`class="label">${label}`);
  expect(nodes.get('#phase-banner')!.innerHTML).toContain('Hold the wall for 10 waves');
  const built = { ...withPart({ ...state, gold: 100n }, 0n, P.CAULDRON, 3n), overclocked: 1n };
  const html = inspectorMarkup(built, 0n);
  expect(html).toMatch(/damage-formula[^>]*>.*Overclock<strong class="formula-result">= \d+/);
});

it('keeps restored results without retained wave history usable', () => {
  const node = { innerHTML: '', hidden: true, querySelectorAll: () => [] };
  vi.stubGlobal('document', { querySelector: () => node });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const state = { ...newRun(13n, 'practice'), wave: 10n, done: true, won: true, score: 1200n };
  renderEnd(state, [], 0, { score: 1200n, wave: 10n, won: true, current: true }, false, false);
  expect(node.innerHTML).toContain('Wave history unavailable');
  expect(node.innerHTML.match(/unplayed walls/g)).toHaveLength(10);
});
