import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IMPLEMENTED_MODULES } from '@nba/shared';
import { REGISTERED_IDS } from '../src/modules/registry.js';

describe('module registry', () => {
  it('matches the list of modules the UI is told are implemented', () => {
    assert.deepEqual([...REGISTERED_IDS].sort(), [...IMPLEMENTED_MODULES].sort());
  });
});
