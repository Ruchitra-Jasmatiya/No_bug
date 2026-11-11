export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function pluralise(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Same rule as the API: add https:// when the user typed a bare domain. */
export function guessUrl(input: string): string {
  const t = input.trim();
  if (!t) return t;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
}

export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'informational'] as const;

export const CATEGORY_LABEL: Record<string, string> = {
  connectivity: 'Connectivity', browser: 'Browser', functional: 'Functional', ui: 'UI', responsive: 'Responsive', performance: 'Performance',
  accessibility: 'Accessibility', seo: 'SEO', security: 'Security', links: 'Links', api: 'API', console: 'Console', visual: 'Visual', pwa: 'PWA', ai: 'AI', report: 'Report',
};

export const STATUS_LABEL: Record<string, string> = {
  queued: 'Waiting in line', running: 'Testing', completed: 'Finished', failed: 'Could not finish', cancelled: 'Cancelled',
  pending: 'Waiting', skipped: 'Skipped', blocked: 'Blocked',
};
