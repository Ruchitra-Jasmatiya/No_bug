import { IMPLEMENTED_MODULES, type ModuleId } from '@nba/shared';
import { functionalModule } from './functional.js';
import { uiModule } from './ui.js';
import { responsiveModule } from './responsive.js';
import { performanceModule } from './performance.js';
import { accessibilityModule } from './accessibility.js';
import { seoModule } from './seo.js';
import { securityModule } from './security.js';
import { linksModule } from './links.js';
import { apiModule } from './api.js';
import { visualRegressionModule } from './visual-regression.js';
import { pwaModule } from './pwa.js';
import { browserLaunchModule } from './browser-launch.js';
import { connectivityModule } from './connectivity.js';
import { consoleModule } from './console.js';
import { pageInspectionModule } from './page-inspection.js';
import { reportModule } from './report.js';
import { aiAnalysisModule } from './ai-analysis.js';
import type { TestModule } from './types.js';

/**
 * Modules with a real implementation. A module that is selected but not listed here is recorded as
 * "skipped: not available in this version" and is never counted as a pass.
 * Keep in sync with IMPLEMENTED_MODULES in @nba/shared (asserted by a test).
 */
export const MODULES: Partial<Record<ModuleId, TestModule>> = {
  connectivity: connectivityModule,
  browser_launch: browserLaunchModule,
  page_inspection: pageInspectionModule,
  console: consoleModule,
  functional: functionalModule,
  ui: uiModule,
  responsive: responsiveModule,
  performance: performanceModule,
  accessibility: accessibilityModule,
  seo: seoModule,
  security: securityModule,
  links_resources: linksModule,
  api: apiModule,
  visual_regression: visualRegressionModule,
  pwa: pwaModule,
  ai_analysis: aiAnalysisModule,
  report_generation: reportModule,
};

export function getModule(id: ModuleId): TestModule | undefined {
  return MODULES[id];
}

export const REGISTERED_IDS = Object.keys(MODULES) as ModuleId[];
void IMPLEMENTED_MODULES;
