import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertParamsComplete,
  buildTemplateButtonParams,
  buildTemplateHeaderParams,
  normalizePhone,
  requireApprovedTemplate,
  resolveContactByUniqueExactName,
  resolveContactId,
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

test('Excel scientific-notation phone numbers are rejected without losing digits silently', () => {
  assert.deepEqual(
    normalizePhone('9.19995E+11', ''),
    { cleanPhone: '', formattedPhone: '', sourceId: '', invalidReason: 'scientific_notation' }
  );
  assert.deepEqual(
    normalizePhone('+919994874789', ''),
    { cleanPhone: '919994874789', formattedPhone: '+919994874789', sourceId: '919994874789', invalidReason: null }
  );
});

test('a unique exact-name contact can recover its WhatsApp inbox source ID', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      payload: [{
        id: 656,
        name: 'chitradevi chitradevi',
        phone_number: '',
        contact_inboxes: [
          { source_id: '1783304167444', inbox: { id: 1 } },
          { source_id: '919994874789', inbox: { id: 1 } },
          { source_id: 'IN.1557570669054718', inbox: { id: 1 } }
        ]
      }]
    })
  });
  try {
    assert.deepEqual(
      await resolveContactByUniqueExactName(
        baseSettings.CHATWOOT_API_URL,
        '1',
        'test-token',
        1,
        'chitradevi chitradevi'
      ),
      { id: 656, sourceId: '919994874789' }
    );
  } finally {
    global.fetch = originalFetch;
  }
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

test('media template headers require a public HTTPS URL', () => {
  const header = { format: 'IMAGE' };
  assert.throws(() => buildTemplateHeaderParams(header, ''), /requires an image header URL/);
  assert.throws(() => buildTemplateHeaderParams(header, 'http://example.com/header.jpg'), /must use a public HTTPS URL/);
  assert.deepEqual(
    buildTemplateHeaderParams(header, 'https://cdn.example.com/header.jpg'),
    { media_url: 'https://cdn.example.com/header.jpg', media_type: 'image' }
  );
  assert.equal(buildTemplateHeaderParams(null, ''), undefined);
});

test('template metadata includes required image header details', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      message_templates: [{
        name: 'image_campaign',
        status: 'APPROVED',
        category: 'MARKETING',
        language: 'en',
        components: [
          { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://cdn.example.com/sample.jpg'] } },
          { type: 'BODY', text: 'Hi {{1}}' }
        ]
      }]
    })
  });
  try {
    const template = await requireApprovedTemplate(
      { ...baseSettings, CHATWOOT_API_URL: 'https://image-template.test' },
      'image_campaign'
    );
    assert.deepEqual(template.header, {
      format: 'IMAGE',
      text: '',
      exampleUrl: 'https://cdn.example.com/sample.jpg'
    });
    assert.equal(template.bodyParamCount, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('contact creation retries a transient Chatwoot 500', async () => {
  const originalFetch = global.fetch;
  let createAttempts = 0;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ url: String(url), method });
    if (String(url).includes('/contacts/search')) {
      return { ok: true, status: 200, json: async () => ({ payload: [] }) };
    }
    if (String(url).endsWith('/contacts/filter')) {
      return { ok: true, status: 200, json: async () => ({ payload: [] }) };
    }
    if (String(url).endsWith('/contacts') && method === 'POST') {
      createAttempts++;
      if (createAttempts === 1) {
        return { ok: false, status: 500, json: async () => ({ message: 'Temporary database error' }) };
      }
      return { ok: true, status: 200, json: async () => ({ payload: { contact: { id: 91 } } }) };
    }
    if (method === 'PUT') {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  try {
    const id = await resolveContactId({
      apiBaseUrl: baseSettings.CHATWOOT_API_URL,
      accountId: '1',
      token: 'test-token',
      inboxId: 1,
      name: 'Vaishu Palani',
      phone: '+919884448433',
      sourceId: '919884448433'
    });
    assert.equal(id, 91);
    assert.equal(createAttempts, 2);
    assert.equal(calls.filter(call => call.url.endsWith('/contacts') && call.method === 'POST').length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('contact creation reuses a contact committed before Chatwoot returned 500', async () => {
  const originalFetch = global.fetch;
  let searchCalls = 0;
  let createAttempts = 0;
  global.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (String(url).includes('/contacts/search')) {
      searchCalls++;
      const payload = searchCalls >= 3 ? [{ id: 92, phone_number: '+919884448433' }] : [];
      return { ok: true, status: 200, json: async () => ({ payload }) };
    }
    if (String(url).endsWith('/contacts') && method === 'POST') {
      createAttempts++;
      return { ok: false, status: 500, json: async () => ({ message: 'Internal server error' }) };
    }
    if (method === 'PUT') {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  try {
    const id = await resolveContactId({
      apiBaseUrl: baseSettings.CHATWOOT_API_URL,
      accountId: '1',
      token: 'test-token',
      inboxId: 1,
      name: 'Vaishu Palani',
      phone: '+919884448433',
      sourceId: '919884448433'
    });
    assert.equal(id, 92);
    assert.equal(createAttempts, 1);
  } finally {
    global.fetch = originalFetch;
  }
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
