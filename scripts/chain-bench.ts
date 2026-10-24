import { createHarness, exerciseRandomRuns, summarizeMeasurements } from './chain-harness.js';
import { C } from '../src/rules/constants.js';

const h = await createHarness();
const corpus = await exerciseRandomRuns(h);
const entry = h.svm.getAccount(h.entryAddress);
console.log(JSON.stringify({
  corpus, constants: C,
  templates: Object.fromEntries(Object.entries(h.deployment.compiled).map(([name, compiled]) => {
    const account = h.svm.getAccount(h.deployment.addresses[name as keyof typeof h.deployment.addresses]);
    return [name, { ...compiled.stats, rent: account.exists ? account.lamports : null }];
  })),
  entry: { bytes: entry.exists ? entry.data.length : 0, rent: entry.exists ? entry.lamports : null },
  actions: summarizeMeasurements(h.measurements),
}, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
