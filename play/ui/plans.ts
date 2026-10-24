import { BuildPlans, planValues } from '../plans.js';
export function planButtons(plans: BuildPlans, blocked: boolean): string {
  return `<span class="plan-switch" role="group" aria-label="Build plan">${(['A', 'B'] as const).map(name => `<button data-command="plan" data-value="${name}" aria-pressed="${plans.selected === name}" ${blocked ? 'disabled' : ''}>Plan ${name}</button>`).join('')}<button class="short-plan-open" data-command="plan-compare">Compare</button></span>`;
}
export function planCompare(plans: BuildPlans): string {
  return `<div class="plan-compare" aria-label="Plan forecasts"><span class="plan-assumption">Walls lost · next two: no more purchases</span>${(['A', 'B'] as const).map(name => {
    const v = planValues(plans.get(name).state);
    return `<p class="plan-values ${plans.selected === name ? 'selected' : ''}" data-plan="${name}"><b>${name}</b><span>W${v.wave}: ${v.loss}</span><span>Next 2: ${v.nextTwoLoss}</span><span>${v.gold}g left</span><span>${v.actions}/6 actions</span></p>`;
  }).join('')}</div>`;
}
