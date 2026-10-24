import { INSTRUCTION_RUN, account, addressBytes, data, expression as e, step, type Expression, type Step } from '@jac0xb/ballista';
import { BALLISTA_ADDRESS } from '@jac0xb/ballista/kit';
import type { Address } from '@solana/kit';
export { e, step, account, addressBytes, BALLISTA_ADDRESS };
export const u = e.u64, w = e.u128, v = e.variable, inp = e.input;
export const mask = (bits: number) => (1n << BigInt(bits)) - 1n;
export const get = (x: Expression, shift: Expression | number, bits: number) => e.bitAnd(e.shiftRight(x, typeof shift === 'number' ? u(shift) : shift), u(mask(bits)));
export const wideGet = (x: Expression, shift: Expression | number, bits: number) => e.cast('u64', e.bitAnd(e.shiftRight(x, typeof shift === 'number' ? u(shift) : shift), w(mask(bits))));
export const cut = (a: Expression, b: Expression) => e.subtract(a, e.min(a, b));
export const or = (...values: Expression[]) => values.reduce(e.bitOr);
export const sum = (...values: Expression[]) => values.reduce(e.add);
export const enc = (x: Expression) => data.encode('u64', x);
export const wide = (x: Expression) => data.encode('u128', x);
export const inputs = (names: string[], widths: string[] = []) => Object.fromEntries(names.map(name => [name, { type: widths.includes(name) ? 'u128' as const : 'u64' as const }]));
export const accounts = (addresses: Record<string, Address>) => ({ ballista: { executable: true, address: addressBytes(BALLISTA_ADDRESS) }, ...Object.fromEntries(Object.entries(addresses).filter(([name]) => name !== 'ballista').map(([name, key]) => [name, { address: addressBytes(key) }])) });
export function call(name: string, values: ReturnType<typeof enc>[], forwarded: string[] = []): Step {
    return step.invoke({ program: account.fixed('ballista'), accounts: [name, ...forwarded].map(key => ({ account: account.fixed(key), signer: false, writable: false })), data: [data.literal(Uint8Array.of(INSTRUCTION_RUN)), ...values] });
}
export function builder() {
    const steps: Step[] = [];
    return { steps, let(name: string, x: Expression) { steps.push(step.let(name, x)); return v(name); } };
}
export function xor(name: string, value: Expression): Step[] {
    return [step.let(name + 'a', e.bitXor(value, e.shiftLeft(e.bitAnd(value, u(mask(51))), u(13)))),
        step.let(name + 'b', e.bitXor(v(name + 'a'), e.shiftRight(v(name + 'a'), u(7)))),
        step.let(name, e.bitXor(v(name + 'b'), e.shiftLeft(e.bitAnd(v(name + 'b'), u(mask(47))), u(17))))];
}
