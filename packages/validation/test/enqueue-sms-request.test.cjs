const assert = require('node:assert/strict');
const test = require('node:test');
const { enqueueSmsRequestSchema } = require('../dist/index.js');

test('accepts a non-empty SMS request', () => {
  const result = enqueueSmsRequestSchema.safeParse({
    phoneNumber: '+15551234567',
    message: 'Your appointment is confirmed.',
    idempotencyKey: 'request-1',
  });

  assert.equal(result.success, true);
});

test('rejects a blank phone number', () => {
  const result = enqueueSmsRequestSchema.safeParse({
    phoneNumber: '  ',
    message: 'Hello',
    idempotencyKey: 'request-1',
  });

  assert.equal(result.success, false);
});
