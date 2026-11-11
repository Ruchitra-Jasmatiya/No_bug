import { isIP } from 'node:net';

/**
 * Classification of IP addresses for SSRF protection.
 * An address is "blocked" unless it is a normal, globally routable unicast address.
 * Anything we cannot parse is treated as blocked (fail closed).
 */

export function parseIPv4(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    result = result * 256 + n;
  }
  return result >>> 0;
}

export function parseIPv6(input: string): bigint | null {
  let value = input;
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  if (value.length === 0) return null;

  // Embedded IPv4 in the last 32 bits, e.g. ::ffff:1.2.3.4
  const lastColon = value.lastIndexOf(':');
  if (lastColon !== -1 && value.slice(lastColon + 1).includes('.')) {
    const v4 = parseIPv4(value.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    value = `${value.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const doubleColon = value.split('::');
  if (doubleColon.length > 2) return null;

  const toGroups = (s: string): string[] | null => {
    if (s === '') return [];
    const groups = s.split(':');
    return groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g)) ? groups : null;
  };

  let groups: string[];
  if (doubleColon.length === 2) {
    const head = toGroups(doubleColon[0] ?? '');
    const tail = toGroups(doubleColon[1] ?? '');
    if (!head || !tail) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    const all = toGroups(value);
    if (!all || all.length !== 8) return null;
    groups = all;
  }

  let result = 0n;
  for (const g of groups) result = (result << 16n) | BigInt(parseInt(g, 16));
  return result;
}

const V4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

const V4_BLOCKED_PARSED = V4_BLOCKED.map(([ip, bits]) => [parseIPv4(ip) as number, bits] as const);

function v4InCidr(addr: number, net: number, bits: number): boolean {
  if (bits === 0) return true;
  const shift = 32 - bits;
  return addr >>> shift === net >>> shift;
}

export function isBlockedIPv4(addr: number): boolean {
  return V4_BLOCKED_PARSED.some(([net, bits]) => v4InCidr(addr, net, bits));
}

const V6_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];
const V6_BLOCKED_PARSED = V6_BLOCKED.map(([ip, bits]) => [parseIPv6(ip) as bigint, bits] as const);

function v6InCidr(addr: bigint, net: bigint, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return addr >> shift === net >> shift;
}

function bigToV4(n: bigint): number {
  return Number(n & 0xffffffffn) >>> 0;
}

export function isBlockedIPv6(addr: bigint): boolean {
  if (V6_BLOCKED_PARSED.some(([net, bits]) => v6InCidr(addr, net, bits))) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d)
  if (v6InCidr(addr, 0xffffn << 32n, 96)) return isBlockedIPv4(bigToV4(addr));
  if (addr >> 32n === 0n) return isBlockedIPv4(bigToV4(addr));
  // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 address
  if (v6InCidr(addr, 0x64ff9bn << 96n, 96)) return isBlockedIPv4(bigToV4(addr));
  // 6to4 (2002::/16) embeds an IPv4 address in bits 16..48
  if (addr >> 112n === 0x2002n) return isBlockedIPv4(Number((addr >> 80n) & 0xffffffffn) >>> 0);
  return false;
}

/** True if the address must not be contacted. Unparseable input fails closed. */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const v4 = parseIPv4(address);
    return v4 === null ? true : isBlockedIPv4(v4);
  }
  if (version === 6) {
    const v6 = parseIPv6(address);
    return v6 === null ? true : isBlockedIPv6(v6);
  }
  return true;
}

/**
 * Cloud metadata / credential endpoints. These are blocked regardless of policy,
 * including the dev-only `allowPrivateTargets` mode, so a misconfigured
 * environment can never be used to read instance credentials.
 */
const ALWAYS_BLOCKED_V4 = ['169.254.169.254', '169.254.170.2', '100.100.100.200', '192.0.0.192'].map((a) => parseIPv4(a) as number);
const ALWAYS_BLOCKED_V6 = [parseIPv6('fd00:ec2::254') as bigint];

export function isAlwaysBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const v4 = parseIPv4(address);
    return v4 !== null && ALWAYS_BLOCKED_V4.includes(v4);
  }
  if (version === 6) {
    const v6 = parseIPv6(address);
    if (v6 === null) return true;
    if (ALWAYS_BLOCKED_V6.includes(v6)) return true;
    // IPv4-mapped / NAT64 forms of a metadata address
    if (v6 >> 32n === 0xffffn || v6 >> 32n === 0x0064ff9bn << 64n) {
      return ALWAYS_BLOCKED_V4.includes(bigToV4(v6));
    }
    return false;
  }
  return true;
}

export interface NetPolicy {
  /**
   * Permit loopback/private destinations. For automated tests and local
   * development ONLY. `getNetPolicy` refuses to enable it in production.
   */
  allowPrivateTargets: boolean;
}

export function getNetPolicy(env: NodeJS.ProcessEnv = process.env): NetPolicy {
  const requested = env.NBA_ALLOW_PRIVATE_TARGETS === 'true';
  if (requested && env.NODE_ENV === 'production') {
    throw new Error('NBA_ALLOW_PRIVATE_TARGETS must not be enabled when NODE_ENV=production.');
  }
  return { allowPrivateTargets: requested };
}

export const STRICT_POLICY: NetPolicy = { allowPrivateTargets: false };
