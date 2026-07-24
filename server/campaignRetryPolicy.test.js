import test from 'node:test';
import assert from 'node:assert/strict';
import {
  campaignRetryDecision,
  MAX_CAMPAIGN_DELIVERY_RETRIES
} from './campaignRetryPolicy.js';

test('campaign retry policy schedules one-hour then two-hour retries', () => {
  const now = Date.parse('2026-07-24T12:00:00.000Z');
  const first = campaignRetryDecision('Temporary provider failure', 0, now);
  assert.equal(first.shouldRetry, true);
  assert.equal(first.retryCount, 1);
  assert.equal(first.runAt, '2026-07-24T13:00:00.000Z');

  const second = campaignRetryDecision('Temporary provider failure', 1, now);
  assert.equal(second.shouldRetry, true);
  assert.equal(second.retryCount, 2);
  assert.equal(second.runAt, '2026-07-24T14:00:00.000Z');

  const exhausted = campaignRetryDecision('Temporary provider failure', MAX_CAMPAIGN_DELIVERY_RETRIES, now);
  assert.deepEqual(exhausted, {
    shouldRetry: false,
    reason: 'retry_limit_reached',
    retryCount: 2
  });
});

test('campaign retry policy does not retry permanent recipient or template failures', () => {
  assert.equal(campaignRetryDecision('(#131008) Required parameter is missing', 0).shouldRetry, false);
  assert.equal(campaignRetryDecision('Recipient is not a WhatsApp user', 0).shouldRetry, false);
  assert.equal(campaignRetryDecision('Template is not approved', 0).shouldRetry, false);
  assert.equal(campaignRetryDecision('Phone number was converted to scientific notation by Excel', 0).shouldRetry, false);
  assert.equal(campaignRetryDecision('Send WhatsApp failed: 400 invalid request', 0).shouldRetry, false);
});
