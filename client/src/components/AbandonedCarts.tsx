import React, { useState, useEffect } from 'react';

const API = '/api';

interface CartItem {
  id: string;
  title: string;
  quantity: number;
  price: string;
}

interface AbandonedCart {
  id: string;
  checkout_token: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  cart_items: CartItem[];
  cart_total_price: string;
  abandoned_at: string;
  recovered_at: string | null;
  status: string;
  shopify_checkout_url: string;
  created_at: string;
  updated_at: string;
}

interface Stats {
  active_abandoned: number;
  recovered: number;
  total_tracked: number;
  total_value: string;
}

export const AbandonedCarts: React.FC = () => {
  const [carts, setCarts] = useState<AbandonedCart[]>([]);
  const [stats, setStats] = useState<Stats>({ active_abandoned: 0, recovered: 0, total_tracked: 0, total_value: '0' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedCart, setSelectedCart] = useState<AbandonedCart | null>(null);
  const [status, setStatus] = useState<'abandoned' | 'recovered'>('abandoned');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  useEffect(() => {
    loadData();
  }, [status]);

  const syncFromShopify = async () => {
    try {
      setSyncing(true);
      setSyncMsg('');
      setError('');
      const res = await fetch(`${API}/abandoned-carts/sync?limit=250`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync failed');
      setSyncMsg(`Imported ${data.imported} of ${data.total} checkouts from Shopify`);
      await loadData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(''), 5000);
    }
  };

  const loadData = async () => {
    try {
      setLoading(true);
      setError('');
      const [cartsRes, statsRes] = await Promise.all([
        fetch(`${API}/abandoned-carts?status=${status}&limit=50`),
        fetch(`${API}/abandoned-carts/stats`)
      ]);

      if (!cartsRes.ok) throw new Error('Failed to load carts');
      if (!statsRes.ok) throw new Error('Failed to load stats');

      const cartsData = await cartsRes.json();
      const statsData = await statsRes.json();

      setCarts(cartsData.carts || []);
      setStats(statsData);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRecover = async (cartId: string) => {
    try {
      const res = await fetch(`${API}/abandoned-carts/${cartId}/recover`, {
        method: 'POST'
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to mark as recovered');
      }
      await loadData();
      setSelectedCart(null);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const formatDate = (iso: string) => {
    const date = new Date(iso);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  const formatCurrency = (price: string | number) => {
    const num = typeof price === 'string' ? parseFloat(price) : price;
    return `₹${(num || 0).toFixed(2)}`;
  };

  const hoursAgo = (iso: string) => {
    const ms = Date.now() - new Date(iso).getTime();
    const hours = Math.floor(ms / 3600000);
    if (hours < 1) return 'Just now';
    if (hours === 1) return '1 hour ago';
    if (hours < 24) return `${hours} hours ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Abandoned Carts</div>
          <div className="page-sub">Track and recover customer checkout abandonment</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {syncMsg && <span style={{ fontSize: 13, color: 'var(--success)' }}>{syncMsg}</span>}
          <button className="btn btn-primary" onClick={syncFromShopify} disabled={syncing}>
            {syncing ? <span className="spinner" style={{ width: 14, height: 14 }} /> : null}
            {syncing ? 'Syncing…' : 'Sync from Shopify'}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 24 }}>
        <div className="card">
          <div className="metric-label">Active Abandoned</div>
          <div className="metric-value">{stats.active_abandoned}</div>
        </div>
        <div className="card">
          <div className="metric-label">Recovered</div>
          <div className="metric-value">{stats.recovered}</div>
        </div>
        <div className="card">
          <div className="metric-label">Total Tracked</div>
          <div className="metric-value">{stats.total_tracked}</div>
        </div>
        <div className="card">
          <div className="metric-label">Potential Value</div>
          <div className="metric-value">{formatCurrency(stats.total_value)}</div>
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button
            className={`btn btn-sm ${status === 'abandoned' ? 'btn-primary' : ''}`}
            onClick={() => setStatus('abandoned')}
          >
            Active ({stats.active_abandoned})
          </button>
          <button
            className={`btn btn-sm ${status === 'recovered' ? 'btn-primary' : ''}`}
            onClick={() => setStatus('recovered')}
          >
            Recovered ({stats.recovered})
          </button>
        </div>

        {error && <div className="callout error mb-3">{error}</div>}

        {loading ? (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <span className="spinner" />
          </div>
        ) : carts.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
            No {status} carts to display
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Cart Value</th>
                  <th>Items</th>
                  <th>Abandoned</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {carts.map(cart => (
                  <tr key={cart.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedCart(cart)}>
                    <td style={{ fontWeight: 500 }}>{cart.customer_name || 'Unknown'}</td>
                    <td>{cart.customer_email || '-'}</td>
                    <td>{cart.customer_phone || '-'}</td>
                    <td style={{ color: 'var(--success)' }}>{formatCurrency(cart.cart_total_price)}</td>
                    <td>{cart.cart_items?.length || 0}</td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{hoursAgo(cart.abandoned_at)}</td>
                    <td>
                      {status === 'abandoned' && (
                        <button
                          className="btn btn-xs btn-success"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRecover(cart.id);
                          }}
                        >
                          Mark Recovered
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selectedCart && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }} onClick={() => setSelectedCart(null)}>
          <div className="card" style={{ width: 500, maxHeight: '90vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div className="page-title">Abandoned Cart Details</div>
              <button className="btn btn-icon" onClick={() => setSelectedCart(null)}>✕</button>
            </div>

            <div className="form-group">
              <label className="form-label">Customer</label>
              <div className="input" style={{ background: 'var(--bg-subtle)' }}>{selectedCart.customer_name || 'Unknown'}</div>
            </div>

            <div className="form-group">
              <label className="form-label">Email</label>
              <div className="input" style={{ background: 'var(--bg-subtle)' }}>{selectedCart.customer_email || '-'}</div>
            </div>

            <div className="form-group">
              <label className="form-label">Phone</label>
              <div className="input" style={{ background: 'var(--bg-subtle)' }}>{selectedCart.customer_phone || '-'}</div>
            </div>

            <div className="form-group">
              <label className="form-label">Cart Items</label>
              {selectedCart.cart_items && selectedCart.cart_items.length > 0 ? (
                <div style={{ background: 'var(--bg-subtle)', padding: 12, borderRadius: 4 }}>
                  {selectedCart.cart_items.map(item => (
                    <div key={item.id} style={{ paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
                      <div style={{ fontWeight: 500 }}>{item.title}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {item.quantity}x @ {formatCurrency(item.price)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="input" style={{ background: 'var(--bg-subtle)' }}>No items</div>
              )}
            </div>

            <div className="form-group">
              <label className="form-label">Total Value</label>
              <div className="input" style={{ background: 'var(--bg-subtle)', color: 'var(--success)', fontWeight: 500 }}>
                {formatCurrency(selectedCart.cart_total_price)}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Abandoned At</label>
              <div className="input" style={{ background: 'var(--bg-subtle)' }}>{formatDate(selectedCart.abandoned_at)}</div>
            </div>

            {selectedCart.recovered_at && (
              <div className="form-group">
                <label className="form-label">Recovered At</label>
                <div className="input" style={{ background: 'var(--bg-subtle)' }}>{formatDate(selectedCart.recovered_at)}</div>
              </div>
            )}

            {selectedCart.shopify_checkout_url && (
              <div className="form-group">
                <a href={selectedCart.shopify_checkout_url} target="_blank" rel="noopener noreferrer" className="btn btn-primary w-full">
                  View Checkout Link →
                </a>
              </div>
            )}

            {selectedCart.status === 'abandoned' && (
              <button className="btn btn-success w-full" onClick={() => handleRecover(selectedCart.id)}>
                Mark as Recovered
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
