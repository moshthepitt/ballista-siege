import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { C, LIMITS, PRICE } from '../src/v1/constants.js';
import { defineTemplates, TEMPLATE_NAMES } from '../src/chain-v1/templates.js';
import { createHarness, exerciseRuns, summarize, type ChainHarness } from './chain-v1-harness.js';
export const hashFile = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
export function benchmarkReport(h: ChainHarness, corpus: object) {
    const templates = defineTemplates(h.deployment.addresses);
    const stats = Object.fromEntries(TEMPLATE_NAMES.map(name => { const a = h.svm.getAccount(h.deployment.addresses[name]); if (!a.exists)
        throw Error(name); return [name, { ...h.deployment.compiled[name].stats, loops: templates[name].steps.filter(s => s.kind === 'repeat').map(s => s.kind === 'repeat' ? s.max : 0), accountBytes: a.data.length, rent: a.lamports }]; }));
    const rent = (key: import('@solana/kit').Address) => { const a = h.svm.getAccount(key); if (!a.exists)
        throw Error('Missing account'); return { bytes: a.data.length, lamports: a.lamports }; };
    const report = { constantsSha256: hashFile('src/v1/constants.ts'), simSha256: hashFile('src/v1/sim.ts'), botsSha256: hashFile('src/v1/bots/index.ts'), chainSha256: Object.fromEntries(['actions', 'client', 'combat', 'enemies', 'state', 'templates', 'vm'].map(n => [n, hashFile('src/chain-v1/' + n + '.ts')])), programSha256: hashFile('vendor/ballista.so'), sdkVersion: JSON.parse(readFileSync('vendor/ballista-sdk/package.json', 'utf8')).version, liteSvmVersion: '1.6.1', constants: { C, LIMITS, PRICE }, templates: stats, metrics: summarize(h.measurements), corpus, registry: { run: rent(h.entries.run), work: rent(h.entries.work) }, lookup: rent(h.lookup.address), templateRent: Object.values(stats).reduce((n, s) => n + s.rent, 0n) };
    writeFileSync('.tmp/chain-v1/measurements.json', JSON.stringify(report, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2));
    return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const h = await createHarness(), before = hashFile('src/v1/constants.ts');
    const corpus = await exerciseRuns(h, Number(process.env.CHAIN_V1_RUNS ?? 300), info => console.log('CHAIN_V1_PROGRESS', JSON.stringify(info)));
    if (before !== hashFile('src/v1/constants.ts'))
        throw Error('Constants changed during benchmark; rerun against final tuning');
    const report = benchmarkReport(h, corpus);
    console.log('CHAIN_V1', JSON.stringify({ corpus, metrics: report.metrics, templateRent: report.templateRent.toString() }));
}
