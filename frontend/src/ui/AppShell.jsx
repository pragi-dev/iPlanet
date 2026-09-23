import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Bell, ChevronDown, ChevronRight, LogOut, Menu, Search, Sparkles, UserRound, X } from 'lucide-react';
import { Avatar, IconButton } from './primitives';
import { readSessionUser } from './format';

// Lets any part of the corporate portal open the AI Support drawer.
export const AIAssistantContext = createContext({ available: false, open: () => {} });
export const useAIAssistant = () => useContext(AIAssistantContext);

export const NOTIFICATIONS_CHANGED = 'iplanet:notifications-changed';
export const notifyNotificationsChanged = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));

function useUnreadCount(fetchUnread) {
  const location = useLocation();
  const [count, setCount] = useState(0);
  const refresh = useCallback(() => {
    fetchUnread().then(result => setCount(Number(result?.count) || 0)).catch(() => setCount(0));
  }, [fetchUnread]);
  useEffect(() => { refresh(); }, [refresh, location.pathname]);
  useEffect(() => {
    window.addEventListener(NOTIFICATIONS_CHANGED, refresh);
    const interval = window.setInterval(refresh, 60000);
    return () => { window.removeEventListener(NOTIFICATIONS_CHANGED, refresh); window.clearInterval(interval); };
  }, [refresh]);
  return count;
}

function signOut(navigate) {
  localStorage.clear();
  navigate('/login', { replace: true });
}

function Sidebar({ config, unread, onNavigate, aiOpen }) {
  return <div className="sidebar-inner">
    <Link to={config.home} className="brand" onClick={onNavigate}>
      <span className="brand-mark" aria-hidden="true">i</span>
      <span className="brand-text">
        <strong>iPlanetCare</strong>
        <small>{config.portalName}</small>
      </span>
    </Link>
    <nav className="sidebar-nav" aria-label={`${config.portalName} navigation`}>
      {config.groups.map(group => <div className="nav-group" key={group.label}>
        <p className="nav-group-label">{group.label}</p>
        <ul>
          {group.items.map(item => {
            const Icon = item.icon;
            const badge = item.badge === 'unread' && unread > 0 ? unread : null;
            if (item.action === 'ai') return <li key={item.label}><button type="button" className="nav-item" title={item.label} onClick={() => { onNavigate?.(); aiOpen(); }}><Icon size={18} aria-hidden="true" /><span className="nav-label">{item.label}</span></button></li>;
            return <li key={item.to}>
              <NavLink to={item.to} end={item.end} title={item.label} onClick={onNavigate} className={({ isActive }) => `nav-item ${isActive || item.match?.some(prefix => window.location.pathname.startsWith(prefix)) ? 'nav-item-active' : ''}`}>
                <Icon size={18} aria-hidden="true" />
                <span className="nav-label">{item.label}</span>
                {badge && <span className="nav-badge" aria-label={`${badge} unread`}>{badge > 99 ? '99+' : badge}</span>}
              </NavLink>
            </li>;
          })}
        </ul>
      </div>)}
    </nav>
    <div className="sidebar-footer">
      <p className="sidebar-product">Service &amp; Self-Care Platform</p>
    </div>
  </div>;
}

function UserMenu({ user, config }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onClick = event => { if (!ref.current?.contains(event.target)) setOpen(false); };
    const onKey = event => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return <div className="user-menu" ref={ref}>
    <button type="button" className="user-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Avatar name={user.name || user.email} size={32} />
      <span className="user-text">
        <strong>{user.name || user.email || 'Signed in'}</strong>
        <small>{config.roleLabel}</small>
      </span>
      <ChevronDown size={15} aria-hidden="true" className="user-caret" />
    </button>
    {open && <div className="menu" role="menu">
      <div className="menu-header">
        <strong>{user.name || 'Signed in'}</strong>
        {user.email && <span>{user.email}</span>}
        <span className="role-chip">{config.roleLabel}</span>
      </div>
      <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); navigate(config.accountRoute); }}><UserRound size={16} aria-hidden="true" />{config.accountLabel}</button>
      <button type="button" role="menuitem" className="menu-item" onClick={() => signOut(navigate)}><LogOut size={16} aria-hidden="true" />Sign out</button>
    </div>}
  </div>;
}

function HeaderSearch({ config }) {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  if (!config.search) return null;
  return <form className="header-search" role="search" onSubmit={event => { event.preventDefault(); const query = value.trim(); navigate(query ? `${config.search.route}?search=${encodeURIComponent(query)}` : config.search.route); setValue(''); }}>
    <Search size={16} aria-hidden="true" />
    <label className="sr-only" htmlFor="global-search">{config.search.placeholder}</label>
    <input id="global-search" type="search" value={value} onChange={event => setValue(event.target.value)} placeholder={config.search.placeholder} />
  </form>;
}

export function AppShell({ config, title, crumbs, children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const user = readSessionUser();
  const unread = useUnreadCount(config.fetchUnread);
  const ai = useAIAssistant();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);
  useEffect(() => { document.title = title ? `${title} · iPlanetCare` : 'iPlanetCare'; }, [title]);
  useEffect(() => {
    if (!mobileOpen) return undefined;
    const onKey = event => { if (event.key === 'Escape') setMobileOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  const trail = crumbs || [{ label: title }];

  return <div className={`app-shell portal-${config.key}`}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`} aria-label="Primary">
      <Sidebar config={config} unread={unread} onNavigate={() => setMobileOpen(false)} aiOpen={ai.open} />
      <button type="button" className="icon-button sidebar-close" aria-label="Close navigation" onClick={() => setMobileOpen(false)}><X size={18} /></button>
    </aside>
    {mobileOpen && <div className="sidebar-scrim" onClick={() => setMobileOpen(false)} aria-hidden="true" />}
    <div className="shell-main">
      <header className="topbar">
        <div className="topbar-left">
          <IconButton className="menu-toggle" label="Open navigation" icon={Menu} onClick={() => setMobileOpen(true)} />
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <ol>
              <li><Link to={config.home}>{config.portalName}</Link></li>
              {trail.map((crumb, index) => <li key={`${crumb.label}-${index}`}>
                <ChevronRight size={14} aria-hidden="true" />
                {crumb.to && index < trail.length - 1 ? <Link to={crumb.to}>{crumb.label}</Link> : <span aria-current={index === trail.length - 1 ? 'page' : undefined}>{crumb.label}</span>}
              </li>)}
            </ol>
          </nav>
        </div>
        <div className="topbar-right">
          <HeaderSearch config={config} />
          {ai.available && <button type="button" className="btn btn-ghost ai-trigger" onClick={ai.open}><Sparkles size={16} aria-hidden="true" /><span>AI Support</span></button>}
          <IconButton label="Notifications" icon={Bell} badge={unread} onClick={() => navigate(config.notificationsRoute)} />
          <span className="topbar-divider" aria-hidden="true" />
          <UserMenu user={user} config={config} />
        </div>
      </header>
      <main className="content" id="main-content" tabIndex={-1}>
        <div className="content-inner">{children}</div>
      </main>
    </div>
  </div>;
}
