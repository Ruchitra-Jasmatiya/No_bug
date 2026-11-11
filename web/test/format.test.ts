import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatDuration, guessUrl, pluralise, timeAgo } from '../src/lib/format';

describe('format helpers', () => {
  it('formats durations', () => {
    assert.equal(formatDuration(4000), '4s');
    assert.equal(formatDuration(125_000), '2m 05s');
    assert.equal(formatDuration(-5), '0s');
  });
  it('guesses https for bare domains and keeps explicit schemes', () => {
    assert.equal(guessUrl('example.com'), 'https://example.com');
    assert.equal(guessUrl('  http://example.com '), 'http://example.com');
    assert.equal(guessUrl(''), '');
  });
  it('pluralises', () => {
    assert.equal(pluralise(1, 'issue'), '1 issue');
    assert.equal(pluralise(2, 'issue'), '2 issues');
  });
  it('timeAgo handles empty and recent values', () => {
    assert.equal(timeAgo(null), '—');
    assert.equal(timeAgo(new Date().toISOString()), 'just now');
  });
});
