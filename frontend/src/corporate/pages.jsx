import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChevronLeft, FilePlus2, KeyRound, Laptop, LogOut, Search, ShieldCheck, Sparkles, Ticket, UserRoundPlus } from 'lucide-react';
import { Shell } from './components';
import { getCoverage, getDashboardStats, getDevice, getDevices, getMyReviews, getProfile, getTickets } from './api';
import {
  AllClear, AttentionList, Avatar, Badge, Button, DeviceIcon, DisclosureRow, EmptyState, ErrorState, FilterBar, FilterSelect, InfoList, Insight, JourneyTrack, NextAction,
  PageHeader, PageSkeleton, RowAction, SearchInput, Section, SectionHeader, Skeleton, Surface, TableCard, coverageExpiring, daysUntil, formatDate, formatDateTime, formatRelative, friendlyError, greeting,
  idOf, isActiveTicket, pluralize, readSessionUser, recurringIssues, riskLabel, riskTone, slaLabel, slaRisk, todayLabel, useAIAssistant, useAsync,
} from '../ui';

const ticketStatuses = ['Open', 'Engineer Assigned', 'Engineer Accepted', 'In Progress', 'Waiting for Parts', 'Completed', 'Closed'];
const toneRank = { critical: 0, warning: 1, info: 2, neutral: 3 };

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

// Builds the "needs your attention" feed from live records. Each item names
// the record it refers to and carries the single action that resolves it.
function corporateAttention({ tickets, devices, reviewedIds }) {
  const items = [];
  tickets.filter(slaRisk).forEach(ticket => {
    const risk = slaRisk(ticket);
    items.push({ key: `sla-${ticket._id}`, tone: riskTone(risk), kicker: riskLabel(risk), title: `${ticket.ticketId} · ${ticket.issueType || 'Service request'}`,
      detail: [ticket.deviceId?.model, ticket.slaTargetAt ? `Target ${formatDateTime(ticket.slaTargetAt)}` : null, ticket.assignedEngineerId ? `Engineer ${ticket.assignedEngineer}` : 'Awaiting engineer'].filter(Boolean).join(' · '),
      action: { label: 'Track request', to: `/corporate/service-requests/${ticket._id}` } });
  });
  recurringIssues(tickets).forEach(group => {
    items.push({ key: `rec-${group.deviceId}-${group.issueType}`, tone: 'warning', kicker: 'Recurring issue', title: group.device?.model || 'Device',
      detail: `${pluralize(group.count, `${group.issueType} request`)} in the last 90 days${group.device?.serialNumber ? ` · ${group.device.serialNumber}` : ''}`,
      action: { label: 'View device', to: `/corporate/devices/${group.deviceId}` } });
  });
  const expiring = devices.flatMap(device => coverageExpiring(device).map(item => ({ device, ...item }))).sort((a, b) => new Date(a.date) - new Date(b.date));
  expiring.slice(0, 3).forEach(({ device, kind, date }) => {
    const days = daysUntil(date);
    items.push({ key: `cov-${device._id}-${kind}`, tone: 'warning', kicker: `${kind} expiring`, title: device.model,
      detail: [device.serialNumber, date ? `Ends ${formatDate(date)}${days !== null && days >= 0 && days <= 365 ? ` · in ${pluralize(days, 'day')}` : ''}` : 'Expiry date not on record', device.employeeName].filter(Boolean).join(' · '),
      action: { label: 'View device', to: `/corporate/devices/${device._id}` } });
  });
  if (expiring.length > 3) items.push({ key: 'cov-more', tone: 'warning', kicker: 'Coverage expiring', title: `${pluralize(expiring.length - 3, 'more device')} with coverage expiring soon`, action: { label: 'View coverage', to: '/corporate/warranty?filter=Expiring%20Soon' } });
  const unassigned = devices.filter(device => device.deviceAllocationStatus === 'Unassigned');
  if (unassigned.length) items.push({ key: 'unassigned', tone: 'info', kicker: 'Unassigned devices', title: unassigned.length === 1 ? `${unassigned[0].model} is ready to assign` : `${unassigned.length} devices are ready to assign`, detail: 'Assign them to employees so service requests can be traced to a user.', action: { label: unassigned.length === 1 ? 'Assign device' : 'Assign devices', to: '/corporate/unassigned-devices' } });
  if (reviewedIds) {
    const awaiting = tickets.filter(ticket => ticket.status === 'Closed' && !reviewedIds.has(String(ticket._id)));
    if (awaiting.length === 1) items.push({ key: 'review', tone: 'info', kicker: 'Your feedback', title: `Rate the service for ${awaiting[0].ticketId}`, detail: [awaiting[0].issueType, awaiting[0].deviceId?.model].filter(Boolean).join(' · '), action: { label: 'Rate service', to: `/corporate/reviews/${awaiting[0]._id}` } });
    if (awaiting.length > 1) items.push({ key: 'review', tone: 'info', kicker: 'Your feedback', title: `${awaiting.length} closed requests are awaiting your review`, action: { label: 'Rate service', to: '/corporate/reviews' } });
  }
  return items.sort((a, b) => toneRank[a.tone] - toneRank[b.tone]);
}

export function Dashboard() {
  const user = readSessionUser();
  const ai = useAIAssistant();
  // Stats run first: that request re-evaluates SLA state server-side, so the
  // ticket list read afterwards reflects current escalation status.
  const main = useAsync(() => getDashboardStats().then(stats => getTickets().then(tickets => ({ stats, tickets }))), []);
  const coverage = useAsync(getCoverage, []);
  const reviews = useAsync(getMyReviews, []);

  if (main.loading && !main.data) return <Shell title="Overview"><PageSkeleton kpis={3} /></Shell>;
  if (main.error) return <Shell title="Overview"><PageHeader title="Overview" /><div className="card"><ErrorState title="Unable to load your service overview" message={friendlyError(main.error)} onRetry={main.reload} /></div></Shell>;

  const { stats, tickets } = main.data;
  const firstName = (user.name || '').split(' ')[0];
  const devices = coverage.data?.devices || [];
  const summary = coverage.data?.summary || {};
  const active = tickets.filter(isActiveTicket);
  const atRisk = active.filter(slaRisk);
  const inServiceIds = new Set(active.map(ticket => idOf(ticket.deviceId)));
  const inService = devices.filter(device => inServiceIds.has(String(device._id))).length;
  const unassigned = devices.filter(device => device.deviceAllocationStatus === 'Unassigned' && !inServiceIds.has(String(device._id))).length;
  const operating = Math.max(0, devices.length - inService - unassigned);
  const reviewedIds = reviews.data ? new Set(reviews.data.map(review => idOf(review.ticketId))) : null;
  const awaitingReview = reviewedIds ? tickets.filter(ticket => ticket.status === 'Closed' && !reviewedIds.has(String(ticket._id))).length : null;
  const attention = corporateAttention({ tickets, devices, reviewedIds });
  const recent = [...tickets].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)).slice(0, 5);
  const share = count => `${devices.length ? (count / devices.length) * 100 : 0}%`;

  return <Shell title="Overview">
    <div className="dashboard-intro">
      <div className="page-header-text">
        <p className="eyebrow">{todayLabel()}</p>
        <h1 className="page-title">{greeting()}{firstName ? `, ${firstName}` : ''}.</h1>
        <p className="page-description">Your service overview{user.company ? ` for ${user.company}` : ''}.</p>
      </div>
      <Button variant="primary" icon={FilePlus2} to="/corporate/raise-request">Raise request</Button>
    </div>

    <section className="overview-hero" aria-label="Fleet status">
      <div>
        <p className="overview-label">Fleet status</p>
        {coverage.loading && !coverage.data ? <div className="stack-12" style={{ marginTop: 12 }}><Skeleton width={180} height={52} /><Skeleton width="80%" /><Skeleton height={8} /></div>
          : coverage.error ? <ErrorState compact title="Device status unavailable" message={friendlyError(coverage.error)} onRetry={coverage.reload} />
          : !devices.length ? <EmptyState compact icon={Laptop} title="No devices registered yet" description="Devices enrolled by iPlanet Service for your organization will appear here." />
          : <>
            <div className="overview-figure"><strong>{operating}</strong><span>of {pluralize(devices.length, 'device')} operating normally</span></div>
            <p className="overview-caption">{inService ? `${pluralize(inService, 'device')} with iPlanet Service right now.` : 'No devices are currently in service.'}</p>
            <div className="split-bar" role="img" aria-label={`${operating} operating normally, ${inService} in service, ${unassigned} unassigned`}>
              <i className="tone-fill-success" style={{ width: share(operating) }} />
              <i className="tone-fill-info" style={{ width: share(inService) }} />
              <i className="tone-fill-neutral" style={{ width: share(unassigned) }} />
            </div>
            <div className="split-legend" aria-hidden="true">
              <span><i className="tone-fill-success" />Operating {operating}</span>
              <span><i className="tone-fill-info" />In service {inService}</span>
              <span><i className="tone-fill-neutral" />Unassigned {unassigned}</span>
            </div>
          </>}
      </div>
      <div>
        <div className="stat-list">
          <Link className={`stat-row ${atRisk.length ? 'stat-row-warning' : ''}`} to="/corporate/service-requests"><span>Active requests{atRisk.length ? <span className="stat-hint">{atRisk.length} need attention</span> : null}</span><strong>{active.length}</strong></Link>
          <Link className="stat-row" to="/corporate/service-requests?status=Closed"><span>Resolved<span className="stat-hint">Completed or closed</span></span><strong>{(stats.completedTickets || 0) + (stats.closedTickets || 0)}</strong></Link>
          <Link className={`stat-row ${summary.expiringSoon ? 'stat-row-warning' : ''}`} to="/corporate/warranty?filter=Expiring%20Soon"><span>Coverage expiring soon</span><strong>{coverage.data ? summary.expiringSoon : '—'}</strong></Link>
          <Link className="stat-row" to="/corporate/warranty?filter=Expired"><span>Coverage expired</span><strong>{coverage.data ? summary.expired : '—'}</strong></Link>
          {awaitingReview !== null && <Link className="stat-row" to="/corporate/reviews"><span>Awaiting your review</span><strong>{awaitingReview}</strong></Link>}
        </div>
      </div>
    </section>

    <section className="page-section" aria-labelledby="attention">
      <SectionHeader id="attention" title="Needs your attention" description={attention.length ? `${pluralize(attention.length, 'item')} to review` : undefined} />
      <div className="card card-flush">
        {coverage.loading && !coverage.data ? <div className="card-body stack-12"><Skeleton width="60%" /><Skeleton width="40%" /></div>
          : <AttentionList items={attention} empty={<AllClear>Nothing needs your attention. Every active request is within its service targets.</AllClear>} />}
      </div>
    </section>

    <section className="page-section" aria-labelledby="quick-actions">
      <SectionHeader id="quick-actions" title="Quick actions" />
      <div className="quick-links">
        <Link className="quick-link" to="/corporate/raise-request"><FilePlus2 size={16} aria-hidden="true" />Raise request</Link>
        <Link className="quick-link" to="/corporate/devices"><Search size={16} aria-hidden="true" />Find device</Link>
        <Link className="quick-link" to="/corporate/warranty"><ShieldCheck size={16} aria-hidden="true" />Check coverage</Link>
        <Link className="quick-link" to="/corporate/service-requests"><Ticket size={16} aria-hidden="true" />Track request</Link>
        {ai.available && <button type="button" className="quick-link" onClick={ai.open}><Sparkles size={16} aria-hidden="true" />Ask AI</button>}
      </div>
    </section>

    <section className="page-section" aria-labelledby="recent-activity">
      <SectionHeader id="recent-activity" title="Recent service" actions={tickets.length ? <Button variant="ghost" size="sm" to="/corporate/service-requests">View all</Button> : null} />
      <div className="card card-flush">
        {recent.length ? <ActivityList tickets={recent} base="/corporate/service-requests" />
          : <EmptyState compact icon={Ticket} title="No service requests yet" description="When your organization raises a request, its progress will appear here." action={<Button size="sm" variant="primary" icon={FilePlus2} to="/corporate/raise-request">Raise service request</Button>} />}
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
        <SearchInput value={search} onChange={setSearch} placeholder="Search serial, model, employee or asset ID" label="Search devices" />
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


function coverageLine(status, expiry) {
  if (!status) return <span className="text-muted">Not on record</span>;
  return <><Badge dot>{status}</Badge>{expiry && <small>{status === 'Expired' ? 'ended' : 'until'} {formatDate(expiry)}</small>}</>;
}

// Lifecycle stages come from the device record and its service requests only:
// enrolment (record exists), assignment, open service, and the last resolved
// request. Stages that haven't happened are shown as not reached, never dated.
function deviceLifecycle(device, tickets, activeTicket) {
  const assigned = device.deviceAllocationStatus === 'Assigned';
  const resolved = tickets.filter(ticket => ['Completed', 'Closed'].includes(ticket.status));
  const lastResolved = resolved.reduce((latest, ticket) => (!latest || new Date(ticket.updatedAt) > new Date(latest.updatedAt) ? ticket : latest), null);
  return [
    { key: 'enrolled', label: 'Enrolled', state: !assigned && !activeTicket ? 'current' : 'done', meta: !assigned && !activeTicket ? 'Awaiting assignment' : device.purchaseDate ? `Purchased ${formatDate(device.purchaseDate)}` : undefined },
    { key: 'assigned', label: 'Assigned', state: assigned ? 'done' : 'upcoming', meta: assigned ? device.employeeName : 'Not assigned yet' },
    { key: 'service', label: 'In service', state: activeTicket ? (activeTicket.status === 'Waiting for Parts' ? 'hold' : 'current') : tickets.length ? 'done' : 'skip', meta: activeTicket ? `${activeTicket.ticketId} · ${activeTicket.status}` : tickets.length ? pluralize(tickets.length, 'request') : 'No service so far' },
    { key: 'repaired', label: 'Repaired', state: lastResolved && !activeTicket ? 'done' : activeTicket ? 'upcoming' : 'skip', meta: lastResolved ? `Last ${formatDate(lastResolved.updatedAt)}` : undefined },
    { key: 'active', label: 'Active', state: assigned && !activeTicket ? 'current' : 'upcoming', meta: assigned && !activeTicket ? 'In use' : undefined },
  ];
}

function deviceNextAction(device, activeTicket) {
  if (activeTicket) {
    const risk = slaRisk(activeTicket);
    return { tone: risk ? riskTone(risk) : 'info', eyebrow: risk ? riskLabel(risk) : 'In service', title: `${activeTicket.issueType || 'Service request'} · ${activeTicket.status}`,
      description: [activeTicket.assignedEngineer ? `Engineer ${activeTicket.assignedEngineer}` : 'iPlanet Service will assign an engineer', activeTicket.slaTargetAt ? `target ${formatDateTime(activeTicket.slaTargetAt)}` : null].filter(Boolean).join(' · '),
      actions: [{ label: 'Track request', icon: Ticket, to: `/corporate/service-requests/${activeTicket._id}` }] };
  }
  if (device.deviceAllocationStatus === 'Unassigned') return { tone: 'info', title: 'Assign this device to an employee', description: 'Assigned devices can be traced to the person using them when service is needed.', actions: [{ label: 'Assign device', icon: UserRoundPlus, to: '/corporate/unassigned-devices' }] };
  const covered = ['Active', 'Expiring Soon'].includes(device.warrantyStatus) || ['Active', 'Expiring Soon'].includes(device.amcStatus);
  if (!covered && (device.warrantyStatus || device.amcStatus)) return { tone: 'warning', eyebrow: 'Coverage', title: 'No active warranty or AMC', description: `Warranty ${String(device.warrantyStatus || 'not on record').toLowerCase()} · AMC ${String(device.amcStatus || 'not on record').toLowerCase()}.`, actions: [{ label: 'View coverage', icon: ShieldCheck, to: '/corporate/warranty' }] };
  const expiring = coverageExpiring(device);
  if (expiring.length) return { tone: 'warning', eyebrow: 'Coverage', title: `${expiring.map(item => item.kind).join(' and ')} expiring soon`, description: expiring.map(item => `${item.kind} ends ${formatDate(item.date)}`).join(' · '), actions: [{ label: 'View coverage', icon: ShieldCheck, to: '/corporate/warranty?filter=Expiring%20Soon' }] };
  return { tone: 'success', eyebrow: 'Status', title: 'Operating normally', description: `No open service requests. Assigned to ${device.employeeName || 'an employee'}.` };
}

export function DeviceDetail() {
  const { id } = useParams();
  const user = readSessionUser();
  const ai = useAIAssistant();
  const state = useAsync(() => Promise.all([getDevice(id), getTickets()]).then(([device, all]) => ({ device, tickets: all.filter(ticket => idOf(ticket.deviceId) === id) })), [id]);
  const crumbs = [{ label: 'Devices', to: '/corporate/devices' }, { label: state.data?.device?.model || 'Device details' }];
  if (state.loading && !state.data) return <Shell title="Device details" crumbs={crumbs}><PageSkeleton variant="detail" kpis={0} /></Shell>;
  if (state.error) return <Shell title="Device details" crumbs={crumbs}><PageHeader title="Device details" back={{ to: '/corporate/devices', label: 'Devices' }} /><div className="card"><ErrorState title={state.error.status === 404 ? 'Device not found' : 'Unable to load this device'} message={friendlyError(state.error)} onRetry={state.reload} /></div></Shell>;

  const { device, tickets } = state.data;
  const activeTicket = tickets.find(isActiveTicket);
  const unassigned = device.deviceAllocationStatus === 'Unassigned';
  const allocation = activeTicket ? 'Under Service' : unassigned ? 'Unassigned' : 'Assigned';
  const recurring = recurringIssues(tickets, { windowDays: 0 });
  const next = deviceNextAction(device, activeTicket);

  return <Shell title={device.model} crumbs={crumbs}>
    <div className="page-header asset-hero">
      <Link className="back-link" to="/corporate/devices"><ChevronLeft size={16} aria-hidden="true" />Devices</Link>
      <div className="asset-header">
        <div className="asset-identity">
          <span className="asset-icon"><DeviceIcon type={device.deviceType} model={device.model} size={30} /></span>
          <div className="page-header-text">
            <p className="eyebrow">Device passport{device.deviceType ? ` · ${device.deviceType}` : ''}</p>
            <h1 className="page-title">{device.model}</h1>
            <div className="page-meta"><span>Serial <span className="mono">{device.serialNumber}</span></span><span className="meta-sep" /><Badge dot tone={allocation === 'Under Service' ? 'warning' : allocation === 'Unassigned' ? 'neutral' : 'success'}>{allocation}</Badge></div>
          </div>
        </div>
        <div className="page-actions">
          {ai.available && <Button icon={Sparkles} onClick={ai.open}>Ask AI about this device</Button>}
          <Button variant="primary" icon={FilePlus2} to={`/corporate/raise-request?device=${device._id}`}>Raise request</Button>
        </div>
      </div>
    </div>

    <NextAction {...next} />

    <section className="passport" aria-label="Device facts">
      {[
        ['Serial number', <span className="mono">{device.serialNumber}</span>],
        ['Asset ID', device.assetId || <span className="text-muted">Not on record</span>],
        ['Corporate', user.company || <span className="text-muted">Not on record</span>],
        ['Employee', device.employeeName ? <>{device.employeeName}{device.employeeId && <small>{device.employeeId}</small>}</> : <span className="text-muted">Not assigned</span>],
        ['Location', device.location || <span className="text-muted">Not on record</span>],
        ['Warranty', coverageLine(device.warrantyStatus, device.warrantyExpiry)],
        ['AMC', coverageLine(device.amcStatus, device.amcExpiry)],
        ['Current status', <><Badge dot tone={allocation === 'Under Service' ? 'warning' : allocation === 'Unassigned' ? 'neutral' : 'success'}>{allocation}</Badge>{device.deviceStatus && <small>{device.deviceStatus}</small>}</>],
      ].map(([label, value]) => <div className="passport-cell" key={label}><span className="passport-label">{label}</span><span className="passport-value">{value}</span></div>)}
    </section>

    <Surface label="Device lifecycle and service">
      <Section title="Lifecycle" description="Where this device is today">
        <JourneyTrack orientation="horizontal" label="Device lifecycle" steps={deviceLifecycle(device, tickets, activeTicket)} />
      </Section>
      <Section title="Service history" description={tickets.length ? `${pluralize(tickets.length, 'request')} raised for this device` : 'No requests raised yet'}>
        <div className="stack-16" id="service-history">
          {recurring.map(group => <Insight key={group.issueType} title={`${pluralize(group.count, `${group.issueType} request`)} for this device`}>
            Raised on {group.tickets.map(ticket => formatDate(ticket.createdAt)).join(', ')}. A repeating issue may point to an underlying fault worth raising with iPlanet Service.
          </Insight>)}
          {tickets.length ? <ul className="disclosure-list">{tickets.map(ticket => <DisclosureRow key={ticket._id} summary={<span className="history-summary">
            <span className="history-date">{formatDate(ticket.createdAt)}</span>
            <span className="history-title"><strong>{ticket.issueType || 'Service request'}</strong><small><span className="mono">{ticket.ticketId}</span>{ticket.category ? ` · ${ticket.category}` : ''}</small></span>
            <Badge dot>{ticket.status}</Badge>
          </span>}>
            {ticket.description && <p className="description-text" style={{ fontSize: 15 }}>{ticket.description}</p>}
            <InfoList columns={2} items={[['Engineer', ticket.assignedEngineer || 'Not assigned'], ['Priority', ticket.priority], ['Service location', ticket.location], ['Last updated', formatDateTime(ticket.updatedAt, '')]]} />
            <div><RowAction to={`/corporate/service-requests/${ticket._id}`} label="Open request" /></div>
          </DisclosureRow>)}</ul>
            : <EmptyState compact icon={Ticket} title="No service requests for this device" description="If something isn't working, raise a request and iPlanet Service will take it from there." action={<Button size="sm" icon={FilePlus2} to={`/corporate/raise-request?device=${device._id}`}>Raise request</Button>} />}
        </div>
      </Section>
      <Section title="Device record" description="Hardware and purchase details">
        <InfoList columns={2} items={[['Model', device.model], ['Device type', device.deviceType], ['Purchase date', formatDate(device.purchaseDate, '')], ['Department', device.department], ['Employee ID', device.employeeId], ['Last service', formatDate(device.lastServiceDate, '')]]} />
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
        <SearchInput value={search} onChange={setSearch} placeholder="Search ticket ID, device or serial" label="Search service requests" />
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
      <Section title="Role" description="Your access in iPlanet Self-care Portal"><InfoList items={[['Role', <Badge tone="info">Corporate Admin</Badge>], ['Access', 'Devices, service requests, coverage, notifications and reviews for your organization']]} /></Section>
      <Section title="Organization"><InfoList columns={2} items={[['Company', profile.company || company.name], ['Company ID', company.companyId], ['Primary location', profile.primaryLocation], ['Managed devices', profile.numberOfDevices], ['Company contact', company.contactName], ['Contact email', company.contactEmail]]} /></Section>
      <Section title="Security" actions={<Button size="sm" icon={LogOut} onClick={() => { localStorage.clear(); navigate('/login', { replace: true }); }}>Sign out</Button>}>
        <InfoList items={[['Sign-in method', <span className="row"><KeyRound size={14} aria-hidden="true" />Email and password</span>], ['Current session expires', expires ? formatDateTime(expires) : null]]} />
      </Section>
    </Surface>
  </Shell>;
}
