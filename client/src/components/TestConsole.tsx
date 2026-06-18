import React, { useState } from 'react';

const API = '/api';

const PRESETS: Record<string, { label: string; topic: string; payload: any }> = {
  order: {
    label: 'Order Created',
    topic: 'orders/create',
    payload: {
      order_number: '1001',
      name: '#1001',
      total_price: '499.00',
      order_status_url: 'https://stomatalfarms.com/orders/abc123',
      created_at: new Date().toISOString(),
      customer: { first_name: 'Rahul', last_name: 'Sharma', phone: '9941569662', email: 'rahul@example.com' },
      billing_address: { first_name: 'Rahul', last_name: 'Sharma', phone: '9941569662', city: 'Chennai' },
      shipping_address: { city: 'Chennai' },
      line_items: [{ name: 'Aarambh Starter Collection', quantity: 2, price: '249.50' }]
    }
  },
  fulfillment: {
    label: 'Order Shipped',
    topic: 'fulfillments/create',
    payload: {
      id: 12345,
      order_id: 99001,
      name: '#1001.1',
      email: 'rahul@example.com',
      status: 'success',
      tracking_company: 'Delhivery',
      tracking_number: 'DL1234567890',
      tracking_url: 'https://www.delhivery.com/track/DL1234567890',
      destination: { first_name: 'Rahul', last_name: 'Sharma', phone: '9941569662', city: 'Chennai' },
      line_items: [{ name: 'Aarambh Starter Collection', quantity: 2, price: '249.50' }]
    }
  },
  checkout: {
    label: 'Abandoned Cart',
    topic: 'checkouts/create',
    payload: {
      id: 55001,
      token: 'sample_token_abc',
      email: 'priya@example.com',
      total_price: '349.00',
      currency: 'INR',
      abandoned_checkout_url: 'https://stomatalfarms.com/checkouts/recover/sample_token_abc',
      created_at: new Date().toISOString(),
      customer: { first_name: 'Priya', last_name: 'Nair', phone: '8610554711', email: 'priya@example.com' },
      billing_address: { first_name: 'Priya', last_name: 'Nair', phone: '8610554711' },
      line_items: [{ title: 'Aarambh Starter Collection', quantity: 1, price: '349.00' }]
    }
  }
};

interface Step { name: string; status: string; durationMs?: number; request?: any; response?: any; error?: any; }
interface Result { success: boolean; id?: string; status?: string; steps?: Step[]; errorMessage?: string; note?: string; }

function StepView({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  const dotClass = step.status === 'success' ? 'success' : step.status === 'failed' ? 'failed' : 'pending';

  return (
    <div className={`timeline-item ${dotClass}`}>
      <div className="timeline-header" onClick={() => setOpen(o => !o)}>
        <span className={`timeline-dot ${dotClass}`} />
        <span className="timeline-step-name">{step.name}</span>
        <span className="timeline-step-meta">
          {step.durationMs != null ? `${step.durationMs}ms` : ''}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginLeft: 6, transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none' }}><path d="m6 9 6 6 6-6"/></svg>
        </span>
      </div>
      {open && (
        <div className="timeline-body">
          {step.request && <div><div className="timeline-section-label">Request</div><pre className="code-block">{JSON.stringify(step.request, null, 2)}</pre></div>}
          {step.response && <div><div className="timeline-section-label">Response</div><pre className="code-block">{JSON.stringify(step.response, null, 2)}</pre></div>}
          {step.error && <div><div className="timeline-section-label">Error</div><pre className="code-block error">{step.error.message}{step.error.stack ? '\n\n' + step.error.stack : ''}</pre></div>}
        </div>
      )}
    </div>
  );
}

export const TestConsole: React.FC = () => {
  const [presetKey, setPresetKey] = useState<keyof typeof PRESETS>('order');
  const [payload, setPayload] = useState(JSON.stringify(PRESETS.order.payload, null, 2));
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [flows, setFlows] = useState<{ id: string; name: string }[]>([]);
  const [selectedFlow, setSelectedFlow] = useState('');

  React.useEffect(() => {
    fetch(`${API}/flows`).then(r => r.json()).then(d => setFlows(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  const applyPreset = (key: keyof typeof PRESETS) => {
    setPresetKey(key);
    setPayload(JSON.stringify(PRESETS[key].payload, null, 2));
    setResult(null);
    setError('');
  };

  const run = async () => {
    setLoading(true);
    setResult(null);
    setError('');
    try {
      let parsed: any;
      try { parsed = JSON.parse(payload); } catch { setError('Invalid JSON — please fix the payload.'); setLoading(false); return; }

      const topic = PRESETS[presetKey]?.topic || 'orders/create';
      const endpoint = selectedFlow ? `${API}/test-flow/${selectedFlow}` : `${API}/test-flow`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-shopify-topic': topic },
        body: JSON.stringify(parsed)
      });
      const data = await res.json();
      setResult(data);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Test Console</div>
          <div className="page-sub">Send test payloads through the automation pipeline synchronously</div>
        </div>
      </div>

      {/* Preset selector */}
      <div className="card mb-4">
        <div className="card-header"><div className="card-title">Payload Type</div></div>
        <div className="filter-tabs" style={{ display: 'inline-flex', marginBottom: 16 }}>
          {Object.entries(PRESETS).map(([k, v]) => (
            <button key={k} className={`filter-tab${presetKey === k ? ' active' : ''}`} onClick={() => applyPreset(k as any)}>
              {v.label}
            </button>
          ))}
        </div>

        <div className="form-group">
          <label className="form-label">Test Against Flow (optional)</label>
          <select className="select" value={selectedFlow} onChange={e => setSelectedFlow(e.target.value)}>
            <option value="">Legacy pipeline (no flow)</option>
            {flows.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <div className="form-hint">Select a flow to test its execution. Note: Delay nodes won't be scheduled in test mode — they will pause the flow and show a note.</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
        {/* Input */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">JSON Payload</div>
            <button className="btn btn-secondary btn-sm" onClick={() => applyPreset(presetKey)}>Reset</button>
          </div>
          <textarea
            className="textarea"
            style={{ minHeight: 420, fontFamily: 'var(--font-mono)', fontSize: 12 }}
            value={payload}
            onChange={e => setPayload(e.target.value)}
            spellCheck={false}
          />
          <div style={{ marginTop: 12 }}>
            {error && <div className="callout error" style={{ marginBottom: 10 }}>{error}</div>}
            <button className="btn btn-primary w-full" onClick={run} disabled={loading}>
              {loading ? <span className="spinner" style={{ width: 14, height: 14 }} /> : null}
              {loading ? 'Running...' : '▶  Run Test'}
            </button>
          </div>
        </div>

        {/* Output */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">Result</div>
            {result && <span className={`badge ${result.success ? 'success' : 'failed'}`}><span className="badge-dot" />{result.success ? 'passed' : 'failed'}</span>}
          </div>

          {!result && !loading && (
            <div className="empty-state" style={{ padding: '40px 0' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
              <h3>No result yet</h3>
              <p>Run the test to see the step-by-step execution log.</p>
            </div>
          )}

          {loading && (
            <div className="empty-state" style={{ padding: '40px 0' }}>
              <span className="spinner" style={{ width: 24, height: 24 }} />
              <h3 style={{ marginTop: 12 }}>Running pipeline...</h3>
            </div>
          )}

          {result && !loading && (
            <div>
              {result.id && (
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-dim text-sm">Transaction ID:</span>
                  <span className="font-mono text-sm text-muted">{result.id}</span>
                </div>
              )}
              {result.note && <div className="callout warn mb-3">{result.note}</div>}
              {result.errorMessage && <div className="callout error mb-3">{result.errorMessage}</div>}

              <div className="timeline">
                {(result.steps || []).map((step, i) => <StepView key={i} step={step} />)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
