import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyWebhookHmac } from './shopify.js';

test('Shopify webhook HMAC is verified against the raw request body', () => {
  const secret = 'test-secret';
  const rawBody = Buffer.from('{"id":123,"token":"checkout-token"}');
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');

  assert.equal(verifyWebhookHmac(rawBody, signature, secret), true);
  assert.equal(verifyWebhookHmac(Buffer.from('{"id":124}'), signature, secret), false);
  assert.equal(verifyWebhookHmac(rawBody, '', secret), false);
});
