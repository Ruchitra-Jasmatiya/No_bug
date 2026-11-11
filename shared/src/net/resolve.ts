import dns from 'node:dns';
import { isIP } from 'node:net';
import { stripBrackets } from '../url.js';
import { isAlwaysBlockedAddress, isBlockedAddress, type NetPolicy } from './ip.js';

export class BlockedTargetError extends Error {
  readonly code = 'EBLOCKED';
  constructor(
    message: string,
    readonly hostname: string,
    readonly address?: string,
  ) {
    super(message);
    this.name = 'BlockedTargetError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return reject(err);
      resolve(addresses.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
    });
  });

/**
 * Resolve a hostname and validate EVERY returned address. If any address is
 * non-public the whole host is rejected. The caller must connect to one of the
 * returned addresses directly, never re-resolve, so DNS rebinding cannot swap
 * the destination after validation.
 */
export async function resolvePublicAddresses(
  rawHostname: string,
  policy: NetPolicy,
  resolver: Resolver = systemResolver,
): Promise<ResolvedAddress[]> {
  const hostname = stripBrackets(rawHostname);
  const literal = isIP(hostname);
  const addresses: ResolvedAddress[] = literal
    ? [{ address: hostname, family: literal === 6 ? 6 : 4 }]
    : await resolver(hostname);

  if (addresses.length === 0) {
    throw Object.assign(new Error(`No addresses found for ${hostname}`), { code: 'ENOTFOUND' });
  }
  const bad = addresses.find(
    (a) => isAlwaysBlockedAddress(a.address) || (!policy.allowPrivateTargets && isBlockedAddress(a.address)),
  );
  if (bad) {
    throw new BlockedTargetError(
      `Destination ${hostname} resolves to a non-public address and cannot be tested.`,
      hostname,
      bad.address,
    );
  }
  return addresses;
}

type LookupCallback = (err: Error | null, address?: string | dns.LookupAddress[], family?: number) => void;

/**
 * Drop-in `lookup` for net/tls/undici connections. Validation happens at
 * connection time, for every hop including redirects and subresources.
 */
export function createGuardedLookup(policy: NetPolicy, resolver: Resolver = systemResolver) {
  return (hostname: string, options: { all?: boolean } | undefined, callback: LookupCallback): void => {
    resolvePublicAddresses(hostname, policy, resolver).then(
      (addresses) => {
        if (options?.all) {
          callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
        } else {
          const first = addresses[0]!;
          callback(null, first.address, first.family);
        }
      },
      (err: Error) => callback(err),
    );
  };
}
