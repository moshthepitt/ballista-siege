import { address, getAddressDecoder } from '@solana/kit';
import type { AccountData } from '../deployment.js';
export const TESTED_PROGRAM = {
  address: 'BLSTAmUBA29tcRUvoq5DBYxRhGptrnWPtfQW65RszRWR',
  programdata: '4AE45nu9kRhXGELiBCnP22JsAiKwN6vKFD1HmbuTCcCz',
  slot: 507526156n,
  authority: 'A9TciQEkWp1uh8ee4DpPyXgi4twSfUuNFe9sGEvjxfsQ',
  loader: 'BPFLoaderUpgradeab1e11111111111111111111111',
} as const;
export const PROGRAM_NOTICE = 'Ballista changed since this build was tested. Playing offline.';
export async function checkProgram(read: (key: string, length: number) => Promise<AccountData | null>): Promise<boolean> {
  try {
    const p = TESTED_PROGRAM, program = await read(p.address, 36), decoder = getAddressDecoder();
    if (!program?.executable || program.owner !== p.loader || program.data.length !== 36) return false;
    const v = new DataView(program.data.buffer, program.data.byteOffset, program.data.byteLength);
    if (v.getUint32(0, true) !== 2 || decoder.decode(program.data.subarray(4, 36)) !== p.programdata) return false;
    const data = await read(p.programdata, 45);
    if (!data || data.owner !== p.loader || data.executable || data.data.length !== 45) return false;
    const d = new DataView(data.data.buffer, data.data.byteOffset, data.data.byteLength);
    return d.getUint32(0, true) === 3 && d.getBigUint64(4, true) === p.slot && data.data[12] === 1 && decoder.decode(data.data.subarray(13, 45)) === address(p.authority);
  } catch { return false; }
}
