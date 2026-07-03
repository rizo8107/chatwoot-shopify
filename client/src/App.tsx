import React, { useEffect, useState } from 'react';
import { Login } from './components/Login';
import { Dashboard } from './components/Dashboard';
import { FlowBuilder } from './components/FlowBuilder';
import { Logs } from './components/Logs';
import { Settings } from './components/Settings';
import { TestConsole } from './components/TestConsole';
import { Campaigns } from './components/Campaigns';
import { Contacts } from './components/Contacts';
import { AbandonedCarts } from './components/AbandonedCarts';
import { AbandonedCartFlows } from './components/AbandonedCartFlows';

type Tab = 'dashboard' | 'flows' | 'campaigns' | 'contacts' | 'abandoned-carts' | 'abandoned-cart-flows' | 'logs' | 'settings' | 'test';

const NAV = [
  {
    id: 'dashboard' as Tab,
    label: 'Dashboard',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/>
        <rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>
      </svg>
    )
  },
  {
    id: 'flows' as Tab,
    label: 'Flows',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="5" cy="6" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="19" cy="18" r="2"/>
        <path d="M5 8v2a4 4 0 0 0 4 4h2"/><path d="M14 12h2a4 4 0 0 1 4 4v2"/><path d="M21 8V6"/>
      </svg>
    )
  },
  {
    id: 'campaigns' as Tab,
    label: 'Campaigns',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>
      </svg>
    )
  },
  {
    id: 'contacts' as Tab,
    label: 'Contacts',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
    )
  },
  {
    id: 'abandoned-carts' as Tab,
    label: 'Abandoned Carts',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/><path d="M6 6h14"/>
      </svg>
    )
  },
  {
    id: 'abandoned-cart-flows' as Tab,
    label: 'Recovery Flows',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
      </svg>
    )
  },
  {
    id: 'logs' as Tab,
    label: 'Logs',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
        <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
      </svg>
    )
  },
  {
    id: 'test' as Tab,
    label: 'Test Console',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
      </svg>
    )
  },
  {
    id: 'settings' as Tab,
    label: 'Settings',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    )
  }
];

const App: React.FC = () => {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [auth, setAuth] = useState<{ loading: boolean; required: boolean; ok: boolean }>({ loading: true, required: false, ok: false });

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => setAuth({ loading: false, required: !!d.authRequired, ok: !!d.authenticated }))
      .catch(() => setAuth({ loading: false, required: false, ok: false }));
  }, []);

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setAuth(a => ({ ...a, ok: false }));
  };

  const renderContent = () => {
    switch (tab) {
      case 'dashboard': return <Dashboard onNavigate={setTab} />;
      case 'flows': return <FlowBuilder />;
      case 'campaigns': return <Campaigns />;
      case 'contacts': return <Contacts />;
      case 'abandoned-carts': return <AbandonedCarts />;
      case 'abandoned-cart-flows': return <AbandonedCartFlows />;
      case 'logs': return <Logs />;
      case 'test': return <TestConsole />;
      case 'settings': return <Settings />;
    }
  };

  if (auth.loading) {
    return <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span className="spinner" /></div>;
  }
  if (auth.required && !auth.ok) {
    return <Login onSuccess={() => setAuth(a => ({ ...a, ok: true }))} />;
  }

  // FlowBuilder handles its own full-screen layout
  if (tab === 'flows') {
    return (
      <div className="app">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <div className="sidebar-brand-name">Stomatal Farms</div>
            <div className="sidebar-brand-sub">Chatwoot Automation</div>
          </div>
          <nav className="sidebar-nav">
            {NAV.map(item => (
              <button key={item.id} className={`nav-item${tab === item.id ? ' active' : ''}`} onClick={() => setTab(item.id)}>
                {item.icon}{item.label}
              </button>
            ))}
          </nav>
          <div className="sidebar-footer">
            {auth.required && (
              <button className="nav-item" onClick={logout} style={{ width: '100%', marginBottom: 8 }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                Log out
              </button>
            )}
            v2.0.0
          </div>
        </aside>
        <div className="main" style={{ padding: 0, overflow: 'hidden' }}>
          <FlowBuilder />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-brand-name">Stomatal Farms</div>
          <div className="sidebar-brand-sub">Chatwoot Automation</div>
        </div>
        <nav className="sidebar-nav">
          {NAV.map(item => (
            <button key={item.id} className={`nav-item${tab === item.id ? ' active' : ''}`} onClick={() => setTab(item.id)}>
              {item.icon}{item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          {auth.required && (
            <button className="nav-item" onClick={logout} style={{ width: '100%', marginBottom: 8 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
              Log out
            </button>
          )}
          v2.0.0
        </div>
      </aside>
      <main className="main">
        {renderContent()}
      </main>
    </div>
  );
};

export default App;
