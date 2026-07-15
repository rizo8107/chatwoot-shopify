import React, { useEffect, useState } from 'react';

interface Metrics { total: number; success: number; failed: number; processing: number; }
interface Transaction {
  id: string; order_number: string; customer_name: string; phone_number: string;
  status: string; type: string; created_at: string; error_message?: string; flow_id?: string;
}

const API = '/api';

function statusBadge(s: string) {
  const map: Record<string, string> = { success: 'success', failed: 'failed', processing: 'processing', delayed: 'delayed', pending: 'pending' };
  return <span className={`badge ${map[s] || 'pending'}`}><span className="badge-dot" />{s}</span>;
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const Dashboard: React.FC<{ onNavigate?: (tab: any) => void }> = ({ onNavigate }) => {
  const [metrics, setMetrics] = useState<Metrics>({ total: 0, success: 0, failed: 0, processing: 0 });
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    try {
      // A stuck DB connection pool on the server must never hang this UI
      // forever — bail out and show a retry option instead of spinning.
      const signal = AbortSignal.timeout(12_000);
      const [mRes, tRes] = await Promise.all([
        fetch(`${API}/metrics`, { signal }),
        fetch(`${API}/transactions?limit=10`, { signal })
      ]);
      if (!mRes.ok || !tRes.ok) throw new Error('Failed to load dashboard data');
      setMetrics(await mRes.json());
      setTransactions(await tRes.json());
      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.name === 'TimeoutError' ? 'Request timed out — the server may be busy.' : 'Failed to load dashboard data.');
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    const iv = setInterval(load, 30_000);
    return () => clearInterval(iv);
  }, []);

  const rate = metrics.total > 0 ? Math.round((metrics.success / metrics.total) * 100) : 0;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Dashboard</div>
          <div className="page-sub">
            Webhook automation overview &nbsp;·&nbsp;
            <span className="text-dim">Last refresh: {lastRefresh.toLocaleTimeString()}</span>
          </div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={load}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
          Refresh
        </button>
      </div>

      {error && (
        <div className="callout error" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span>{error}</span>
          <button className="btn btn-sm btn-secondary" onClick={load}>Retry</button>
        </div>
      )}

      {/* Metrics */}
      <div className="metrics-row">
        <div className="metric-card">
          <div className="metric-label">Total Executions</div>
          <div className="metric-value">{loading ? '—' : metrics.total}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Successful</div>
          <div className="metric-value green">{loading ? '—' : metrics.success}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Failed</div>
          <div className="metric-value red">{loading ? '—' : metrics.failed}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Success Rate</div>
          <div className="metric-value blue">{loading ? '—' : `${rate}%`}</div>
        </div>
      </div>

      <div className="dashboard-content-grid">
      {/* Recent Logs */}
      <div className="card dashboard-executions">
        <div className="card-header">
          <div>
            <div className="card-title">Recent Executions</div>
            <div className="card-sub">Last 10 — auto-refreshes every 30s</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => onNavigate?.('logs')}>
            View all →
          </button>
        </div>

        {loading ? (
          <div className="empty-state" style={{ padding: '30px' }}>
            <span className="spinner" />
          </div>
        ) : error ? (
          <div className="empty-state">
            <p className="text-dim">Couldn't load recent executions.</p>
          </div>
        ) : transactions.length === 0 ? (
          <div className="empty-state">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <h3>No executions yet</h3>
            <p>Send a Shopify webhook or use the Test Console to get started.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order / ID</th>
                  <th>Customer</th>
                  <th>Phone</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map(tx => (
                  <tr key={tx.id} onClick={() => onNavigate?.('logs')}>
                    <td className="mono">#{tx.order_number || '—'}</td>
                    <td>{tx.customer_name || '—'}</td>
                    <td className="mono">{tx.phone_number || '—'}</td>
                    <td><span className="text-sm text-dim">{tx.type || 'webhook'}</span></td>
                    <td>{statusBadge(tx.status)}</td>
                    <td className="muted">{timeAgo(tx.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Quick Links */}
      <div className="dashboard-side-stack">
        <div className="card dashboard-side-card">
          <div className="card-title" style={{ marginBottom: 8 }}>Shopify webhook</div>
          <div className="text-sm text-muted" style={{ marginBottom: 10 }}>Add this URL in Shopify → Settings → Notifications → Webhooks</div>
          <WebhookUrlDisplay />
        </div>
        <div className="card dashboard-side-card">
          <div className="card-title" style={{ marginBottom: 8 }}>Automation workspace</div>
          <div className="text-sm text-muted" style={{ marginBottom: 10 }}>Build and manage automation flows with drag-and-drop</div>
          <button className="btn btn-secondary btn-sm w-full" onClick={() => onNavigate?.('flows')}>Open Flow Builder →</button>
        </div>
      </div>
      </div>
    </div>
  );
};

const WebhookUrlDisplay: React.FC = () => {
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/api/webhook/info').then(r => r.json()).then(d => setUrl(d.webhookUrl || '')).catch(() => {});
  }, []);

  const copy = () => {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="webhook-url-box">
      <span className="webhook-url-text">{url || 'Loading...'}</span>
      <button className="btn btn-secondary btn-sm btn-icon" onClick={copy} title="Copy URL">
        {copied
          ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
          : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        }
      </button>
    </div>
  );
};
