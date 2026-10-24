/** Shared without loading any chain implementation. */
export { BURNER_KEY, stored } from './browser-storage.js';
export const RPC_KEY = 'ballista-siege.v1.rpc';
export const DEFAULT_RPC = 'https://api.devnet.solana.com';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const FIRST_RUN_RENT = 3_300_000n, RUN_FEES = 1_000_000n, TURN_FEES = 60_000n;
export interface Eligibility { loaded: boolean; program: boolean; templates: boolean; balance: bigint; hasEntries: boolean; manifest: boolean; checking?: boolean }
export function offlineReason(s: Eligibility): string | undefined {
  if (!s.loaded) return 'Open Fund to play on devnet.';
  if (s.checking) return 'Checking devnet. Playing offline.';
  if (!s.manifest) return 'This build has no devnet deployment. Playing offline.';
  if (!s.program) return 'Ballista changed since this build was tested. Playing offline.';
  if (!s.templates) return 'Templates unavailable. Playing offline.';
  if (s.balance < RUN_FEES + (s.hasEntries ? 0n : FIRST_RUN_RENT)) return 'Fund your burner to play on devnet.';
}
export function runsLeft(balance: bigint, hasEntries: boolean): number {
  return Number((balance > (hasEntries ? 0n : FIRST_RUN_RENT) ? balance - (hasEntries ? 0n : FIRST_RUN_RENT) : 0n) / RUN_FEES);
}
