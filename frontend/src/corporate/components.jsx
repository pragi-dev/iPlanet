import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Smartphone, PlusCircle, Ticket, ShieldCheck, UserRound, LogOut, Bell, Search, ChevronRight, ArrowUpRight, UserRoundCheck, BellRing, Building2 } from 'lucide-react';
import { getNotificationUnreadCount } from './api';

export function Badge({ children }) { return <span className={`badge badge-${String(children).toLowerCase().replaceAll(' ', '-').replaceAll('/', '')}`}>{children}</span>; }
export function Sidebar() {
  const navigate = useNavigate(); const [unread, setUnread] = useState(0);
  const links = [['/corporate/dashboard', LayoutDashboard, 'Dashboard'], ['/corporate/devices', Smartphone, 'My Devices'], ['/corporate/unassigned-devices', UserRoundCheck, 'Unassigned Devices'], ['/corporate/raise-request', PlusCircle, 'Raise Request'], ['/corporate/service-requests', Ticket, 'My Tickets'], ['/corporate/warranty', ShieldCheck, 'Warranty & AMC'], ['/corporate/google-business', Building2, 'Google Reviews'], ['/corporate/notifications', BellRing, 'Notifications'], ['/corporate/profile', UserRound, 'Profile']];
  useEffect(() => { getNotificationUnreadCount().then(result => setUnread(result.count)).catch(() => setUnread(0)); }, []);
  return <aside className="sidebar"><div className="brand"><div className="brand-mark">i</div><div><strong>iPlanet</strong><small>Customer care</small></div></div><nav>{links.map(([to, Icon, label]) => <NavLink key={to} to={to} className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}><Icon size={17} />{label}{label === 'Notifications' && unread > 0 && <span className="nav-count">{unread}</span>}</NavLink>)}</nav><div className="sidebar-foot"><div className="secure"><ShieldCheck size={16} /><span>Secure workspace<small>Customer portal</small></span></div><button className="logout" onClick={() => { localStorage.clear(); navigate('/login'); }}><LogOut size={16} />Sign out</button></div></aside>;
}
export function Header({ title, eyebrow }) { const navigate = useNavigate(); const [unread, setUnread] = useState(0); useEffect(() => { getNotificationUnreadCount().then(result => setUnread(result.count)).catch(() => setUnread(0)); }, [title]); return <header className="topbar"><div><p className="eyebrow">{eyebrow || 'Customer self-care portal'}</p><h1>{title}</h1></div><div className="top-actions"><button className="icon-button" title="Notifications" onClick={() => navigate('/corporate/notifications')}><Bell size={18} />{unread > 0 && <span className="notification-count">{unread}</span>}</button><div className="avatar">AK</div><div className="profile-label"><strong>Arun Kumar</strong><span>IT Admin</span></div></div></header>; }
export function Shell({ children, title, eyebrow }) { return <div className="app-shell"><Sidebar /><main className="main"><Header title={title} eyebrow={eyebrow} />{children}</main></div>; }
// Route titles belong to the shell header. PageTitle retains the page-specific
// description and actions, and only renders a title for a genuinely distinct
// piece of content (such as a ticket identifier).
export function PageTitle({ title, description, action, showTitle = false }) { return <div className="page-title"><div>{showTitle && <h2>{title}</h2>}{description && <p>{description}</p>}</div>{action}</div>; }
export function Empty({ message }) { return <div className="empty"><Search size={20} /><p>{message}</p></div>; }
export function RowLink({ children, to }) { return <NavLink className="row-link" to={to}>{children}<ChevronRight size={16} /></NavLink>; }
export function Metric({ label, value, note, accent }) { return <div className="metric"><div className={`metric-icon ${accent || ''}`}><ArrowUpRight size={16} /></div><span>{label}</span><strong>{value}</strong><small>{note}</small></div>; }
