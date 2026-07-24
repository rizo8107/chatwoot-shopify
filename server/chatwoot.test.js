import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertParamsComplete,
  buildTemplateButtonParams,
  requireApprovedTemplate,
  resolveConversationId,
  sendWhatsAppTemplate
} from './chatwoot.js';

const baseSettings = {
  CHATWOOT_API_URL: 'https://chat.example.test',
  CHATWOOT_API_TOKEN: 'test-token',
  CHATWOOT_ACCOUNT_ID: '1',
  CHATWOOT_INBOX_ID: '1'
};

test('blank template fails before any Chatwoot request or conversation creation', async () => {
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => {
    requests++;
    throw new Error('fetch must not be called');
  };
  try {
    const result = await sendWhatsAppTemplate(
      { templateName: '', variableMapping: {} },
      { phone: '+919999999999', fullName: 'Test Customer', sourceId: '919999999999' },
      baseSettings,
      { request: null, response: null },
      null
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /No WhatsApp template name configured/);
    assert.equal(requests, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('unknown template fails closed', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      message_templates: [{
        name: 'approved_template',
        status: 'APPROVED',
        category: 'UTILITY',
        language: 'en',
        components: [{ type: 'BODY', text: 'Hi {{1}}' }]
      }]
    })
  });
  try {
    await assert.rejects(
      requireApprovedTemplate({ ...baseSettings, CHATWOOT_API_URL: 'https://unknown-template.test' }, 'missing_template'),
      /was not found/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('non-approved template fails closed', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      message_templates: [{
        name: 'pending_template',
        status: 'PENDING',
        category: 'MARKETING',
        language: 'en',
        components: [{ type: 'BODY', text: 'Hi {{1}}' }]
      }]
    })
  });
  try {
    await assert.rejects(
      requireApprovedTemplate({ ...baseSettings, CHATWOOT_API_URL: 'https://pending-template.test' }, 'pending_template'),
      /not APPROVED/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('required body parameters cannot be omitted', () => {
  assert.throws(() => assertParamsComplete({}, 2), /\{\{1\}\}.*\{\{2\}\}/);
  assert.doesNotThrow(() => assertParamsComplete({ 1: 'A', 2: 'B' }, 2));
});

test('dynamic template buttons require a real mapped URL', () => {
  const buttons = [{ index: 0, type: 'URL', url: 'https://pay.example/{{1}}' }];
  assert.throws(
    () => buildTemplateButtonParams(buttons, {}, { button_0: 'abandonedCheckoutUrl' }),
    /Missing value for template button/
  );
  assert.throws(
    () => buildTemplateButtonParams(buttons, { abandonedCheckoutUrl: 'not-a-url' }),
    /Invalid URL for template button/
  );
  assert.deepEqual(
    buildTemplateButtonParams(
      buttons,
      { abandonedCheckoutUrl: 'https://pay.example/checkouts/abc?key=123' },
      { button_0: 'abandonedCheckoutUrl' }
    ),
    [{ type: 'url', parameter: 'checkouts/abc?key=123' }]
  );
});

test('existing open conversation is reused', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url) => {
    requests.push(String(url));
    return {
      ok: true,
      json: async () => ({
        payload: [
          { id: 10, inbox_id: 1, status: 'resolved', last_activity_at: 30 },
          { id: 11, inbox_id: 1, status: 'open', last_activity_at: 20 },
          { id: 12, inbox_id: 1, status: 'open', last_activity_at: 40, last_non_activity_message: { status: 'read', content: 'Valid message', created_at: 40 } },
          { id: 13, inbox_id: 1, status: 'open', last_activity_at: 99, last_non_activity_message: { status: 'failed', content: 'Template: ', created_at: 99 } }
        ]
      })
    };
  };
  try {
    const result = await resolveConversationId({
      apiBaseUrl: baseSettings.CHATWOOT_API_URL,
      accountId: '1',
      token: 'test-token',
      inboxId: 1,
      contactId: 5,
      sourceId: '919999999999',
      settings: baseSettings
    });
    assert.deepEqual(result, { id: 12, reused: true });
    assert.equal(requests.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a conversation is created only when none is reusable', async () => {
  const originalFetch = global.fetch;
  let request = 0;
  global.fetch = async (_url, options = {}) => {
    request++;
    if (!options.method) return { ok: true, json: async () => ({ payload: [] }) };
    return { ok: true, json: async () => ({ id: 77 }) };
  };
  try {
    const result = await resolveConversationId({
      apiBaseUrl: baseSettings.CHATWOOT_API_URL,
      accountId: '1',
      token: 'test-token',
      inboxId: 1,
      contactId: 5,
      sourceId: '919999999999',
      settings: baseSettings
    });
    assert.equal(result.id, 77);
    assert.equal(result.reused, false);
    assert.equal(request, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
