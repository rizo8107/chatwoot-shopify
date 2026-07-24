import React, { useEffect, useState } from 'react';

const API = '/api';

async function readApiResponse(response: Response) {
  const text = await response.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) {
    const fallback = response.status === 502 || response.status === 503
      ? 'Backend is starting or unavailable. Run npm run dev from the project root, then retry.'
      : `Request failed (${response.status})`;
    throw new Error(data.error || fallback);
  }
  return data;
}

interface CampaignSummary {
  id: string; name: string; template_name: string; status: string;
  delay_seconds: number; total: number; sent: number; failed: number; skipped: number;
  steps: DripStep[]; shopify_check_mode: string; campaign_type: CampaignKind;
  enrollment_source: 'csv' | 'webhook'; trigger_event?: string; trigger_conditions?: TriggerCondition[];
  created_at: string; started_at?: string;
}

interface DripStep {
  id: string; template_name: string; language: string; category: string;
  delay_value: number; delay_unit: 'minutes' | 'hours' | 'days'; param_mapping: string[];
  header_media_url?: string; header_media_column?: string;
}

interface Recipient {
  id: string; row_index: number; phone: string; name: string;
  variables: Record<string, string>; status: string; error_message?: string;
  current_step: number; last_shopify_status?: string; order_reference?: string; email?: string;
  run_at?: string; sent_at?: string; delivery_retry_count?: number;
}

interface CampaignDetail extends CampaignSummary {
  language: string; category: string; phone_column: string; name_column: string;
  param_mapping: string[]; recipients: Recipient[]; logs: CampaignLog[];
}

interface CampaignLog {
  id: string; recipient_id: string; step_index: number; template_name: string;
  status: string; shopify_status?: string; error_message?: string; created_at: string;
}

interface TriggerCondition { field: string; operator: string; value: string; }

const WEBHOOK_FIELDS = [
  { value: 'firstName', label: 'Customer first name' },
  { value: 'fullName', label: 'Customer full name' },
  { value: 'phone', label: 'Customer phone' },
  { value: 'email', label: 'Customer email' },
  { value: 'orderNumber', label: 'Order number' },
  { value: 'orderName', label: 'Order name' },
  { value: 'totalPrice', label: 'Order total' },
  { value: 'itemsSummary', label: 'Items summary' },
  { value: 'financialStatus', label: 'Financial status' },
  { value: 'fulfillmentStatus', label: 'Fulfillment status' },
  { value: 'shippingCity', label: 'Shipping city' },
  { value: 'tags', label: 'Order/customer tags' },
  { value: 'currency', label: 'Currency' },
  { value: 'itemCount', label: 'Item quantity' }
];

const WEBHOOK_EVENTS = [
  { value: 'orders/create', label: 'Order created' },
  { value: 'orders/paid', label: 'Order paid' },
  { value: 'fulfillments/create', label: 'Order fulfilled / shipped' }
];

interface TemplateInfo {
  name: string; language: string; category: string; status: string; paramCount: number; body: string;
  header?: {
    required: boolean; format: 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'TEXT';
    text?: string; exampleUrl?: string | null;
  } | null;
}

type View = { kind: 'list' } | { kind: 'new' } | { kind: 'detail'; id: string };
export type CampaignKind = 'bulk' | 'drip';

// ─── CSV parsing ────────────────────────────────────────────────────────────

function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter(r => r.some(c => c.trim() !== ''));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = nonEmpty[0].map(h => h.trim());
  const dataRows = nonEmpty.slice(1).map(r => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = (r[idx] ?? '').trim(); });
    return obj;
  });
  return { headers, rows: dataRows };
}

function statusBadge(s: string) {
  const cls: Record<string, string> = {
    completed: 'success', delivered: 'success', read: 'success',
    sent: 'processing', accepted: 'processing', running: 'processing',
    pending: 'pending', retry_scheduled: 'delayed', paused: 'delayed', draft: 'pending', failed: 'failed', skipped: 'delayed',
    enrolled: 'success', filtered: 'delayed'
  };
  return <span className={`badge ${cls[s] || 'pending'}`}><span className="badge-dot" />{s}</span>;
}

// ─── List view ──────────────────────────────────────────────────────────────

function CampaignList({ kind, onNew, onOpen }: { kind: CampaignKind; onNew: () => void; onOpen: (id: string) => void }) {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const load = async () => {
    try {
      const data = await fetch(`${API}/campaigns`).then(readApiResponse);
      setCampaigns(Array.isArray(data) ? data.filter((c: CampaignSummary) => (c.campaign_type || 'bulk') === kind) : []);
      setLoadError('');
      setLoading(false);
      return true;
    } catch (err: any) {
      setLoadError(err.message || 'Could not connect to the backend');
      setLoading(false);
      return false;
    }
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const ok = await load();
      if (!cancelled && ok) timer = setTimeout(poll, 5000);
    };
    poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [kind]);

  const act = async (id: string, action: 'start' | 'pause') => {
    await fetch(`${API}/campaigns/${id}/${action}`, { method: 'POST' });
    load();
  };

  const del = async (id: string) => {
    if (!confirm('Delete this campaign? This cannot be undone.')) return;
    await fetch(`${API}/campaigns/${id}`, { method: 'DELETE' });
    load();
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">{kind === 'drip' ? 'Drip Campaigns' : 'Campaigns'}</div>
          <div className="page-sub">{kind === 'drip' ? 'Build timed WhatsApp sequences with Shopify safeguards and step-level logs' : 'Send one WhatsApp template to a CSV audience'}</div>
        </div>
        <button className="btn btn-primary" onClick={onNew}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New {kind === 'drip' ? 'Drip Campaign' : 'Campaign'}
        </button>
      </div>

      {loadError && <div className="callout error mb-3"><span>{loadError}</span><button className="btn btn-secondary btn-sm" onClick={() => { setLoading(true); load(); }}>Retry</button></div>}

      <div className="card" style={{ padding: 0 }}>
        {loading ? (
          <div className="empty-state" style={{ padding: 40 }}><span className="spinner" /></div>
        ) : campaigns.length === 0 ? (
          <div className="empty-state">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>
            <h3>No {kind === 'drip' ? 'drip campaigns' : 'campaigns'} yet</h3>
            <p>{kind === 'drip' ? 'Create a timed sequence from a CSV audience.' : 'Create a one-message campaign from a CSV audience.'}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>{kind === 'drip' ? 'Sequence' : 'Template'}</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Pacing</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {campaigns.map(c => {
                  const done = c.sent + c.failed + (c.skipped || 0);
                  const pct = c.total ? Math.round((done / c.total) * 100) : 0;
                  return (
                    <tr key={c.id} style={{ cursor: 'pointer' }}>
                      <td onClick={() => onOpen(c.id)} style={{ fontWeight: 600 }}>{c.name}</td>
                      <td onClick={() => onOpen(c.id)} className="text-sm">{kind === 'drip' ? <>{c.steps?.length || 1} steps<div className="text-dim">{c.enrollment_source === 'webhook' ? c.trigger_event : 'CSV enrollment'}</div></> : <span className="mono">{c.template_name}</span>}</td>
                      <td onClick={() => onOpen(c.id)}>{statusBadge(c.status)}</td>
                      <td onClick={() => onOpen(c.id)} style={{ minWidth: 160 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ flex: 1, height: 6, background: 'var(--bg-hover)', borderRadius: 4, overflow: 'hidden' }}>
                            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--green)' }} />
                          </div>
                          <span className="text-dim text-sm" style={{ whiteSpace: 'nowrap' }}>
                            {c.sent} delivered {c.skipped > 0 ? `· ${c.skipped} stopped ` : ''}{c.failed > 0 ? `· ${c.failed} failed ` : ''}/ {c.total}
                          </span>
                        </div>
                      </td>
                      <td onClick={() => onOpen(c.id)} className="text-dim text-sm">{c.delay_seconds}s</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          {(c.status === 'draft' || c.status === 'paused') && (
                            <button className="btn btn-secondary btn-sm" onClick={() => act(c.id, 'start')}>
                              {c.status === 'paused' ? 'Resume' : 'Start'}
                            </button>
                          )}
                          {c.status === 'running' && (
                            <button className="btn btn-secondary btn-sm" onClick={() => act(c.id, 'pause')}>Pause</button>
                          )}
                          <button className="btn btn-ghost btn-sm btn-icon" onClick={() => del(c.id)} title="Delete">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
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
}

// ─── New campaign wizard ────────────────────────────────────────────────────

function NewCampaign({ kind, onCancel, onCreated }: { kind: CampaignKind; onCancel: () => void; onCreated: () => void }) {
  const [csvText, setCsvText] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [parseError, setParseError] = useState('');

  const [name, setName] = useState('');
  const [delay, setDelay] = useState(5);
  const [templateName, setTemplateName] = useState('');
  const [language, setLanguage] = useState('en');
  const [category, setCategory] = useState('UTILITY');

  const [phoneCol, setPhoneCol] = useState('');
  const [nameCol, setNameCol] = useState('');
  const [paramMapping, setParamMapping] = useState<string[]>(['', '']);
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [headerMediaColumn, setHeaderMediaColumn] = useState('');
  const [followUps, setFollowUps] = useState<DripStep[]>([]);
  const [enrollmentSource, setEnrollmentSource] = useState<'csv' | 'webhook'>(kind === 'drip' ? 'webhook' : 'csv');
  const [triggerEvent, setTriggerEvent] = useState('orders/create');
  const [triggerConditions, setTriggerConditions] = useState<TriggerCondition[]>([]);
  const [shopifyCheckMode, setShopifyCheckMode] = useState(kind === 'drip' ? 'stop_if_paid_or_fulfilled' : 'off');
  const [orderCol, setOrderCol] = useState('');
  const [emailCol, setEmailCol] = useState('');

  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [templatesMsg, setTemplatesMsg] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [wizardStep, setWizardStep] = useState(1);

  // Prefill template name + variable slot count from saved Settings
  useEffect(() => {
    fetch(`${API}/settings`).then(readApiResponse).then(d => {
      if (d.WHATSAPP_TEMPLATE_NAME) setTemplateName(d.WHATSAPP_TEMPLATE_NAME);
      const savedMapping = (d.WHATSAPP_TEMPLATE_MAPPING || '').split(',').map((s: string) => s.trim()).filter(Boolean);
      if (savedMapping.length > 0) setParamMapping(new Array(savedMapping.length).fill(''));
    }).catch(() => {});
  }, []);

  // Load the live template list from Chatwoot
  useEffect(() => {
    setTemplatesMsg('Loading templates…');
    fetch(`${API}/whatsapp/templates`).then(readApiResponse).then(d => {
      setTemplates(Array.isArray(d) ? d : []);
      setTemplatesMsg(Array.isArray(d) && d.length ? '' : 'No templates found on the Chatwoot inbox.');
    }).catch(err => setTemplatesMsg(err.message));
  }, []);

  const pickTemplate = (name: string) => {
    setSelectedTemplate(name);
    const t = templates.find(x => x.name === name);
    if (!t) return;
    setTemplateName(t.name);
    setLanguage(t.language || 'en');
    setCategory((t.category || 'UTILITY').toUpperCase());
    setParamMapping(new Array(t.paramCount).fill(''));
    setHeaderMediaUrl('');
    setHeaderMediaColumn('');
  };

  const selectedBody = templates.find(t => t.name === selectedTemplate)?.body;

  const applyCsv = (text: string) => {
    setCsvText(text);
    const { headers, rows } = parseCSV(text);
    if (text.trim() && headers.length === 0) { setParseError('Could not parse CSV headers.'); setHeaders([]); setRows([]); return; }
    setParseError('');
    setHeaders(headers);
    setRows(rows);
    // Auto-guess phone / name columns
    const lower = headers.map(h => h.toLowerCase());
    const phoneGuess = headers[lower.findIndex(h => h.includes('phone') || h.includes('mobile') || h.includes('number'))];
    const nameGuess = headers[lower.findIndex(h => h.includes('name'))];
    const orderGuess = headers[lower.findIndex(h => h.includes('order'))];
    const emailGuess = headers[lower.findIndex(h => h.includes('email'))];
    if (phoneGuess) setPhoneCol(phoneGuess);
    if (nameGuess) setNameCol(nameGuess);
    if (orderGuess) setOrderCol(orderGuess);
    if (emailGuess) setEmailCol(emailGuess);
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => applyCsv(String(reader.result || ''));
    reader.readAsText(file);
  };

  const setSlot = (i: number, v: string) => setParamMapping(m => m.map((x, idx) => idx === i ? v : x));
  const addSlot = () => setParamMapping(m => [...m, '']);
  const removeSlot = (i: number) => setParamMapping(m => m.filter((_, idx) => idx !== i));

  const addFollowUp = () => setFollowUps(current => [...current, {
    id: `step_${current.length + 2}`,
    template_name: '', language: 'en', category: 'MARKETING',
    delay_value: 1, delay_unit: 'days', param_mapping: [],
    header_media_url: '', header_media_column: ''
  }]);

  const updateFollowUp = (index: number, patch: Partial<DripStep>) => {
    setFollowUps(current => current.map((step, i) => i === index ? { ...step, ...patch } : step));
  };

  const pickFollowUpTemplate = (index: number, templateName: string) => {
    const template = templates.find(t => t.name === templateName);
    updateFollowUp(index, {
      template_name: templateName,
      language: template?.language || 'en',
      category: (template?.category || 'MARKETING').toUpperCase(),
      param_mapping: new Array(template?.paramCount || 0).fill(''),
      header_media_url: '',
      header_media_column: ''
    });
  };

  const previewRow = rows[0];
  const mappingFields = enrollmentSource === 'webhook' ? WEBHOOK_FIELDS.map(field => field.value) : headers;
  const renderPreviewVal = (col: string) => col && previewRow ? (previewRow[col] ?? '') : '—';
  const selectedTemplateInfo = templates.find(t => t.name === selectedTemplate);
  const selectedHeader = selectedTemplateInfo?.header;
  const mediaHeaderIsMissing = (header: TemplateInfo['header'], url?: string, column?: string) =>
    Boolean(header?.required && !url?.trim() && !(enrollmentSource === 'csv' && column));

  const continueDripSetup = () => {
    setError('');
    if (wizardStep === 1 && enrollmentSource === 'csv' && rows.length === 0) {
      setError('Add a CSV audience before continuing.');
      return;
    }
    if (wizardStep === 2 && !name.trim()) {
      setError('Enter a campaign name before continuing.');
      return;
    }
    if (wizardStep === 2 && !templateName.trim()) {
      setError('Choose the first WhatsApp template before continuing.');
      return;
    }
    if (wizardStep === 3 && followUps.some(step => !step.template_name)) {
      setError('Choose a template for each follow-up before continuing.');
      return;
    }
    setWizardStep(step => Math.min(4, step + 1));
  };

  const submit = async (autostart: boolean) => {
    setError('');
    if (!name.trim()) { setError('Enter a campaign name.'); return; }
    if (enrollmentSource === 'csv' && rows.length === 0) { setError('Upload or paste a CSV with at least one row.'); return; }
    if (enrollmentSource === 'csv' && !phoneCol) { setError('Select which column holds the phone number.'); return; }
    if (enrollmentSource === 'csv') {
      const scientificRow = rows.findIndex(row => /^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i.test(String(row[phoneCol] || '').trim()));
      if (scientificRow >= 0) {
        setError(`Row ${scientificRow + 1} has an Excel scientific-notation phone number. Format the phone column as Text and export the CSV again.`);
        return;
      }
    }
    if (!templateName.trim()) { setError('Enter a WhatsApp template name (or set one in Settings).'); return; }
    if (mediaHeaderIsMissing(selectedHeader, headerMediaUrl, headerMediaColumn)) {
      setError(`Add the required ${selectedHeader?.format.toLowerCase()} header URL for the first template.`);
      return;
    }
    if (kind === 'drip' && followUps.some(step => !step.template_name)) { setError('Select a template for every drip step.'); return; }
    const missingFollowUpHeader = kind === 'drip' && followUps.find(step => {
      const template = templates.find(item => item.name === step.template_name);
      return mediaHeaderIsMissing(template?.header, step.header_media_url, step.header_media_column);
    });
    if (missingFollowUpHeader) {
      const template = templates.find(item => item.name === missingFollowUpHeader.template_name);
      setError(`Add the required ${template?.header?.format.toLowerCase()} header URL for ${missingFollowUpHeader.template_name}.`);
      return;
    }
    if (kind === 'drip' && enrollmentSource === 'csv' && shopifyCheckMode !== 'off' && !orderCol && !emailCol) { setError('Select an order number or email column for Shopify cross-checking.'); return; }

    setSaving(true);
    try {
      const res = await fetch(`${API}/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, delay_seconds: delay, template_name: templateName, language, category,
          phone_column: phoneCol, name_column: nameCol, param_mapping: paramMapping,
          campaign_type: kind,
          enrollment_source: kind === 'drip' ? enrollmentSource : 'csv',
          trigger_event: kind === 'drip' && enrollmentSource === 'webhook' ? triggerEvent : null,
          trigger_conditions: kind === 'drip' && enrollmentSource === 'webhook' ? triggerConditions : [],
          shopify_check_mode: kind === 'drip' && enrollmentSource === 'csv' ? shopifyCheckMode : 'off',
          order_column: kind === 'drip' && enrollmentSource === 'csv' ? orderCol : '', email_column: kind === 'drip' && enrollmentSource === 'csv' ? emailCol : '',
          steps: [{
            id: 'step_1', template_name: templateName, language, category,
            delay_value: 0, delay_unit: 'minutes', param_mapping: paramMapping,
            header_media_url: headerMediaUrl, header_media_column: headerMediaColumn
          }, ...(kind === 'drip' ? followUps : [])],
          rows, autostart
        })
      });
      await readApiResponse(res);
      onCreated();
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">New {kind === 'drip' ? 'Drip Campaign' : 'Campaign'}</div>
          <div className="page-sub">{kind === 'drip' ? 'Enroll from Shopify events or CSV, apply conditions, and configure timed messages' : 'Upload an audience and send one approved WhatsApp template'}</div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={onCancel}>← Back</button>
      </div>

      {kind === 'drip' && (
        <nav className="setup-stepper" aria-label="Drip campaign setup">
          {['Trigger', 'First message', 'Follow-ups', 'Review & launch'].map((label, index) => {
            const step = index + 1;
            return (
              <button
                key={label}
                type="button"
                className={`setup-step${wizardStep === step ? ' active' : ''}${wizardStep > step ? ' complete' : ''}`}
                onClick={() => step <= wizardStep && setWizardStep(step)}
                aria-current={wizardStep === step ? 'step' : undefined}
              >
                <span>{wizardStep > step ? '✓' : step}</span>
                <strong>{label}</strong>
              </button>
            );
          })}
        </nav>
      )}

      {/* Step 1: CSV */}
      {(kind !== 'drip' || wizardStep === 1) && <div className="card mb-4 setup-panel">
        <div className="card-header"><div><div className="card-title">1 · {kind === 'drip' ? 'Enrollment trigger' : 'Recipients (CSV)'}</div>{kind === 'drip' && <div className="card-sub">Choose how customers enter this drip campaign.</div>}</div></div>
        {kind === 'drip' && <div className="form-group">
          <label className="form-label">Enrollment source</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <button className={`btn ${enrollmentSource === 'webhook' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setEnrollmentSource('webhook')}>Shopify webhook</button>
            <button className={`btn ${enrollmentSource === 'csv' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setEnrollmentSource('csv')}>CSV audience</button>
          </div>
        </div>}

        {enrollmentSource === 'csv' ? <>
        <div className="form-group">
          <label className="form-label">Upload CSV file</label>
          <input type="file" accept=".csv,text/csv" className="input" onChange={onFile} />
        </div>
        <div className="form-group">
          <label className="form-label">…or paste CSV</label>
          <textarea className="textarea" style={{ minHeight: 110, fontFamily: 'var(--font-mono)', fontSize: 12 }}
            placeholder={'Order id,Billing Name,Shipping Phone\n#2036,Kumar Kumar,9150115554'}
            value={csvText} onChange={e => applyCsv(e.target.value)} spellCheck={false} />
        </div>
        {parseError && <div className="callout error">{parseError}</div>}
        {rows.length > 0 && (
          <>
            <div className="text-dim text-sm mb-2">{rows.length} recipient{rows.length !== 1 ? 's' : ''} · {headers.length} columns</div>
            <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 8 }}>
              <table>
                <thead><tr>{headers.map(h => <th key={h}>{h}</th>)}</tr></thead>
                <tbody>
                  {rows.slice(0, 5).map((r, i) => (
                    <tr key={i}>{headers.map(h => <td key={h} className="text-sm">{r[h]}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > 5 && <div className="text-dim text-sm mt-2">…and {rows.length - 5} more</div>}
          </>
        )}
        </> : <>
          <div className="callout info mb-3">The campaign remains active and automatically enrolls each matching Shopify event once.</div>
          <div className="form-group">
            <label className="form-label">Shopify event</label>
            <select className="select" value={triggerEvent} onChange={e => setTriggerEvent(e.target.value)}>
              {WEBHOOK_EVENTS.map(event => <option key={event.value} value={event.value}>{event.label}</option>)}
            </select>
          </div>
          <div className="divider" />
          <div className="flex items-center justify-between mb-3">
            <div><div className="form-label">Conditions</div><div className="form-hint">All conditions must match. Leave empty to enroll every event.</div></div>
            <button className="btn btn-secondary btn-sm" onClick={() => setTriggerConditions(current => [...current, { field: 'totalPrice', operator: 'greater_than', value: '' }])}>+ Add condition</button>
          </div>
          {triggerConditions.map((condition, index) => (
            <div key={index} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.2fr auto', gap: 8, marginBottom: 8 }}>
              <select className="select" value={condition.field} onChange={e => setTriggerConditions(current => current.map((item, i) => i === index ? { ...item, field: e.target.value } : item))}>
                {WEBHOOK_FIELDS.map(field => <option key={field.value} value={field.value}>{field.label}</option>)}
              </select>
              <select className="select" value={condition.operator} onChange={e => setTriggerConditions(current => current.map((item, i) => i === index ? { ...item, operator: e.target.value } : item))}>
                <option value="equals">Equals</option><option value="not_equals">Does not equal</option><option value="contains">Contains</option>
                <option value="greater_than">Greater than</option><option value="less_than">Less than</option><option value="exists">Exists</option><option value="not_exists">Does not exist</option>
              </select>
              <input className="input" value={condition.value} disabled={['exists', 'not_exists'].includes(condition.operator)} onChange={e => setTriggerConditions(current => current.map((item, i) => i === index ? { ...item, value: e.target.value } : item))} placeholder="Condition value" />
              <button className="btn btn-ghost btn-sm" onClick={() => setTriggerConditions(current => current.filter((_, i) => i !== index))}>Remove</button>
            </div>
          ))}
        </>}
      </div>}

      {/* Step 2: Settings */}
      {(kind !== 'drip' || wizardStep === 2) && <div className="card mb-4 setup-panel">
        <div className="card-header"><div className="card-title">2 · Campaign settings</div></div>

        <div className="form-group">
          <label className="form-label">WhatsApp template (from Chatwoot)</label>
          <select className="select" value={selectedTemplate} onChange={e => pickTemplate(e.target.value)}>
            <option value="">— pick a template —</option>
            {templates.map(t => (
              <option key={t.name} value={t.name}>
                {t.name} · {t.language} · {t.category} · {t.paramCount} body var{t.paramCount !== 1 ? 's' : ''}
                {t.header?.required ? ` · ${t.header.format.toLowerCase()} header` : ''}
              </option>
            ))}
          </select>
          <div className="form-hint">{templatesMsg || 'Picking one fills in the name, language, category, and variable slots below.'}</div>
          {selectedBody && (
            <pre className="code-block" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{selectedBody}</pre>
          )}
          {selectedHeader?.required && (
            <div className="callout info mt-3" style={{ display: 'block' }}>
              <div className="text-sm" style={{ fontWeight: 700, marginBottom: 6 }}>
                {selectedHeader.format} header required
              </div>
              <div className="text-sm mb-2">
                Chatwoot requires a public HTTPS {selectedHeader.format.toLowerCase()} URL for every send.
                This requirement was fetched from the selected template.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: enrollmentSource === 'csv' ? '1fr 1fr' : '1fr', gap: 12 }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">Fixed {selectedHeader.format.toLowerCase()} URL</label>
                  <input
                    className="input"
                    type="url"
                    value={headerMediaUrl}
                    onChange={e => setHeaderMediaUrl(e.target.value)}
                    placeholder="https://cdn.example.com/header.jpg"
                  />
                  <div className="form-hint">Used for every recipient in this step.</div>
                </div>
                {enrollmentSource === 'csv' && (
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Or use a CSV URL column</label>
                    <select className="select" value={headerMediaColumn} onChange={e => setHeaderMediaColumn(e.target.value)}>
                      <option value="">— none —</option>
                      {headers.map(header => <option key={header} value={header}>{header}</option>)}
                    </select>
                    <div className="form-hint">Overrides the fixed URL for each row.</div>
                  </div>
                )}
              </div>
              {selectedHeader.exampleUrl && (
                <div className="form-hint mt-2">
                  Chatwoot includes a sample header, but it is not reused because Meta sample URLs can expire.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="divider" />
        <div style={{ display: 'grid', gridTemplateColumns: kind === 'drip' ? '1fr' : '1fr 1fr', gap: '0 20px' }}>
          <div className="form-group">
            <label className="form-label">Campaign name</label>
            <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Order delay notice — June" />
          </div>
          {kind !== 'drip' && <div className="form-group">
            <label className="form-label">Delay between messages (seconds)</label>
            <input className="input" type="number" min={1} value={delay} onChange={e => setDelay(Math.max(1, parseInt(e.target.value || '1', 10)))} />
            <div className="form-hint">Paces sending to avoid WhatsApp rate limits.</div>
          </div>}
          {kind !== 'drip' && <div className="form-group">
            <label className="form-label">Template name</label>
            <input className="input" value={templateName} onChange={e => setTemplateName(e.target.value)} placeholder="order_confirmation_01" />
            <div className="form-hint">Prefilled from Settings — editable per campaign.</div>
          </div>}
          {kind !== 'drip' && <div className="form-group">
            <label className="form-label">Language / Category</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="input" value={language} onChange={e => setLanguage(e.target.value)} placeholder="en" style={{ flex: 1 }} />
              <select className="select" value={category} onChange={e => setCategory(e.target.value)} style={{ flex: 1 }}>
                <option value="UTILITY">UTILITY</option>
                <option value="MARKETING">MARKETING</option>
                <option value="AUTHENTICATION">AUTHENTICATION</option>
              </select>
            </div>
          </div>}
          {kind === 'drip' && selectedTemplate && (
            <div className="selected-template-meta">{language} · {category} · {paramMapping.length} variable{paramMapping.length === 1 ? '' : 's'}</div>
          )}
        </div>
      </div>}

      {/* Step 3: Drip sequence */}
      {kind === 'drip' && wizardStep === 3 && <div className="card mb-4 setup-panel">
        <div className="card-header">
          <div>
            <div className="card-title">3 · Drip sequence</div>
            <div className="card-sub">Each recipient advances through these messages independently.</div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={addFollowUp}>+ Add follow-up</button>
        </div>

        <div className="callout info mb-3">
          Step 1 sends immediately using <span className="mono">{templateName || 'the primary template'}</span>.
        </div>

        {followUps.length === 0 ? (
          <div className="empty-state" style={{ padding: 24 }}>
            <p>Add a follow-up to turn this into a multi-message drip campaign.</p>
          </div>
        ) : followUps.map((step, index) => (
          <div key={step.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginBottom: 12 }}>
            <div className="flex items-center justify-between mb-3">
              <div className="card-title">Step {index + 2}</div>
              <button className="btn btn-ghost btn-sm" onClick={() => setFollowUps(current => current.filter((_, i) => i !== index))}>Remove</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
              <div className="form-group">
                <label className="form-label">WhatsApp template</label>
                <select className="select" value={step.template_name} onChange={e => pickFollowUpTemplate(index, e.target.value)}>
                  <option value="">— select template —</option>
                  {templates.map(t => <option key={t.name} value={t.name}>{t.name} · {t.language}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Wait before step</label>
                <input className="input" type="number" min={0} value={step.delay_value} onChange={e => updateFollowUp(index, { delay_value: Math.max(0, Number(e.target.value)) })} />
              </div>
              <div className="form-group">
                <label className="form-label">Unit</label>
                <select className="select" value={step.delay_unit} onChange={e => updateFollowUp(index, { delay_unit: e.target.value as DripStep['delay_unit'] })}>
                  <option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option>
                </select>
              </div>
            </div>
            {(() => {
              const template = templates.find(item => item.name === step.template_name);
              const header = template?.header;
              if (!header?.required) return null;
              return (
                <div className="callout info mb-3" style={{ display: 'block' }}>
                  <div className="form-label">{header.format} header URL</div>
                  <div style={{ display: 'grid', gridTemplateColumns: enrollmentSource === 'csv' ? '1fr 1fr' : '1fr', gap: 12 }}>
                    <input
                      className="input"
                      type="url"
                      value={step.header_media_url || ''}
                      onChange={e => updateFollowUp(index, { header_media_url: e.target.value })}
                      placeholder="https://cdn.example.com/header.jpg"
                    />
                    {enrollmentSource === 'csv' && (
                      <select
                        className="select"
                        value={step.header_media_column || ''}
                        onChange={e => updateFollowUp(index, { header_media_column: e.target.value })}
                      >
                        <option value="">Or choose a CSV URL column</option>
                        {headers.map(headerName => <option key={headerName} value={headerName}>{headerName}</option>)}
                      </select>
                    )}
                  </div>
                </div>
              );
            })()}
            {step.param_mapping.map((column, slot) => (
              <div key={slot} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <span className="badge pending" style={{ minWidth: 44, justifyContent: 'center' }}>{`{{${slot + 1}}}`}</span>
                <select className="select" value={column} onChange={e => updateFollowUp(index, { param_mapping: step.param_mapping.map((value, i) => i === slot ? e.target.value : value) })}>
                  <option value="">— select {enrollmentSource === 'webhook' ? 'Shopify field' : 'CSV column'} —</option>
                  {mappingFields.map(field => <option key={field} value={field}>{enrollmentSource === 'webhook' ? WEBHOOK_FIELDS.find(item => item.value === field)?.label : field}</option>)}
                </select>
              </div>
            ))}
          </div>
        ))}
      </div>}

      {/* Step 4: Mapping */}
      {(kind !== 'drip' || wizardStep === 4) && <div className="card mb-4 setup-panel">
        <div className="card-header"><div><div className="card-title">{kind === 'drip' ? '4 · Review data and launch' : '3 · Recipient and variable mapping'}</div>{kind === 'drip' && <div className="card-sub">Confirm how message variables are filled before activating the campaign.</div>}</div></div>
        {kind === 'drip' && (
          <div className="review-summary mb-4">
            <div><span>Enrollment</span><strong>{enrollmentSource === 'webhook' ? WEBHOOK_EVENTS.find(event => event.value === triggerEvent)?.label || triggerEvent : `${rows.length} CSV recipients`}</strong></div>
            <div><span>Messages</span><strong>{followUps.length + 1}</strong></div>
            <div><span>First template</span><strong>{templateName}</strong></div>
          </div>
        )}
        {enrollmentSource === 'csv' && headers.length === 0 ? (
          <div className="callout info">Add a CSV above to map its columns.</div>
        ) : (
          <>
            {enrollmentSource === 'csv' && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
              <div className="form-group">
                <label className="form-label">Phone column (recipient)</label>
                <select className="select" value={phoneCol} onChange={e => setPhoneCol(e.target.value)}>
                  <option value="">— select —</option>
                  {headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
                <div className="form-hint">10-digit numbers are auto-prefixed with +91.</div>
              </div>
              <div className="form-group">
                <label className="form-label">Name column (optional)</label>
                <select className="select" value={nameCol} onChange={e => setNameCol(e.target.value)}>
                  <option value="">— none —</option>
                  {headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
                <div className="form-hint">Used as the contact name.</div>
              </div>
            </div>}

            {kind === 'drip' && enrollmentSource === 'csv' && <>
              <div className="divider" />
              <div className="form-group">
              <label className="form-label">Shopify order cross-check</label>
              <select className="select" value={shopifyCheckMode} onChange={e => setShopifyCheckMode(e.target.value)}>
                <option value="stop_if_paid_or_fulfilled">Stop when paid, fulfilled, refunded, voided, or cancelled</option>
                <option value="stop_if_order_found">Stop when any matching order is found</option>
                <option value="off">Disabled</option>
              </select>
              <div className="form-hint">Runs before every drip step. If Shopify cannot be checked, the send fails closed and is logged.</div>
              </div>
              {shopifyCheckMode !== 'off' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
                <div className="form-group">
                  <label className="form-label">Order number column</label>
                  <select className="select" value={orderCol} onChange={e => setOrderCol(e.target.value)}>
                    <option value="">— not available —</option>
                    {headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Customer email column</label>
                  <select className="select" value={emailCol} onChange={e => setEmailCol(e.target.value)}>
                    <option value="">— not available —</option>
                    {headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              </div>
              )}
            </>}

            <div className="divider" />
            <label className="form-label">Template variables → {enrollmentSource === 'webhook' ? 'Shopify fields' : 'CSV columns'}</label>
            <div className="form-hint mb-2">Map each template placeholder to a {enrollmentSource === 'webhook' ? 'webhook value' : 'column'}. Order matches {'{{1}}, {{2}}'}…</div>
            {paramMapping.map((col, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <span className="badge pending" style={{ minWidth: 44, justifyContent: 'center' }}>{`{{${i + 1}}}`}</span>
                <select className="select" value={col} onChange={e => setSlot(i, e.target.value)} style={{ flex: 1 }}>
                  <option value="">— select {enrollmentSource === 'webhook' ? 'Shopify field' : 'column'} —</option>
                  {mappingFields.map(field => <option key={field} value={field}>{enrollmentSource === 'webhook' ? WEBHOOK_FIELDS.find(item => item.value === field)?.label : field}</option>)}
                </select>
                {enrollmentSource === 'csv' && <span className="text-dim text-sm" style={{ minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {renderPreviewVal(col)}
                </span>}
                <button className="btn btn-ghost btn-sm btn-icon" onClick={() => removeSlot(i)} title="Remove" aria-label={`Remove variable ${i + 1}`}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            ))}
            <button className="btn btn-secondary btn-sm" onClick={addSlot}>+ Add variable</button>

            {enrollmentSource === 'csv' && previewRow && (
              <div className="callout info mt-3" style={{ display: 'block' }}>
                <div className="text-sm" style={{ fontWeight: 600, marginBottom: 4 }}>Preview (first row)</div>
                <div className="text-sm">To: {nameCol ? renderPreviewVal(nameCol) + ' · ' : ''}{phoneCol ? renderPreviewVal(phoneCol) : '(no phone)'}</div>
                {paramMapping.map((col, i) => (
                  <div key={i} className="text-sm font-mono">{`{{${i + 1}}}`} = {renderPreviewVal(col)}</div>
                ))}
              </div>
            )}
          </>
        )}
      </div>}

      {error && <div className="callout error mb-3">{error}</div>}
      {kind === 'drip' ? (
        <div className="setup-actions">
          <button className="btn btn-secondary" onClick={wizardStep === 1 ? onCancel : () => { setError(''); setWizardStep(step => Math.max(1, step - 1)); }}>
            {wizardStep === 1 ? 'Cancel' : 'Back'}
          </button>
          <div className="flex gap-2">
            {wizardStep === 4 ? <>
              <button className="btn btn-secondary" onClick={() => submit(false)} disabled={saving}>Save draft</button>
              <button className="btn btn-primary" onClick={() => submit(true)} disabled={saving}>
                {saving ? <span className="spinner" style={{ width: 14, height: 14 }} /> : null}
                Start campaign
              </button>
            </> : (
              <button className="btn btn-primary" onClick={continueDripSetup}>Continue</button>
            )}
          </div>
        </div>
      ) : (
        <div className="setup-actions">
          <span />
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={() => submit(false)} disabled={saving}>Save as draft</button>
            <button className="btn btn-primary" onClick={() => submit(true)} disabled={saving}>
              {saving ? <span className="spinner" style={{ width: 14, height: 14 }} /> : null}
              Create & Start
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Detail view ────────────────────────────────────────────────────────────

function CampaignDetailView({ id, kind, onBack }: { id: string; kind: CampaignKind; onBack: () => void }) {
  const [c, setC] = useState<CampaignDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const data = await fetch(`${API}/campaigns/${id}`).then(readApiResponse);
      setC(data);
    } catch (_) { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [id]);

  const act = async (action: 'start' | 'pause') => {
    await fetch(`${API}/campaigns/${id}/${action}`, { method: 'POST' });
    load();
  };

  const retryAll = async () => {
    await fetch(`${API}/campaigns/${id}/retry`, { method: 'POST' });
    load();
  };

  const retryOne = async (recipientId: string) => {
    await fetch(`${API}/campaigns/${id}/recipients/${recipientId}/retry`, { method: 'POST' });
    load();
  };

  if (loading) return <div className="page"><div className="empty-state" style={{ padding: 40 }}><span className="spinner" /></div></div>;
  if (!c) return <div className="page"><div className="callout error">Campaign not found.</div></div>;

  const done = c.sent + c.failed + (c.skipped || 0);
  const pct = c.total ? Math.round((done / c.total) * 100) : 0;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">{c.name}</div>
          <div className="page-sub">{kind === 'drip' ? `${c.steps?.length || 1}-step drip · ${c.enrollment_source === 'webhook' ? `Webhook: ${c.trigger_event}` : 'CSV enrollment'} · ${c.delay_seconds}s pacing` : `Template ${c.template_name} · ${c.delay_seconds}s recipient pacing`}</div>
        </div>
        <div className="flex items-center gap-3">
          {statusBadge(c.status)}
          {c.failed > 0 && (
            <button className="btn btn-primary btn-sm" onClick={retryAll}>Retry failed ({c.failed})</button>
          )}
          {(c.status === 'draft' || c.status === 'paused') && (
            <button className="btn btn-primary btn-sm" onClick={() => act('start')}>{c.status === 'paused' ? 'Resume' : 'Start'}</button>
          )}
          {c.status === 'running' && <button className="btn btn-secondary btn-sm" onClick={() => act('pause')}>Pause</button>}
          <button className="btn btn-secondary btn-sm" onClick={onBack}>← Back</button>
        </div>
      </div>

      <div className="card mb-4">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, height: 8, background: 'var(--bg-hover)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--green)' }} />
          </div>
          <span className="text-sm">{c.sent} delivered {kind === 'drip' ? `· ${c.skipped || 0} stopped ` : ''}· {c.failed} failed · {c.total} total</span>
        </div>
      </div>

      {kind === 'drip' && <div className="card mb-4">
        <div className="card-header"><div className="card-title">Drip sequence</div></div>
        <div style={{ display: 'grid', gap: 10 }}>
          {(c.steps?.length ? c.steps : [{ id: 'legacy', template_name: c.template_name, language: c.language, category: c.category, delay_value: 0, delay_unit: 'minutes' as const, param_mapping: c.param_mapping }]).map((step, index) => (
            <div key={step.id} className="flex items-center justify-between" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
              <div><strong>Step {index + 1}</strong> <span className="mono text-sm">{step.template_name}</span></div>
              <span className="text-dim text-sm">{index === 0 ? 'Immediately' : `After ${step.delay_value} ${step.delay_unit}`}</span>
            </div>
          ))}
        </div>
      </div>}

      <div className="card mb-4" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th><th>Name</th><th>Phone</th>{kind === 'drip' && <><th>Step</th><th>Shopify</th></>}
                {c.param_mapping.map((_, i) => <th key={i}>{`{{${i + 1}}}`}</th>)}
                <th>Status</th><th>Error</th><th />
              </tr>
            </thead>
            <tbody>
              {c.recipients.map(r => (
                <tr key={r.id}>
                  <td className="text-dim text-sm">{r.row_index + 1}</td>
                  <td>{r.name || '—'}</td>
                  <td className="mono text-sm">{r.phone || '—'}</td>
                  {kind === 'drip' && <><td className="text-sm">{Math.min((r.current_step || 0) + 1, c.steps?.length || 1)} / {c.steps?.length || 1}</td>
                  <td className="text-sm">{r.last_shopify_status || '—'}</td></>}
                  {c.param_mapping.map((_, i) => <td key={i} className="text-sm">{r.variables[String(i + 1)] ?? ''}</td>)}
                  <td>
                    {statusBadge(r.status)}
                    {r.status === 'retry_scheduled' && r.run_at && (
                      <div className="text-dim" style={{ fontSize: 11, marginTop: 4, whiteSpace: 'nowrap' }}>
                        Retry {r.delivery_retry_count || 1}/2 · {new Date(r.run_at).toLocaleString()}
                      </div>
                    )}
                  </td>
                  <td style={{ maxWidth: 220 }}>
                    {r.error_message && <span className="text-sm" style={{ color: 'var(--red)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.error_message}>{r.error_message}</span>}
                  </td>
                  <td>
                    {r.status === 'failed' && (
                      <button className="btn btn-secondary btn-sm" onClick={() => retryOne(r.id)}>Retry</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="card-header" style={{ padding: '16px 18px' }}>
          <div><div className="card-title">{kind === 'drip' ? 'Drip execution log' : 'Delivery log'}</div><div className="card-sub">{kind === 'drip' ? 'Every Shopify check and drip-step result is retained here.' : 'Every recipient send result is retained here.'}</div></div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Recipient</th>{kind === 'drip' && <th>Step</th>}<th>Template</th>{kind === 'drip' && <th>Shopify</th>}<th>Status</th><th>Error</th></tr></thead>
            <tbody>
              {(c.logs || []).map(log => {
                const recipient = c.recipients.find(r => r.id === log.recipient_id);
                return <tr key={log.id}>
                  <td className="text-sm text-dim">{new Date(log.created_at).toLocaleString()}</td>
                  <td>{recipient?.name || recipient?.phone || log.recipient_id}</td>
                  {kind === 'drip' && <td>{log.step_index < 0 ? 'Enrollment' : log.step_index + 1}</td>}
                  <td className="mono text-sm">{log.template_name || '—'}</td>
                  {kind === 'drip' && <td className="text-sm">{log.shopify_status || '—'}</td>}
                  <td>{statusBadge(log.status)}</td>
                  <td className="text-sm" style={{ color: log.error_message ? 'var(--red)' : undefined }}>{log.error_message || '—'}</td>
                </tr>;
              })}
              {(c.logs || []).length === 0 && <tr><td colSpan={kind === 'drip' ? 7 : 5} className="text-dim" style={{ textAlign: 'center', padding: 24 }}>No messages have run yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Root ───────────────────────────────────────────────────────────────────

export const Campaigns: React.FC<{ kind?: CampaignKind }> = ({ kind = 'bulk' }) => {
  const [view, setView] = useState<View>({ kind: 'list' });

  if (view.kind === 'new') {
    return <NewCampaign kind={kind} onCancel={() => setView({ kind: 'list' })} onCreated={() => setView({ kind: 'list' })} />;
  }
  if (view.kind === 'detail') {
    return <CampaignDetailView id={view.id} kind={kind} onBack={() => setView({ kind: 'list' })} />;
  }
  return <CampaignList kind={kind} onNew={() => setView({ kind: 'new' })} onOpen={id => setView({ kind: 'detail', id })} />;
};
