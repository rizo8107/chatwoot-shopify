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
  SHOPIFY_API_KEY: string;
  SHOPIFY_API_SECRET: string;
  SHOPIFY_SCOPES: string;
  SHOPIFY_APP_URL: string;
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
  SHOPIFY_API_KEY: '', SHOPIFY_API_SECRET: '', SHOPIFY_SCOPES: 'read_orders,read_checkouts,read_fulfillments', SHOPIFY_APP_URL: '',
  WEBHOOK_MAX_RETRIES: '3',
};

interface TemplateInfo { name: string; language: string; category: string; paramCount: number; body: string; }

function MappingInput({ label, hint, mappingKey, templateKey, settings, onChange, templates }: {
  label: string; hint: string; mappingKey: string; templateKey: string;
  settings: Settings; onChange: (k: string, v: string) => void; templates: TemplateInfo[];
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
        {templates.length > 0 && (
          <select className="select" style={{ marginBottom: 6 }} value={templates.some(t => t.name === settings[templateKey]) ? settings[templateKey] : ''}
            onChange={e => { if (e.target.value) onChange(templateKey, e.target.value); }}>
            <option value="">— pick a template from Chatwoot —</option>
            {templates.map(t => <option key={t.name} value={t.name}>{t.name} · {t.language} · {t.paramCount} var{t.paramCount !== 1 ? 's' : ''}</option>)}
          </select>
        )}
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
  const [showShopifySecret, setShowShopifySecret] = useState(false);
  const [shopStatus, setShopStatus] = useState<{ connected: boolean; shop: string; scopes: string; hasCredentials: boolean } | null>(null);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);

  const loadStatus = () => {
    fetch(`${API}/shopify/status`).then(r => r.json()).then(setShopStatus).catch(() => {});
  };

  useEffect(() => {
    fetch(`${API}/settings`)
      .then(r => r.json())
      .then(d => { setSettings({ ...EMPTY, ...d }); setLoading(false); })
      .catch(() => setLoading(false));
    loadStatus();
    fetch(`${API}/whatsapp/templates`).then(r => r.json()).then(d => setTemplates(Array.isArray(d) ? d : [])).catch(() => {});
    if (new URLSearchParams(window.location.search).get('shopify') === 'connected') {
      setMsg('Shopify connected ✓');
      setTimeout(() => setMsg(''), 4000);
    }
  }, []);

  const set = (k: string, v: string) => setSettings(s => ({ ...s, [k]: v }));

  const connectShopify = async () => {
    // Persist credentials first so the OAuth start route can read them
    await fetch(`${API}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
    const shop = encodeURIComponent(settings.SHOPIFY_STORE_URL || '');
    window.location.href = `${API}/shopify/auth?shop=${shop}`;
  };

  const disconnectShopify = async () => {
    if (!confirm('Disconnect the Shopify store? The stored access token will be cleared.')) return;
    await fetch(`${API}/shopify/disconnect`, { method: 'POST' });
    setSettings(s => ({ ...s, SHOPIFY_ADMIN_TOKEN: '' }));
    loadStatus();
  };

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
            <div className="card-title">🛍 Shopify</div>
            <div className="card-sub">Connect your store via OAuth to read orders & abandoned checkouts and auto-register webhooks</div>
          </div>
          {shopStatus && (
            <span className={`badge ${shopStatus.connected ? 'success' : 'pending'}`}>
              <span className="badge-dot" />{shopStatus.connected ? `Connected: ${shopStatus.shop}` : 'Not connected'}
            </span>
          )}
        </div>

        {/* OAuth credentials */}
        <div className="divider-label mb-4"><span>OAuth App Credentials</span></div>
        <div className="callout info mb-4" style={{ display: 'block' }}>
          Create a custom app in your Shopify admin (<b>Settings → Apps → Develop apps</b>) or a Partner app, copy its
          <b> API key</b> &amp; <b>API secret</b> here, and add this redirect URL to the app's allowed URLs:
          <div className="font-mono text-sm mt-2">{(settings.SHOPIFY_APP_URL || window.location.origin)}/api/shopify/auth/callback</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
          <div className="form-group">
            <label className="form-label">Store URL</label>
            <input className="input" value={settings.SHOPIFY_STORE_URL} onChange={e => set('SHOPIFY_STORE_URL', e.target.value)} placeholder="yourstore.myshopify.com" />
            <div className="form-hint">Without https:// prefix</div>
          </div>
          <div className="form-group">
            <label className="form-label">App URL (public base)</label>
            <input className="input" value={settings.SHOPIFY_APP_URL} onChange={e => set('SHOPIFY_APP_URL', e.target.value)} placeholder="https://flow.stomatalfarms.com" />
            <div className="form-hint">Where this dashboard is hosted (used to build the redirect URL)</div>
          </div>
          <div className="form-group">
            <label className="form-label">API Key</label>
            <input className="input" value={settings.SHOPIFY_API_KEY} onChange={e => set('SHOPIFY_API_KEY', e.target.value)} placeholder="Client ID" />
          </div>
          <div className="form-group">
            <label className="form-label">API Secret</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="input" type={showShopifySecret ? 'text' : 'password'} value={settings.SHOPIFY_API_SECRET} onChange={e => set('SHOPIFY_API_SECRET', e.target.value)} placeholder="Client secret" style={{ flex: 1 }} />
              <button className="btn btn-secondary btn-sm btn-icon" onClick={() => setShowShopifySecret(s => !s)}>
                {showShopifySecret
                  ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                }
              </button>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Scopes</label>
            <input className="input" value={settings.SHOPIFY_SCOPES} onChange={e => set('SHOPIFY_SCOPES', e.target.value)} placeholder="read_orders,read_checkouts,read_fulfillments" />
          </div>
        </div>

        <div className="flex items-center gap-3 mb-4">
          <button className="btn btn-primary" onClick={connectShopify} disabled={!settings.SHOPIFY_STORE_URL || !settings.SHOPIFY_API_KEY || !settings.SHOPIFY_API_SECRET}>
            {shopStatus?.connected ? 'Reconnect Shopify' : 'Connect Shopify'}
          </button>
          {shopStatus?.connected && <button className="btn btn-secondary" onClick={disconnectShopify}>Disconnect</button>}
          <span className="text-dim text-sm">Saves credentials, then redirects to Shopify to authorize.</span>
        </div>

        {/* Manual token fallback */}
        <div className="divider" />
        <div className="divider-label mb-4"><span>Manual Admin Token (optional fallback)</span></div>
        <div className="form-group" style={{ maxWidth: '50%' }}>
          <label className="form-label">Admin API Access Token</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="input" type={showShopifyToken ? 'text' : 'password'} value={settings.SHOPIFY_ADMIN_TOKEN} onChange={e => set('SHOPIFY_ADMIN_TOKEN', e.target.value)} placeholder="shpat_... (set automatically after OAuth)" style={{ flex: 1 }} />
            <button className="btn btn-secondary btn-sm btn-icon" onClick={() => setShowShopifyToken(s => !s)}>
              {showShopifyToken
                ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              }
            </button>
          </div>
          <div className="form-hint">Auto-filled by OAuth. Only set manually if using a custom-app token instead.</div>
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
          templates={templates}
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
          templates={templates}
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
          templates={templates}
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
