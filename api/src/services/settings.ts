import type pg from 'pg';
import { IMPLEMENTED_MODULES, type ModuleId, MODULE_IDS } from '@nba/shared';

export interface PlatformSettings {
  enabledModules: ModuleId[];
  maxActiveJobsPerUser: number;
  testsPerHourPerUser: number;
  testsPerHourPerDomain: number;
}

const DEFAULTS: PlatformSettings = {
  enabledModules: [...IMPLEMENTED_MODULES],
  maxActiveJobsPerUser: 2,
  testsPerHourPerUser: 20,
  testsPerHourPerDomain: 30,
};

/** Reads admin-editable settings on each call, so admin changes apply immediately without redeploying. */
export async function loadSettings(pool: pg.Pool): Promise<PlatformSettings> {
  const { rows } = await pool.query<{ key: string; value: unknown }>(
    `select key, value from public.app_settings where key in ('enabled_modules','concurrency','rate_limits')`,
  );
  const by = new Map(rows.map((r) => [r.key, r.value as Record<string, unknown> | string[]]));
  const enabledRaw = by.get('enabled_modules');
  const enabled = Array.isArray(enabledRaw) ? enabledRaw.filter((m): m is ModuleId => (MODULE_IDS as readonly string[]).includes(m)) : DEFAULTS.enabledModules;
  const conc = (by.get('concurrency') ?? {}) as Record<string, number>;
  const rate = (by.get('rate_limits') ?? {}) as Record<string, number>;
  return {
    enabledModules: enabled,
    maxActiveJobsPerUser: Number(conc.max_active_jobs_per_user) || DEFAULTS.maxActiveJobsPerUser,
    testsPerHourPerUser: Number(rate.tests_per_hour_per_user) || DEFAULTS.testsPerHourPerUser,
    testsPerHourPerDomain: Number(rate.tests_per_hour_per_domain) || DEFAULTS.testsPerHourPerDomain,
  };
}
