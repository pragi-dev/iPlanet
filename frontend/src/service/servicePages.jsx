import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { BarChart3, Building2, CalendarClock, CalendarDays, ChevronRight, ClipboardList, KeyRound, LogOut, Mail, MapPin, ScanLine, ShieldAlert, Ticket, UserCheck, UsersRound, Wrench } from 'lucide-react';
import { ServiceShell } from './components';
import { engineerFilterOptions, filterEngineers } from './engineerFilters';
import { getEngineers, getProactiveFollowUps, getServiceActivity, getServiceCentres, getServiceTickets } from './api';
import {
  ActivityFeed, AttentionFeed, Avatar, Badge, Button, CalmState, Card, DashboardHeader, DashboardSection, Drawer, EmptyState, ErrorState, FilterBar, FilterSelect, InfoList, Insight, KPI, KPIGrid,
  MetricSummary, PageHeader, PageSkeleton, QuickActions, SearchInput, Skeleton, StatusDistribution, TableCard, formatDateTime, formatRelative, friendlyError, greeting, idOf, isActiveTicket,
  pluralize, readSessionUser, recurringIssues, riskLabel, riskTone, slaCountdown, slaLabel, slaRisk, suggestEngineer, todayLabel, useAsync,
} from '../ui';

export { ServiceShell };

const riskStates = ['At Risk', 'SLA Breached', 'Escalated'];
const isActive = isActiveTicket;
const engineerOf = ticket => idOf(ticket.assignedEngineerId);
const toneRank = { critical: 0, warning: 1, info: 2, neutral: 3 };
const companyOf = ticket => ticket.companyId?.name || ticket.customerId?.company || 'Corporate';
const GROUP_AFTER = 2;

// Active tickets per engineer, counted from the ticket list itself so
// completed-but-not-closed work is not treated as open workload.
function activeLoad(tickets) {
  const load = new Map();
  tickets.filter(isActive).forEach(ticket => { const id = engineerOf(ticket); if (id) load.set(id, (load.get(id) || 0) + 1); });
  return load;
}

function slaMeta(ticket) {
  const countdown = slaCountdown(ticket);
  if (!countdown) return null;
  return countdown.overdue ? `Target passed ${countdown.text} ago` : `Breach in ${countdown.text}`;
}

// Why a ticket is stuck, from its status and assignment.
function ticketReason(ticket, engineers) {
  const engineer = ticket.assignedEngineer || 'The engineer';
  const escalation = ticket.escalationStatus === 'Escalated' ? `Escalated${ticket.escalationLevel ? ` to level ${ticket.escalationLevel}` : ''}${ticket.escalationReason ? ` — ${ticket.escalationReason}` : ''}. ` : '';
  if (!ticket.assignedEngineerId) {
    const suggestion = suggestEngineer(engineers, ticket);
    return `${escalation}No engineer assigned.${suggestion ? ` ${suggestion.engineer.name} is available in ${suggestion.engineer.location}.` : ticket.location ? ` No engineer is available in ${ticket.location}.` : ''}`;
  }
  if (ticket.status === 'Engineer Assigned') return `${escalation}${engineer} has not accepted the ticket yet.`;
  if (ticket.status === 'Engineer Accepted') return `${escalation}${engineer} accepted but has not started work.`;
  if (ticket.status === 'Waiting for Parts') return `${escalation}Repair is paused while parts arrive.`;
  return `${escalation}Repair in progress with ${engineer}.`;
}

// Operational problems that need the service team, most urgent first. Each
// item says what is wrong, why, and the action that moves it forward.
function operationsAttention(tickets, engineers) {
  const items = [];
  const listed = new Set();
  const context = ticket => [companyOf(ticket), ticket.location, ticket.deviceId?.model].filter(Boolean).join(' · ');
  tickets.filter(slaRisk).sort((a, b) => new Date(a.slaTargetAt) - new Date(b.slaTargetAt)).forEach(ticket => {
    const risk = slaRisk(ticket);
    listed.add(ticket._id);
    const action = !ticket.assignedEngineerId ? { label: 'Assign engineer', to: `/service/tickets/${ticket._id}?assign=1` }
      : risk === 'escalated' ? { label: 'Review escalation', to: `/service/tickets/${ticket._id}` }
      : { label: 'Open ticket', to: `/service/tickets/${ticket._id}` };
    items.push({ key: `sla-${ticket._id}`, tone: riskTone(risk), category: riskLabel(risk), meta: slaMeta(ticket), title: `${ticket.ticketId} · ${ticket.issueType || 'Service'}`, reason: ticketReason(ticket, engineers), context: context(ticket), action });
  });
  tickets.filter(ticket => isActive(ticket) && !ticket.assignedEngineerId && !listed.has(ticket._id)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).forEach(ticket => {
    listed.add(ticket._id);
    items.push({ key: `un-${ticket._id}`, tone: 'warning', category: 'Unassigned', meta: `Raised ${formatRelative(ticket.createdAt)}`, title: `${ticket.ticketId} · ${ticket.issueType || 'Service'}`,
      reason: ticketReason(ticket, engineers), context: context(ticket), action: { label: 'Assign engineer', to: `/service/tickets/${ticket._id}?assign=1` } });
  });
  const waiting = tickets.filter(ticket => ticket.status === 'Waiting for Parts' && !listed.has(ticket._id)).sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
  if (waiting.length > GROUP_AFTER) items.push({ key: 'wp-group', tone: 'info', category: 'Waiting for parts', title: `${waiting.length} tickets are waiting for parts`,
    reason: `Longest wait: ${waiting[0].ticketId}, paused ${formatRelative(waiting[0].updatedAt)}.`, action: { label: 'View tickets', to: '/service/tickets?status=Waiting%20for%20Parts' } });
  else waiting.forEach(ticket => items.push({ key: `wp-${ticket._id}`, tone: 'info', category: 'Waiting for parts', meta: `Paused ${formatRelative(ticket.updatedAt)}`, title: `${ticket.ticketId} · ${ticket.issueType || 'Service'}`,
    reason: `Repair is paused until parts arrive${ticket.assignedEngineer ? ` for ${ticket.assignedEngineer}` : ''}.`, context: context(ticket), action: { label: 'Open ticket', to: `/service/tickets/${ticket._id}` } }));
  const completed = tickets.filter(ticket => ticket.status === 'Completed').sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
  if (completed.length > GROUP_AFTER) items.push({ key: 'done-group', tone: 'info', category: 'Ready to close', title: `${completed.length} completed tickets are waiting to be closed`,
    reason: `Engineers have finished these repairs. Oldest: ${completed[0].ticketId}, completed ${formatRelative(completed[0].updatedAt)}.`, action: { label: 'Review tickets', to: '/service/tickets?status=Completed' } });
  else completed.forEach(ticket => items.push({ key: `done-${ticket._id}`, tone: 'info', category: 'Ready to close', meta: `Completed ${formatRelative(ticket.updatedAt)}`, title: `${ticket.ticketId} · ${ticket.issueType || 'Service'}`,
    reason: `${ticket.assignedEngineer || 'The engineer'} finished the repair. Review and close the ticket.`, context: context(ticket), action: { label: 'Review & close', to: `/service/tickets/${ticket._id}` } }));
  recurringIssues(tickets).slice(0, 3).forEach(group => {
    const serial = group.device?.serialNumber;
    items.push({ key: `rec-${group.deviceId}-${group.issueType}`, tone: 'warning', category: 'Recurring issue', meta: `Last reported ${formatRelative(new Date(group.lastAt))}`, title: [group.device?.model || 'Device', serial].filter(Boolean).join(' · '),
      reason: `${pluralize(group.count, `${group.issueType.toLowerCase()} request`)} in the last 90 days. A repeat repair may need a deeper diagnosis.`, context: companyOf(group.tickets[0]),
      action: { label: 'View tickets', to: `/service/tickets?search=${encodeURIComponent(serial || group.issueType)}` } });
  });
  // Workload imbalance: an engineer carrying at least twice the team average (and 3+ active tickets).
  const load = activeLoad(tickets);
  const average = engineers.length ? [...load.values()].reduce((sum, value) => sum + value, 0) / engineers.length : 0;
  engineers.filter(engineer => (load.get(String(engineer._id)) || 0) >= 3 && (load.get(String(engineer._id)) || 0) >= average * 2).forEach(engineer => {
    const lighter = engineers.filter(other => other._id !== engineer._id && other.status === 'Available' && other.location === engineer.location).sort((a, b) => (load.get(String(a._id)) || 0) - (load.get(String(b._id)) || 0))[0];
    items.push({ key: `load-${engineer._id}`, tone: 'warning', category: 'Engineer workload', title: `${engineer.name} has ${load.get(String(engineer._id))} active tickets`,
      reason: `Team average is ${average.toFixed(1)}.${lighter ? ` ${lighter.name} in ${lighter.location} has ${pluralize(load.get(String(lighter._id)) || 0, 'active ticket')}.` : ''}`, context: engineer.location,
      action: { label: 'View engineer', to: `/service/engineers?engineer=${engineer._id}` } });
  });
  return items.sort((a, b) => toneRank[a.tone] - toneRank[b.tone]);
}

// Engineers and active work grouped by service location.
// Proactive-service items for the attention feed, from the engine's summary.
// Each is a count with the filtered follow-up list as its action.
function proactiveAttention(summary, config) {
  if (!summary) return [];
  const items = [];
  const due = summary.due + summary.reminderDue;
  if (due) items.push({ key: 'pro-due', tone: 'warning', category: 'Proactive service', title: `${pluralize(due, 'device')} due for preventive service`,
    reason: `Contact the customer before raising a request.${summary.reminderDue ? ` Includes ${pluralize(summary.reminderDue, 'reminder')} that came due.` : ''}`, action: { label: 'Review follow-ups', to: '/service/proactive?status=Needs%20action' } });
  if (summary.overdue) items.push({ key: 'pro-overdue', tone: 'warning', category: 'Proactive service', title: `${pluralize(summary.overdue, 'overdue follow-up')}`,
    reason: `More than ${config?.overdueGraceDays ?? 14} days past the recommended service date with no customer decision.`, action: { label: 'Review overdue', to: '/service/proactive?status=Overdue' } });
  if (summary.awaitingCustomer) items.push({ key: 'pro-awaiting', tone: 'info', category: 'Customer response', title: `${summary.awaitingCustomer} ${summary.awaitingCustomer === 1 ? 'customer is' : 'customers are'} awaiting a follow-up`,
    reason: 'Contacted about preventive service with no decision recorded yet.', action: { label: 'Follow up', to: '/service/proactive?status=Awaiting%20customer' } });
  if (summary.amcExpiringSoon) items.push({ key: 'pro-amc', tone: 'info', category: 'Coverage', title: `${pluralize(summary.amcExpiringSoon, 'AMC renewal')} approaching`,
    reason: 'Raise renewal with the customer during the next follow-up.', action: { label: 'View coverage', to: '/service/warranty?filter=Expiring%20Soon' } });
  return items;
}

function locationOverview(engineers, tickets) {
  const rows = new Map();
  const row = name => { if (!rows.has(name)) rows.set(name, { name, engineers: 0, available: 0, active: 0, unassigned: 0 }); return rows.get(name); };
  engineers.forEach(engineer => { const entry = row(engineer.location || 'No location'); entry.engineers += 1; if (engineer.status === 'Available') entry.available += 1; });
  tickets.filter(isActive).forEach(ticket => { const entry = row(ticket.location || 'No location'); entry.active += 1; if (!ticket.assignedEngineerId) entry.unassigned += 1; });
  return [...rows.values()].sort((a, b) => b.active - a.active || a.name.localeCompare(b.name));
}

function operationsSummary({ active, risky, breached, unassigned }) {
  if (!active) return 'No active tickets right now. New requests will appear here as they arrive.';
  const slaText = !risky ? null : breached === risky ? `${risky === active ? 'all' : risky} past SLA or escalated` : `${risky} at SLA risk${breached ? `, ${breached} already past SLA` : ''}`;
  const risks = [slaText, unassigned && `${unassigned} waiting for an engineer`].filter(Boolean);
  return <><strong>{pluralize(active, 'active ticket')}</strong>. {risks.length ? <>{risks.join(', ')}.</> : 'All are assigned and within SLA.'}</>;
}

const startOfToday = () => { const date = new Date(); date.setHours(0, 0, 0, 0); return date; };

export function ServiceDashboard() {
  const user = readSessionUser();
  const state = useAsync(() => Promise.all([getServiceTickets(), getEngineers()]).then(([tickets, engineers]) => ({ tickets, engineers })), []);
  const activity = useAsync(() => getServiceActivity({ limit: 8, since: startOfToday() }), []);
  const proactive = useAsync(() => getProactiveFollowUps(), []);
  if (state.loading && !state.data) return <ServiceShell title="Overview"><PageSkeleton kpis={5} /></ServiceShell>;
  if (state.error) return <ServiceShell title="Overview"><PageHeader title="Service operations" /><div className="card"><ErrorState title="Unable to load service operations" message={friendlyError(state.error)} onRetry={state.reload} /></div></ServiceShell>;

  const { tickets, engineers } = state.data;
  const active = tickets.filter(isActive);
  const risky = active.filter(slaRisk);
  const breached = risky.filter(ticket => slaRisk(ticket) !== 'risk').length;
  const escalated = active.filter(ticket => ticket.escalationStatus === 'Escalated').length;
  const unassigned = active.filter(ticket => !ticket.assignedEngineerId).length;
  const count = status => tickets.filter(ticket => ticket.status === status).length;
  const proSummary = proactive.data?.summary;
  const attention = [...operationsAttention(tickets, engineers), ...proactiveAttention(proSummary, proactive.data?.config)].sort((a, b) => toneRank[a.tone] - toneRank[b.tone]);
  const locations = locationOverview(engineers, tickets);
  const load = activeLoad(tickets);
  const workload = [...engineers].map(engineer => ({ engineer, active: load.get(String(engineer._id)) || 0 })).sort((a, b) => b.active - a.active || String(a.engineer.name).localeCompare(String(b.engineer.name)));
  const maxLoad = Math.max(1, ...workload.map(row => row.active));
  const flaggedEngineers = new Set(attention.filter(item => item.key.startsWith('load-')).map(item => item.key.slice(5)));
  const available = engineers.filter(engineer => engineer.status === 'Available').length;
  const firstName = (user.name || '').split(' ')[0];
  const issueCounts = active.reduce((map, ticket) => (ticket.issueType ? map.set(ticket.issueType, (map.get(ticket.issueType) || 0) + 1) : map), new Map());
  const [topIssue, topIssueCount] = [...issueCounts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  const showIssueInsight = active.length >= 5 && topIssueCount >= 3 && topIssueCount / active.length >= 0.3;
  const events = activity.data?.events || [];
  const recentTickets = [...tickets].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)).slice(0, 8);

  return <ServiceShell title="Overview">
    <div className="cc-page">
      <DashboardHeader
        eyebrow={`iPlanet Service · ${todayLabel()}`}
        title={`${greeting()}, ${firstName || 'Service Team'}`}
        summary={operationsSummary({ active: active.length, risky: risky.length, breached, unassigned })}
        actions={<><Button icon={ScanLine} to="/service/device-enrollment">Enroll device</Button><Button variant="primary" icon={ClipboardList} to="/service/tickets">Open ticket queue</Button></>} />

      <section className="cc-band" aria-label="Service operations">
        <p className="cc-band-label">Service operations</p>
        <MetricSummary size="lg" label="Operations summary" items={[
          { label: 'Active', value: active.length, hint: `${count('In Progress')} in progress`, to: '/service/tickets' },
          { label: 'SLA risk', value: risky.length, hint: breached ? `${breached} breached or escalated` : 'None breached', tone: breached ? 'critical' : risky.length ? 'warning' : undefined, to: '/service/escalation' },
          { label: 'Unassigned', value: unassigned, hint: `${pluralize(available, 'engineer')} available`, tone: unassigned ? 'warning' : undefined, to: '/service/tickets?status=Open&assignment=Unassigned' },
          { label: 'Waiting for parts', value: count('Waiting for Parts'), hint: 'Repairs paused', to: '/service/tickets?status=Waiting%20for%20Parts' },
          { label: 'Proactive follow-ups', value: proSummary ? proSummary.needsAction : '—', hint: proactive.error ? 'Unavailable' : proSummary?.overdue ? `${proSummary.overdue} overdue` : 'Preventive service', tone: proSummary?.overdue ? 'warning' : undefined, to: '/service/proactive?status=Needs%20action' },
          { label: 'Completed today', value: activity.data ? activity.data.completedToday : '—', hint: activity.error ? 'Unavailable' : 'Since midnight', to: '/service/tickets?status=Completed' },
        ]} />
        <div className="cc-band-divider" />
        <div className="stack-12">
          <div className="cc-band-head"><p className="cc-band-label">Service status</p><span className="cc-band-note">{pluralize(active.length + count('Completed'), 'ticket')} not yet closed</span></div>
          <StatusDistribution label="Tickets by status" segments={[
            { label: 'Open', value: count('Open'), tone: 'neutral', to: '/service/tickets?status=Open' },
            { label: 'Engineer assigned', value: count('Engineer Assigned'), tone: 'sky', to: '/service/tickets?status=Engineer%20Assigned' },
            { label: 'Accepted', value: count('Engineer Accepted'), tone: 'indigo', to: '/service/tickets?status=Engineer%20Accepted' },
            { label: 'In progress', value: count('In Progress'), tone: 'info', to: '/service/tickets?status=In%20Progress' },
            { label: 'Waiting for parts', value: count('Waiting for Parts'), tone: 'warning', to: '/service/tickets?status=Waiting%20for%20Parts' },
            { label: 'Completed', value: count('Completed'), tone: 'success', to: '/service/tickets?status=Completed' },
          ]} />
        </div>
      </section>

      <div className="cc-grid">
        <div className="cc-main">
          <DashboardSection className="cc-order-1" title="Needs attention" description={attention.length ? `${pluralize(attention.length, 'item')}, most urgent first` : undefined}>
            <AttentionFeed items={attention} limit={6} empty={<CalmState title="Everything is on track.">No SLA risks, unassigned tickets, paused repairs or workload imbalances right now.</CalmState>} />
          </DashboardSection>

          <DashboardSection className="cc-order-3" title="Recent service activity" actions={<Button size="sm" variant="ghost" to="/service/tickets">View queue</Button>}>
            {activity.loading && !activity.data ? <div className="cc-panel card-body stack-12"><Skeleton width="70%" /><Skeleton width="50%" /><Skeleton width="60%" /></div>
              : activity.error ? <ActivityFeed items={recentTickets.map(ticket => ({ key: ticket._id, to: `/service/tickets/${ticket._id}`, title: <><span className="mono">{ticket.ticketId}</span><span>{companyOf(ticket)}</span></>,
                subtitle: [ticket.issueType, ticket.assignedEngineer || 'Unassigned'].filter(Boolean).join(' · '), status: ticket.status, time: ticket.updatedAt || ticket.createdAt }))} />
              : <ActivityFeed
                items={events.map(event => ({ key: event._id, to: `/service/tickets/${event.ticketId._id}`, title: <><span className="mono">{event.ticketId.ticketId}</span><span>{event.status || 'Update'}</span></>,
                  subtitle: [event.message, event.ticketId.companyId?.name].filter(Boolean).join(' · '), status: event.ticketId.status, time: event.timestamp }))}
                empty={<div className="cc-panel"><EmptyState compact icon={Ticket} title="No service activity yet" description="Ticket updates from the service team will appear here as they happen." /></div>} />}
          </DashboardSection>
        </div>

        <div className="cc-aside">
          <DashboardSection className="cc-order-2" title="Quick actions">
            <QuickActions actions={[
              { label: 'Assign tickets', hint: unassigned ? `${unassigned} waiting for an engineer` : 'Every active ticket is assigned', icon: UserCheck, to: '/service/tickets?status=Open&assignment=Unassigned', count: unassigned, tone: 'warning' },
              { label: 'SLA risks & escalations', hint: risky.length ? [`${risky.length} at risk`, escalated && `${escalated} escalated`].filter(Boolean).join(' · ') : 'Escalation matrix and rules', icon: ShieldAlert, to: '/service/escalation', count: risky.length, tone: breached ? 'critical' : 'warning' },
              { label: 'Review service follow-ups', hint: proSummary ? (proSummary.needsAction ? `${pluralize(proSummary.needsAction, 'device')} need a follow-up` : 'No follow-ups due') : 'Proactive service', icon: CalendarClock, to: '/service/proactive?status=Needs%20action', count: proSummary?.needsAction, tone: proSummary?.overdue ? 'warning' : 'neutral' },
              { label: 'View upcoming services', hint: proSummary ? `${proSummary.upcoming} in the next ${proactive.data.config.upcomingDays} days` : 'Service calendar', icon: CalendarDays, to: '/service/proactive?status=Upcoming' },
              { label: 'Enroll device', hint: 'Register a customer device', icon: ScanLine, to: '/service/device-enrollment' },
              { label: 'View engineers', hint: `${available} of ${pluralize(engineers.length, 'engineer')} available`, icon: UsersRound, to: '/service/engineers' },
              { label: 'View reports', hint: 'Volume, locations and issue types', icon: BarChart3, to: '/service/reports' },
            ]} />
          </DashboardSection>

          <DashboardSection className="cc-order-4" title="Engineer workload" description="Active tickets per engineer" actions={<Button size="sm" variant="ghost" to="/service/engineers">View engineers</Button>}>
            {workload.length ? <ul className="cc-list">{workload.slice(0, 6).map(({ engineer, active: count }) => <li key={engineer._id}>
              <Link className="cc-list-row cc-list-row-link" to={`/service/engineers?engineer=${engineer._id}`}>
                <span className="cc-list-name"><strong>{engineer.name}</strong><small>{[engineer.location, engineer.status].filter(Boolean).join(' · ')}</small></span>
                <span className="cc-list-figure"><strong>{count}</strong> active</span>
                <span className="cc-list-bar" aria-hidden="true"><i className={flaggedEngineers.has(String(engineer._id)) ? 'cc-bar-warning' : ''} style={{ width: `${(count / maxLoad) * 100}%` }} /></span>
              </Link>
            </li>)}</ul> : <p className="cc-list-empty">No engineers on record yet.</p>}
          </DashboardSection>

          <DashboardSection className="cc-order-5" title="Service locations" description="Active work and engineer availability">
            {locations.length ? <ul className="cc-list">{locations.map(row => <li key={row.name}>
              <Link className="cc-list-row cc-list-row-link" to={row.name === 'No location' ? '/service/tickets' : `/service/tickets?location=${encodeURIComponent(row.name)}`}>
                <span className="cc-list-name"><strong>{row.name}</strong><small>{row.engineers ? `${row.available} of ${pluralize(row.engineers, 'engineer')} available` : 'No engineers based here'}</small></span>
                <span className="cc-list-figure"><strong>{row.active}</strong> active{row.unassigned ? ` · ${row.unassigned} unassigned` : ''}</span>
              </Link>
            </li>)}</ul> : <p className="cc-list-empty">No locations with engineers or active tickets yet.</p>}
          </DashboardSection>

          {showIssueInsight && <DashboardSection className="cc-order-6" title="Insights">
            <Insight eyebrow="Service pattern" title={`${topIssue} accounts for ${topIssueCount} of ${active.length} active tickets`} action={{ label: 'View these tickets', to: `/service/tickets?search=${encodeURIComponent(topIssue)}` }}>
              The most common issue in the current queue. Check parts stock and engineer skills for it.
            </Insight>
          </DashboardSection>}
        </div>
      </div>
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

