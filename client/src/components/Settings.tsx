import React, { useEffect, useState } from 'react';

const API = '/api';

interface Settings {
  CHATWOOT_API_URL: string;
  CHATWOOT_API_TOKEN: string;
  CHATWOOT_ACCOUNT_ID: string;
  CHATWOOT_INBOX_ID: string;
  WHATSAPP_TEMPLATE_NAME: string;
  WHATSAPP_TEMPLATE_MAPPING: string;
  WHATSAPP_SHIPPING_TEMPLATE_NAME: string;
  WHATSAPP_SHIPPING_TEMPLATE_MAPPING: string;
  WHATSAPP_ABANDONED_CART_TEMPLATE_NAME: string;
  WHATSAPP_ABANDONED_CART_TEMPLATE_MAPPING: string;
  SHOPIFY_STORE_URL: string;
  SHOPIFY_ADMIN_TOKEN: string;
  WEBHOOK_MAX_RETRIES: string;
  [key: string]: string;
}

const CONTEXT_FIELDS = [
  'fullName', 'firstName', 'lastName', 'phone', 'email', 'orderNumber', 'orderName',
  'totalPrice', 'itemsSummary', 'orderDate', 'shippingCity', 'orderStatusUrl',
  'checkoutId', 'abandonedCheckoutUrl', 'trackingNumber', 'trackingUrl', 'trackingCompany',
];

const EMPTY: Settings = {
  CHATWOOT_API_URL: '', CHATWOOT_API_TOKEN: '', CHATWOOT_ACCOUNT_ID: '', CHATWOOT_INBOX_ID: '',
  WHATSAPP_TEMPLATE_NAME: '', WHATSAPP_TEMPLATE_MAPPING: '',
  WHATSAPP_SHIPPING_TEMPLATE_NAME: '', WHATSAPP_SHIPPING_TEMPLATE_MAPPING: '',
  WHATSAPP_ABANDONED_CART_TEMPLATE_NAME: '', WHATSAPP_ABANDONED_CART_TEMPLATE_MAPPING: '',
  SHOPIFY_STORE_URL: '', SHOPIFY_ADMIN_TOKEN: '',
  WEBHOOK_MAX_RETRIES: '3',
};

function MappingInput({ label, hint, mappingKey, templateKey, settings, onChange }: {
  label: string; hint: string; mappingKey: string; templateKey: string;
  settings: Settings; onChange: (k: string, v: string) => void;
}) {
  const addField = (field: string) => {
    if (!field) return;
    const curr = (settings[mappingKey] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!curr.includes(field)) onChange(mappingKey, [...curr, field].join(', '));
  };

  const removeField = (field: string) => {
    const curr = (settings[mappingKey] || '').split(',').map(s => s.trim()).filter(Boolean);
    onChange(mappingKey, curr.filter(f => f !== field).join(', '));
  };

  const mapped = (settings[mappingKey] || '').split(',').map(s => s.trim()).filter(Boolean);

  return (
    <div>
      <div className="form-group">
        <label className="form-label">{templateKey.replace(/_/g, ' ').replace('WHATSAPP ', '')}</label>
        <input className="input" value={settings[templateKey] || ''} onChange={e => onChange(templateKey, e.target.value)} placeholder="e.g. order_confirmation_01" />
      </div>
      <div className="form-group">
        <label className="form-label">{label}</label>
        <div className="form-hint" style={{ marginBottom: 6 }}>{hint}</div>
        {/* Mapped fields display */}
        {mapped.length > 0 && (
          <div className="flex gap-2 mb-2" style={{ flexWrap: 'wrap' }}>
            {mapped.map((f, i) => (
              <span key={f} className="badge pending" style={{ cursor: 'default', gap: 6 }}>
                <span className="text-dim" style={{ fontSize: 10 }}>{'{{' + (i + 1) + '}}'}</span>
                {f}
                <button
                  onClick={() => removeField(f)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', padding: 0, display: 'flex', alignItems: 'center' }}
                >×</button>
              </span>
            ))}
          </div>
        )}
        {/* Add field dropdown */}
        <select className="select"
          onChange={e => { addField(e.target.value); e.target.value = ''; }}
          defaultValue="">
          <option value="">+ Add variable...</option>
          {CONTEXT_FIELDS.filter(f => !mapped.includes(f)).map(f => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
        {/* Raw edit */}
        <input className="input mt-2" value={settings[mappingKey] || ''}
          onChange={e => onChange(mappingKey, e.target.value)}
          placeholder="or type manually: field1, field2, field3" />
      </div>
    </div>
  );
}

export const Settings: React.FC = () => {
  const [settings, setSettings] = useState<Settings>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [showShopifyToken, setShowShopifyToken] = useState(false);

  useEffect(() => {
    fetch(`${API}/settings`)
      .then(r => r.json())
      .then(d => { setSettings({ ...EMPTY, ...d }); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const set = (k: string, v: string) => setSettings(s => ({ ...s, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      await fetch(`${API}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      setMsg('Settings saved successfully ✓');
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
    setSaving(false);
    setTimeout(() => setMsg(''), 4000);
  };

  if (loading) return (
    <div className="page"><div className="empty-state"><span className="spinner" /></div></div>
  );

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Settings</div>
          <div className="page-sub">Configure Chatwoot, Shopify, and WhatsApp template settings</div>
        </div>
        <div className="flex items-center gap-3">
          {msg && <span style={{ fontSize: 13, color: msg.startsWith('Error') ? 'var(--red)' : 'var(--green)' }}>{msg}</span>}
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <span className="spinner" style={{ width: 14, height: 14 }} /> : null}
            Save Settings
          </button>
        </div>
      </div>

      {/* Chatwoot */}
      <div className="card mb-4">
        <div className="card-header"><div className="card-title">🟣 Chatwoot Configuration</div></div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
          <div className="form-group">
            <label className="form-label">API Base URL</label>
            <input className="input" value={settings.CHATWOOT_API_URL} onChange={e => set('CHATWOOT_API_URL', e.target.value)} placeholder="https://app.chatwoot.com" />
          </div>
          <div className="form-group">
            <label className="form-label">Account ID</label>
            <input className="input" value={settings.CHATWOOT_ACCOUNT_ID} onChange={e => set('CHATWOOT_ACCOUNT_ID', e.target.value)} placeholder="1" />
          </div>
          <div className="form-group">
            <label className="form-label">API Access Token</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="input" type={showToken ? 'text' : 'password'} value={settings.CHATWOOT_API_TOKEN} onChange={e => set('CHATWOOT_API_TOKEN', e.target.value)} placeholder="User API access token" style={{ flex: 1 }} />
              <button className="btn btn-secondary btn-sm btn-icon" onClick={() => setShowToken(s => !s)}>
                {showToken
                  ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                }
              </button>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">WhatsApp Inbox ID</label>
            <input className="input" value={settings.CHATWOOT_INBOX_ID} onChange={e => set('CHATWOOT_INBOX_ID', e.target.value)} placeholder="1" />
          </div>
          <div className="form-group">
            <label className="form-label">Auto-retry failed webhooks</label>
            <input className="input" type="number" min={0} value={settings.WEBHOOK_MAX_RETRIES} onChange={e => set('WEBHOOK_MAX_RETRIES', e.target.value)} placeholder="3" />
            <div className="form-hint">Max automatic retries on failure (backoff 1m → 5m → 15m). Set 0 to disable.</div>
          </div>
        </div>
      </div>

      {/* Shopify */}
      <div className="card mb-4">
        <div className="card-header">
          <div>
            <div className="card-title">🛍 Shopify Admin API</div>
            <div className="card-sub">Required for Fetch Shopify nodes in flows</div>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
          <div className="form-group">
            <label className="form-label">Store URL</label>
            <input className="input" value={settings.SHOPIFY_STORE_URL} onChange={e => set('SHOPIFY_STORE_URL', e.target.value)} placeholder="yourstore.myshopify.com" />
            <div className="form-hint">Without https:// prefix</div>
          </div>
          <div className="form-group">
            <label className="form-label">Admin API Access Token</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="input" type={showShopifyToken ? 'text' : 'password'} value={settings.SHOPIFY_ADMIN_TOKEN} onChange={e => set('SHOPIFY_ADMIN_TOKEN', e.target.value)} placeholder="shpat_..." style={{ flex: 1 }} />
              <button className="btn btn-secondary btn-sm btn-icon" onClick={() => setShowShopifyToken(s => !s)}>
                {showShopifyToken
                  ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                }
              </button>
            </div>
            <div className="form-hint">Needs read_orders and read_checkouts scopes</div>
          </div>
        </div>
      </div>

      {/* Templates */}
      <div className="card mb-4">
        <div className="card-header">
          <div>
            <div className="card-title">💬 WhatsApp Templates (Legacy / Fallback)</div>
            <div className="card-sub">Used when no matching flow is active. Each Send WhatsApp node can override these.</div>
          </div>
        </div>

        <div className="divider-label mb-4"><span>Order Confirmation</span></div>
        <MappingInput
          label="Variable Mapping"
          hint="Maps order fields to template variables {{1}}, {{2}}, etc."
          templateKey="WHATSAPP_TEMPLATE_NAME"
          mappingKey="WHATSAPP_TEMPLATE_MAPPING"
          settings={settings}
          onChange={set}
        />

        <div className="divider" />
        <div className="divider-label mb-4"><span>Shipping Confirmation</span></div>
        <MappingInput
          label="Variable Mapping"
          hint="Maps fulfillment fields to template variables"
          templateKey="WHATSAPP_SHIPPING_TEMPLATE_NAME"
          mappingKey="WHATSAPP_SHIPPING_TEMPLATE_MAPPING"
          settings={settings}
          onChange={set}
        />

        <div className="divider" />
        <div className="divider-label mb-4"><span>Abandoned Cart</span></div>
        <MappingInput
          label="Variable Mapping"
          hint="Maps checkout fields to template variables"
          templateKey="WHATSAPP_ABANDONED_CART_TEMPLATE_NAME"
          mappingKey="WHATSAPP_ABANDONED_CART_TEMPLATE_MAPPING"
          settings={settings}
          onChange={set}
        />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', paddingBottom: 32 }}>
        {msg && <span style={{ fontSize: 13, color: msg.startsWith('Error') ? 'var(--red)' : 'var(--green)', marginRight: 12, alignSelf: 'center' }}>{msg}</span>}
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? <span className="spinner" style={{ width: 14, height: 14 }} /> : null}
          Save Settings
        </button>
      </div>
    </div>
  );
};
