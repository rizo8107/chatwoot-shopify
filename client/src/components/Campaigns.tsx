import React, { useEffect, useState } from 'react';

const API = '/api';

interface CampaignSummary {
  id: string; name: string; template_name: string; status: string;
  delay_seconds: number; total: number; sent: number; failed: number;
  created_at: string; started_at?: string;
}

interface Recipient {
  id: string; row_index: number; phone: string; name: string;
  variables: Record<string, string>; status: string; error_message?: string;
  run_at?: string; sent_at?: string;
}

interface CampaignDetail extends CampaignSummary {
  language: string; category: string; phone_column: string; name_column: string;
  param_mapping: string[]; recipients: Recipient[];
}

interface TemplateInfo {
  name: string; language: string; category: string; status: string; paramCount: number; body: string;
}

type View = { kind: 'list' } | { kind: 'new' } | { kind: 'detail'; id: string };

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
    completed: 'success', sent: 'success', running: 'processing',
    pending: 'pending', paused: 'delayed', draft: 'pending', failed: 'failed'
  };
  return <span className={`badge ${cls[s] || 'pending'}`}><span className="badge-dot" />{s}</span>;
}

// ─── List view ──────────────────────────────────────────────────────────────

function CampaignList({ onNew, onOpen }: { onNew: () => void; onOpen: (id: string) => void }) {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const data = await fetch(`${API}/campaigns`).then(r => r.json());
      setCampaigns(Array.isArray(data) ? data : []);
    } catch (_) { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

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
          <div className="page-title">Campaigns</div>
          <div className="page-sub">Bulk-send WhatsApp templates from a CSV with column → variable mapping</div>
        </div>
        <button className="btn btn-primary" onClick={onNew}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New Campaign
        </button>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {loading ? (
          <div className="empty-state" style={{ padding: 40 }}><span className="spinner" /></div>
        ) : campaigns.length === 0 ? (
          <div className="empty-state">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>
            <h3>No campaigns yet</h3>
            <p>Create one to bulk-send templates from a CSV.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Template</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Delay</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {campaigns.map(c => {
                  const done = c.sent + c.failed;
                  const pct = c.total ? Math.round((done / c.total) * 100) : 0;
                  return (
                    <tr key={c.id} style={{ cursor: 'pointer' }}>
                      <td onClick={() => onOpen(c.id)} style={{ fontWeight: 600 }}>{c.name}</td>
                      <td onClick={() => onOpen(c.id)} className="mono text-sm">{c.template_name}</td>
                      <td onClick={() => onOpen(c.id)}>{statusBadge(c.status)}</td>
                      <td onClick={() => onOpen(c.id)} style={{ minWidth: 160 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ flex: 1, height: 6, background: 'var(--bg-hover)', borderRadius: 4, overflow: 'hidden' }}>
                            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--green)' }} />
                          </div>
                          <span className="text-dim text-sm" style={{ whiteSpace: 'nowrap' }}>
                            {c.sent}✓ {c.failed > 0 ? `${c.failed}✗ ` : ''}/ {c.total}
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

function NewCampaign({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
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

  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [templatesMsg, setTemplatesMsg] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Prefill template name + variable slot count from saved Settings
  useEffect(() => {
    fetch(`${API}/settings`).then(r => r.json()).then(d => {
      if (d.WHATSAPP_TEMPLATE_NAME) setTemplateName(d.WHATSAPP_TEMPLATE_NAME);
      const savedMapping = (d.WHATSAPP_TEMPLATE_MAPPING || '').split(',').map((s: string) => s.trim()).filter(Boolean);
      if (savedMapping.length > 0) setParamMapping(new Array(savedMapping.length).fill(''));
    }).catch(() => {});
  }, []);

  // Load the live template list from Chatwoot
  useEffect(() => {
    setTemplatesMsg('Loading templates…');
    fetch(`${API}/whatsapp/templates`).then(async r => {
      const d = await r.json();
      if (!r.ok) { setTemplatesMsg(d.error || 'Could not load templates'); return; }
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
    if (phoneGuess) setPhoneCol(phoneGuess);
    if (nameGuess) setNameCol(nameGuess);
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

  const previewRow = rows[0];
  const renderPreviewVal = (col: string) => col && previewRow ? (previewRow[col] ?? '') : '—';

  const submit = async (autostart: boolean) => {
    setError('');
    if (!name.trim()) { setError('Enter a campaign name.'); return; }
    if (rows.length === 0) { setError('Upload or paste a CSV with at least one row.'); return; }
    if (!phoneCol) { setError('Select which column holds the phone number.'); return; }
    if (!templateName.trim()) { setError('Enter a WhatsApp template name (or set one in Settings).'); return; }

    setSaving(true);
    try {
      const res = await fetch(`${API}/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, delay_seconds: delay, template_name: templateName, language, category,
          phone_column: phoneCol, name_column: nameCol, param_mapping: paramMapping, rows, autostart
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create campaign');
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
          <div className="page-title">New Campaign</div>
          <div className="page-sub">Upload a CSV, map columns to template variables, and send</div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={onCancel}>← Back</button>
      </div>

      {/* Step 1: CSV */}
      <div className="card mb-4">
        <div className="card-header"><div className="card-title">1 · Recipients (CSV)</div></div>
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
      </div>

      {/* Step 2: Settings */}
      <div className="card mb-4">
        <div className="card-header"><div className="card-title">2 · Campaign settings</div></div>

        <div className="form-group">
          <label className="form-label">WhatsApp template (from Chatwoot)</label>
          <select className="select" value={selectedTemplate} onChange={e => pickTemplate(e.target.value)}>
            <option value="">— pick a template —</option>
            {templates.map(t => (
              <option key={t.name} value={t.name}>{t.name} · {t.language} · {t.category} · {t.paramCount} var{t.paramCount !== 1 ? 's' : ''}</option>
            ))}
          </select>
          <div className="form-hint">{templatesMsg || 'Picking one fills in the name, language, category, and variable slots below.'}</div>
          {selectedBody && (
            <pre className="code-block" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{selectedBody}</pre>
          )}
        </div>

        <div className="divider" />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
          <div className="form-group">
            <label className="form-label">Campaign name</label>
            <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Order delay notice — June" />
          </div>
          <div className="form-group">
            <label className="form-label">Delay between messages (seconds)</label>
            <input className="input" type="number" min={1} value={delay} onChange={e => setDelay(Math.max(1, parseInt(e.target.value || '1', 10)))} />
            <div className="form-hint">Paces sending to avoid WhatsApp rate limits.</div>
          </div>
          <div className="form-group">
            <label className="form-label">Template name</label>
            <input className="input" value={templateName} onChange={e => setTemplateName(e.target.value)} placeholder="order_confirmation_01" />
            <div className="form-hint">Prefilled from Settings — editable per campaign.</div>
          </div>
          <div className="form-group">
            <label className="form-label">Language / Category</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="input" value={language} onChange={e => setLanguage(e.target.value)} placeholder="en" style={{ flex: 1 }} />
              <select className="select" value={category} onChange={e => setCategory(e.target.value)} style={{ flex: 1 }}>
                <option value="UTILITY">UTILITY</option>
                <option value="MARKETING">MARKETING</option>
                <option value="AUTHENTICATION">AUTHENTICATION</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Step 3: Mapping */}
      <div className="card mb-4">
        <div className="card-header"><div className="card-title">3 · Column mapping</div></div>
        {headers.length === 0 ? (
          <div className="callout info">Add a CSV above to map its columns.</div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
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
            </div>

            <div className="divider" />
            <label className="form-label">Template variables → CSV columns</label>
            <div className="form-hint mb-2">Map each template placeholder to a column. Order matches {'{{1}}, {{2}}'}…</div>
            {paramMapping.map((col, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <span className="badge pending" style={{ minWidth: 44, justifyContent: 'center' }}>{`{{${i + 1}}}`}</span>
                <select className="select" value={col} onChange={e => setSlot(i, e.target.value)} style={{ flex: 1 }}>
                  <option value="">— select column —</option>
                  {headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
                <span className="text-dim text-sm" style={{ minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {renderPreviewVal(col)}
                </span>
                <button className="btn btn-ghost btn-sm btn-icon" onClick={() => removeSlot(i)} title="Remove">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            ))}
            <button className="btn btn-secondary btn-sm" onClick={addSlot}>+ Add variable</button>

            {previewRow && (
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
      </div>

      {error && <div className="callout error mb-3">{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingBottom: 32 }}>
        <button className="btn btn-secondary" onClick={() => submit(false)} disabled={saving}>Save as draft</button>
        <button className="btn btn-primary" onClick={() => submit(true)} disabled={saving}>
          {saving ? <span className="spinner" style={{ width: 14, height: 14 }} /> : null}
          Create & Start
        </button>
      </div>
    </div>
  );
}

// ─── Detail view ────────────────────────────────────────────────────────────

function CampaignDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const [c, setC] = useState<CampaignDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const data = await fetch(`${API}/campaigns/${id}`).then(r => r.json());
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

  const done = c.sent + c.failed;
  const pct = c.total ? Math.round((done / c.total) * 100) : 0;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">{c.name}</div>
          <div className="page-sub">Template <span className="mono">{c.template_name}</span> · {c.delay_seconds}s between messages</div>
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
          <span className="text-sm">{c.sent} sent · {c.failed} failed · {c.total} total</span>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th><th>Name</th><th>Phone</th>
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
                  {c.param_mapping.map((_, i) => <td key={i} className="text-sm">{r.variables[String(i + 1)] ?? ''}</td>)}
                  <td>{statusBadge(r.status)}</td>
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
    </div>
  );
}

// ─── Root ───────────────────────────────────────────────────────────────────

export const Campaigns: React.FC = () => {
  const [view, setView] = useState<View>({ kind: 'list' });

  if (view.kind === 'new') {
    return <NewCampaign onCancel={() => setView({ kind: 'list' })} onCreated={() => setView({ kind: 'list' })} />;
  }
  if (view.kind === 'detail') {
    return <CampaignDetailView id={view.id} onBack={() => setView({ kind: 'list' })} />;
  }
  return <CampaignList onNew={() => setView({ kind: 'new' })} onOpen={id => setView({ kind: 'detail', id })} />;
};
