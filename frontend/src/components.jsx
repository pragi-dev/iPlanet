import { NavLink, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Smartphone, PlusCircle, Ticket, ShieldCheck, UserRound, LogOut, Bell, Search, ChevronRight, ArrowUpRight } from 'lucide-react';

export function Badge({ children }) { return <span className={`badge badge-${String(children).toLowerCase().replaceAll(' ', '-').replaceAll('/', '')}`}>{children}</span>; }

export function Sidebar() {
  const navigate = useNavigate();
  const links = [['/dashboard', LayoutDashboard, 'Dashboard'], ['/devices', Smartphone, 'My Devices'], ['/unassigned-devices', UserRound, 'Unassigned Devices'], ['/request', PlusCircle, 'Raise Request'], ['/tickets', Ticket, 'My Tickets'], ['/coverage', ShieldCheck, 'Warranty & AMC'], ['/profile', UserRound, 'Profile']];
  return <aside className="sidebar"><div className="brand"><div className="brand-mark">i</div><div><strong>iPlanet</strong><small>Customer care</small></div></div><nav>{links.map(([to, Icon, label]) => <NavLink key={to} to={to} className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}><Icon size={17} />{label}</NavLink>)}</nav><div className="sidebar-foot"><div className="secure"><ShieldCheck size={16} /><span>Secure workspace<small>Local demo environment</small></span></div><button className="logout" onClick={() => { localStorage.clear(); navigate('/'); }}><LogOut size={16} />Sign out</button></div></aside>;
}

export function Header({ title, eyebrow }) { return <header className="topbar"><div><p className="eyebrow">{eyebrow || 'Customer self-care portal'}</p><h1>{title}</h1></div><div className="top-actions"><button className="icon-button" title="Notifications"><Bell size={18} /><span className="notification-dot" /></button><div className="avatar">AK</div><div className="profile-label"><strong>Arun Kumar</strong><span>IT Admin</span></div></div></header>; }
export function Shell({ children, title, eyebrow }) { return <div className="app-shell"><Sidebar /><main className="main"><Header title={title} eyebrow={eyebrow} />{children}</main></div>; }
export function PageTitle({ title, description, action }) { return <div className="page-title"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>; }
export function Empty({ message }) { return <div className="empty"><Search size={20} /><p>{message}</p></div>; }
export function RowLink({ children, to }) { return <NavLink className="row-link" to={to}>{children}<ChevronRight size={16} /></NavLink>; }
export function Metric({ label, value, note, accent }) { return <div className="metric"><div className={`metric-icon ${accent || ''}`}><ArrowUpRight size={16} /></div><span>{label}</span><strong>{value}</strong><small>{note}</small></div>; }
