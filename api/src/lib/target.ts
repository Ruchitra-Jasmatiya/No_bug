import { normalizeTargetUrl } from '@nba/shared';
import { BlockedTargetError, resolvePublicAddresses, type NetPolicy, type Resolver } from '@nba/shared/net';
import { badRequest, unprocessable } from './errors.js';

export interface ValidTarget {
  url: string;
  hostname: string;
  origin: string;
}

/**
 * Server-side validation of a user-supplied target. Never trust the browser: syntax rules first, then DNS
 * resolution with every address checked against the SSRF policy. (The worker re-validates at connection time,
 * which is what defeats DNS rebinding.)
 */
export async function validateTarget(input: string, policy: NetPolicy, resolver?: Resolver): Promise<ValidTarget> {
  const check = normalizeTargetUrl(input, { relaxed: policy.allowPrivateTargets });
  if (!check.ok) {
    throw check.code === 'blocked_hostname' || check.code === 'blocked_port'
      ? unprocessable(check.message, 'target_blocked')
      : badRequest(check.message);
  }
  try {
    await resolvePublicAddresses(check.hostname, policy, resolver);
  } catch (err) {
    if (err instanceof BlockedTargetError) {
      throw unprocessable('This address points to a private or internal destination and cannot be tested.', 'target_blocked');
    }
    throw unprocessable('We could not reach this website. Please verify the address and try again.', 'target_unreachable');
  }
  return { url: check.url, hostname: check.hostname, origin: check.origin };
}
