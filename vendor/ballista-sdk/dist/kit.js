import { AccountRole, address, appendTransactionMessageInstruction, estimateResourceLimitsFactory, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, getTransactionMessageSize, getTransactionMessageSizeLimit, setTransactionMessageComputeUnitLimit, setTransactionMessageLoadedAccountsDataSizeLimit, } from '@solana/kit';
import { MAX_REGISTRIES } from './schema.js';
import { BALLISTA_PROGRAM_ADDRESS, buildRunInstruction, encodeCancelTemplate, encodeWriteTemplateChunk, planTemplateUpload, resumeTemplateUpload, } from './instructions.js';
export const BALLISTA_ADDRESS = address(BALLISTA_PROGRAM_ADDRESS);
export const SYSTEM_PROGRAM_ADDRESS = address('11111111111111111111111111111111');
export const MAX_TRANSACTION_COMPUTE_UNITS = 1_400_000;
export const MAX_LOADED_ACCOUNTS_DATA_SIZE = 64 * 1_024 * 1_024;
export const LOADED_ACCOUNTS_DATA_PAGE_SIZE = 32 * 1_024;
export function getComputeUnitLimitWithMargin(simulatedComputeUnits, config = {}) {
    const marginBps = config.marginBps ?? 1_000;
    const maximum = config.maxComputeUnitLimit ?? MAX_TRANSACTION_COMPUTE_UNITS;
    if (!Number.isInteger(simulatedComputeUnits) || simulatedComputeUnits < 0) {
        throw new RangeError('Simulated compute units must be a non-negative integer');
    }
    if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps > 100_000) {
        throw new RangeError('Compute unit margin must be an integer from 0 to 100,000 basis points');
    }
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > MAX_TRANSACTION_COMPUTE_UNITS) {
        throw new RangeError('Maximum compute unit limit must be from 1 to 1,400,000');
    }
    if (simulatedComputeUnits > maximum) {
        throw new RangeError('Simulated compute units exceed the configured maximum');
    }
    const requested = Math.ceil((simulatedComputeUnits * (10_000 + marginBps)) / 10_000);
    const computeUnitLimit = Math.min(requested, maximum);
    return {
        simulatedComputeUnits,
        computeUnitLimit,
        marginComputeUnits: computeUnitLimit - simulatedComputeUnits,
        marginBps,
        capped: requested > maximum,
    };
}
/**
 * Simulates transaction messages with Solana Kit's resource estimator and applies a buffered CU
 * limit. Version-1 loaded-account data limits are preserved from the same simulation.
 */
export function createComputeUnitProvider(input) {
    const estimateResourceLimits = estimateResourceLimitsFactory({ rpc: input.rpc });
    const marginConfig = {
        ...(input.marginBps === undefined ? {} : { marginBps: input.marginBps }),
        ...(input.maxComputeUnitLimit === undefined
            ? {}
            : { maxComputeUnitLimit: input.maxComputeUnitLimit }),
    };
    const estimate = async (transactionMessage, config) => {
        const resources = await estimateResourceLimits(transactionMessage, config);
        const loadedAccountsDataSize = 'loadedAccountsDataSizeLimit' in resources
            ? resources.loadedAccountsDataSizeLimit
            : undefined;
        return {
            ...getComputeUnitLimitWithMargin(resources.computeUnitLimit, marginConfig),
            ...(loadedAccountsDataSize !== undefined
                ? {
                    simulatedLoadedAccountsDataSize: loadedAccountsDataSize,
                    loadedAccountsDataSizeLimit: getLoadedAccountsDataSizeLimitWithHeadroom(loadedAccountsDataSize),
                }
                : {}),
        };
    };
    return {
        estimate,
        async estimateAndSet(transactionMessage, config) {
            const measurement = await estimate(transactionMessage, config);
            let transactionMessageWithLimits = setTransactionMessageComputeUnitLimit(measurement.computeUnitLimit, transactionMessage);
            if (transactionMessage.version === 1 &&
                measurement.loadedAccountsDataSizeLimit !== undefined) {
                transactionMessageWithLimits = setTransactionMessageLoadedAccountsDataSizeLimit(measurement.loadedAccountsDataSizeLimit, transactionMessageWithLimits);
            }
            return { transactionMessage: transactionMessageWithLimits, estimate: measurement };
        },
    };
}
/** Rounds a simulation result to the next 32 KiB cost-model page for v1 headroom. */
export function getLoadedAccountsDataSizeLimitWithHeadroom(simulatedBytes) {
    if (!Number.isInteger(simulatedBytes) ||
        simulatedBytes < 0 ||
        simulatedBytes > MAX_LOADED_ACCOUNTS_DATA_SIZE) {
        throw new RangeError('Loaded account data size must be from 0 to 64 MiB');
    }
    if (simulatedBytes === 0)
        return LOADED_ACCOUNTS_DATA_PAGE_SIZE;
    return Math.min(Math.ceil(simulatedBytes / LOADED_ACCOUNTS_DATA_PAGE_SIZE) *
        LOADED_ACCOUNTS_DATA_PAGE_SIZE, MAX_LOADED_ACCOUNTS_DATA_SIZE);
}
/** Reads the authoritative CU count returned in confirmed transaction metadata. */
export function getComputeUnitsConsumed(transaction) {
    const value = transaction?.meta?.computeUnitsConsumed;
    if (value === undefined || value === null)
        return undefined;
    const units = Number(value);
    if (!Number.isSafeInteger(units) || units < 0) {
        throw new RangeError('Transaction compute units are not a safe non-negative integer');
    }
    return units;
}
export async function getTemplateAddress(creator, templateId, programAddress = BALLISTA_ADDRESS) {
    validateTemplateId(templateId);
    const [templateAddress, bump] = await getProgramDerivedAddress({
        programAddress,
        seeds: [
            new TextEncoder().encode('template'),
            getAddressEncoder().encode(creator),
            Uint8Array.of(templateId & 0xff, templateId >>> 8),
        ],
    });
    return [templateAddress, bump];
}
/**
 * A registry entry's address and bump: `["registry", template, [registryIndex], key]` under
 * Ballista, where the entry's open creates it. `registryIndex` is the registry's position among
 * those the template declares; `registryIndex(compiled, name)` finds it by name. `key` is the 32
 * bytes the template computes for the entry: an address such as the caller's for a per-caller
 * entry, or all zeros for one template-wide entry.
 */
export async function findRegistryEntryAddress(template, registryIndex, key, programAddress = BALLISTA_ADDRESS) {
    if (!Number.isInteger(registryIndex) || registryIndex < 0 || registryIndex >= MAX_REGISTRIES) {
        throw new RangeError(`Registry index must be 0 to ${MAX_REGISTRIES - 1}`);
    }
    const keyBytes = typeof key === 'string' ? getAddressEncoder().encode(key) : key;
    if (keyBytes.length !== 32)
        throw new RangeError('A registry key is 32 bytes');
    const [entryAddress, bump] = await getProgramDerivedAddress({
        programAddress,
        seeds: [
            new TextEncoder().encode('registry'),
            getAddressEncoder().encode(template),
            Uint8Array.of(registryIndex),
            keyBytes,
        ],
    });
    return [entryAddress, bump];
}
/**
 * Finds the lowest template ID at or above `start` whose address holds no account. Anyone can
 * dust a predictable template address, and creation tolerates that, but an address that already
 * holds a finalized or uploading template cannot be reused, so callers probe before uploading.
 */
export async function findFreeTemplateId(input) {
    const programAddress = input.programAddress ?? BALLISTA_ADDRESS;
    const batchSize = input.batchSize ?? 16;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
        throw new RangeError('Probe batch size must be from 1 to 100');
    }
    let templateId = input.start ?? 0;
    validateTemplateId(templateId);
    while (templateId <= 0xffff) {
        const count = Math.min(batchSize, 0x1_0000 - templateId);
        const candidates = await Promise.all(Array.from({ length: count }, (_, offset) => getTemplateAddress(input.creator, templateId + offset, programAddress)));
        const { value } = await input.rpc.getMultipleAccounts(candidates.map(([address]) => address)).send();
        const free = value.findIndex((account) => account === null);
        if (free !== -1) {
            const [templateAddress, bump] = candidates[free];
            return { templateId: templateId + free, templateAddress, bump };
        }
        templateId += count;
    }
    throw new RangeError('Every template ID for this creator is taken');
}
export function toKitInstruction(descriptor) {
    const decoder = getAddressDecoder();
    return {
        programAddress: decoder.decode(descriptor.programAddress),
        accounts: descriptor.accounts.map((account) => ({
            address: decoder.decode(account.address),
            role: accountRole(account.signer, account.writable),
        })),
        data: descriptor.data,
    };
}
export function buildKitRunInstruction(input) {
    const encoder = getAddressEncoder();
    const accountGroups = input.accountGroups
        ? Object.fromEntries(Object.entries(input.accountGroups).map(([name, members]) => [
            name,
            members.map((member) => ({
                address: Uint8Array.from(encoder.encode(member.address)),
                ...(member.writable !== undefined ? { writable: member.writable } : {}),
            })),
        ]))
        : undefined;
    const accounts = Object.fromEntries(Object.entries(input.accounts).map(([name, binding]) => [
        name,
        { address: Uint8Array.from(encoder.encode(binding.address)) },
    ]));
    const batchRows = input.batchRows?.map((row) => Object.fromEntries(Object.entries(row).map(([name, binding]) => [
        name,
        { address: Uint8Array.from(encoder.encode(binding.address)) },
    ])));
    const instruction = toKitInstruction(buildRunInstruction({
        compiled: input.compiled,
        programAddress: Uint8Array.from(encoder.encode(input.programAddress ?? BALLISTA_ADDRESS)),
        templateAddress: Uint8Array.from(encoder.encode(input.templateAddress)),
        inputs: input.inputs,
        accounts,
        batchRows,
        ...(input.batchInputs ? { batchInputs: input.batchInputs } : {}),
        ...(accountGroups ? { accountGroups } : {}),
    }));
    return { ...instruction, accounts: withSigners(instruction, runBindings(input)) };
}
/** Each run account's binding and name, in the instruction's order, after the template account. */
function runBindings(input) {
    const { compiled } = input;
    return [
        ...compiled.fixedAccountOrder.map((name) => ({ name, binding: input.accounts[name] })),
        ...(input.batchRows ?? []).flatMap((row, index) => compiled.batchAccountOrder.map((name) => ({ name: `${name} in row ${index}`, binding: row[name] }))),
        ...compiled.accountGroupOrder.flatMap((group) => (input.accountGroups?.[group] ?? []).map((binding) => ({ name: `a member of ${group}`, binding }))),
    ];
}
/** Attaches each binding's signer to its account, where the template declares it a signer. */
function withSigners(instruction, bindings) {
    return (instruction.accounts ?? []).map((meta, index) => {
        const bound = index === 0 ? undefined : bindings[index - 1];
        const signer = bound?.binding.signer;
        if (!bound || !signer)
            return meta;
        if (signer.address !== bound.binding.address) {
            throw new TypeError(`The signer for ${bound.name} is ${signer.address}, not the bound ${bound.binding.address}`);
        }
        if (meta.role !== AccountRole.READONLY_SIGNER && meta.role !== AccountRole.WRITABLE_SIGNER) {
            throw new TypeError(`The template does not declare ${bound.name} a signer, so it cannot carry one`);
        }
        // `role` is restated so its narrowing to a signer role carries into the result.
        return { ...meta, role: meta.role, signer };
    });
}
export async function buildKitTemplateUploadPlan(input) {
    const programAddress = input.programAddress ?? BALLISTA_ADDRESS;
    const [templateAddress, bump] = await getTemplateAddress(input.creator, input.templateId, programAddress);
    let plan;
    if (input.transactionMessage) {
        const oneShot = planTemplateUpload(input.compiled, input.templateId, {
            maxInstructionDataBytes: input.compiled.bytes.length + 35,
        });
        const createInstruction = buildUploadInstruction(oneShot.instructions[0], programAddress, input.creator, templateAddress);
        if (measureInstructionInTransaction(input.transactionMessage, createInstruction).fits) {
            plan = oneShot;
        }
        else {
            const maxInstructionDataBytes = findLargestWriteInstructionData(input.transactionMessage, programAddress, input.creator, templateAddress);
            plan = planTemplateUpload(input.compiled, input.templateId, { maxInstructionDataBytes });
        }
    }
    else {
        plan = planTemplateUpload(input.compiled, input.templateId, {
            maxInstructionDataBytes: input.maxInstructionDataBytes,
        });
    }
    return mapUploadPlan(plan, programAddress, input.creator, templateAddress, bump);
}
export async function buildKitResumeTemplateUploadPlan(input) {
    const programAddress = input.programAddress ?? BALLISTA_ADDRESS;
    const [templateAddress, bump] = await getTemplateAddress(input.creator, input.templateId, programAddress);
    const maxInstructionDataBytes = input.transactionMessage
        ? findLargestWriteInstructionData(input.transactionMessage, programAddress, input.creator, templateAddress)
        : input.maxInstructionDataBytes;
    const plan = resumeTemplateUpload(input.compiled, input.account, { maxInstructionDataBytes });
    return mapUploadPlan(plan, programAddress, input.creator, templateAddress, bump);
}
export async function buildKitCancelTemplateInstruction(input) {
    const programAddress = input.programAddress ?? BALLISTA_ADDRESS;
    const [templateAddress] = await getTemplateAddress(input.creator, input.templateId, programAddress);
    return {
        programAddress,
        accounts: [
            { address: input.creator, role: AccountRole.WRITABLE_SIGNER },
            { address: templateAddress, role: AccountRole.WRITABLE },
        ],
        data: encodeCancelTemplate(),
    };
}
export function measureTransactionMessage(transactionMessage) {
    const size = getTransactionMessageSize(transactionMessage);
    const limit = getTransactionMessageSizeLimit(transactionMessage);
    return { size, limit, fits: size <= limit };
}
export function measureInstructionInTransaction(transactionMessage, instruction) {
    return measureTransactionMessage(appendTransactionMessageInstruction(instruction, transactionMessage));
}
function mapUploadPlan(plan, programAddress, creator, templateAddress, bump) {
    return {
        mode: plan.mode,
        templateAddress,
        bump,
        instructions: plan.instructions.map((upload) => ({
            kind: upload.kind,
            offset: upload.offset,
            instruction: buildUploadInstruction(upload, programAddress, creator, templateAddress),
        })),
        payloadLength: plan.payloadLength,
        payloadHash: plan.payloadHash,
    };
}
function buildUploadInstruction(upload, programAddress, creator, templateAddress) {
    const accounts = upload.kind === 'create' || upload.kind === 'begin'
        ? [
            { address: creator, role: AccountRole.WRITABLE_SIGNER },
            { address: templateAddress, role: AccountRole.WRITABLE },
            { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        ]
        : [
            { address: creator, role: AccountRole.WRITABLE_SIGNER },
            { address: templateAddress, role: AccountRole.WRITABLE },
        ];
    return { programAddress, accounts, data: upload.data };
}
function findLargestWriteInstructionData(transactionMessage, programAddress, creator, templateAddress) {
    let low = 64;
    let high = getTransactionMessageSizeLimit(transactionMessage);
    let best = 0;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const upload = {
            kind: 'write',
            offset: 0,
            data: encodeWriteTemplateChunk(0, new Uint8Array(middle - 5)),
        };
        const instruction = buildUploadInstruction(upload, programAddress, creator, templateAddress);
        if (measureInstructionInTransaction(transactionMessage, instruction).fits) {
            best = middle;
            low = middle + 1;
        }
        else {
            high = middle - 1;
        }
    }
    if (best < 64)
        throw new RangeError('The base transaction message leaves no room for an upload chunk');
    return best;
}
function accountRole(signer, writable) {
    if (signer)
        return writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER;
    return writable ? AccountRole.WRITABLE : AccountRole.READONLY;
}
function validateTemplateId(templateId) {
    if (!Number.isInteger(templateId) || templateId < 0 || templateId > 0xffff) {
        throw new RangeError('Template ID must be an unsigned 16-bit integer');
    }
}
//# sourceMappingURL=kit.js.map