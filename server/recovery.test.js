import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCartContext } from './recovery.js';

test('recovery context exposes only usable cart values', () => {
  const context = buildCartContext({
    checkout_token: 'checkout-token',
    customer_name: '',
    customer_email: 'customer@example.com',
    customer_phone: '9876543210',
    cart_items: [{ title: 'Incense Combo', quantity: 2, price: '405.00' }],
    cart_total_price: '810',
    abandoned_at: '2026-07-06T03:12:39.754Z',
    shopify_checkout_url: 'https://pay.stomatalfarms.com/checkouts/abc'
  });

  assert.equal(context.fullName, 'Customer');
  assert.equal(context.firstName, 'there');
  assert.equal(context.phone, '+919876543210');
  assert.equal(context.totalPrice, 'INR 810.00');
  assert.equal(context.itemsSummary, 'Incense Combo x2 @ INR 405.00');
  assert.equal(context.checkoutDate, '06 Jul 2026');
  assert.equal(context.abandonedCheckoutUrl, 'https://pay.stomatalfarms.com/checkouts/abc');
});

test('email-shaped Shopify names are not used as WhatsApp greetings', () => {
  const context = buildCartContext({
    checkout_token: 'checkout-token',
    customer_name: 'customer@example.com',
    customer_phone: '+919876543210',
    cart_items: [],
    abandoned_at: '2026-07-06T03:12:39.754Z'
  });

  assert.equal(context.fullName, 'Customer');
  assert.equal(context.firstName, 'there');
});
