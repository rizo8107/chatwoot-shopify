import React, { useState, useEffect } from 'react';

const API = '/api';

// ─── Available context fields the user can map to ────────────────────────────
const CONTEXT_FIELDS: { value: string; label: string; example: string }[] = [
  { value: 'firstName',           label: 'First Name',           example: 'Nirmal' },
  { value: 'fullName',            label: 'Full Name',            example: 'Nirmal Raj' },
  { value: 'itemsSummary',        label: 'Cart Items Summary',   example: 'Incense Combo x1' },
  { value: 'totalPrice',          label: 'Cart Total Price',     example: '₹405.00' },
  { value: 'abandonedCheckoutUrl',label: 'Checkout Recovery URL',example: 'https://pay.stomatalfarms.com/...' },
  { value: 'checkoutDate',        label: 'Abandoned Date',       example: '06 Jul 2026' },
  { value: 'orderName',           label: 'Order Name',           example: '#1234' },
  { value: 'orderNumber',         label: 'Order Number',         example: '1234' },
  { value: 'orderStatusUrl',      label: 'Order Status URL',     example: 'https://...' },
  { value: 'totalPrice',          label: 'Order Total',          example: '₹560.00' },
  { value: 'itemsSummary',        label: 'Order Items',          example: 'Product x2' },
  { value: 'orderDate',           label: 'Order Date',           example: '06 Jul 2026' },
  { value: 'shippingCity',        label: 'Shipping City',        example: 'Chennai' },
  { value: 'trackingUrl',         label: 'Tracking URL',         example: 'https://...' },
  { value: 'trackingNumber',      label: 'Tracking Number',      example: 'TRK123' },
  { value: 'trackingCompany',     label: 'Courier Company',      example: 'Delhivery' },
];

// ─── Types ───────────────────────────────────────────────────────────────────
interface VariableMapping {
  [placeholder: string]: string; // e.g. { '{{1}}': 'firstName', '{{2}}': 'itemsSummary', 'button_0': 'abandonedCheckoutUrl' }
}

interface Message {
  id: string;
  sequence_order: number;
  template_name: string;
  delay_minutes: number;
  variable_mapping?: VariableMapping;
}

interface Flow {
  id: string;
  name: string;
  description: string;
  is_active: boolean;
  messages: Message[];
  created_at: string;
  updated_at: string;
}

interface TemplateVariable {
  placeholder: string; // '{{1}}'
  index: number;        // 1
}

interface TemplateButton {
  index: number;
  type: string;
  text: string;
  url: string;
}

interface Template {
  name: string;
  language: string;
  category: string;
  paramCount: number;
  body: string;
  variables: TemplateVariable[];
  buttons: TemplateButton[];
}

// ─── Helper: render body preview with filled values ──────────────────────────
function renderPreview(body: string, mapping: VariableMapping): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => {
    const key = mapping[`{{${n}}}`];
    if (!key) return `{{${n}}}`;
    const field = CONTEXT_FIELDS.find(f => f.value === key);
    return field ? `[${field.example}]` : `{{${n}}}`;
  });
}

// ─── Variable Mapper sub-component ───────────────────────────────────────────
const VariableMapper: React.FC<{
  template: Template;
  mapping: VariableMapping;
  onChange: (m: VariableMapping) => void;
}> = ({ template, mapping, onChange }) => {
  if (template.variables.length === 0 && template.buttons.length === 0) return null;

  const setField = (placeholder: string, value: string) => {
    onChange({ ...mapping, [placeholder]: value });
  };

  return (
    <div style={{
      marginTop: 12,
      padding: '12px 14px',
      background: 'rgba(var(--primary-rgb, 99,102,241), 0.07)',
      borderRadius: 8,
      border: '1px solid rgba(var(--primary-rgb, 99,102,241), 0.18)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--primary)', marginBottom: 10 }}>
        Template Variable Mapping
      </div>

      {/* Body variables */}
      {template.variables.length > 0 && (
        <div style={{ marginBottom: template.buttons.length > 0 ? 10 : 0 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600 }}>
            📝 Body Variables
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {template.variables.map(v => (
              <div key={v.placeholder} style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: 8, alignItems: 'center' }}>
                <div style={{
                  fontFamily: 'monospace',
                  fontSize: 12,
                  fontWeight: 700,
                  color: 'var(--primary)',
                  background: 'rgba(var(--primary-rgb,99,102,241),0.12)',
                  borderRadius: 4,
                  padding: '3px 6px',
                  textAlign: 'center',
                }}>
                  {v.placeholder}
                </div>
                <select
                  className="select"
                  style={{ fontSize: 12, padding: '4px 8px', height: 32 }}
                  value={mapping[v.placeholder] || ''}
                  onChange={e => setField(v.placeholder, e.target.value)}
                >
                  <option value="">— choose a field —</option>
                  {CONTEXT_FIELDS.map((f, i) => (
                    <option key={`${f.value}_${i}`} value={f.value}>
                      {f.label} · e.g. {f.example}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Button variables */}
      {template.buttons.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600 }}>
            🔘 Button URL Variable
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {template.buttons.map(btn => {
              const key = `button_${btn.index}`;
              return (
                <div key={key} style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: 8, alignItems: 'center' }}>
                  <div style={{
                    fontFamily: 'monospace',
                    fontSize: 11,
                    fontWeight: 700,
                    color: '#f59e0b',
                    background: 'rgba(245,158,11,0.12)',
                    borderRadius: 4,
                    padding: '3px 6px',
                    textAlign: 'center',
                  }}>
                    btn[{btn.index}]
                  </div>
                  <select
                    className="select"
                    style={{ fontSize: 12, padding: '4px 8px', height: 32 }}
                    value={mapping[key] || 'abandonedCheckoutUrl'}
                    onChange={e => setField(key, e.target.value)}
                  >
                    <option value="">— choose a field —</option>
                    {CONTEXT_FIELDS.filter(f => f.value.toLowerCase().includes('url') || f.value.toLowerCase().includes('link')).map((f, i) => (
                      <option key={`${f.value}_${i}`} value={f.value}>
                        {f.label} · e.g. {f.example}
                      </option>
                    ))}
                    <optgroup label="── All fields ──">
                      {CONTEXT_FIELDS.map((f, i) => (
                        <option key={`all_${f.value}_${i}`} value={f.value}>
                          {f.label}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Live preview */}
      {template.variables.length > 0 && (
        <div style={{
          marginTop: 12,
          padding: '8px 10px',
          background: 'var(--bg-subtle)',
          borderRadius: 6,
          fontSize: 11,
          lineHeight: 1.6,
          color: 'var(--text-muted)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          <span style={{ fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }}>
            Live Preview:
          </span>
          {renderPreview(template.body, mapping)}
        </div>
      )}
    </div>
  );
};

// ─── Main Component ───────────────────────────────────────────────────────────
export const AbandonedCartFlows: React.FC = () => {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingFlow, setEditingFlow] = useState<Flow | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [editorStep, setEditorStep] = useState(1);

  useEffect(() => {
    loadFlows();
    loadTemplates();
  }, []);

  const loadFlows = async () => {
    try {
      const res = await fetch(`${API}/abandoned-cart-flows`);
      if (!res.ok) throw new Error('Failed to load flows');
      const data = await res.json();
      setFlows(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadTemplates = async () => {
    try {
      const res = await fetch(`${API}/whatsapp/templates`);
      if (res.ok) {
        const data = await res.json();
        setTemplates(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('Failed to load templates:', err);
    }
  };

  const startCreate = () => {
    setEditingFlow({
      id: '',
      name: '',
      description: '',
      is_active: true,
      messages: [
        { id: '1', sequence_order: 1, template_name: '', delay_minutes: 0, variable_mapping: {} },
        { id: '2', sequence_order: 2, template_name: '', delay_minutes: 60, variable_mapping: {} },
        { id: '3', sequence_order: 3, template_name: '', delay_minutes: 1440, variable_mapping: {} }
      ],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    setIsCreating(true);
    setEditorStep(1);
    setError('');
  };

  const continueSetup = () => {
    if (!editingFlow) return;
    setError('');
    if (editorStep === 1 && !editingFlow.name.trim()) {
      setError('Enter a flow name before continuing.');
      return;
    }
    if (editorStep === 2 && editingFlow.messages.some(message => !message.template_name)) {
      setError('Choose a WhatsApp template for every message.');
      return;
    }
    if (editorStep === 2) {
      for (const [index, message] of editingFlow.messages.entries()) {
        const template = templates.find(item => item.name === message.template_name);
        const missing = (template?.variables || []).filter(variable => !message.variable_mapping?.[variable.placeholder]);
        if (missing.length > 0) {
          setError(`Message ${index + 1}: map ${missing.map(variable => variable.placeholder).join(', ')} before continuing.`);
          return;
        }
      }
    }
    setEditorStep(step => Math.min(3, step + 1));
  };

  const saveFlow = async () => {
    if (!editingFlow) return;
    if (!editingFlow.name.trim()) { setError('Flow name is required'); return; }
    if (editingFlow.messages.some(m => !m.template_name)) {
      setError('All messages must have a template selected');
      return;
    }

    try {
      // The button selector visually defaults to the checkout URL. Persist
      // that default as well, including for flows created before button
      // mappings were stored explicitly.
      const messages = editingFlow.messages.map(message => {
        const template = templates.find(t => t.name === message.template_name);
        const variable_mapping = { ...(message.variable_mapping || {}) };
        template?.buttons.forEach(button => {
          const key = `button_${button.index}`;
          if (!variable_mapping[key]) variable_mapping[key] = 'abandonedCheckoutUrl';
        });
        return { ...message, variable_mapping };
      });

      const method = isCreating ? 'POST' : 'PUT';
      const endpoint = isCreating
        ? `${API}/abandoned-cart-flows`
        : `${API}/abandoned-cart-flows/${editingFlow.id}`;

      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editingFlow.name,
          description: editingFlow.description,
          is_active: editingFlow.is_active,
          messages
        })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save flow');
      }
      await loadFlows();
      setEditingFlow(null);
      setIsCreating(false);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const deleteFlow = async (id: string) => {
    if (!confirm('Delete this recovery flow?')) return;
    try {
      const res = await fetch(`${API}/abandoned-cart-flows/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete flow');
      await loadFlows();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const toggleFlow = async (id: string, is_active: boolean) => {
    try {
      const res = await fetch(`${API}/abandoned-cart-flows/${id}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !is_active })
      });
      if (!res.ok) throw new Error('Failed to toggle flow');
      await loadFlows();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const updateMessage = (idx: number, field: keyof Message, value: any) => {
    if (!editingFlow) return;
    const updated = { ...editingFlow };
    updated.messages = [...updated.messages];
    updated.messages[idx] = { ...updated.messages[idx], [field]: value };
    // When template changes, reset the mapping
    if (field === 'template_name') {
      const template = templates.find(t => t.name === value);
      const defaults: VariableMapping = {};
      template?.buttons.forEach(button => {
        defaults[`button_${button.index}`] = 'abandonedCheckoutUrl';
      });
      updated.messages[idx].variable_mapping = defaults;
    }
    setEditingFlow(updated);
  };

  const updateMapping = (idx: number, newMapping: VariableMapping) => {
    if (!editingFlow) return;
    const updated = { ...editingFlow };
    updated.messages = [...updated.messages];
    updated.messages[idx] = { ...updated.messages[idx], variable_mapping: newMapping };
    setEditingFlow(updated);
  };

  const addMessage = () => {
    if (!editingFlow) return;
    const maxOrder = Math.max(...editingFlow.messages.map(m => m.sequence_order), 0);
    const newMsg: Message = {
      id: `msg_${Date.now()}`,
      sequence_order: maxOrder + 1,
      template_name: '',
      delay_minutes: 0,
      variable_mapping: {}
    };
    setEditingFlow({ ...editingFlow, messages: [...editingFlow.messages, newMsg] });
  };

  const removeMessage = (idx: number) => {
    if (!editingFlow || editingFlow.messages.length <= 1) return;
    setEditingFlow({
      ...editingFlow,
      messages: editingFlow.messages.filter((_, i) => i !== idx)
    });
  };

  const formatDelay = (minutes: number): string => {
    if (minutes === 0) return 'Immediately';
    if (minutes < 60) return `${minutes}m`;
    if (minutes === 60) return '1h';
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
    if (minutes === 1440) return '1 day';
    return `${Math.floor(minutes / 1440)}d`;
  };

  if (loading) {
    return (
      <div className="page">
        <div style={{ textAlign: 'center', padding: 32 }}>
          <span className="spinner" />
        </div>
      </div>
    );
  }

  // ─── Edit / Create view ──────────────────────────────────────────────────
  if (editingFlow) {
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <div className="page-title">{isCreating ? 'Create' : 'Edit'} Recovery Flow</div>
            <div className="page-sub">Create a clear message schedule for abandoned checkouts</div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => { setEditingFlow(null); setIsCreating(false); setError(''); }}>Exit setup</button>
        </div>

        <nav className="setup-stepper recovery-stepper" aria-label="Recovery flow setup">
          {['Flow details', 'Message schedule', 'Review'].map((label, index) => {
            const step = index + 1;
            return (
              <button
                key={label}
                type="button"
                className={`setup-step${editorStep === step ? ' active' : ''}${editorStep > step ? ' complete' : ''}`}
                onClick={() => step <= editorStep && setEditorStep(step)}
                aria-current={editorStep === step ? 'step' : undefined}
              >
                <span>{editorStep > step ? '✓' : step}</span>
                <strong>{label}</strong>
              </button>
            );
          })}
        </nav>

        {/* Basic Info */}
        {editorStep === 1 && <div className="card mb-4 setup-panel">
          <div className="card-header"><div><div className="card-title">Flow details</div><div className="card-sub">Name this recovery journey and choose whether it should enroll new carts.</div></div></div>
          <div className="form-group">
            <label className="form-label">Flow Name</label>
            <input
              className="input"
              value={editingFlow.name}
              onChange={e => setEditingFlow({ ...editingFlow, name: e.target.value })}
              placeholder="e.g., 3-Day Recovery Campaign"
            />
          </div>
          <div className="form-group">
            <label className="form-label">Description</label>
            <input
              className="input"
              value={editingFlow.description}
              onChange={e => setEditingFlow({ ...editingFlow, description: e.target.value })}
              placeholder="Optional description"
            />
          </div>
          <div className="form-group">
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={editingFlow.is_active}
                onChange={e => setEditingFlow({ ...editingFlow, is_active: e.target.checked })}
              />
              <span>Active (automatically triggers for new abandoned carts)</span>
            </label>
          </div>
        </div>}

        {/* Messages */}
        {editorStep === 2 && <div className="card setup-panel">
          <div className="card-header">
            <div>
              <div className="card-title">Follow-up Messages</div>
              <div className="card-sub">Configure up to 5 messages with delays and variable mappings</div>
            </div>
            {editingFlow.messages.length < 5 && (
              <button className="btn btn-sm btn-secondary" onClick={addMessage}>
                + Add Message
              </button>
            )}
          </div>

          <div className="message-schedule">
            {editingFlow.messages.map((msg, idx) => {
              const tpl = templates.find(t => t.name === msg.template_name);
              const mapping = msg.variable_mapping || {};

              return (
                <div key={msg.id} className="message-step-card">
                  {/* Header row: step badge + delete */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div style={{
                      fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1,
                      color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: 6
                    }}>
                      <span style={{
                        background: 'var(--primary)', color: '#fff',
                        width: 20, height: 20, borderRadius: '50%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, fontWeight: 700
                      }}>{idx + 1}</span>
                      Message {idx + 1}
                    </div>
                    {editingFlow.messages.length > 1 && (
                      <button className="btn btn-xs btn-danger" onClick={() => removeMessage(idx)}>
                        Remove
                      </button>
                    )}
                  </div>

                  {/* Template + delay row */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 0 }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label" style={{ fontSize: 12 }}>WhatsApp Template</label>
                      <select
                        className="select"
                        value={msg.template_name}
                        onChange={e => updateMessage(idx, 'template_name', e.target.value)}
                      >
                        <option value="">— select template —</option>
                        {templates.map(t => (
                          <option key={t.name} value={t.name}>
                            {t.name} ({t.language} · {t.paramCount} var{t.paramCount !== 1 ? 's' : ''}{t.buttons.length > 0 ? ` · ${t.buttons.length} btn` : ''})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label" style={{ fontSize: 12 }}>Delay after cart abandonment</label>
                      <input
                        type="number"
                        min={0}
                        className="input"
                        value={msg.delay_minutes}
                        onChange={e => updateMessage(idx, 'delay_minutes', parseInt(e.target.value) || 0)}
                        placeholder="0"
                      />
                      <div className="form-hint">Minutes · {formatDelay(msg.delay_minutes)}</div>
                    </div>
                  </div>

                  {/* Variable mapper (shown only when template has variables/buttons) */}
                  {tpl && (tpl.variables.length > 0 || tpl.buttons.length > 0) && (
                    <details className="mapping-disclosure">
                      <summary>
                        <span>Variables and button links</span>
                        <small>{tpl.variables.length + tpl.buttons.length} field{tpl.variables.length + tpl.buttons.length === 1 ? '' : 's'} to map</small>
                      </summary>
                      <VariableMapper
                        template={tpl}
                        mapping={mapping}
                        onChange={m => updateMapping(idx, m)}
                      />
                    </details>
                  )}

                  {/* Template selected but no variables */}
                  {tpl && tpl.variables.length === 0 && tpl.buttons.length === 0 && (
                    <div style={{
                      marginTop: 10, fontSize: 11, color: 'var(--text-muted)',
                      padding: '6px 10px', background: 'var(--bg-subtle)', borderRadius: 6
                    }}>
                      ✅ This template has no variable placeholders — it will be sent as-is.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>}

        {editorStep === 3 && (
          <div className="card setup-panel">
            <div className="card-header"><div><div className="card-title">Review recovery flow</div><div className="card-sub">Check the schedule before saving. No messages are sent from this screen.</div></div></div>
            <div className="review-summary">
              <div><span>Flow</span><strong>{editingFlow.name}</strong></div>
              <div><span>Status</span><strong>{editingFlow.is_active ? 'Active for new carts' : 'Saved inactive'}</strong></div>
              <div><span>Messages</span><strong>{editingFlow.messages.length}</strong></div>
            </div>
            <div className="review-timeline">
              {editingFlow.messages.map((message, index) => (
                <div key={message.id} className="review-step">
                  <span>{index + 1}</span>
                  <div><strong>{message.template_name || 'Template not selected'}</strong><small>{formatDelay(message.delay_minutes)} after abandonment</small></div>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && <div className="callout error mt-3">{error}</div>}
        <div className="setup-actions">
          <button className="btn btn-secondary" onClick={editorStep === 1 ? () => { setEditingFlow(null); setIsCreating(false); setError(''); } : () => { setError(''); setEditorStep(step => Math.max(1, step - 1)); }}>
            {editorStep === 1 ? 'Cancel' : 'Back'}
          </button>
          {editorStep === 3
            ? <button className="btn btn-primary" onClick={saveFlow}>Save flow</button>
            : <button className="btn btn-primary" onClick={continueSetup}>Continue</button>}
        </div>
      </div>
    );
  }

  // ─── List view ───────────────────────────────────────────────────────────
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Abandoned Cart Recovery</div>
          <div className="page-sub">Automate follow-up messages to recover abandoned checkouts</div>
        </div>
        <button className="btn btn-primary" onClick={startCreate}>
          + Create Recovery Flow
        </button>
      </div>

      {error && <div className="card mb-4"><div className="callout error">{error}</div></div>}

      <div className="card">
        {flows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
            <div style={{ marginBottom: 16 }}>No recovery flows yet</div>
            <button className="btn btn-primary" onClick={startCreate}>
              Create your first flow
            </button>
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Flow Name</th>
                  <th>Messages</th>
                  <th>Duration</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {flows.map(flow => {
                  const lastMsg = flow.messages[flow.messages.length - 1];
                  const totalMinutes = lastMsg ? lastMsg.delay_minutes : 0;
                  const duration = totalMinutes === 0 ? 'Immediate' : formatDelay(totalMinutes);

                  return (
                    <tr key={flow.id}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{flow.name}</div>
                        {flow.description && (
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{flow.description}</div>
                        )}
                      </td>
                      <td>
                        <div style={{ fontSize: 12 }}>
                          {flow.messages.length} message{flow.messages.length !== 1 ? 's' : ''}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {flow.messages.map(m => m.template_name || '—').join(' → ')}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{duration}</div>
                      </td>
                      <td>
                        <span className={`badge ${flow.is_active ? 'success' : 'pending'}`}>
                          <span className="badge-dot" />
                          {flow.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button
                            className="btn btn-xs btn-secondary"
                            onClick={() => { setEditingFlow(flow); setIsCreating(false); setEditorStep(1); setError(''); }}
                          >
                            Edit
                          </button>
                          <button
                            className={`btn btn-xs ${flow.is_active ? 'btn-warning' : 'btn-success'}`}
                            onClick={() => toggleFlow(flow.id, flow.is_active)}
                          >
                            {flow.is_active ? 'Pause' : 'Resume'}
                          </button>
                          <button
                            className="btn btn-xs btn-danger"
                            onClick={() => deleteFlow(flow.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
