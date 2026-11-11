import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMPTY_COUNTS } from '@nba/shared';
import { deriveOverall } from '../src/lib/store.js';

describe('deriveOverall', () => {
  const c = (o: Partial<typeof EMPTY_COUNTS>) => ({ ...EMPTY_COUNTS, ...o });
  it('any failure means issues found', () => assert.equal(deriveOverall(c({ pass: 9, fail: 1 })), 'issues_found'));
  it('warnings without failures', () => assert.equal(deriveOverall(c({ pass: 9, warning: 2 })), 'warnings_only'));
  it('passes only → no issues detected (in the tests performed)', () => assert.equal(deriveOverall(c({ pass: 3 })), 'no_issues_detected'));
  it('nothing passed and nothing failed is incomplete, never a pass', () => {
    assert.equal(deriveOverall(c({ skipped: 5 })), 'incomplete');
    assert.equal(deriveOverall(c({ blocked: 2 })), 'incomplete');
    assert.equal(deriveOverall(c({})), 'incomplete');
  });
  it('skipped and blocked checks never turn into passes', () => {
    assert.notEqual(deriveOverall(c({ skipped: 10, blocked: 10 })), 'no_issues_detected');
  });
});
