import React, { useEffect, useState } from 'react';

interface Transaction {
  id: string; flow_id?: string; order_number: string; customer_name: string;
  phone_number: string; status: string; type: string; created_at: string; error_message?: string;
}

interface Step {
  name: string; nodeType?: string; status: string; startedAt: string; endedAt?: string;
  durationMs?: number; request?: any; response?: any; error?: any;
}

const API = '/api';

function statusBadge(s: string) {
  const cls: Record<string, string> = { success: 'success', failed: 'failed', processing: 'processing', delayed: 'delayed', pending: 'pending', scheduled: 'delayed' };
  return <span className={`badge ${cls[s] || 'pending'}`}><span className="badge-dot" />{s}</span>;
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

function StepTimeline({ steps }: { steps: Step[] }) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const toggle = (i: number) => setExpanded(e => ({ ...e, [i]: !e[i] }));

  return (
    <div className="timeline">
      {steps.map((step, i) => (
        <div key={i} className={`timeline-item ${step.status}`}>
          <div className="timeline-header" onClick={() => toggle(i)}>
            <span className={`timeline-dot ${step.status}`} />
            <span className="timeline-step-name">{step.name}</span>
            <span className="timeline-step-meta">
              {step.durationMs != null ? `${step.durationMs}ms` : ''}&nbsp;&nbsp;
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transition: 'transform 0.2s', transform: expanded[i] ? 'rotate(180deg)' : 'none' }}><path d="m6 9 6 6 6-6"/></svg>
            </span>
          </div>

          {expanded[i] && (
            <div className="timeline-body">
              {step.request && (
                <div>
                  <div className="timeline-section-label">Request</div>
                  <pre className="code-block">{JSON.stringify(step.request, null, 2)}</pre>
                </div>
              )}
              {step.response && (
                <div>
                  <div className="timeline-section-label">Response</div>
                  <pre className="code-block">{JSON.stringify(step.response, null, 2)}</pre>
                </div>
              )}
              {step.error && (
                <div>
                  <div className="timeline-section-label">Error</div>
                  <pre className="code-block error">{step.error.message}{step.error.stack ? '\n\n' + step.error.stack : ''}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function TransactionDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [tx, setTx] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/transactions/${id}`).then(r => r.json()).then(d => { setTx(d); setLoading(false); }).catch(() => setLoading(false));
  }, [id]);

  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: '16px 12px', background: 'var(--bg-hover)' }}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <span className="font-semibold" style={{ fontSize: 13 }}>Execution Detail</span>
          <span className="text-dim font-mono" style={{ fontSize: 11, marginLeft: 10 }}>{id}</span>
        </div>
        <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      {loading
        ? <div className="flex items-center gap-2"><span className="spinner" /><span className="text-dim text-sm">Loading...</span></div>
        : tx?.steps?.length > 0
          ? <StepTimeline steps={tx.steps} />
          : <div className="text-dim text-sm">No step details recorded.</div>
      }
    </div>
  );
}

export const Logs: React.FC = () => {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const url = statusFilter === 'all'
        ? `${API}/transactions?limit=200`
        : `${API}/transactions?limit=200&status=${statusFilter}`;
      const data = await fetch(url).then(r => r.json());
      setTransactions(data);
    } catch (_) {}
    setLoading(false);
  };

  useEffect(() => { load(); }, [statusFilter]);

  const filtered = transactions.filter(tx => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (tx.order_number || '').toLowerCase().includes(q)
      || (tx.customer_name || '').toLowerCase().includes(q)
      || (tx.phone_number || '').toLowerCase().includes(q)
      || tx.id.toLowerCase().includes(q);
  });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Execution Logs</div>
          <div className="page-sub">Full history of webhook processing and flow executions</div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={load}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4" style={{ flexWrap: 'wrap' }}>
        <div className="filter-tabs">
          {['all', 'success', 'failed', 'processing', 'delayed'].map(s => (
            <button key={s} className={`filter-tab${statusFilter === s ? ' active' : ''}`} onClick={() => setStatusFilter(s)}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <div className="search-wrap" style={{ flex: 1, minWidth: 200 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input className="input search-input" placeholder="Search by order, name, phone, or ID..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <span className="text-dim text-sm">{filtered.length} result{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {loading ? (
          <div className="empty-state" style={{ padding: 40 }}><span className="spinner" /></div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <h3>No matching logs</h3>
            <p>Try adjusting your filters or search query.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order #</th>
                  <th>Customer</th>
                  <th>Phone</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Error</th>
                  <th>Time</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map(tx => (
                  <React.Fragment key={tx.id}>
                    <tr onClick={() => setExpanded(expanded === tx.id ? null : tx.id)} style={{ borderBottom: expanded === tx.id ? 'none' : undefined }}>
                      <td className="mono">#{tx.order_number || '—'}</td>
                      <td>{tx.customer_name || '—'}</td>
                      <td className="mono">{tx.phone_number || '—'}</td>
                      <td><span className="text-sm text-dim">{tx.type || 'webhook'}</span></td>
                      <td>{statusBadge(tx.status)}</td>
                      <td style={{ maxWidth: 200 }}>
                        {tx.error_message && <span className="text-sm" style={{ color: 'var(--red)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tx.error_message}</span>}
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>{timeAgo(tx.created_at)}</td>
                      <td>
                        <button className="btn btn-ghost btn-sm btn-icon">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transition: 'transform 0.2s', transform: expanded === tx.id ? 'rotate(180deg)' : 'none' }}><path d="m6 9 6 6 6-6"/></svg>
                        </button>
                      </td>
                    </tr>
                    {expanded === tx.id && (
                      <tr>
                        <td colSpan={8} style={{ padding: 0, borderBottom: '1px solid var(--border)' }}>
                          <TransactionDetail id={tx.id} onClose={() => setExpanded(null)} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
