const assert = require('node:assert/strict');
const test = require('node:test');
const { canTransitionJobStatus } = require('../dist/index.js');

test('allows jobs to move from queued to sending', () => {
  assert.equal(canTransitionJobStatus('queued', 'sending'), true);
});

test('does not allow a sent job to be queued again', () => {
  assert.equal(canTransitionJobStatus('sent', 'queued'), false);
});

test('allows failed jobs to be retried', () => {
  assert.equal(canTransitionJobStatus('failed', 'queued'), true);
});
