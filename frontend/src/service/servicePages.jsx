import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Building2, ChevronRight, ClipboardList, KeyRound, LogOut, Mail, MapPin, ScanLine, ShieldAlert, Ticket, UserCheck, UsersRound, Wrench } from 'lucide-react';
import { ServiceShell } from './components';
import { engineerFilterOptions, filterEngineers } from './engineerFilters';
import { getEngineers, getServiceCentres, getServiceDashboard, getServiceTickets } from './api';
import {
  AllClear, AttentionList, Avatar, Badge, Button, Card, Drawer, EmptyState, ErrorState, FilterBar, FilterSelect, InfoList, KPI, KPIGrid, PageHeader, PageSkeleton,
  SearchInput, SectionHeader, TableCard, formatDateTime, formatRelative, friendlyError, greeting, idOf, isActiveTicket, pluralize, readSessionUser, recurringIssues,
  riskLabel, riskTone, slaLabel, slaRisk, todayLabel, useAsync,
} from '../ui';

export { ServiceShell };

const riskStates = ['At Risk', 'SLA Breached', 'Escalated'];
const isActive = isActiveTicket;
const engineerOf = ticket => idOf(ticket.assignedEngineerId);
const toneRank = { critical: 0, warning: 1, info: 2, neutral: 3 };
const companyOf = ticket => ticket.companyId?.name || ticket.customerId?.company || 'Corporate';

// Highest-priority operational items, one row per ticket/device/engineer,
// each with the action that moves it forward.
function operationsAttention(tickets, engineers) {
  const items = [];
  const listed = new Set();
  tickets.filter(slaRisk).sort((a, b) => new Date(a.slaTargetAt) - new Date(b.slaTargetAt)).forEach(ticket => {
    const risk = slaRisk(ticket);
    listed.add(ticket._id);
    items.push({ key: `sla-${ticket._id}`, tone: riskTone(risk), kicker: riskLabel(risk), title: `${ticket.ticketId} · ${ticket.issueType || 'Service'}`,
      detail: [companyOf(ticket), ticket.location, ticket.slaTargetAt ? `Target ${formatDateTime(ticket.slaTargetAt)}` : null, ticket.assignedEngineer || 'Unassigned'].filter(Boolean).join(' · '),
      action: ticket.assignedEngineerId ? { label: 'Open ticket', to: `/service/tickets/${ticket._id}` } : { label: 'Assign engineer', to: `/service/tickets/${ticket._id}?assign=1` } });
  });
  tickets.filter(ticket => ticket.status === 'Open' && !ticket.assignedEngineerId && !listed.has(ticket._id)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).forEach(ticket => {
    items.push({ key: `un-${ticket._id}`, tone: 'warning', kicker: 'Unassigned', title: `${ticket.ticketId} · ${ticket.issueType || 'Service'}`, detail: [companyOf(ticket), ticket.location, `raised ${formatRelative(ticket.createdAt)}`].filter(Boolean).join(' · '), action: { label: 'Assign engineer', to: `/service/tickets/${ticket._id}?assign=1` } });
  });
  tickets.filter(ticket => ticket.status === 'Waiting for Parts' && !listed.has(ticket._id)).forEach(ticket => {
    items.push({ key: `wp-${ticket._id}`, tone: 'info', kicker: 'Waiting for parts', title: `${ticket.ticketId} · ${ticket.issueType || 'Service'}`, detail: [companyOf(ticket), ticket.assignedEngineer, `paused ${formatRelative(ticket.updatedAt)}`].filter(Boolean).join(' · '), action: { label: 'Open ticket', to: `/service/tickets/${ticket._id}` } });
  });
  tickets.filter(ticket => ticket.status === 'Completed').forEach(ticket => {
    items.push({ key: `done-${ticket._id}`, tone: 'info', kicker: 'Ready to close', title: `${ticket.ticketId} · ${ticket.issueType || 'Service'}`, detail: [companyOf(ticket), ticket.assignedEngineer, `completed ${formatRelative(ticket.updatedAt)}`].filter(Boolean).join(' · '), action: { label: 'Review & close', to: `/service/tickets/${ticket._id}` } });
  });
  recurringIssues(tickets).slice(0, 3).forEach(group => {
    const serial = group.device?.serialNumber;
    items.push({ key: `rec-${group.deviceId}-${group.issueType}`, tone: 'warning', kicker: 'Recurring issue', title: [group.device?.model || 'Device', serial].filter(Boolean).join(' · '), detail: `${pluralize(group.count, `${group.issueType} request`)} in the last 90 days · ${companyOf(group.tickets[0])}`, action: { label: 'View tickets', to: `/service/tickets?search=${encodeURIComponent(serial || group.issueType)}` } });
  });
  // Workload imbalance: an engineer carrying at least twice the team average (and 3+ tickets).
  const loads = engineers.map(engineer => engineer.assignedTicketCount || 0);
  const average = loads.length ? loads.reduce((sum, value) => sum + value, 0) / loads.length : 0;
  engineers.filter(engineer => (engineer.assignedTicketCount || 0) >= 3 && (engineer.assignedTicketCount || 0) >= average * 2).forEach(engineer => {
    items.push({ key: `load-${engineer._id}`, tone: 'warning', kicker: 'Workload', title: `${engineer.name} has ${engineer.assignedTicketCount} open tickets`, detail: `Team average ${average.toFixed(1)}${engineer.location ? ` · ${engineer.location}` : ''}`, action: { label: 'View engineer', to: `/service/engineers?engineer=${engineer._id}` } });
  });
  return items.sort((a, b) => toneRank[a.tone] - toneRank[b.tone]);
}

// Engineers and open work grouped by service location.
function capacityByLocation(engineers, tickets) {
  const rows = new Map();
  const row = name => { if (!rows.has(name)) rows.set(name, { name, engineers: [], openTickets: 0, unassigned: 0 }); return rows.get(name); };
  engineers.forEach(engineer => row(engineer.location || 'No location').engineers.push(engineer));
  tickets.filter(isActive).forEach(ticket => { const entry = row(ticket.location || 'No location'); entry.openTickets += 1; if (!ticket.assignedEngineerId) entry.unassigned += 1; });
  return [...rows.values()].sort((a, b) => b.openTickets - a.openTickets || a.name.localeCompare(b.name));
}

const ATTENTION_LIMIT = 8;

export function ServiceDashboard() {
  const user = readSessionUser();
  const [showAll, setShowAll] = useState(false);
  const state = useAsync(() => Promise.all([getServiceDashboard(), getServiceTickets(), getEngineers()]).then(([dashboard, tickets, engineers]) => ({ ...dashboard, tickets, engineers })), []);
  if (state.loading && !state.data) return <ServiceShell title="Overview"><PageSkeleton kpis={4} /></ServiceShell>;
  if (state.error) return <ServiceShell title="Overview"><PageHeader title="Service operations" /><div className="card"><ErrorState title="Unable to load service operations" message={friendlyError(state.error)} onRetry={state.reload} /></div></ServiceShell>;

  const { tickets, engineers } = state.data;
  const active = tickets.filter(isActive);
  const risky = active.filter(slaRisk);
  const breached = risky.filter(ticket => ['breached', 'escalated'].includes(slaRisk(ticket))).length;
  const unassigned = active.filter(ticket => !ticket.assignedEngineerId).length;
  const waitingParts = active.filter(ticket => ticket.status === 'Waiting for Parts').length;
  const inProgress = active.filter(ticket => ticket.status === 'In Progress').length;
  const attention = operationsAttention(tickets, engineers);
  const capacity = capacityByLocation(engineers, tickets);
  const available = engineers.filter(engineer => engineer.status === 'Available').length;
  const recentActivity = [...tickets].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)).slice(0, 7);

  return <ServiceShell title="Overview">
    <div className="dashboard-intro">
      <div className="page-header-text">
        <p className="eyebrow">{greeting()}{user.name ? `, ${user.name.split(' ')[0]}` : ''} · {todayLabel()}</p>
        <h1 className="page-title">Service operations</h1>
        <p className="page-description">{risky.length ? `${pluralize(risky.length, 'ticket')} at SLA risk${unassigned ? ` and ${unassigned} waiting for an engineer` : ''}.` : unassigned ? `${pluralize(unassigned, 'ticket')} waiting for an engineer. No SLA risks.` : 'All active tickets are assigned and within SLA.'}</p>
      </div>
      <div className="page-actions"><Button icon={ScanLine} to="/service/device-enrollment">Enroll device</Button><Button variant="primary" icon={ClipboardList} to="/service/tickets">Open ticket queue</Button></div>
    </div>

    <section className="ops-strip" aria-label="Operations summary">
      <Link className="ops-stat" to="/service/tickets"><strong>{active.length}</strong><span>Active</span><small>{inProgress} in progress</small></Link>
      <Link className={`ops-stat ${breached ? 'ops-stat-critical' : risky.length ? 'ops-stat-warning' : ''}`} to="/service/tickets?slaStatus=At%20Risk"><strong>{risky.length}</strong><span>SLA risk</span><small>{breached ? `${breached} breached or escalated` : 'None breached'}</small></Link>
      <Link className={`ops-stat ${unassigned ? 'ops-stat-warning' : ''}`} to="/service/tickets?status=Open&assignment=Unassigned"><strong>{unassigned}</strong><span>Unassigned</span><small>{available} engineer{available === 1 ? '' : 's'} available</small></Link>
      <Link className="ops-stat" to="/service/tickets?status=Waiting%20for%20Parts"><strong>{waitingParts}</strong><span>Waiting for parts</span><small>Repairs paused</small></Link>
    </section>

    <section className="page-section" aria-labelledby="ops-attention">
      <SectionHeader id="ops-attention" title="Needs attention" description={attention.length ? `${pluralize(attention.length, 'item')}, most urgent first` : undefined} actions={attention.length > ATTENTION_LIMIT ? <Button size="sm" variant="ghost" onClick={() => setShowAll(value => !value)}>{showAll ? 'Show fewer' : `Show all ${attention.length}`}</Button> : null} />
      <div className="card card-flush">
        <AttentionList items={showAll ? attention : attention.slice(0, ATTENTION_LIMIT)} empty={<AllClear>No SLA risks, unassigned tickets or paused repairs right now.</AllClear>} />
      </div>
    </section>

    <div className="grid-2">
      <section className="page-section" aria-labelledby="ops-capacity">
        <SectionHeader id="ops-capacity" title="Engineer capacity" description={`${available} of ${pluralize(engineers.length, 'engineer')} available`} actions={<Button size="sm" variant="ghost" to="/service/engineers">Engineers</Button>} />
        <div className="card card-flush">
          {capacity.length ? <ul className="capacity-list">{capacity.map(row => {
            const free = row.engineers.filter(engineer => engineer.status === 'Available').length;
            return <li className="capacity-row" key={row.name}>
              <span className="capacity-name"><strong>{row.name}</strong><small>{row.engineers.length ? `${free} of ${pluralize(row.engineers.length, 'engineer')} available` : 'No engineers based here'}</small></span>
              <span className="capacity-meter" role="img" aria-label={`${free} available, ${row.engineers.length - free} not available`}>{row.engineers.map(engineer => <i key={engineer._id} className={engineer.status === 'Available' ? 'on' : 'busy'} title={`${engineer.name} · ${engineer.status} · ${engineer.assignedTicketCount || 0} open`} />)}</span>
              <span className="capacity-figure"><strong>{row.openTickets}</strong> active{row.unassigned ? <> · <strong>{row.unassigned}</strong> unassigned</> : ''}</span>
            </li>;
          })}</ul> : <EmptyState compact icon={UsersRound} title="No engineers on record" description="Engineers added to the service team will appear here with their location and availability." />}
        </div>
      </section>

      <section className="page-section" aria-labelledby="ops-activity">
        <SectionHeader id="ops-activity" title="Recent service activity" actions={<Button size="sm" variant="ghost" to="/service/tickets">View queue</Button>} />
        <div className="card card-flush">
          {recentActivity.length ? <ul className="activity-list">{recentActivity.map(ticket => <li key={ticket._id}><Link className="activity-item" to={`/service/tickets/${ticket._id}`}>
            <span className="activity-title"><span className="mono">{ticket.ticketId}</span><span>{companyOf(ticket)}</span></span>
            <span className="activity-sub">{[ticket.issueType, ticket.deviceId?.model, ticket.assignedEngineer || 'Unassigned'].filter(Boolean).join(' · ')}</span>
            <span className="activity-side"><Badge dot>{ticket.status}</Badge><time dateTime={ticket.updatedAt}>{formatRelative(ticket.updatedAt || ticket.createdAt)}</time></span>
          </Link></li>)}</ul> : <EmptyState compact icon={Ticket} title="No tickets yet" description="When a corporate customer raises a request, it will appear here." />}
        </div>
      </section>
    </div>
  </ServiceShell>;
}

function EngineerDrawer({ engineer, tickets, onClose }) {
  const assigned = tickets.filter(ticket => engineerOf(ticket) === String(engineer._id));
  const current = assigned.filter(isActive);
  const completed = assigned.filter(ticket => ['Completed', 'Closed'].includes(ticket.status));
  const list = items => items.length ? <ul className="activity-list" style={{ margin: '0 -20px' }}>{items.map(ticket => <li key={ticket._id}><Link className="activity-item" to={`/service/tickets/${ticket._id}`} onClick={onClose}>
    <span className="activity-title"><span className="mono">{ticket.ticketId}</span><span>{ticket.issueType}</span></span>
    <span className="activity-sub">{[ticket.companyId?.name, ticket.deviceId?.model].filter(Boolean).join(' · ')}</span>
    <span className="activity-side"><Badge dot>{ticket.status}</Badge>{isActive(ticket) && <Badge>{slaLabel(ticket)}</Badge>}</span>
  </Link></li>)}</ul> : <p className="text-muted text-small">None</p>;
  return <Drawer title={engineer.name} eyebrow={`${engineer.employeeId || ''}${engineer.location ? ` · ${engineer.location}` : ''}`} icon={<UsersRound size={18} />} onClose={onClose} width={480}>
    <InfoList items={[['Availability', <Badge dot>{engineer.status}</Badge>], ['Phone', engineer.phone], ['Email', engineer.email], ['Active workload', `${engineer.assignedTicketCount || 0} tickets`], ['Completed', `${completed.length} tickets`]]} />
    <div><p className="subheading">Current assignments ({current.length})</p>{list(current)}</div>
    <div><p className="subheading">Completed tickets ({completed.length})</p>{list(completed.slice(0, 10))}</div>
  </Drawer>;
}

export function Engineers() {
  const state = useAsync(() => Promise.all([getEngineers(), getServiceTickets()]).then(([engineers, tickets]) => ({ engineers, tickets })), []);
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('All');
  const [location, setLocation] = useState('All');
  const [selected, setSelected] = useState(null);
  const requestedEngineer = params.get('engineer');
  useEffect(() => {
    if (!requestedEngineer || !state.data) return;
    const match = state.data.engineers.find(engineer => String(engineer._id) === requestedEngineer);
    if (match) setSelected(match);
  }, [requestedEngineer, state.data]);
  const closeDrawer = () => { setSelected(null); if (requestedEngineer) setParams({}, { replace: true }); };
  const engineers = state.data?.engineers || [];
  const tickets = state.data?.tickets || [];
  const rows = useMemo(() => engineers.map(engineer => {
    const mine = tickets.filter(ticket => engineerOf(ticket) === String(engineer._id));
    return { ...engineer, completedCount: mine.filter(ticket => ['Completed', 'Closed'].includes(ticket.status)).length, riskCount: mine.filter(ticket => isActive(ticket) && (riskStates.includes(slaLabel(ticket)) || riskStates.includes(ticket.escalationStatus))).length };
  }), [engineers, tickets]);
  const maxLoad = Math.max(1, ...rows.map(row => row.assignedTicketCount || 0));
  const visible = filterEngineers(rows, { search, location, status });
  const { locations, statuses } = engineerFilterOptions(engineers);
  return <ServiceShell title="Engineers">
    <PageHeader title="Engineers" description="Availability, workload and SLA exposure across the service team." />
    <KPIGrid columns={4}>
      <KPI label="Engineers" value={state.data ? engineers.length : '—'} icon={UsersRound} />
      <KPI label="Available" value={state.data ? engineers.filter(engineer => engineer.status === 'Available').length : '—'} icon={UserCheck} tone="success" />
      <KPI label="Active assignments" value={state.data ? rows.reduce((sum, row) => sum + (row.assignedTicketCount || 0), 0) : '—'} icon={Wrench} tone="info" />
      <KPI label="Assignments at SLA risk" value={state.data ? rows.reduce((sum, row) => sum + row.riskCount, 0) : '—'} icon={ShieldAlert} tone={rows.some(row => row.riskCount) ? 'warning' : 'neutral'} />
    </KPIGrid>
    <TableCard columns={7} loading={state.loading && !state.data} error={state.error && friendlyError(state.error)} errorTitle="Unable to load engineers" onRetry={state.reload}
      toolbar={<FilterBar summary={state.data ? `${visible.length} of ${pluralize(engineers.length, 'engineer')}` : null}><SearchInput value={search} onChange={setSearch} placeholder="Search engineer name, ID, phone or location" label="Search engineers by name, email, phone, ID or location" /><FilterSelect label="Location" value={location} onChange={setLocation} options={locations} allLabel="All locations" /><FilterSelect label="Availability" value={status} onChange={setStatus} options={statuses} allLabel="All availability" /></FilterBar>}
      isEmpty={!visible.length} empty={<EmptyState icon={UsersRound} title={engineers.length ? 'No engineers match these filters' : 'No engineers on record'} description={engineers.length ? 'Try a different search term, or clear the location and availability filters.' : 'Engineers added to the service team will appear here.'} action={engineers.length ? <Button size="sm" onClick={() => { setSearch(''); setLocation('All'); setStatus('All'); }}>Clear filters</Button> : null} />}>
      <table className="table">
        <thead><tr><th>Engineer</th><th>Location</th><th>Availability</th><th>Active tickets</th><th className="cell-right">Completed</th><th className="cell-right">SLA risk</th><th><span className="sr-only">Action</span></th></tr></thead>
        <tbody>{visible.map(engineer => <tr key={engineer._id} className="row-clickable" onClick={() => setSelected(engineer)}>
          <td><div className="person-cell"><Avatar name={engineer.name} size={32} /><div><button type="button" className="btn-link cell-link" style={{ color: 'inherit' }} onClick={event => { event.stopPropagation(); setSelected(engineer); }}>{engineer.name}</button><span className="cell-sub">{engineer.employeeId}{engineer.phone ? ` · ${engineer.phone}` : ''}</span></div></div></td>
          <td><span className="row"><MapPin size={14} aria-hidden="true" className="text-muted" />{engineer.location || '—'}</span></td>
          <td><Badge dot>{engineer.status}</Badge></td>
          <td><div className="load-meter"><span>{engineer.assignedTicketCount || 0}</span><span className="bar-track"><span className="bar-fill" style={{ width: `${((engineer.assignedTicketCount || 0) / maxLoad) * 100}%` }} /></span></div></td>
          <td className="cell-right cell-num">{engineer.completedCount}</td>
          <td className="cell-right">{engineer.riskCount ? <Badge tone="warning">{engineer.riskCount}</Badge> : <span className="text-muted">0</span>}</td>
          <td className="cell-right"><span className="row-action">Details<ChevronRight size={14} aria-hidden="true" /></span></td>
        </tr>)}</tbody>
      </table>
    </TableCard>
    {selected && <EngineerDrawer engineer={selected} tickets={tickets} onClose={closeDrawer} />}
  </ServiceShell>;
}

function sessionExpiry() {
  try {
    const payload = JSON.parse(atob(localStorage.getItem('iplanet_token').split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.exp ? new Date(payload.exp * 1000) : null;
  } catch { return null; }
}

export function ServiceSettings() {
  const navigate = useNavigate();
  const user = readSessionUser();
  const centres = useAsync(getServiceCentres, []);
  const centre = (centres.data || []).find(item => String(item._id) === String(user.serviceCentreId));
  const expires = sessionExpiry();
  const sections = [['personal', 'Personal information'], ['contact', 'Contact'], ['role', 'Role'], ['organization', 'Organization'], ['integrations', 'Integrations'], ['security', 'Security']];
  return <ServiceShell title="Settings">
    <PageHeader title="Settings" description="Your account, organization and integration settings." />
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">{sections.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</nav>
      <div className="settings-sections">
        <div className="card"><div className="card-body profile-banner"><Avatar name={user.name} size={56} tone="accent" /><div><h2>{user.name || 'iPlanet Service'}</h2><p>iPlanet Service Operations</p></div></div></div>
        <div id="personal" className="settings-section"><Card title="Personal information"><InfoList columns={2} items={[['Full name', user.name], ['User ID', user.id]]} /></Card></div>
        <div id="contact" className="settings-section"><Card title="Contact"><InfoList items={[['Email', user.email && <span className="row"><Mail size={14} aria-hidden="true" />{user.email}</span>]]} /></Card></div>
        <div id="role" className="settings-section"><Card title="Role" description="Your access level in iPlanet Self-care Portal"><InfoList items={[['Role', <Badge tone="info">iPlanet Service</Badge>], ['Access', 'Tickets, enrollment, engineers, reports, coverage, escalation matrix, notifications and reviews']]} /></Card></div>
        <div id="organization" className="settings-section"><Card title="Organization"><InfoList columns={2} items={[['Organization', 'iPlanet Service'], ['Service centre', user.serviceCentreId ? (centres.loading ? 'Loading…' : centre?.name || 'Not found') : 'All service centres'], ['Centre location', centre?.location], ['Centre contact', centre?.contactNumber]]} /></Card></div>
        <div id="integrations" className="settings-section"><Card title="Integrations" description="External services connected to iPlanet Self-care Portal">
          <div className="row-between"><div className="person-cell"><span className="thumb thumb-lg"><Building2 size={18} aria-hidden="true" /></span><div><strong>Google Business Profile</strong><span className="cell-sub">Connect locations and sync public Google reviews</span></div></div><Button to="/service/reviews/google">Manage</Button></div>
        </Card></div>
        <div id="security" className="settings-section"><Card title="Security" actions={<Button icon={LogOut} onClick={() => { localStorage.clear(); navigate('/login', { replace: true }); }}>Sign out</Button>}>
          <InfoList items={[['Sign-in method', <span className="row"><KeyRound size={14} aria-hidden="true" />Email and password</span>], ['Current session expires', expires ? formatDateTime(expires) : null]]} />
        </Card></div>
      </div>
    </div>
  </ServiceShell>;
}

