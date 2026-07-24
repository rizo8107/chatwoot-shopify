import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileCampaignDeliveryStatuses } from './campaigns.js';

test('campaign delivery reconciliation fetches final Chatwoot statuses', async () => {
  const originalFetch = global.fetch;
  const updates = [];
  let fetches = 0;
  global.fetch = async url => {
    fetches++;
    assert.match(String(url), /conversations\/1433\/messages$/);
    return {
      ok: true,
      json: async () => ({
        payload: [
          { id: 2042, status: 'failed', content_attributes: { external_error_message: 'Meta rejected the message' } },
          { id: 2043, status: 'delivered', content_attributes: {} }
        ]
      })
    };
  };

  try {
    await reconcileCampaignDeliveryStatuses({
      getPending: async () => [
        { chatwoot_message_id: '2042', conversation_id: 1433 },
        { chatwoot_message_id: '2043', conversation_id: 1433 }
      ],
      getSettings: async () => ({
        CHATWOOT_API_URL: 'https://chat.example.test',
        CHATWOOT_ACCOUNT_ID: '1',
        CHATWOOT_API_TOKEN: 'test-token'
      }),
      updateStatus: async (id, status, error) => updates.push({ id, status, error })
    });
    assert.equal(fetches, 1, 'messages in one conversation should be fetched together');
    assert.deepEqual(updates, [
      { id: 2042, status: 'failed', error: 'Meta rejected the message' },
      { id: 2043, status: 'delivered', error: null }
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});
