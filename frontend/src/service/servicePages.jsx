import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Building2, CheckCircle2, ChevronRight, CircleCheck, ClipboardList, Clock3, KeyRound, LogOut, Mail, MapPin, Package, ScanLine, ShieldAlert, Ticket, TriangleAlert, UserCheck, UserRoundX, UsersRound, Wrench } from 'lucide-react';
import { ServiceShell } from './components';
import { getCoverage, getEngineers, getServiceCentres, getServiceDashboard, getServiceReports, getServiceTickets } from './api';
import {
  Avatar, Badge, BarList, Button, Card, ColumnChart, Drawer, EmptyState, ErrorState, FilterBar, FilterSelect, InfoList, KPI, KPIGrid, PageHeader, PageSkeleton,
  RowAction, SearchInput, TableCard, formatDateTime, formatRelative, friendlyError, greeting, monthlyVolume, readSessionUser, slaLabel, todayLabel, useAsync,
} from '../ui';

export { ServiceShell };

const activeStatuses = ['Open', 'Engineer Assigned', 'Engineer Accepted', 'In Progress', 'Waiting for Parts'];
const riskStates = ['At Risk', 'SLA Breached', 'Escalated'];
const isActive = ticket => activeStatuses.includes(ticket.status);
const engineerOf = ticket => String(ticket.assignedEngineerId?._id || ticket.assignedEngineerId || '');

function Attention({ to, tone, icon: Icon, title, detail, count }) {
  return <Link to={to} className={`attention-item attention-${tone}`}>
    <span className="attention-icon" aria-hidden="true"><Icon size={16} /></span>
    <span className="attention-text"><strong>{title}</strong><span>{detail}</span></span>
    <span className="attention-count">{count}</span>
    <ChevronRight size={16} className="chev" aria-hidden="true" />
  </Link>;
}

export function ServiceDashboard() {
  const user = readSessionUser();
  const state = useAsync(() => Promise.all([getServiceDashboard(), getServiceTickets(), getEngineers()]).then(([dashboard, tickets, engineers]) => ({ ...dashboard, tickets, engineers })), []);
  if (state.loading && !state.data) return <ServiceShell title="Dashboard"><PageSkeleton kpis={6} /></ServiceShell>;
  if (state.error) return <ServiceShell title="Dashboard"><PageHeader title="Dashboard" /><div className="card"><ErrorState title="Unable to load service operations" message={friendlyError(state.error)} onRetry={state.reload} /></div></ServiceShell>;

  const { stats: s, volume, locations, tickets, engineers } = state.data;
  const active = tickets.filter(isActive);
  const count = predicate => active.filter(predicate).length;
  const breached = count(ticket => slaLabel(ticket) === 'SLA Breached' || ticket.escalationStatus === 'SLA Breached');
  const escalated = count(ticket => ticket.escalationStatus === 'Escalated');
  const atRisk = count(ticket => slaLabel(ticket) === 'At Risk' || ticket.escalationStatus === 'At Risk');
  const unassignedOpen = count(ticket => ticket.status === 'Open' && !ticket.assignedEngineerId);
  const pendingAcceptance = count(ticket => ticket.status === 'Engineer Assigned');
  const waitingParts = count(ticket => ticket.status === 'Waiting for Parts');
  const attention = [
    breached && { to: '/service/tickets?slaStatus=SLA%20Breached', tone: 'critical', icon: ShieldAlert, title: 'SLA breached', detail: 'Active tickets past their resolution target', count: breached },
    escalated && { to: '/service/tickets?slaStatus=Escalated', tone: 'critical', icon: TriangleAlert, title: 'Escalated', detail: 'Raised to service management', count: escalated },
    atRisk && { to: '/service/tickets?slaStatus=At%20Risk', tone: 'warning', icon: Clock3, title: 'SLA at risk', detail: 'Approaching their resolution target', count: atRisk },
    unassignedOpen && { to: '/service/tickets?status=Open&assignment=Unassigned', tone: 'warning', icon: UserRoundX, title: 'Unassigned tickets', detail: 'Open tickets waiting for an engineer', count: unassignedOpen },
    pendingAcceptance && { to: '/service/tickets?status=Engineer%20Assigned', tone: 'info', icon: UserCheck, title: 'Pending engineer acceptance', detail: 'Assigned but not yet accepted', count: pendingAcceptance },
    waitingParts && { to: '/service/tickets?status=Waiting%20for%20Parts', tone: 'info', icon: Package, title: 'Waiting for parts', detail: 'Repairs paused until parts arrive', count: waitingParts },
  ].filter(Boolean);
  const recentActivity = [...tickets].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)).slice(0, 7);
  const workload = engineers.map(engineer => ({ name: engineer.name, value: engineer.assignedTicketCount || 0 }));

  return <ServiceShell title="Dashboard">
    <div className="dashboard-intro">
      <div className="page-header-text">
        <p className="eyebrow">{greeting()}{user.name ? `, ${user.name.split(' ')[0]}` : ''} · {todayLabel()}</p>
        <h1 className="page-title">Service Operations</h1>
        <p className="page-description">Monitor service activity, SLA performance, engineers and device operations.</p>
      </div>
      <div className="page-actions"><Button icon={ScanLine} to="/service/device-enrollment">Enroll device</Button><Button variant="primary" icon={ClipboardList} to="/service/tickets">Open ticket queue</Button></div>
    </div>

    <KPIGrid columns={6}>
      <KPI label="Open tickets" value={s.newRequests} hint={unassignedOpen ? `${unassignedOpen} awaiting an engineer` : 'All assigned'} to="/service/tickets?status=Open" />
      <KPI label="In progress" value={s.inProgress} hint={waitingParts ? `${waitingParts} waiting for parts` : undefined} to="/service/tickets?status=In%20Progress" />
      <KPI label="SLA at risk" value={atRisk} tone={atRisk ? 'warning' : 'neutral'} hint="Active tickets" to="/service/tickets?slaStatus=At%20Risk" />
      <KPI label="SLA breached" value={breached} tone={breached ? 'critical' : 'neutral'} hint={escalated ? `${escalated} escalated` : "Active tickets"} to="/service/tickets?slaStatus=SLA%20Breached" />
      <KPI label="Unassigned" value={s.unassigned} icon={UserRoundX} tone={s.unassigned ? 'warning' : 'neutral'} to="/service/tickets?assignment=Unassigned" />
      <KPI label="Completed" value={s.completed} icon={CircleCheck} tone="success" hint={`${s.closed} closed`} to="/service/tickets?status=Completed" />
    </KPIGrid>

    <div className="grid-2">
      <Card flush title="Needs attention" description="Active tickets that need action now">
        {attention.length ? <div className="attention-list">{attention.map(item => <Attention key={item.title} {...item} />)}</div> : <div className="all-clear"><CheckCircle2 size={18} aria-hidden="true" />No SLA risks or unassigned work right now.</div>}
      </Card>
      <Card flush title="Service activity" description="Most recently updated tickets" actions={<Button size="sm" variant="ghost" to="/service/tickets">View queue</Button>}>
        {recentActivity.length ? <ul className="activity-list">{recentActivity.map(ticket => <li key={ticket._id}><Link className="activity-item" to={`/service/tickets/${ticket._id}`}>
          <span className="activity-title"><span className="mono">{ticket.ticketId}</span><span>{ticket.companyId?.name || ticket.customerId?.company || 'Corporate'}</span></span>
          <span className="activity-sub">{[ticket.issueType, ticket.deviceId?.model, ticket.assignedEngineer || 'Unassigned'].filter(Boolean).join(' · ')}</span>
          <span className="activity-side"><Badge dot>{ticket.status}</Badge><time dateTime={ticket.updatedAt}>{formatRelative(ticket.updatedAt || ticket.createdAt)}</time></span>
        </Link></li>)}</ul> : <EmptyState compact icon={Ticket} title="No tickets yet" description="Tickets raised by corporate customers will appear here." />}
      </Card>
    </div>

    <div className="grid-main-side">
      <Card title="Ticket volume" description="Tickets created per calendar month (all years)"><ColumnChart data={volume} dataKey="tickets" nameKey="month" seriesName="Tickets" emptyText="No tickets created yet." /></Card>
      <Card title="Location distribution" description="Tickets by service location"><BarList data={locations} emptyText="No tickets yet." /></Card>
    </div>

    <div className="grid-main-side">
      <Card flush title="Recent tickets" actions={<Button size="sm" variant="ghost" to="/service/tickets">View all</Button>}>
        {tickets.length ? <div className="table-scroll"><table className="table table-compact">
          <thead><tr><th>Ticket</th><th>Corporate</th><th>Priority</th><th>Status</th><th>SLA</th><th><span className="sr-only">Action</span></th></tr></thead>
          <tbody>{tickets.slice(0, 6).map(ticket => <tr key={ticket._id}>
            <td><Link className="cell-link mono" to={`/service/tickets/${ticket._id}`}>{ticket.ticketId}</Link><span className="cell-sub">{ticket.issueType}</span></td>
            <td>{ticket.companyId?.name || ticket.customerId?.company || '—'}</td>
            <td><Badge>{ticket.priority}</Badge></td>
            <td><Badge dot>{ticket.status}</Badge></td>
            <td><Badge>{slaLabel(ticket)}</Badge></td>
            <td className="cell-right"><RowAction to={`/service/tickets/${ticket._id}`} label="Open" /></td>
          </tr>)}</tbody>
        </table></div> : <EmptyState compact icon={Ticket} title="No tickets yet" />}
      </Card>
      <Card title="Engineer workload" description="Active (not closed) tickets per engineer" actions={<Button size="sm" variant="ghost" to="/service/engineers">Engineers</Button>}><BarList data={workload} emptyText="No active assignments." /></Card>
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
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('All');
  const [selected, setSelected] = useState(null);
  const engineers = state.data?.engineers || [];
  const tickets = state.data?.tickets || [];
  const rows = useMemo(() => engineers.map(engineer => {
    const mine = tickets.filter(ticket => engineerOf(ticket) === String(engineer._id));
    return { ...engineer, completedCount: mine.filter(ticket => ['Completed', 'Closed'].includes(ticket.status)).length, riskCount: mine.filter(ticket => isActive(ticket) && (riskStates.includes(slaLabel(ticket)) || riskStates.includes(ticket.escalationStatus))).length };
  }), [engineers, tickets]);
  const maxLoad = Math.max(1, ...rows.map(row => row.assignedTicketCount || 0));
  const visible = rows.filter(row => (status === 'All' || row.status === status) && JSON.stringify(row).toLowerCase().includes(search.toLowerCase()));
  const statuses = [...new Set(engineers.map(engineer => engineer.status).filter(Boolean))];
  return <ServiceShell title="Engineers">
    <PageHeader title="Engineers" description="Availability, workload and SLA exposure across the service team." />
    <KPIGrid columns={4}>
      <KPI label="Engineers" value={state.data ? engineers.length : '—'} icon={UsersRound} />
      <KPI label="Available" value={state.data ? engineers.filter(engineer => engineer.status === 'Available').length : '—'} icon={UserCheck} tone="success" />
      <KPI label="Active assignments" value={state.data ? rows.reduce((sum, row) => sum + (row.assignedTicketCount || 0), 0) : '—'} icon={Wrench} tone="info" />
      <KPI label="Assignments at SLA risk" value={state.data ? rows.reduce((sum, row) => sum + row.riskCount, 0) : '—'} icon={ShieldAlert} tone={rows.some(row => row.riskCount) ? 'warning' : 'neutral'} />
    </KPIGrid>
    <TableCard columns={7} loading={state.loading && !state.data} error={state.error && friendlyError(state.error)} errorTitle="Unable to load engineers" onRetry={state.reload}
      toolbar={<FilterBar summary={state.data ? `${visible.length} engineers` : null}><SearchInput value={search} onChange={setSearch} placeholder="Search name, ID or location" label="Search engineers" /><FilterSelect label="Availability" value={status} onChange={setStatus} options={statuses} allLabel="All availability" /></FilterBar>}
      isEmpty={!visible.length} empty={<EmptyState icon={UsersRound} title={engineers.length ? 'No engineers match these filters' : 'No engineers on record'} description={engineers.length ? 'Try a different search term.' : 'Engineers added to the service team will appear here.'} />}>
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
    {selected && <EngineerDrawer engineer={selected} tickets={tickets} onClose={() => setSelected(null)} />}
  </ServiceShell>;
}

const periods = [{ value: 'all', label: 'All time' }, { value: 'year', label: 'This year' }, { value: '90', label: 'Last 90 days' }, { value: '30', label: 'Last 30 days' }];
function inPeriod(ticket, period) {
  if (period === 'all') return true;
  const created = new Date(ticket.createdAt);
  if (period === 'year') return created.getFullYear() === new Date().getFullYear();
  return Date.now() - created.getTime() <= Number(period) * 86400000;
}
function groupBy(items, pick) {
  return Object.entries(items.reduce((result, item) => { const key = pick(item) || 'Other'; result[key] = (result[key] || 0) + 1; return result; }, {})).map(([name, value]) => ({ name, value }));
}

export function ServiceReports() {
  const state = useAsync(() => Promise.all([getServiceReports(), getServiceTickets(), getCoverage()]).then(([reports, tickets, coverage]) => ({ reports, tickets, coverage })), []);
  const [period, setPeriod] = useState('all');
  if (state.loading && !state.data) return <ServiceShell title="Reports"><PageSkeleton kpis={5} /></ServiceShell>;
  if (state.error) return <ServiceShell title="Reports"><PageHeader title="Reports" /><div className="card"><ErrorState title="Unable to load reports" message={friendlyError(state.error)} onRetry={state.reload} /></div></ServiceShell>;

  const { reports, coverage } = state.data;
  const tickets = state.data.tickets.filter(ticket => inPeriod(ticket, period));
  // "All time" uses the backend aggregates; narrower periods aggregate the same ticket records client-side.
  const base = period === 'all' ? reports : {
    total: tickets.length,
    open: tickets.filter(ticket => ticket.status === 'Open').length,
    completed: tickets.filter(ticket => ticket.status === 'Completed').length,
    closed: tickets.filter(ticket => ticket.status === 'Closed').length,
    locations: groupBy(tickets, ticket => ticket.location),
    deviceTypes: groupBy(tickets, ticket => ticket.deviceId?.deviceType),
    issueTypes: groupBy(tickets, ticket => ticket.issueType),
  };
  const closed = tickets.filter(ticket => ticket.status === 'Closed' && ticket.createdAt && ticket.updatedAt);
  const avgDays = closed.length ? closed.reduce((sum, ticket) => sum + (new Date(ticket.updatedAt) - new Date(ticket.createdAt)), 0) / closed.length / 86400000 : null;
  const healthCamp = monthlyVolume(tickets.filter(ticket => ticket.category === 'Health Camp'));
  const periodLabel = periods.find(item => item.value === period).label;

  return <ServiceShell title="Reports">
    <PageHeader title="Reports" description="Operational analytics across tickets, locations, categories and coverage." actions={<label className="filter-select"><span className="sr-only">Reporting period</span><select value={period} onChange={event => setPeriod(event.target.value)} aria-label="Reporting period">{periods.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>} />
    <KPIGrid columns={5}>
      <KPI label="Total tickets" value={base.total} icon={Ticket} hint={periodLabel} />
      <KPI label="Open" value={base.open} icon={ClipboardList} tone="info" />
      <KPI label="Completed" value={base.completed} icon={Wrench} tone="success" />
      <KPI label="Closed" value={base.closed} icon={CircleCheck} tone="success" />
      <KPI label="Avg. resolution time" value={avgDays === null ? '—' : `${avgDays.toFixed(1)} days`} icon={Clock3} hint={closed.length ? `Created → closed, ${closed.length} tickets` : 'No closed tickets in period'} />
    </KPIGrid>
    <div className="grid-main-side">
      <Card title="Monthly ticket volume" description={`Tickets created per month, ${new Date().getFullYear()}`}><ColumnChart data={monthlyVolume(tickets)} dataKey="tickets" nameKey="month" seriesName="Tickets" emptyText="No tickets this year." /></Card>
      <Card title="Ticket status" description={periodLabel}><BarList data={groupBy(tickets, ticket => ticket.status)} emptyText="No tickets in this period." /></Card>
    </div>
    <div className="grid-3">
      <Card title="Location distribution" description="Tickets by service location"><BarList data={base.locations} emptyText="No tickets in this period." /></Card>
      <Card title="Service category" description="Tickets by request category"><BarList data={groupBy(tickets, ticket => ticket.category || 'Service')} emptyText="No tickets in this period." /></Card>
      <Card title="Device type" description="Tickets by device type"><BarList data={base.deviceTypes} emptyText="No tickets in this period." /></Card>
    </div>
    <div className="grid-main-side">
      <Card title="Issue types" description="Most frequently reported issues"><ColumnChart data={[...(base.issueTypes || [])].sort((a, b) => b.value - a.value)} seriesName="Tickets" emptyText="No tickets in this period." /></Card>
      <Card title="AMC device counts" description="All enrolled devices by AMC status"><BarList data={groupBy(coverage.devices || [], device => device.amcStatus)} tone="#34c759" emptyText="No devices enrolled." /></Card>
    </div>
    <Card title="Health camp requests" description={`Health Camp requests per month, ${new Date().getFullYear()}`}><ColumnChart data={healthCamp} dataKey="tickets" nameKey="month" seriesName="Health camp requests" height={200} emptyText="No health camp requests this year." /></Card>
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
        <div id="role" className="settings-section"><Card title="Role" description="Your access level in iPlanetCare"><InfoList items={[['Role', <Badge tone="info">iPlanet Service</Badge>], ['Access', 'Tickets, enrollment, engineers, reports, coverage, escalation matrix, notifications and reviews']]} /></Card></div>
        <div id="organization" className="settings-section"><Card title="Organization"><InfoList columns={2} items={[['Organization', 'iPlanet Service'], ['Service centre', user.serviceCentreId ? (centres.loading ? 'Loading…' : centre?.name || 'Not found') : 'All service centres'], ['Centre location', centre?.location], ['Centre contact', centre?.contactNumber]]} /></Card></div>
        <div id="integrations" className="settings-section"><Card title="Integrations" description="External services connected to iPlanetCare">
          <div className="row-between"><div className="person-cell"><span className="thumb thumb-lg"><Building2 size={18} aria-hidden="true" /></span><div><strong>Google Business Profile</strong><span className="cell-sub">Connect locations and sync public Google reviews</span></div></div><Button to="/service/reviews/google">Manage</Button></div>
        </Card></div>
        <div id="security" className="settings-section"><Card title="Security" actions={<Button icon={LogOut} onClick={() => { localStorage.clear(); navigate('/login', { replace: true }); }}>Sign out</Button>}>
          <InfoList items={[['Sign-in method', <span className="row"><KeyRound size={14} aria-hidden="true" />Email and password</span>], ['Current session expires', expires ? formatDateTime(expires) : null]]} />
        </Card></div>
      </div>
    </div>
  </ServiceShell>;
}

