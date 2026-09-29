import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChevronLeft, FilePlus2, KeyRound, Laptop, LogOut, Search, ShieldCheck, Sparkles, Ticket, UserRoundPlus } from 'lucide-react';
import { Shell } from './components';
import { getCoverage, getDashboardStats, getDevice, getDevices, getMyReviews, getProfile, getTickets } from './api';
import {
  ActivityFeed, AttentionFeed, Avatar, Badge, Button, CalmState, DashboardHeader, DashboardSection, DeviceIcon, DisclosureRow, EmptyState, ErrorState, FilterBar, FilterSelect, HealthRing, InfoList, Insight, JourneyTrack,
  MetricSummary, NextAction, PageHeader, PageSkeleton, QuickActions, RowAction, SearchInput, Section, Skeleton, Surface, TableCard, coverageExpiring, daysUntil, formatDate, formatDateTime, formatRelative, friendlyError, greeting,
  idOf, isActiveTicket, issueClusters, pluralize, readSessionUser, recurringIssues, riskLabel, riskTone, slaCountdown, slaLabel, slaRisk, todayLabel, useAIAssistant, useAsync,
} from '../ui';

const ticketStatuses = ['Open', 'Engineer Assigned', 'Engineer Accepted', 'In Progress', 'Waiting for Parts', 'Completed', 'Closed'];
const toneRank = { critical: 0, warning: 1, info: 2, neutral: 3 };

// A device is healthy when it has no active service request, no recurring
// issue (same issue type twice in 90 days) and no warranty/AMC expiring soon.
// Every figure is a count of device records; nothing is scored or weighted.
function fleetHealth({ devices, tickets }) {
  const inServiceIds = new Set(tickets.filter(isActiveTicket).map(ticket => idOf(ticket.deviceId)));
  const flaggedIds = new Set(recurringIssues(tickets).map(group => group.deviceId));
  devices.forEach(device => { if (coverageExpiring(device).length) flaggedIds.add(String(device._id)); });
  const inService = devices.filter(device => inServiceIds.has(String(device._id)));
  const attention = devices.filter(device => !inServiceIds.has(String(device._id)) && flaggedIds.has(String(device._id)));
  const unassigned = devices.filter(device => device.deviceAllocationStatus === 'Unassigned' && !inServiceIds.has(String(device._id)));
  return {
    total: devices.length,
    healthy: devices.length - inService.length - attention.length,
    inService: inService.length,
    attention: attention.length,
    unassigned: unassigned.length,
    inUse: devices.length - inService.length - unassigned.length,
  };
}

// Why an at-risk request is at risk, in the customer's terms.
function requestReason(ticket) {
  if (ticket.escalationStatus === 'Escalated') return 'iPlanet has escalated this request to its service management team.';
  if (!ticket.assignedEngineerId) return 'iPlanet has not assigned an engineer yet.';
  if (ticket.status === 'Engineer Assigned') return `${ticket.assignedEngineer || 'The engineer'} has not accepted the request yet.`;
  if (ticket.status === 'Engineer Accepted') return `${ticket.assignedEngineer || 'The engineer'} has accepted but not started work.`;
  if (ticket.status === 'Waiting for Parts') return 'The repair is paused while replacement parts arrive.';
  return `The repair is in progress with ${ticket.assignedEngineer || 'the assigned engineer'}.`;
}

function slaMeta(ticket) {
  const countdown = slaCountdown(ticket);
  if (!countdown) return null;
  return countdown.overdue ? `Target passed ${countdown.text} ago` : `Target in ${countdown.text}`;
}

// Builds the "needs your attention" feed from live records. Each item says
// what needs attention, why, and carries the one action that resolves it.
function corporateAttention({ tickets, devices, reviewedIds }) {
  const items = [];
  tickets.filter(slaRisk).sort((a, b) => new Date(a.slaTargetAt) - new Date(b.slaTargetAt)).forEach(ticket => {
    const risk = slaRisk(ticket);
    items.push({ key: `sla-${ticket._id}`, tone: riskTone(risk), category: riskLabel(risk), meta: slaMeta(ticket), title: `${ticket.ticketId} · ${ticket.issueType || 'Service request'}`,
      reason: requestReason(ticket), context: [ticket.deviceId?.model, ticket.deviceId?.serialNumber, ticket.deviceId?.employeeName].filter(Boolean).join(' · '),
      action: { label: 'Track request', to: `/corporate/service-requests/${ticket._id}` } });
  });
  recurringIssues(tickets).forEach(group => {
    items.push({ key: `rec-${group.deviceId}-${group.issueType}`, tone: 'warning', category: 'Recurring issue', meta: `Last reported ${formatRelative(new Date(group.lastAt))}`,
      title: [group.device?.model || 'Device', group.device?.employeeName].filter(Boolean).join(' · '),
      reason: `${pluralize(group.count, `${group.issueType.toLowerCase()} request`)} in the last 90 days.`,
      context: group.device?.serialNumber, action: { label: 'View device', to: `/corporate/devices/${group.deviceId}` } });
  });
  const expiring = devices.flatMap(device => coverageExpiring(device).map(item => ({ device, ...item }))).sort((a, b) => new Date(a.date) - new Date(b.date));
  const expiringDevices = new Set(expiring.map(item => String(item.device._id))).size;
  if (expiringDevices === 1) {
    const [{ device, kind, date }] = expiring;
    const days = daysUntil(date);
    items.push({ key: `cov-${device._id}`, tone: 'warning', category: 'Coverage expiring', meta: days !== null && days >= 0 ? `In ${pluralize(days, 'day')}` : null, title: device.model,
      reason: date ? `${kind} ends on ${formatDate(date)}. Renew to keep repairs and parts covered.` : `${kind} is expiring soon. Renew to keep repairs and parts covered.`,
      context: [device.serialNumber, device.employeeName].filter(Boolean).join(' · '), action: { label: 'Review coverage', to: `/corporate/devices/${device._id}` } });
  } else if (expiringDevices > 1) {
    const [first] = expiring;
    items.push({ key: 'cov-many', tone: 'warning', category: 'Coverage expiring', title: `${expiringDevices} devices`,
      reason: `Warranty or AMC is expiring soon${first.date ? ` — the first ends on ${formatDate(first.date)} (${first.device.model})` : ''}.`,
      action: { label: 'Review coverage', to: '/corporate/warranty?filter=Expiring%20Soon' } });
  }
  const unassigned = devices.filter(device => device.deviceAllocationStatus === 'Unassigned');
  if (unassigned.length) items.push({ key: 'unassigned', tone: 'info', category: 'Unassigned devices',
    title: unassigned.length === 1 ? `${unassigned[0].model} is not assigned to an employee` : `${unassigned.length} devices are not assigned to employees`,
    reason: 'Assign them so service requests can be traced to the person using the device.',
    context: unassigned.length > 1 ? unassigned.slice(0, 3).map(device => device.model).join(', ') + (unassigned.length > 3 ? ` and ${unassigned.length - 3} more` : '') : unassigned[0].serialNumber,
    action: { label: unassigned.length === 1 ? 'Assign device' : 'Assign devices', to: '/corporate/unassigned-devices' } });
  if (reviewedIds) {
    const awaiting = tickets.filter(ticket => ticket.status === 'Closed' && !reviewedIds.has(String(ticket._id)));
    if (awaiting.length === 1) items.push({ key: 'review', tone: 'info', category: 'Your feedback', title: `${awaiting[0].ticketId} · ${awaiting[0].issueType || 'Service request'}`,
      reason: 'This request is closed. Rate the service to let iPlanet know how it went.', context: awaiting[0].deviceId?.model, action: { label: 'Rate service', to: `/corporate/reviews/${awaiting[0]._id}` } });
    if (awaiting.length > 1) items.push({ key: 'review', tone: 'info', category: 'Your feedback', title: `${awaiting.length} closed requests`,
      reason: 'These requests are closed. Rate the service to let iPlanet know how it went.', action: { label: 'Rate service', to: '/corporate/reviews' } });
  }
  return items.sort((a, b) => toneRank[a.tone] - toneRank[b.tone]);
}

function fleetSummary(health, attentionCount, activeCount) {
  if (!health.total) return 'No devices are registered for your organization yet.';
  return <>
    <strong>{health.healthy} of {pluralize(health.total, 'device')}</strong> {health.healthy === 1 ? 'is' : 'are'} healthy{activeCount ? `, with ${pluralize(activeCount, 'request')} in service` : ''}.{' '}
    {attentionCount ? <><strong>{pluralize(attentionCount, 'item')}</strong> {attentionCount === 1 ? 'needs' : 'need'} your attention.</> : 'Nothing needs your attention.'}
  </>;
}

export function Dashboard() {
  const user = readSessionUser();
  const ai = useAIAssistant();
  // Stats run first: that request re-evaluates SLA state server-side, so the
  // ticket list read afterwards reflects current escalation status.
  const main = useAsync(() => getDashboardStats().then(() => getTickets()), []);
  const coverage = useAsync(getCoverage, []);
  const reviews = useAsync(getMyReviews, []);

  if (main.loading && !main.data) return <Shell title="Overview"><PageSkeleton kpis={3} /></Shell>;
  if (main.error) return <Shell title="Overview"><PageHeader title="Overview" /><div className="card"><ErrorState title="Unable to load your service overview" message={friendlyError(main.error)} onRetry={main.reload} /></div></Shell>;

  const tickets = main.data;
  const firstName = (user.name || '').split(' ')[0];
  const devices = coverage.data?.devices || [];
  const summary = coverage.data?.summary || {};
  const coverageReady = Boolean(coverage.data);
  const active = tickets.filter(isActiveTicket);
  const atRisk = active.filter(slaRisk);
  const health = fleetHealth({ devices, tickets });
  const reviewedIds = reviews.data ? new Set(reviews.data.map(review => idOf(review.ticketId))) : null;
  const attention = coverageReady ? corporateAttention({ tickets, devices, reviewedIds }) : [];
  const recent = [...tickets].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)).slice(0, 5);
  const [cluster] = issueClusters(tickets);
  const ringTone = health.total && health.healthy / health.total < 0.6 ? 'warning' : 'success';

  return <Shell title="Overview">
    <div className="cc-page">
      <DashboardHeader
        eyebrow={todayLabel()}
        title={`${greeting()}${firstName ? `, ${firstName}` : ''}`}
        summary={coverageReady ? fleetSummary(health, attention.length, active.length) : `Your service overview${user.company ? ` for ${user.company}` : ''}.`}
        actions={<Button variant="primary" icon={FilePlus2} to="/corporate/raise-request">Raise request</Button>} />

      <section className="cc-band" aria-label="Fleet health">
        <div className="cc-band-head"><p className="cc-band-label">Fleet health</p>{user.company && <span className="cc-band-note">{user.company}</span>}</div>
        {coverage.loading && !coverage.data ? <div className="cc-fleet"><Skeleton width={148} height={148} radius={74} /><div className="stack-12"><Skeleton width="50%" height={24} /><Skeleton width="80%" /><Skeleton height={48} /></div></div>
          : coverage.error ? <ErrorState compact title="Device status unavailable" message={friendlyError(coverage.error)} onRetry={coverage.reload} />
          : !devices.length ? <EmptyState compact icon={Laptop} title="No devices registered yet" description="Devices enrolled by iPlanet Service for your organization will appear here." />
          : <div className="cc-fleet">
            <HealthRing value={health.healthy} total={health.total} label="healthy" tone={ringTone} />
            <div className="cc-fleet-body">
              <div>
                <p className="cc-fleet-statement">{health.healthy === health.total ? 'Every device is healthy.' : `${health.healthy} of ${pluralize(health.total, 'device')} healthy`}</p>
                <p className="cc-fleet-caption">Healthy means no open service request, no repeated issue in the last 90 days and no warranty or AMC expiring soon.</p>
              </div>
              <MetricSummary label="Device status" items={[
                { label: 'Devices', value: health.total, to: '/corporate/devices' },
                { label: 'In use', value: health.inUse, hint: 'Assigned, not in service' },
                { label: 'In service', value: health.inService, hint: atRisk.length ? `${atRisk.length} at SLA risk` : 'With iPlanet now', tone: atRisk.length ? 'warning' : undefined, to: '/corporate/service-requests' },
                { label: 'Need attention', value: health.attention, hint: 'Recurring issue or coverage', tone: health.attention ? 'warning' : undefined },
                { label: 'Unassigned', value: health.unassigned, hint: 'No employee yet', to: health.unassigned ? '/corporate/unassigned-devices' : undefined },
              ]} />
              <p className="cc-coverage-line">
                <Link to="/corporate/warranty?filter=Covered"><span>Covered</span><strong>{devices.filter(device => device.coverageStatus === 'Covered').length}</strong></Link>
                <Link to="/corporate/warranty?filter=Expiring%20Soon"><span>Expiring soon</span><strong>{summary.expiringSoon ?? 0}</strong></Link>
                <Link to="/corporate/warranty?filter=Expired"><span>Expired</span><strong>{summary.expired ?? 0}</strong></Link>
              </p>
            </div>
          </div>}
      </section>

      <div className="cc-grid">
        <div className="cc-main">
          <DashboardSection className="cc-order-1" title="Needs your attention" description={attention.length ? `${pluralize(attention.length, 'item')}, most urgent first` : undefined}>
            {!coverageReady && !coverage.error ? <div className="cc-panel card-body stack-12"><Skeleton width="60%" /><Skeleton width="40%" /></div>
              : <AttentionFeed items={attention} limit={5} empty={<CalmState title="Everything is up to date.">Every active request is within its service targets and no device needs action.</CalmState>} />}
          </DashboardSection>

          <DashboardSection className="cc-order-3" title="Recent service" actions={tickets.length ? <Button variant="ghost" size="sm" to="/corporate/service-requests">View all</Button> : null}>
            <ActivityFeed
              items={recent.map(ticket => ({ key: ticket._id, to: `/corporate/service-requests/${ticket._id}`, title: <><span className="mono">{ticket.ticketId}</span><span>{ticket.issueType || 'Service request'}</span></>,
                subtitle: [ticket.deviceId?.model, ticket.deviceId?.employeeName || ticket.deviceId?.serialNumber].filter(Boolean).join(' · '), status: ticket.status, time: ticket.updatedAt || ticket.createdAt }))}
              empty={<div className="cc-panel"><EmptyState compact icon={Ticket} title="No service requests yet" description="When your organization raises a request, its progress will appear here." action={<Button size="sm" variant="primary" icon={FilePlus2} to="/corporate/raise-request">Raise service request</Button>} /></div>} />
          </DashboardSection>
        </div>

        <div className="cc-aside">
          <DashboardSection className="cc-order-2" title="Quick actions">
            <QuickActions actions={[
              { label: 'Raise service request', hint: 'Report an issue on any device', icon: FilePlus2, to: '/corporate/raise-request' },
              { label: 'Find device', hint: devices.length ? `Search ${pluralize(devices.length, 'device')}` : 'Search by serial, model or employee', icon: Search, to: '/corporate/devices' },
              { label: 'Check coverage', hint: summary.expiringSoon ? `${summary.expiringSoon} expiring soon` : 'Warranty and AMC status', icon: ShieldCheck, to: summary.expiringSoon ? '/corporate/warranty?filter=Expiring%20Soon' : '/corporate/warranty', count: summary.expiringSoon, tone: 'warning' },
              { label: 'Track request', hint: active.length ? `${pluralize(active.length, 'request')} in progress` : 'No requests in progress', icon: Ticket, to: '/corporate/service-requests', count: active.length },
              ai.available && { label: 'Ask AI', hint: 'Troubleshoot before raising a request', icon: Sparkles, onClick: ai.open },
            ]} />
          </DashboardSection>

          {cluster && <DashboardSection className="cc-order-4" title="Insights">
            <Insight eyebrow="Service pattern" title={`${cluster.devices} devices in ${cluster.location} reported ${cluster.issueType.toLowerCase()} issues`}
              action={{ label: 'View these requests', to: `/corporate/service-requests?search=${encodeURIComponent(cluster.issueType)}` }}>
              {pluralize(cluster.tickets.length, 'service request')} since {formatDate(cluster.since)}. A shared cause at this location may be worth checking.
            </Insight>
          </DashboardSection>}
        </div>
      </div>
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
