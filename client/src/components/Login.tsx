import React, { useState } from 'react';

const API = '/api';

type View = 'signin' | 'forgot' | 'reset';

export const Login: React.FC<{ onSuccess: () => void }> = ({ onSuccess }) => {
  const [view, setView] = useState<View>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Login failed');
      onSuccess();
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  const requestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch(`${API}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to send reset code');
      setNotice(`If ${email} has an account, a reset code was sent to it.`);
      setView('reset');
    } catch (err: any) {
      setError(err.message);
    }
    setBusy(false);
  };

  const submitReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch(`${API}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code, newPassword })
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to reset password');
      setNotice('Password updated. Sign in with your new password.');
      setPassword('');
      setCode('');
      setNewPassword('');
      setView('signin');
    } catch (err: any) {
      setError(err.message);
    }
    setBusy(false);
  };

  const switchView = (v: View) => {
    setView(v);
    setError('');
    setNotice('');
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        background:
          'radial-gradient(ellipse 900px 600px at 50% -10%, rgba(31, 224, 138, 0.08), transparent 60%), var(--bg)'
      }}
    >
      <div className="card" style={{ width: '100%', maxWidth: 380, padding: 32 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div
            style={{
              width: 44,
              height: 44,
              margin: '0 auto 16px',
              borderRadius: 12,
              background: 'var(--accent-gradient)',
              boxShadow: '0 6px 20px var(--accent-glow)'
            }}
          />
          <div className="page-title" style={{ fontSize: 20 }}>Stomatal Farms</div>
          <div className="page-sub">
            {view === 'signin' && 'Chatwoot Automation — sign in to continue'}
            {view === 'forgot' && 'Reset your password'}
            {view === 'reset' && 'Enter the code we emailed you'}
          </div>
        </div>

        {view === 'signin' && (
          <form onSubmit={signIn}>
            <div className="form-group">
              <label className="form-label">Email</label>
              <input
                className="input"
                type="email"
                value={email}
                autoFocus
                onChange={e => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </div>

            <div className="form-group" style={{ marginBottom: 12 }}>
              <label className="form-label">Password</label>
              <input
                className="input"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>

            <div style={{ textAlign: 'right', marginBottom: 20 }}>
              <button
                type="button"
                className="btn-ghost"
                style={{ background: 'none', border: 'none', padding: 0, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}
                onClick={() => switchView('forgot')}
              >
                Forgot password?
              </button>
            </div>

            {error && <div className="callout error">{error}</div>}

            <button className="btn btn-primary w-full" type="submit" disabled={busy} style={{ justifyContent: 'center' }}>
              {busy ? <span className="spinner" style={{ width: 14, height: 14 }} /> : null}
              {busy ? 'Signing in…' : 'Sign in to Dashboard'}
            </button>
          </form>
        )}

        {view === 'forgot' && (
          <form onSubmit={requestReset}>
            <div className="form-group" style={{ marginBottom: 20 }}>
              <label className="form-label">Email</label>
              <input
                className="input"
                type="email"
                value={email}
                autoFocus
                onChange={e => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
              <div className="form-hint">We'll email you a 6-digit reset code.</div>
            </div>

            {error && <div className="callout error">{error}</div>}

            <button className="btn btn-primary w-full" type="submit" disabled={busy} style={{ justifyContent: 'center' }}>
              {busy ? <span className="spinner" style={{ width: 14, height: 14 }} /> : null}
              {busy ? 'Sending…' : 'Send reset code'}
            </button>

            <button
              type="button"
              className="btn btn-secondary w-full"
              style={{ justifyContent: 'center', marginTop: 8 }}
              onClick={() => switchView('signin')}
            >
              Back to sign in
            </button>
          </form>
        )}

        {view === 'reset' && (
          <form onSubmit={submitReset}>
            {notice && <div className="callout success">{notice}</div>}

            <div className="form-group">
              <label className="form-label">Reset code</label>
              <input
                className="input"
                value={code}
                autoFocus
                onChange={e => setCode(e.target.value)}
                placeholder="123456"
                maxLength={6}
              />
            </div>

            <div className="form-group" style={{ marginBottom: 20 }}>
              <label className="form-label">New password</label>
              <input
                className="input"
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>

            {error && <div className="callout error">{error}</div>}

            <button className="btn btn-primary w-full" type="submit" disabled={busy} style={{ justifyContent: 'center' }}>
              {busy ? <span className="spinner" style={{ width: 14, height: 14 }} /> : null}
              {busy ? 'Resetting…' : 'Reset password'}
            </button>

            <button
              type="button"
              className="btn btn-secondary w-full"
              style={{ justifyContent: 'center', marginTop: 8 }}
              onClick={() => switchView('signin')}
            >
              Back to sign in
            </button>
          </form>
        )}

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)', textAlign: 'center' }}>
          <span className="text-dim text-sm">Secured by InsForge · session expires after 7 days</span>
        </div>
      </div>
    </div>
  );
};
