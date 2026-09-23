import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CalendarClock, CheckCircle2, ChevronRight, CircleCheck, Clock3, FilePlus2, KeyRound, Laptop, LogOut, Package, Search, ShieldAlert, ShieldCheck, Star, Ticket, TriangleAlert, UserRoundPlus, Wrench } from 'lucide-react';
import { Shell } from './components';
import { getCoverage, getDashboard, getDevice, getDevices, getMyReviews, getProfile, getTickets } from './api';
import {
  Avatar, Badge, BarList, Button, Card, ColumnChart, CoverageTiles, DeviceIcon, EmptyState, ErrorState, FilterBar, FilterSelect, InfoList, KPI, KPIGrid,
  PageHeader, PageSkeleton, RowAction, SearchInput, SectionHeader, TableCard, formatDate, formatDateTime, formatRelative, friendlyError, greeting,
  monthlyVolume, readSessionUser, slaLabel, todayLabel, useAsync,
} from '../ui';

const ticketStatuses = ['Open', 'Engineer Assigned', 'Engineer Accepted', 'In Progress', 'Waiting for Parts', 'Completed', 'Closed'];
const activeStatuses = ['Open', 'Engineer Assigned', 'Engineer Accepted', 'In Progress', 'Waiting for Parts'];

function AttentionRow({ to, tone, icon: Icon, title, detail, count }) {
  return <Link to={to} className={`attention-item attention-${tone}`}>
    <span className="attention-icon" aria-hidden="true"><Icon size={16} /></span>
    <span className="attention-text"><strong>{title}</strong><span>{detail}</span></span>
    <span className="attention-count">{count}</span>
    <ChevronRight size={16} className="chev" aria-hidden="true" />
  </Link>;
}

function ActivityList({ tickets, base }) {
  return <ul className="activity-list">
    {tickets.map(ticket => <li key={ticket._id}>
      <Link to={`${base}/${ticket._id}`} className="activity-item">
        <span className="activity-title"><span className="mono">{ticket.ticketId}</span><span>{ticket.issueType || 'Service request'}</span></span>
        <span className="activity-sub">{[ticket.deviceId?.model, ticket.deviceId?.serialNumber, ticket.location].filter(Boolean).join(' · ')}</span>
        <span className="activity-side"><Badge dot>{ticket.status}</Badge><time dateTime={ticket.updatedAt || ticket.createdAt}>{formatRelative(ticket.updatedAt || ticket.createdAt)}</time></span>
      </Link>
    </li>)}
  </ul>;
}

export function Dashboard() {
  const user = readSessionUser();
  const main = useAsync(() => Promise.all([getDashboard(), getTickets()]).then(([dashboard, tickets]) => ({ ...dashboard, tickets })), []);
  const coverage = useAsync(getCoverage, []);
  const reviews = useAsync(getMyReviews, []);

  if (main.loading && !main.data) return <Shell title="Dashboard"><PageSkeleton kpis={5} /></Shell>;
  if (main.error) return <Shell title="Dashboard"><PageHeader title="Dashboard" /><div className="card"><ErrorState title="Unable to load your dashboard" message={friendlyError(main.error)} onRetry={main.reload} /></div></Shell>;

  const { stats: s, locations, tickets } = main.data;
  const firstName = (user.name || '').split(' ')[0];
  const waitingParts = tickets.filter(ticket => ticket.status === 'Waiting for Parts').length;
  // Attention counts only active requests; closed tickets keep their historical SLA state.
  const activeTickets = tickets.filter(ticket => activeStatuses.includes(ticket.status));
  const activeCount = state => activeTickets.filter(ticket => slaLabel(ticket) === state || ticket.escalationStatus === state).length;
  const breached = activeCount('SLA Breached');
  const escalated = activeTickets.filter(ticket => ticket.escalationStatus === 'Escalated').length;
  const atRisk = activeCount('At Risk');
  const devices = coverage.data?.devices || [];
  const unassigned = devices.filter(device => device.deviceAllocationStatus === 'Unassigned').length;
  const reviewedIds = new Set((reviews.data || []).map(review => String(review.ticketId?._id || review.ticketId)));
  const awaitingReview = reviews.data ? tickets.filter(ticket => ticket.status === 'Closed' && !reviewedIds.has(String(ticket._id))).length : 0;
  const attention = [
    breached > 0 && { to: '/corporate/service-requests?sla=SLA%20Breached', tone: 'critical', icon: ShieldAlert, title: 'SLA breached', detail: 'Active requests past their resolution target', count: breached },
    escalated > 0 && { to: '/corporate/service-requests?sla=Escalated', tone: 'critical', icon: TriangleAlert, title: 'Escalated requests', detail: 'Escalated to iPlanet service management', count: escalated },
    atRisk > 0 && { to: '/corporate/service-requests?sla=At%20Risk', tone: 'warning', icon: Clock3, title: 'SLA at risk', detail: 'Approaching their resolution target', count: atRisk },
    waitingParts > 0 && { to: '/corporate/service-requests?status=Waiting%20for%20Parts', tone: 'warning', icon: Package, title: 'Waiting for parts', detail: 'Repairs paused until parts arrive', count: waitingParts },
    unassigned > 0 && { to: '/corporate/unassigned-devices', tone: 'info', icon: UserRoundPlus, title: 'Unassigned devices', detail: 'Ready to be assigned to an employee', count: unassigned },
    coverage.data?.summary?.expiringSoon > 0 && { to: '/corporate/warranty', tone: 'warning', icon: CalendarClock, title: 'Coverage expiring soon', detail: 'Warranty or AMC ending shortly', count: coverage.data.summary.expiringSoon },
    awaitingReview > 0 && { to: '/corporate/reviews', tone: 'info', icon: Star, title: 'Awaiting your review', detail: 'Closed requests you can rate', count: awaitingReview },
  ].filter(Boolean);

  return <Shell title="Dashboard">
    <div className="dashboard-intro">
      <div className="page-header-text">
        <p className="eyebrow">{todayLabel()}</p>
        <h1 className="page-title">{greeting()}{firstName ? `, ${firstName}` : ''}</h1>
        <p className="page-description">Here's what's happening across your devices and service requests.</p>
      </div>
      <Button variant="primary" icon={FilePlus2} to="/corporate/raise-request">Raise request</Button>
    </div>

    <KPIGrid columns={5}>
      <KPI label="Total devices" value={s.totalDevices} icon={Laptop} to="/corporate/devices" hint={coverage.data ? `${unassigned} unassigned` : undefined} />
      <KPI label="Open requests" value={s.openTickets} icon={Ticket} tone="info" to="/corporate/service-requests?status=Open" />
      <KPI label="In progress" value={s.inProgress} icon={Wrench} tone="info" to="/corporate/service-requests?status=In%20Progress" />
      <KPI label="Closed" value={s.closedTickets} icon={CircleCheck} tone="success" to="/corporate/service-requests?status=Closed" hint={s.completedTickets ? `${s.completedTickets} completed, pending closure` : undefined} />
      <KPI label="Warranty active" value={s.warrantyDevices} icon={ShieldCheck} tone="success" to="/corporate/warranty" hint={`${s.amcDevices} with active AMC`} />
    </KPIGrid>

    <section aria-labelledby="quick-actions" className="stack-12">
      <SectionHeader id="quick-actions" title="Quick actions" />
      <div className="quick-actions">
        {[
          ['/corporate/raise-request', FilePlus2, 'Raise request', 'Service, buyback, e-waste'],
          ['/corporate/devices', Search, 'Find device', 'Search by serial or employee'],
          ['/corporate/unassigned-devices', UserRoundPlus, 'Assign device', 'Allocate to an employee'],
          ['/corporate/service-requests', Ticket, 'Track request', 'Follow service progress'],
          ['/corporate/warranty', ShieldCheck, 'Check coverage', 'Warranty and AMC'],
        ].map(([to, Icon, label, hint]) => <Link key={to} to={to} className="quick-action"><span className="quick-action-icon" aria-hidden="true"><Icon size={16} /></span><span>{label}<small>{hint}</small></span></Link>)}
      </div>
    </section>

    <div className="grid-2">
      <Card flush title="Needs attention" description="Items that may need action from your team">
        {coverage.loading || reviews.loading ? <div className="card-body"><div className="skeleton" style={{ height: 120 }} /></div>
          : attention.length ? <div className="attention-list">{attention.map(item => <AttentionRow key={item.title} {...item} />)}</div>
          : <div className="all-clear"><CheckCircle2 size={18} aria-hidden="true" />Nothing needs your attention right now.</div>}
        {coverage.error && <ErrorState compact title="Coverage alerts unavailable" message={friendlyError(coverage.error)} onRetry={coverage.reload} />}
      </Card>
      <Card flush title="Recent service activity" actions={<Button variant="ghost" size="sm" to="/corporate/service-requests">View all</Button>}>
        {tickets.length ? <ActivityList tickets={tickets.slice(0, 6)} base="/corporate/service-requests" /> : <EmptyState compact icon={Ticket} title="No service requests yet" description="When a request is raised, it will appear here." action={<Button variant="primary" size="sm" to="/corporate/raise-request">Raise request</Button>} />}
      </Card>
    </div>

    <div className="grid-main-side">
      <Card title="Service requests by month" description={`Requests raised by your organization in ${new Date().getFullYear()}`}>
        <ColumnChart data={monthlyVolume(tickets)} dataKey="tickets" nameKey="month" seriesName="Requests" emptyText="No requests raised this year." />
      </Card>
      <Card title="Devices by location" description="Where your registered devices are deployed">
        <BarList data={locations} emptyText="No devices registered yet." />
      </Card>
    </div>
  </Shell>;
}

function TicketTable({ tickets, base = '/corporate/service-requests' }) {
  const navigate = useNavigate();
  return <table className="table">
    <thead><tr><th>Request</th><th>Device</th><th>Issue</th><th>Location</th><th>Priority</th><th>Status</th><th>SLA</th><th>Created</th><th><span className="sr-only">Action</span></th></tr></thead>
    <tbody>{tickets.map(ticket => <tr key={ticket._id} className="row-clickable" onClick={event => { if (!event.target.closest('a')) navigate(`${base}/${ticket._id}`); }}>
      <td className="cell-nowrap"><Link className="cell-link mono" to={`${base}/${ticket._id}`}>{ticket.ticketId}</Link><span className="cell-sub">{ticket.category || 'Service'}</span></td>
      <td><span className="cell-primary">{ticket.deviceId?.model || '—'}</span><span className="cell-sub mono">{ticket.deviceId?.serialNumber}</span></td>
      <td>{ticket.issueType || '—'}</td>
      <td>{ticket.location || '—'}</td>
      <td><Badge>{ticket.priority}</Badge></td>
      <td><Badge dot>{ticket.status}</Badge></td>
      <td><Badge>{slaLabel(ticket)}</Badge></td>
      <td className="cell-nowrap">{formatDate(ticket.createdAt)}</td>
      <td className="cell-right"><RowAction to={`${base}/${ticket._id}`} /></td>
    </tr>)}</tbody>
  </table>;
}

export function Devices() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [search, setSearch] = useState(params.get('search') || '');
  const [query, setQuery] = useState(search);
  const [allocation, setAllocation] = useState('All');
  const [warranty, setWarranty] = useState('All');
  useEffect(() => { setSearch(params.get('search') || ''); setQuery(params.get('search') || ''); }, [params]);
  useEffect(() => { const timer = window.setTimeout(() => setQuery(search), 250); return () => window.clearTimeout(timer); }, [search]);
  const state = useAsync(() => getDevices(query), [query]);
  const all = state.data || [];
  const devices = all.filter(device => (allocation === 'All' || device.deviceAllocationStatus === allocation) && (warranty === 'All' || device.warrantyStatus === warranty));
  const warrantyOptions = [...new Set(all.map(device => device.warrantyStatus).filter(Boolean))];

  return <Shell title="Devices">
    <PageHeader title="Devices" description="Manage and monitor your organization's registered devices." actions={<><Button icon={UserRoundPlus} to="/corporate/unassigned-devices">Assign device</Button><Button variant="primary" icon={FilePlus2} to="/corporate/raise-request">Raise request</Button></>} />
    <TableCard
      columns={8}
      loading={state.loading && !state.data}
      error={state.error && friendlyError(state.error)}
      errorTitle="Unable to load devices"
      onRetry={state.reload}
      toolbar={<FilterBar summary={state.data ? `${devices.length} device${devices.length === 1 ? '' : 's'}` : null}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search asset, serial, model or employee" label="Search devices" />
        <FilterSelect label="Assignment" value={allocation} onChange={setAllocation} options={['Assigned', 'Unassigned']} allLabel="All assignments" />
        <FilterSelect label="Warranty" value={warranty} onChange={setWarranty} options={warrantyOptions} allLabel="All warranty" />
      </FilterBar>}
      isEmpty={!devices.length}
      empty={<EmptyState icon={Laptop} title={query || allocation !== 'All' || warranty !== 'All' ? 'No devices match your search' : 'No devices registered yet'} description={query || allocation !== 'All' || warranty !== 'All' ? 'Try a different search term or clear the filters.' : 'Devices enrolled by iPlanet Service for your organization will appear here.'} />}
    >
      <table className="table">
        <thead><tr><th>Device</th><th>Serial number</th><th>Employee</th><th>Location</th><th>Warranty</th><th>AMC</th><th>Status</th><th><span className="sr-only">Action</span></th></tr></thead>
        <tbody>{devices.map(device => <tr key={device._id} className="row-clickable" onClick={event => { if (!event.target.closest('a')) navigate(`/corporate/devices/${device._id}`); }}>
          <td><div className="person-cell"><span className="asset-icon" style={{ width: 32, height: 32, borderRadius: 8 }}><DeviceIcon type={device.deviceType} model={device.model} size={16} /></span><div><Link className="cell-link" to={`/corporate/devices/${device._id}`}>{device.model}</Link><span className="cell-sub">{[device.assetId, device.deviceType].filter(Boolean).join(' · ')}</span></div></div></td>
          <td className="mono cell-nowrap">{device.serialNumber}</td>
          <td>{device.employeeName ? <><span className="cell-primary">{device.employeeName}</span><span className="cell-sub">{[device.department, device.employeeId].filter(Boolean).join(' · ')}</span></> : <span className="text-muted">Not assigned</span>}</td>
          <td>{device.location || '—'}</td>
          <td className="cell-nowrap"><Badge>{device.warrantyStatus}</Badge><span className="cell-sub">{device.warrantyExpiry ? `Ends ${formatDate(device.warrantyExpiry)}` : ''}</span></td>
          <td className="cell-nowrap"><Badge>{device.amcStatus}</Badge><span className="cell-sub">{device.amcExpiry ? `Ends ${formatDate(device.amcExpiry)}` : ''}</span></td>
          <td className="cell-nowrap"><Badge dot>{device.deviceAllocationStatus || 'Assigned'}</Badge>{device.deviceStatus && <span className="cell-sub">{device.deviceStatus}</span>}</td>
          <td className="cell-right"><RowAction to={`/corporate/devices/${device._id}`} /></td>
        </tr>)}</tbody>
      </table>
    </TableCard>
  </Shell>;
}

export function DeviceDetail() {
  const { id } = useParams();
  const user = readSessionUser();
  const state = useAsync(() => Promise.all([getDevice(id), getTickets()]).then(([device, all]) => ({ device, tickets: all.filter(ticket => String(ticket.deviceId?._id || ticket.deviceId) === id) })), [id]);
  const crumbs = [{ label: 'Devices', to: '/corporate/devices' }, { label: state.data?.device?.model || 'Device details' }];
  if (state.loading && !state.data) return <Shell title="Device details" crumbs={crumbs}><PageSkeleton variant="detail" /></Shell>;
  if (state.error) return <Shell title="Device details" crumbs={crumbs}><PageHeader title="Device details" back={{ to: '/corporate/devices', label: 'Devices' }} /><div className="card"><ErrorState title="Unable to load this device" message={friendlyError(state.error)} onRetry={state.reload} /></div></Shell>;

  const { device, tickets } = state.data;
  const activeTicket = tickets.find(ticket => activeStatuses.includes(ticket.status));
  const unassigned = device.deviceAllocationStatus === 'Unassigned';
  const allocation = activeTicket ? 'Under Service' : unassigned ? 'Unassigned' : 'Assigned';
  return <Shell title={device.model} crumbs={crumbs}>
    <div className="page-header">
      <Link className="back-link" to="/corporate/devices"><ChevronRight size={15} style={{ transform: 'rotate(180deg)' }} aria-hidden="true" />Devices</Link>
      <div className="asset-header">
        <div className="asset-identity">
          <span className="asset-icon"><DeviceIcon type={device.deviceType} model={device.model} size={26} /></span>
          <div className="page-header-text">
            <h1 className="page-title">{device.model}</h1>
            <div className="page-meta"><span>Serial <span className="mono">{device.serialNumber}</span></span><span className="meta-sep" /><span>{device.assetId}</span><span className="meta-sep" /><Badge dot tone={allocation === 'Under Service' ? 'warning' : undefined}>{allocation}</Badge></div>
          </div>
        </div>
        <div className="page-actions">
          {unassigned && <Button icon={UserRoundPlus} to="/corporate/unassigned-devices">Assign device</Button>}
          {activeTicket && <Button icon={Ticket} to={`/corporate/service-requests/${activeTicket._id}`}>View ticket</Button>}
          <Button variant="primary" icon={FilePlus2} to={`/corporate/raise-request?device=${device._id}`}>Raise request</Button>
        </div>
      </div>
    </div>

    <div className="summary-strip">
      <div><span className="summary-label">Employee</span><span className="summary-value">{device.employeeName || 'Not assigned'}</span></div>
      <div><span className="summary-label">Location</span><span className="summary-value">{device.location || '—'}</span></div>
      <div><span className="summary-label">Warranty</span><span className="summary-value"><Badge>{device.warrantyStatus || 'Not available'}</Badge></span></div>
      <div><span className="summary-label">AMC</span><span className="summary-value"><Badge>{device.amcStatus || 'Not available'}</Badge></span></div>
    </div>

    <div className="detail-layout">
      <div className="detail-main">
        <Card title="Device information">
          <InfoList columns={2} items={[['Model', device.model], ['Device type', device.deviceType], ['Serial number', <span className="mono">{device.serialNumber}</span>], ['Asset ID', device.assetId], ['Purchase date', formatDate(device.purchaseDate, '')], ['Device status', device.deviceStatus], ['Corporate', user.company], ['Last service', formatDate(device.lastServiceDate, '')]]} />
        </Card>
        <Card title="Assignment">
          <InfoList columns={2} items={[['Employee', device.employeeName], ['Employee ID', device.employeeId], ['Department', device.department], ['Location', device.location]]} />
        </Card>
        <Card flush title="Service history" description="Every service request raised for this device">
          {tickets.length ? <ActivityList tickets={tickets} base="/corporate/service-requests" /> : <EmptyState compact icon={Ticket} title="No service history" description="Requests raised for this device will appear here." action={<Button size="sm" to={`/corporate/raise-request?device=${device._id}`}>Raise request</Button>} />}
        </Card>
      </div>
      <aside className="detail-side">
        <Card title="Coverage"><CoverageTiles device={device} /></Card>
      </aside>
    </div>
  </Shell>;
}

export function Tickets() {
  const [params] = useSearchParams();
  const state = useAsync(getTickets, []);
  const [filter, setFilter] = useState(params.get('status') || 'All');
  const [sla, setSla] = useState(params.get('sla') || 'All');
  const [search, setSearch] = useState(params.get('search') || '');
  useEffect(() => { setFilter(params.get('status') || 'All'); setSla(params.get('sla') || 'All'); }, [params]);
  const tickets = state.data || [];
  const visible = useMemo(() => tickets.filter(ticket => (filter === 'All' || ticket.status === filter) && (sla === 'All' || slaLabel(ticket) === sla || ticket.escalationStatus === sla) && JSON.stringify(ticket).toLowerCase().includes(search.toLowerCase())), [tickets, filter, sla, search]);
  const filtered = filter !== 'All' || sla !== 'All' || search;

  return <Shell title="Service Requests">
    <PageHeader title="Service Requests" description="Track every request raised for your organization's devices." actions={<Button variant="primary" icon={FilePlus2} to="/corporate/raise-request">Raise request</Button>} />
    <TableCard
      columns={9}
      loading={state.loading && !state.data}
      error={state.error && friendlyError(state.error)}
      errorTitle="Unable to load service requests"
      onRetry={state.reload}
      toolbar={<FilterBar summary={state.data ? `${visible.length} of ${tickets.length} requests` : null}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search request, serial or device" label="Search service requests" />
        <FilterSelect label="Status" value={filter} onChange={setFilter} options={ticketStatuses} allLabel="All statuses" />
        <FilterSelect label="SLA" value={sla} onChange={setSla} options={['Healthy', 'At Risk', 'Escalated', 'SLA Breached', 'Resolved']} allLabel="All SLA states" />
      </FilterBar>}
      isEmpty={!visible.length}
      empty={filtered && tickets.length
        ? <EmptyState icon={Search} title="No requests match these filters" description="Try a different search term or clear the filters." action={<Button size="sm" onClick={() => { setFilter('All'); setSla('All'); setSearch(''); }}>Clear filters</Button>} />
        : <EmptyState icon={Ticket} title="No service requests yet" description="When a request is raised, it will appear here." action={<Button variant="primary" size="sm" icon={FilePlus2} to="/corporate/raise-request">Raise request</Button>} />}
    >
      <TicketTable tickets={visible} />
    </TableCard>
  </Shell>;
}

function sessionExpiry() {
  try {
    const payload = JSON.parse(atob(localStorage.getItem('iplanet_token').split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.exp ? new Date(payload.exp * 1000) : null;
  } catch { return null; }
}

export function Profile() {
  const navigate = useNavigate();
  const state = useAsync(getProfile, []);
  if (state.loading && !state.data) return <Shell title="Profile"><PageSkeleton variant="detail" kpis={0} /></Shell>;
  if (state.error) return <Shell title="Profile"><PageHeader title="Profile" /><div className="card"><ErrorState title="Unable to load your profile" message={friendlyError(state.error)} onRetry={state.reload} /></div></Shell>;
  const profile = state.data;
  const company = profile.companyId && typeof profile.companyId === 'object' ? profile.companyId : {};
  const expires = sessionExpiry();
  const sections = [['personal', 'Personal information'], ['contact', 'Contact'], ['role', 'Role'], ['organization', 'Organization'], ['security', 'Security']];
  return <Shell title="Profile">
    <PageHeader title="Profile" description="Your account and organization details." />
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Profile sections">{sections.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</nav>
      <div className="settings-sections">
        <div className="card"><div className="card-body profile-banner">
          <Avatar name={profile.name} size={56} tone="accent" />
          <div><h2>{profile.name}</h2><p>{profile.company || company.name} · Corporate Admin</p></div>
        </div></div>
        <div id="personal" className="settings-section"><Card title="Personal information"><InfoList columns={2} items={[['Full name', profile.name], ['Email', profile.email]]} /></Card></div>
        <div id="contact" className="settings-section"><Card title="Contact"><InfoList columns={2} items={[['Email', profile.email], ['Phone', profile.phone]]} /></Card></div>
        <div id="role" className="settings-section"><Card title="Role" description="Your access level in iPlanetCare"><InfoList items={[['Role', <Badge tone="info">Corporate Admin</Badge>], ['Access', 'Devices, service requests, coverage, notifications and reviews for your organization']]} /></Card></div>
        <div id="organization" className="settings-section"><Card title="Organization"><InfoList columns={2} items={[['Company', profile.company || company.name], ['Company ID', company.companyId], ['Primary location', profile.primaryLocation], ['Managed devices', profile.numberOfDevices], ['Company contact', company.contactName], ['Contact email', company.contactEmail]]} /></Card></div>
        <div id="security" className="settings-section"><Card title="Security" actions={<Button icon={LogOut} onClick={() => { localStorage.clear(); navigate('/login', { replace: true }); }}>Sign out</Button>}>
          <InfoList items={[['Sign-in method', <span className="row"><KeyRound size={14} aria-hidden="true" />Email and password</span>], ['Current session expires', expires ? formatDateTime(expires) : null]]} />
        </Card></div>
      </div>
    </div>
  </Shell>;
}
