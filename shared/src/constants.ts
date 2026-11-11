export const BRAND = {
  name: 'NO BUGS ALLOWED',
  tagline: 'Find the bugs. Fix the problems. Launch with confidence.',
  assistant: 'BUGSY',
} as const;

/** Wording required by the product spec: never claim a site is bug-free. */
export const NO_ISSUES_MESSAGE = 'No issues detected in the tests performed.';

export const JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'cancelled'];

export const MODULE_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
  'blocked',
] as const;
export type ModuleStatus = (typeof MODULE_STATUSES)[number];
/** Module states that are final: the orchestrator never reruns these on recovery. */
export const SETTLED_MODULE_STATUSES: readonly ModuleStatus[] = [
  'completed',
  'failed',
  'skipped',
  'blocked',
];

/**
 * pass     - the check ran and succeeded
 * fail     - the check ran and found a problem
 * warning  - the check ran and found a lower-confidence or lower-impact concern
 * info     - informational finding, not a pass or a problem
 * skipped  - the check was intentionally not run (not applicable / disabled)
 * blocked  - the check could not run (permission denied, tool unavailable, timeout)
 */
export const RESULT_STATUSES = ['pass', 'fail', 'warning', 'info', 'skipped', 'blocked'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** How sure we are about a finding (spec section 5, module G). */
export const CONFIDENCE_LEVELS = ['confirmed', 'potential', 'informational'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const CHECK_CATEGORIES = [
  'connectivity',
  'browser',
  'functional',
  'ui',
  'responsive',
  'performance',
  'accessibility',
  'seo',
  'security',
  'links',
  'api',
  'console',
  'visual',
  'pwa',
  'ai',
  'report',
] as const;
export type CheckCategory = (typeof CHECK_CATEGORIES)[number];

export const MODULE_IDS = [
  'connectivity',
  'browser_launch',
  'page_inspection',
  'console',
  'functional',
  'ui',
  'responsive',
  'performance',
  'accessibility',
  'seo',
  'security',
  'links_resources',
  'api',
  'visual_regression',
  'pwa',
  'ai_analysis',
  'report_generation',
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export interface ModuleDefinition {
  id: ModuleId;
  label: string;
  description: string;
  category: CheckCategory;
  /** Relative weight used to compute real progress from completed modules. */
  weight: number;
  /** System modules always run and cannot be deselected. */
  system: boolean;
}

/** Ordered registry. Order here is execution order. */
export const MODULE_DEFINITIONS: readonly ModuleDefinition[] = [
  { id: 'connectivity', label: 'Website connectivity', description: 'DNS, TLS and HTTP reachability of the target.', category: 'connectivity', weight: 4, system: true },
  { id: 'browser_launch', label: 'Browser launch', description: 'Launches an isolated Chromium session.', category: 'browser', weight: 3, system: true },
  { id: 'page_inspection', label: 'Page inspection', description: 'Loads the page and records the document, redirects and network activity.', category: 'browser', weight: 8, system: true },
  { id: 'console', label: 'JavaScript & console', description: 'Console errors, unhandled exceptions and failed requests captured during load.', category: 'console', weight: 4, system: false },
  { id: 'functional', label: 'Functional testing', description: 'Navigation, buttons, forms, tabs, modals and interactive elements.', category: 'functional', weight: 12, system: false },
  { id: 'ui', label: 'UI testing', description: 'Overlaps, overflow, clipped content and layout problems.', category: 'ui', weight: 8, system: false },
  { id: 'responsive', label: 'Responsive testing', description: 'Layout checks across mobile, tablet and desktop viewports.', category: 'responsive', weight: 10, system: false },
  { id: 'performance', label: 'Performance testing', description: 'Lighthouse performance metrics and recommendations.', category: 'performance', weight: 12, system: false },
  { id: 'accessibility', label: 'Accessibility testing', description: 'axe-core and keyboard/focus checks.', category: 'accessibility', weight: 8, system: false },
  { id: 'seo', label: 'SEO testing', description: 'Titles, meta tags, canonical, robots, sitemap and structured signals.', category: 'seo', weight: 6, system: false },
  { id: 'security', label: 'Security checks', description: 'Passive, non-destructive header, cookie and transport checks.', category: 'security', weight: 8, system: false },
  { id: 'links_resources', label: 'Links & resources', description: 'Broken links, failed assets and redirect loops.', category: 'links', weight: 8, system: false },
  { id: 'api', label: 'API inspection', description: 'Publicly observed API calls: status, timing, content type and CORS.', category: 'api', weight: 5, system: false },
  { id: 'visual_regression', label: 'Visual regression', description: 'Screenshot comparison against an authorised baseline.', category: 'visual', weight: 4, system: false },
  { id: 'pwa', label: 'PWA & compatibility', description: 'Manifest, service worker and installability signals.', category: 'pwa', weight: 3, system: false },
  { id: 'ai_analysis', label: 'AI analysis', description: 'AI-assisted explanation and fix suggestions for detected problems.', category: 'ai', weight: 6, system: true },
  { id: 'report_generation', label: 'Report generation', description: 'Aggregates results into the final report.', category: 'report', weight: 2, system: true },
] as const;

/**
 * Modules with a real implementation in the worker. A module absent from this
 * list is reported as "skipped: not available in this version" and is never
 * counted as a pass. Keep in sync with worker/src/modules/registry.ts.
 */
export const IMPLEMENTED_MODULES: readonly ModuleId[] = [
  'connectivity',
  'browser_launch',
  'page_inspection',
  'console',
  'functional',
  'ui',
  'responsive',
  'performance',
  'accessibility',
  'seo',
  'security',
  'links_resources',
  'api',
  'visual_regression',
  'pwa',
  'ai_analysis',
  'report_generation',
];

export const MODULE_BY_ID: Readonly<Record<ModuleId, ModuleDefinition>> = Object.fromEntries(
  MODULE_DEFINITIONS.map((m) => [m.id, m]),
) as Record<ModuleId, ModuleDefinition>;

/** Resolve the ordered module list for a job from a user selection. */
export function resolveModules(selection?: readonly ModuleId[] | null): ModuleId[] {
  const wanted = new Set<ModuleId>(selection && selection.length > 0 ? selection : IMPLEMENTED_MODULES);
  return MODULE_DEFINITIONS.filter((m) => m.system || wanted.has(m.id)).map((m) => m.id);
}

export const VIEWPORTS = [
  { id: 'small-mobile', label: 'Small mobile', width: 320, height: 568 },
  { id: 'mobile', label: 'Standard mobile', width: 375, height: 812 },
  { id: 'large-mobile', label: 'Large mobile', width: 430, height: 932 },
  { id: 'tablet', label: 'Tablet', width: 768, height: 1024 },
  { id: 'laptop', label: 'Laptop', width: 1280, height: 800 },
  { id: 'desktop', label: 'Desktop', width: 1440, height: 900 },
  { id: 'large-desktop', label: 'Large desktop', width: 1920, height: 1080 },
] as const;

export const LIMITS = {
  maxUrlLength: 2048,
  maxRedirects: 5,
  connectTimeoutMs: 10_000,
  /** Largest HTML document we will download for inspection. */
  maxDocumentBytes: 5 * 1024 * 1024,
  maxConsoleEventsStored: 200,
  maxFailedRequestsStored: 200,
  maxLogMessageLength: 2000,
} as const;
