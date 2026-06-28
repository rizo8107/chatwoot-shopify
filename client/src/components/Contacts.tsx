import React, { useEffect, useMemo, useState } from 'react';

const API = '/api';

interface Contact {
  id: number;
  name: string;
  email: string;
  phone: string;
  created_at: number | string | null;
  custom_attributes: Record<string, any>;
  additional_attributes: Record<string, any>;
}

interface TemplateInfo { name: string; language: string; category: string; paramCount: number; body: string; }

// ─── helpers ─────────────────────────────────────────────────────────────────

function toDate(v: number | string | null): Date | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return new Date(v * 1000);
  const n = Number(v);
  if (!isNaN(n) && String(v).length <= 11) return new Date(n * 1000);
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function fmtDate(v: number | string | null): string {
  const d = toDate(v);
  return d ? d.toLocaleDateString() : '—';
}

function attrsText(c: Contact): string {
  return JSON.stringify({ ...c.additional_attributes, ...c.custom_attributes }).toLowerCase();
}

function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const rows: string[][] = [];
  let field = '', row: string[] = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const ne = rows.filter(r => r.some(x => x.trim() !== ''));
  if (!ne.length) return { headers: [], rows: [] };
  const headers = ne[0].map(h => h.trim());
  return { headers, rows: ne.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]))) };
}

// ─── Segment + Campaign ──────────────────────────────────────────────────────

function Segment() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  // filters
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [attr, setAttr] = useState('');

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showCampaign, setShowCampaign] = useState(false);

  const load = () => {
    setLoading(true); setErr('');
    fetch(`${API}/chatwoot/contacts?maxPages=40`).then(async r => {
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to fetch contacts');
      setContacts(d.contacts || []);
    }).catch(e => setErr(e.message)).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const from = dateFrom ? new Date(dateFrom + 'T00:00:00').getTime() : null;
    const to = dateTo ? new Date(dateTo + 'T23:59:59').getTime() : null;
    const a = attr.trim().toLowerCase();
    return contacts.filter(c => {
      if (q && !(`${c.name} ${c.phone} ${c.email}`.toLowerCase().includes(q))) return false;
      if (a && !attrsText(c).includes(a)) return false;
      if (from || to) {
        const d = toDate(c.created_at)?.getTime();
        if (d == null) return false;
        if (from && d < from) return false;
        if (to && d > to) return false;
      }
      return true;
    });
  }, [contacts, search, dateFrom, dateTo, attr]);

  const allFilteredSelected = filtered.length > 0 && filtered.every(c => selected.has(c.id));
  const toggleAll = () => {
    const next = new Set(selected);
    if (allFilteredSelected) filtered.forEach(c => next.delete(c.id));
    else filtered.forEach(c => next.add(c.id));
    setSelected(next);
  };
  const toggle = (id: number) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const selectedContacts = contacts.filter(c => selected.has(c.id));

  return (
    <>
      <div className="flex items-center gap-3 mb-4" style={{ flexWrap: 'wrap' }}>
        <div className="search-wrap" style={{ flex: 1, minWidth: 200 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input className="input search-input" placeholder="Search name / phone / email…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <button className="btn btn-secondary btn-sm" onClick={load}>Refresh</button>
      </div>

      <div className="card mb-4">
        <div className="card-header"><div className="card-title">Filters (segment)</div></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 16px' }}>
          <div className="form-group">
            <label className="form-label">Created from</label>
            <input className="input" type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Created to</label>
            <input className="input" type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Order ID / attribute contains</label>
            <input className="input" value={attr} onChange={e => setAttr(e.target.value)} placeholder="e.g. #2036" />
            <div className="form-hint">Matches custom/additional attributes.</div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between mb-3">
        <span className="text-dim text-sm">{filtered.length} of {contacts.length} contacts · {selected.size} selected</span>
        <button className="btn btn-primary btn-sm" disabled={selected.size === 0} onClick={() => setShowCampaign(true)}>
          Create campaign from selection ({selected.size})
        </button>
      </div>

      {err && <div className="callout error mb-3">{err}</div>}

      <div className="card" style={{ padding: 0 }}>
        {loading ? (
          <div className="empty-state" style={{ padding: 40 }}><span className="spinner" /></div>
        ) : filtered.length === 0 ? (
          <div className="empty-state"><h3>No contacts</h3><p>Adjust filters or refresh.</p></div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 34 }}><input type="checkbox" checked={allFilteredSelected} onChange={toggleAll} /></th>
                  <th>Name</th><th>Phone</th><th>Email</th><th>Created</th><th>Attributes</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 500).map(c => (
                  <tr key={c.id} onClick={() => toggle(c.id)} style={{ cursor: 'pointer' }}>
                    <td onClick={e => e.stopPropagation()}><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} /></td>
                    <td>{c.name || '—'}</td>
                    <td className="mono text-sm">{c.phone || '—'}</td>
                    <td className="text-sm">{c.email || '—'}</td>
                    <td className="text-sm text-dim">{fmtDate(c.created_at)}</td>
                    <td className="text-sm text-dim" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {Object.keys({ ...c.custom_attributes, ...c.additional_attributes }).slice(0, 3).join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCampaign && (
        <CampaignFromSegment contacts={selectedContacts} onClose={() => setShowCampaign(false)} />
      )}
    </>
  );
}

// ─── Campaign from a contact segment ─────────────────────────────────────────

function CampaignFromSegment({ contacts, onClose }: { contacts: Contact[]; onClose: () => void }) {
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [tmpl, setTmpl] = useState('');
  const [name, setName] = useState('');
  const [delay, setDelay] = useState(5);
  const [mapping, setMapping] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);

  // available contact fields to map template vars to
  const fields = useMemo(() => {
    const keys = new Set<string>(['name', 'phone', 'email']);
    contacts.forEach(c => { Object.keys(c.custom_attributes || {}).forEach(k => keys.add(k)); Object.keys(c.additional_attributes || {}).forEach(k => keys.add(k)); });
    return [...keys];
  }, [contacts]);

  useEffect(() => {
    fetch(`${API}/whatsapp/templates`).then(r => r.json()).then(d => setTemplates(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  const pick = (n: string) => {
    setTmpl(n);
    const t = templates.find(x => x.name === n);
    if (t) setMapping(new Array(t.paramCount).fill(''));
  };

  const flatten = (c: Contact): Record<string, string> => ({
    name: c.name, phone: c.phone, email: c.email,
    ...Object.fromEntries(Object.entries({ ...c.additional_attributes, ...c.custom_attributes }).map(([k, v]) => [k, String(v ?? '')]))
  });

  const submit = async (autostart: boolean) => {
    setMsg('');
    const t = templates.find(x => x.name === tmpl);
    if (!name.trim()) { setMsg('Enter a campaign name.'); return; }
    if (!tmpl) { setMsg('Pick a template.'); return; }
    setSaving(true);
    try {
      const rows = contacts.map(flatten);
      const res = await fetch(`${API}/campaigns`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, delay_seconds: delay, template_name: tmpl, language: t?.language, category: t?.category,
          phone_column: 'phone', name_column: 'name', param_mapping: mapping, rows, autostart
        })
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to create campaign');
      setMsg('Campaign created ✓ — see the Campaigns tab.');
      setTimeout(onClose, 1200);
    } catch (e: any) { setMsg(e.message); setSaving(false); }
  };

  const preview = contacts[0] ? flatten(contacts[0]) : null;

  return (
    <div className="modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={onClose}>
      <div className="card" style={{ width: 560, maxHeight: '85vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
        <div className="card-header"><div className="card-title">Campaign → {contacts.length} contacts</div>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="form-group">
          <label className="form-label">Campaign name</label>
          <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. June re-engagement" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
          <div className="form-group">
            <label className="form-label">Template</label>
            <select className="select" value={tmpl} onChange={e => pick(e.target.value)}>
              <option value="">— pick —</option>
              {templates.map(t => <option key={t.name} value={t.name}>{t.name} · {t.paramCount} var{t.paramCount !== 1 ? 's' : ''}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Delay between messages (s)</label>
            <input className="input" type="number" min={1} value={delay} onChange={e => setDelay(Math.max(1, parseInt(e.target.value || '1', 10)))} />
          </div>
        </div>

        {mapping.length > 0 && (
          <div className="form-group">
            <label className="form-label">Map template variables → contact fields</label>
            {mapping.map((f, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <span className="badge pending" style={{ minWidth: 44, justifyContent: 'center' }}>{`{{${i + 1}}}`}</span>
                <select className="select" value={f} onChange={e => setMapping(m => m.map((x, idx) => idx === i ? e.target.value : x))} style={{ flex: 1 }}>
                  <option value="">— field —</option>
                  {fields.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
                <span className="text-dim text-sm" style={{ minWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preview && f ? preview[f] : ''}</span>
              </div>
            ))}
          </div>
        )}

        {msg && <div className={`callout ${msg.includes('✓') ? 'success' : 'error'} mb-3`}>{msg}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn btn-secondary" onClick={() => submit(false)} disabled={saving}>Save draft</button>
          <button className="btn btn-primary" onClick={() => submit(true)} disabled={saving}>Create & Start</button>
        </div>
      </div>
    </div>
  );
}

// ─── Import contacts to Chatwoot ─────────────────────────────────────────────

function ImportToChatwoot() {
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [nameCol, setNameCol] = useState('');
  const [phoneCol, setPhoneCol] = useState('');
  const [emailCol, setEmailCol] = useState('');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const apply = (text: string) => {
    const { headers, rows } = parseCSV(text);
    setHeaders(headers); setRows(rows); setResult(null); setErr('');
    const low = headers.map(h => h.toLowerCase());
    setPhoneCol(headers[low.findIndex(h => h.includes('phone') || h.includes('mobile') || h.includes('number'))] || '');
    setNameCol(headers[low.findIndex(h => h.includes('name'))] || '');
    setEmailCol(headers[low.findIndex(h => h.includes('email') || h.includes('mail'))] || '');
  };
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader(); r.onload = () => apply(String(r.result || '')); r.readAsText(f);
  };

  const run = async () => {
    setErr(''); setResult(null);
    if (!phoneCol) { setErr('Select the phone column.'); return; }
    setBusy(true);
    try {
      const payload = rows.map(r => ({ name: nameCol ? r[nameCol] : '', phone: r[phoneCol], email: emailCol ? r[emailCol] : '' }));
      const res = await fetch(`${API}/chatwoot/contacts/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: payload }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Import failed');
      setResult(d);
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <div className="card">
      <div className="card-header"><div className="card-title">Import contacts to Chatwoot</div></div>
      <div className="form-group">
        <label className="form-label">Upload CSV</label>
        <input type="file" accept=".csv,text/csv" className="input" onChange={onFile} />
      </div>
      <div className="form-group">
        <label className="form-label">…or paste CSV</label>
        <textarea className="textarea" style={{ minHeight: 100, fontFamily: 'var(--font-mono)', fontSize: 12 }} placeholder={'Name,Phone,Email\nKumar,9150115554,k@x.com'} onChange={e => apply(e.target.value)} />
      </div>
      {headers.length > 0 && (
        <>
          <div className="text-dim text-sm mb-2">{rows.length} rows · {headers.length} columns</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 16px' }}>
            <div className="form-group">
              <label className="form-label">Phone column</label>
              <select className="select" value={phoneCol} onChange={e => setPhoneCol(e.target.value)}>
                <option value="">— select —</option>{headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Name column</label>
              <select className="select" value={nameCol} onChange={e => setNameCol(e.target.value)}>
                <option value="">— none —</option>{headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Email column</label>
              <select className="select" value={emailCol} onChange={e => setEmailCol(e.target.value)}>
                <option value="">— none —</option>{headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          </div>
          <button className="btn btn-primary" onClick={run} disabled={busy}>
            {busy ? <span className="spinner" style={{ width: 14, height: 14 }} /> : null} Import {rows.length} contacts
          </button>
        </>
      )}
      {err && <div className="callout error mt-3">{err}</div>}
      {result && <div className="callout success mt-3">Imported {result.imported}/{result.total} · failed {result.failed}</div>}
    </div>
  );
}

// ─── Root ────────────────────────────────────────────────────────────────────

export const Contacts: React.FC = () => {
  const [tab, setTab] = useState<'segment' | 'import'>('segment');
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Contacts</div>
          <div className="page-sub">Segment Chatwoot contacts into campaigns, or import contacts from CSV</div>
        </div>
      </div>
      <div className="filter-tabs" style={{ display: 'inline-flex', marginBottom: 16 }}>
        <button className={`filter-tab${tab === 'segment' ? ' active' : ''}`} onClick={() => setTab('segment')}>Segment → Campaign</button>
        <button className={`filter-tab${tab === 'import' ? ' active' : ''}`} onClick={() => setTab('import')}>Import to Chatwoot</button>
      </div>
      {tab === 'segment' ? <Segment /> : <ImportToChatwoot />}
    </div>
  );
};
