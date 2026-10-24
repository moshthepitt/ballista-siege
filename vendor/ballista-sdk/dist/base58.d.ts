/** Encodes bytes as base58: each leading zero byte as a `1`, the rest as one big number. */
export declare function encodeBase58(bytes: Uint8Array): string;
/** Decodes base58 text, throwing a `TypeError` for a character outside the alphabet. */
export declare function decodeBase58(text: string): Uint8Array<ArrayBuffer>;
//# sourceMappingURL=base58.d.ts.map