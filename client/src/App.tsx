import React, { useEffect, useRef, useState } from 'react';
import { Login } from './components/Login';
import { Dashboard } from './components/Dashboard';
import { FlowBuilder } from './components/FlowBuilder';
import { Logs } from './components/Logs';
import { Settings } from './components/Settings';
import { TestConsole } from './components/TestConsole';
import { Campaigns } from './components/Campaigns';
import { DripCampaigns } from './components/DripCampaigns';
import { Contacts } from './components/Contacts';
import { AbandonedCarts } from './components/AbandonedCarts';
import { AbandonedCartFlows } from './components/AbandonedCartFlows';

type Tab = 'dashboard' | 'flows' | 'campaigns' | 'drip-campaigns' | 'contacts' | 'abandoned-carts' | 'abandoned-cart-flows' | 'logs' | 'settings' | 'test';
type NavSection = 'Workspace' | 'Recovery' | 'System';

const ICONS: Record<Tab, React.ReactNode> = {
  dashboard: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="4" rx="1"/><rect x="14" y="11" width="7" height="10" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></>,
  flows: <><circle cx="5" cy="6" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="18" r="2"/><path d="M6.5 7.5 10.5 11M13.5 13.5l4 3"/></>,
  campaigns: <><path d="M3 11l18-5v12L3 14v-3z"/><path d="M8 15.3V19a2 2 0 0 0 2 2h1"/></>,
  'drip-campaigns': <><path d="M5 4h14M5 12h14M5 20h14"/><circle cx="8" cy="4" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="20" r="2"/></>,
  contacts: <><circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M16 5a4 4 0 0 1 0 7M19 15a6 6 0 0 1 3 6"/></>,
  'abandoned-carts': <><circle cx="9" cy="20" r="1"/><circle cx="19" cy="20" r="1"/><path d="M3 4h2l2.4 10.4A2 2 0 0 0 9.3 16H18a2 2 0 0 0 1.9-1.4L22 7H6"/></>,
  'abandoned-cart-flows': <><path d="M20 7h-6V1"/><path d="M4 17h6v6"/><path d="M5.1 9A8 8 0 0 1 19 5l1 2M4 17l1 2a8 8 0 0 0 13.9-4"/></>,
  logs: <><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h8M9 17h8"/></>,
  test: <><path d="m4 17 6-6-6-6M12 19h8"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21h-4v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1-2.8-2.8.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3v-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1 2.8-2.8.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3h4v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1 2.8 2.8-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1h.2v4h-.2a1.7 1.7 0 0 0-1.4 1z"/></>,
};

const NAV: { id: Tab; label: string; section: NavSection }[] = [
  { id: 'dashboard', label: 'Overview', section: 'Workspace' },
  { id: 'flows', label: 'Automations', section: 'Workspace' },
  { id: 'campaigns', label: 'Campaigns', section: 'Workspace' },
  { id: 'drip-campaigns', label: 'Drip campaigns', section: 'Workspace' },
  { id: 'contacts', label: 'Contacts', section: 'Workspace' },
  { id: 'abandoned-carts', label: 'Abandoned carts', section: 'Recovery' },
  { id: 'abandoned-cart-flows', label: 'Recovery flows', section: 'Recovery' },
  { id: 'logs', label: 'Execution logs', section: 'System' },
  { id: 'test', label: 'Test console', section: 'System' },
  { id: 'settings', label: 'Settings', section: 'System' },
];

const SECTION_ORDER: NavSection[] = ['Workspace', 'Recovery', 'System'];

function NavIcon({ tab }: { tab: Tab }) {
  return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[tab]}</svg>;
}

function AppShell({ tab, setTab, authRequired, logout, children }: {
  tab: Tab;
  setTab: (tab: Tab) => void;
  authRequired: boolean;
  logout: () => void;
  children: React.ReactNode;
}) {
  const current = NAV.find(item => item.id === tab);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  const openSearchResult = () => {
    const result = NAV.find(item => item.label.toLowerCase().includes(search.trim().toLowerCase()));
    if (result) {
      setTab(result.id);
      setSearch('');
      searchRef.current?.blur();
    }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark" aria-hidden="true">S</div>
          <div>
            <div className="sidebar-brand-name">Stomatal</div>
            <div className="sidebar-brand-sub">Commerce operations</div>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Primary navigation">
          {SECTION_ORDER.map(section => (
            <div className="nav-section" key={section}>
              <div className="sidebar-section-label">{section}</div>
              {NAV.filter(item => item.section === section).map(item => (
                <button
                  key={item.id}
                  className={`nav-item${tab === item.id ? ' active' : ''}`}
                  onClick={() => setTab(item.id)}
                  aria-current={tab === item.id ? 'page' : undefined}
                >
                  <NavIcon tab={item.id} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="workspace-profile">
            <div className="profile-avatar">SF</div>
            <div className="profile-copy">
              <strong>Stomatal Farms</strong>
              <span>Production workspace</span>
            </div>
          </div>
          {authRequired && (
            <button className="logout-button" onClick={logout}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
              Sign out
            </button>
          )}
        </div>
      </aside>

      <section className="workspace">
        <header className="workspace-header">
          <div className="workspace-context">
            <div className="workspace-eyebrow">Stomatal Farms / {current?.section}</div>
            <div className="workspace-title">{current?.label}</div>
          </div>
          <label className="workspace-command">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
            <input
              ref={searchRef}
              aria-label="Search workspace"
              placeholder="Search workspace..."
              value={search}
              onChange={event => setSearch(event.target.value)}
              onKeyDown={event => event.key === 'Enter' && openSearchResult()}
            />
            <kbd>Ctrl K</kbd>
          </label>
          <div className="workspace-actions">
            <button className="header-action" onClick={() => setTab('test')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m5 3 14 9-14 9V3z"/></svg>
              Run test
            </button>
            <span className="environment-pill"><span /> Live</span>
            <div className="header-avatar">SF</div>
          </div>
        </header>
        <main className={`main${tab === 'flows' ? ' flow-route' : ''}`}>{children}</main>
      </section>
    </div>
  );
}

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
      case 'drip-campaigns': return <DripCampaigns />;
      case 'contacts': return <Contacts />;
      case 'abandoned-carts': return <AbandonedCarts />;
      case 'abandoned-cart-flows': return <AbandonedCartFlows />;
      case 'logs': return <Logs />;
      case 'test': return <TestConsole />;
      case 'settings': return <Settings />;
    }
  };

  if (auth.loading) return <div className="app-loading"><span className="spinner" /><span>Loading workspace</span></div>;
  if (auth.required && !auth.ok) return <Login onSuccess={() => setAuth(a => ({ ...a, ok: true }))} />;

  return (
    <AppShell tab={tab} setTab={setTab} authRequired={auth.required} logout={logout}>
      {renderContent()}
    </AppShell>
  );
};

export default App;
