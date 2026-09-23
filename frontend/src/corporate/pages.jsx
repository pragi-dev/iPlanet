import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, ChevronLeft, ChevronRight, Clock3, FilePlus2, KeyRound, Laptop, LogOut, Search, ShieldCheck, Star, Ticket, UserRoundPlus } from 'lucide-react';
import { Shell } from './components';
import { getCoverage, getDashboard, getDevice, getDevices, getMyReviews, getProfile, getTickets } from './api';
import {
  Avatar, Badge, Button, CoverageTiles, DeviceIcon, EmptyState, ErrorState, FilterBar, FilterSelect, InfoList, KPI, KPIGrid,
  PageHeader, PageSkeleton, RowAction, SearchInput, Section, SectionHeader, Surface, TableCard, formatDate, formatDateTime, formatRelative, friendlyError, greeting,
  readSessionUser, slaLabel, statusTone, todayLabel, useAsync,
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

  if (main.loading && !main.data) return <Shell title="Dashboard"><PageSkeleton kpis={4} /></Shell>;
  if (main.error) return <Shell title="Dashboard"><PageHeader title="Dashboard" /><div className="card"><ErrorState title="Unable to load your dashboard" message={friendlyError(main.error)} onRetry={main.reload} /></div></Shell>;

  const { stats: s, tickets } = main.data;
  const firstName = (user.name || '').split(' ')[0];
  const activeTickets = tickets.filter(ticket => activeStatuses.includes(ticket.status));
  const needsAttention = activeTickets.filter(ticket => ['At Risk', 'SLA Breached', 'Escalated'].includes(slaLabel(ticket)) || ['At Risk', 'SLA Breached', 'Escalated'].includes(ticket.escalationStatus));
  const devices = coverage.data?.devices || [];
  const summary = coverage.data?.summary || {};
  const unassigned = devices.filter(device => device.deviceAllocationStatus === 'Unassigned').length;
  const reviewedIds = new Set((reviews.data || []).map(review => String(review.ticketId?._id || review.ticketId)));
  const awaitingReview = reviews.data ? tickets.filter(ticket => ticket.status === 'Closed' && !reviewedIds.has(String(ticket._id))).length : 0;
  const attention = [
    needsAttention.length > 0 && { to: '/corporate/service-requests', tone: needsAttention.some(ticket => slaLabel(ticket) === 'SLA Breached' || ticket.escalationStatus === 'SLA Breached') ? 'critical' : 'warning', icon: Clock3, title: 'Requests outside SLA targets', detail: 'At risk, escalated or breached', count: needsAttention.length },
    unassigned > 0 && { to: '/corporate/unassigned-devices', tone: 'info', icon: UserRoundPlus, title: 'Devices awaiting assignment', detail: 'Ready to be assigned to an employee', count: unassigned },
    awaitingReview > 0 && { to: '/corporate/reviews', tone: 'info', icon: Star, title: 'Awaiting your review', detail: 'Closed requests you can rate', count: awaitingReview },
  ].filter(Boolean);
  const pct = (part, total) => (total ? Math.round((part / total) * 100) : 0);
  const recent = [...tickets].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)).slice(0, 5);

  return <Shell title="Dashboard">
    <div className="dashboard-intro">
      <div className="page-header-text">
        <p className="eyebrow">{todayLabel()}</p>
        <h1 className="page-title">{greeting()}{firstName ? `, ${firstName}` : ''}.</h1>
        <p className="page-description">Here's what's happening with your organization's devices and services.</p>
      </div>
      <Button variant="primary" icon={FilePlus2} to="/corporate/raise-request">Raise request</Button>
    </div>

    <KPIGrid columns={4}>
      <KPI label="Open requests" value={s.openTickets} to="/corporate/service-requests?status=Open" tone={needsAttention.length ? 'warning' : 'neutral'} hint={needsAttention.length ? `${needsAttention.length} outside SLA targets` : 'All within SLA'} />
      <KPI label="In progress" value={s.inProgress} to="/corporate/service-requests?status=In%20Progress" hint="With iPlanet engineers" />
      <KPI label="Completed" value={s.completedTickets + s.closedTickets} to="/corporate/service-requests?status=Closed" hint={`${s.closedTickets} closed`} />
      <KPI label="Devices" value={s.totalDevices} to="/corporate/devices" hint={coverage.data ? `${unassigned} unassigned` : undefined} />
    </KPIGrid>

    <section className="page-section" aria-labelledby="quick-actions">
      <SectionHeader id="quick-actions" title="Quick actions" />
      <div className="quick-actions">
        {[
          ['/corporate/raise-request', FilePlus2, 'Raise request', 'Service, health camp, buyback or e-waste'],
          ['/corporate/devices', Search, 'Find device', 'Search by serial or employee'],
          ['/corporate/service-requests', Ticket, 'Track service', 'Follow every request'],
          ['/corporate/warranty', ShieldCheck, 'Check coverage', 'Warranty and AMC status'],
        ].map(([to, Icon, label, hint]) => <Link key={to} to={to} className="quick-action"><span className="quick-action-icon" aria-hidden="true"><Icon size={17} /></span><span>{label}<small>{hint}</small></span></Link>)}
      </div>
    </section>

    <section className="page-section" aria-labelledby="active-service">
      <SectionHeader id="active-service" title="Active service" description={activeTickets.length ? `${activeTickets.length} request${activeTickets.length === 1 ? '' : 's'} in progress with iPlanet Service` : undefined} actions={<Button variant="ghost" size="sm" to="/corporate/service-requests">View all</Button>} />
      <div className="card card-flush">
        {attention.length > 0 && <div className="attention-list" style={{ borderBottom: '1px solid var(--color-divider)' }}>{attention.map(item => <AttentionRow key={item.title} {...item} />)}</div>}
        {activeTickets.length ? <ul className="activity-list">{activeTickets.slice(0, 6).map(ticket => <li key={ticket._id}><Link to={`/corporate/service-requests/${ticket._id}`} className="activity-item">
          <span className="activity-title"><span>{ticket.deviceId?.model || 'Device'}</span><span className="mono">{ticket.ticketId}</span></span>
          <span className="activity-sub">{[ticket.issueType, ticket.assignedEngineer ? `Engineer ${ticket.assignedEngineer}` : 'Awaiting engineer'].filter(Boolean).join(' · ')}</span>
          <span className="activity-side"><Badge dot>{ticket.status}</Badge>{slaLabel(ticket) !== 'Healthy' && <Badge>{slaLabel(ticket)}</Badge>}</span>
        </Link></li>)}</ul>
          : <EmptyState compact icon={CheckCircle2} title="No active service requests" description="Requests you raise will be tracked here until they're closed." action={<Button size="sm" to="/corporate/raise-request">Raise request</Button>} />}
      </div>
    </section>

    <section className="page-section" aria-labelledby="coverage-overview">
      <SectionHeader id="coverage-overview" title="Coverage" description={coverage.data ? `${summary.total} registered device${summary.total === 1 ? '' : 's'}` : undefined} actions={<Button variant="ghost" size="sm" to="/corporate/warranty">View coverage</Button>} />
      <div className="card">
        {coverage.loading && !coverage.data ? <div className="card-body"><div className="skeleton" style={{ height: 88 }} /></div>
          : coverage.error ? <ErrorState compact title="Coverage unavailable" message={friendlyError(coverage.error)} onRetry={coverage.reload} />
          : <div className="coverage-summary">
            <div><span>Warranty active</span><strong>{summary.warrantyActive}</strong><span>{pct(summary.warrantyActive, summary.total)}% of devices</span><div className="meter" aria-hidden="true"><i style={{ width: `${pct(summary.warrantyActive, summary.total)}%` }} /></div></div>
            <div><span>AMC active</span><strong>{summary.amcActive}</strong><span>{pct(summary.amcActive, summary.total)}% of devices</span><div className="meter" aria-hidden="true"><i style={{ width: `${pct(summary.amcActive, summary.total)}%` }} /></div></div>
            <div><span>Expiring soon</span><strong style={summary.expiringSoon ? { color: 'var(--color-warning-text)' } : undefined}>{summary.expiringSoon}</strong><span>{summary.expired ? `${summary.expired} already expired` : 'None expired'}</span></div>
          </div>}
      </div>
    </section>

    <section className="page-section" aria-labelledby="recent-activity">
      <SectionHeader id="recent-activity" title="Recent activity" />
      <div className="card card-flush">
        {recent.length ? <ActivityList tickets={recent} base="/corporate/service-requests" /> : <EmptyState compact icon={Ticket} title="No service activity yet" description="When a request is raised, its progress appears here." />}
      </div>
    </section>
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
          <td><div className="person-cell"><span className="thumb"><DeviceIcon type={device.deviceType} model={device.model} size={16} /></span><div><Link className="cell-link" to={`/corporate/devices/${device._id}`}>{device.model}</Link><span className="cell-sub">{[device.assetId, device.deviceType].filter(Boolean).join(' · ')}</span></div></div></td>
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
  if (state.loading && !state.data) return <Shell title="Device details" crumbs={crumbs}><PageSkeleton variant="detail" kpis={0} /></Shell>;
  if (state.error) return <Shell title="Device details" crumbs={crumbs}><PageHeader title="Device details" back={{ to: '/corporate/devices', label: 'Devices' }} /><div className="card"><ErrorState title="Unable to load this device" message={friendlyError(state.error)} onRetry={state.reload} /></div></Shell>;

  const { device, tickets } = state.data;
  const activeTicket = tickets.find(ticket => activeStatuses.includes(ticket.status));
  const unassigned = device.deviceAllocationStatus === 'Unassigned';
  const allocation = activeTicket ? 'Under Service' : unassigned ? 'Unassigned' : 'Assigned';
  return <Shell title={device.model} crumbs={crumbs}>
    <div className="page-header asset-hero">
      <Link className="back-link" to="/corporate/devices"><ChevronLeft size={16} aria-hidden="true" />Devices</Link>
      <div className="asset-header">
        <div className="asset-identity">
          <span className="asset-icon"><DeviceIcon type={device.deviceType} model={device.model} size={30} /></span>
          <div className="page-header-text">
            <p className="eyebrow">Corporate device{device.deviceType ? ` · ${device.deviceType}` : ''}</p>
            <h1 className="page-title">{device.model}</h1>
            <div className="page-meta"><span>Serial <span className="mono">{device.serialNumber}</span></span><span className="meta-sep" /><Badge dot tone={allocation === 'Under Service' ? 'warning' : allocation === 'Unassigned' ? 'neutral' : 'success'}>{allocation}</Badge></div>
          </div>
        </div>
        <div className="page-actions">
          {unassigned && <Button icon={UserRoundPlus} to="/corporate/unassigned-devices">Assign device</Button>}
          {activeTicket && <Button icon={Ticket} to={`/corporate/service-requests/${activeTicket._id}`}>View ticket</Button>}
          <Button variant="primary" icon={FilePlus2} to={`/corporate/raise-request?device=${device._id}`}>Raise request</Button>
        </div>
      </div>
    </div>

    <Surface label="Device profile">
      <Section title="Device" description="Hardware and purchase record">
        <InfoList columns={2} items={[['Model', device.model], ['Serial number', <span className="mono">{device.serialNumber}</span>], ['Device type', device.deviceType], ['Asset ID', device.assetId], ['Purchase date', formatDate(device.purchaseDate, '')], ['Location', device.location], ['Device status', device.deviceStatus], ['Corporate', user.company]]} />
      </Section>
      <Section title="Current assignment" description={unassigned ? 'This device is not assigned to an employee.' : 'The employee using this device'} actions={unassigned ? <Button size="sm" icon={UserRoundPlus} to="/corporate/unassigned-devices">Assign device</Button> : null}>
        <InfoList columns={2} items={[['Employee', device.employeeName], ['Employee ID', device.employeeId], ['Department', device.department], ['Location', device.location]]} />
      </Section>
      <Section title="Coverage" description="Warranty and AMC validity">
        <CoverageTiles device={device} />
      </Section>
      <Section title="Service history" description={tickets.length ? `${tickets.length} request${tickets.length === 1 ? '' : 's'} raised for this device` : 'No requests raised yet'} actions={<Button size="sm" variant="ghost" to={`/corporate/raise-request?device=${device._id}`}>Raise request</Button>}>
        {tickets.length ? <ol className="timeline">{tickets.map((ticket, index) => <li key={ticket._id} className={`timeline-item timeline-${statusTone(ticket.status)} ${index === 0 ? 'timeline-latest' : ''}`}>
          <span className="timeline-marker" aria-hidden="true" />
          <div className="timeline-content">
            <Link className="timeline-title" to={`/corporate/service-requests/${ticket._id}`}>{ticket.issueType || 'Service request'}</Link>
            <p className="timeline-text"><span className="mono">{ticket.ticketId}</span> · {ticket.status}{ticket.assignedEngineer ? ` · ${ticket.assignedEngineer}` : ''}</p>
            <p className="timeline-meta"><time dateTime={ticket.createdAt}>{formatDateTime(ticket.createdAt)}</time></p>
          </div>
        </li>)}</ol> : <p className="text-muted">Service requests raised for this device will appear here.</p>}
      </Section>
    </Surface>
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
  return <Shell title="Profile">
    <div className="profile-banner">
      <Avatar name={profile.name} size={72} tone="accent" />
      <div className="page-header-text">
        <h1 className="page-title">{profile.name}</h1>
        <p className="page-description">{profile.company || company.name} · Corporate Admin</p>
      </div>
    </div>
    <Surface label="Account">
      <Section title="Personal information"><InfoList columns={2} items={[['Full name', profile.name], ['Email', profile.email]]} /></Section>
      <Section title="Contact"><InfoList columns={2} items={[['Email', profile.email], ['Phone', profile.phone]]} /></Section>
      <Section title="Role" description="Your access in iPlanetCare"><InfoList items={[['Role', <Badge tone="info">Corporate Admin</Badge>], ['Access', 'Devices, service requests, coverage, notifications and reviews for your organization']]} /></Section>
      <Section title="Organization"><InfoList columns={2} items={[['Company', profile.company || company.name], ['Company ID', company.companyId], ['Primary location', profile.primaryLocation], ['Managed devices', profile.numberOfDevices], ['Company contact', company.contactName], ['Contact email', company.contactEmail]]} /></Section>
      <Section title="Security" actions={<Button size="sm" icon={LogOut} onClick={() => { localStorage.clear(); navigate('/login', { replace: true }); }}>Sign out</Button>}>
        <InfoList items={[['Sign-in method', <span className="row"><KeyRound size={14} aria-hidden="true" />Email and password</span>], ['Current session expires', expires ? formatDateTime(expires) : null]]} />
      </Section>
    </Surface>
  </Shell>;
}
