import { NavLink } from 'react-router-dom';
import { Search, ArrowUpRight } from 'lucide-react';
export function Badge({ children }) { return <span className={`badge badge-${String(children).toLowerCase().replaceAll(' ', '-').replaceAll('/', '')}`}>{children}</span>; }
export function Empty({ message }) { return <div className="empty"><Search size={20} /><p>{message}</p></div>; }
export function Metric({ label, value, note, accent }) { return <div className="metric"><div className={`metric-icon ${accent || ''}`}><ArrowUpRight size={16} /></div><span>{label}</span><strong>{value}</strong><small>{note}</small></div>; }
export function PageTitle({ title, description, action }) { return <div className="page-title"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>; }
export function ShellLink({ to, children }) { return <NavLink to={to}>{children}</NavLink>; }
