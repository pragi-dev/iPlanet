import { useState } from 'react';
import { CircleCheck, ClipboardList, Clock3, Ticket, Wrench } from 'lucide-react';
import { ServiceShell } from './components';
import { getCoverage, getServiceReports, getServiceTickets } from './api';
import { BarList, ColumnChart } from '../ui/charts';
import { Button, Card, ErrorState, KPI, KPIGrid, PageHeader, PageSkeleton, friendlyError, isActiveTicket, monthlyVolume, pluralize, slaLabel, slaRisk, useAsync } from '../ui';

// Reports live in their own module so the charting library only loads here.
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
  // SLA outcome per ticket from its recorded escalation state. Resolved tickets
  // keep the last state evaluated before completion.
  const breachStates = ['SLA Breached', 'Escalated'];
  const slaOutcome = groupBy(tickets, ticket => {
    if (isActiveTicket(ticket)) return { breached: 'Open · breached or escalated', escalated: 'Open · breached or escalated', risk: 'Open · at risk' }[slaRisk(ticket)] || 'Open · within SLA';
    if (['Completed', 'Closed'].includes(ticket.status)) return breachStates.includes(ticket.escalationStatus) || slaLabel(ticket) === 'SLA Breached' ? 'Resolved · breach recorded' : 'Resolved · no breach recorded';
    return 'Other';
  });
  const resolvedCount = tickets.filter(ticket => ['Completed', 'Closed'].includes(ticket.status)).length;
  const resolvedClean = slaOutcome.find(item => item.name === 'Resolved · no breach recorded')?.value || 0;
  const workload = groupBy(tickets.filter(isActiveTicket), ticket => ticket.assignedEngineer || 'Unassigned');

  return <ServiceShell title="Reports">
    <PageHeader title="Reports" description="Operational analytics across tickets, SLA, engineers, locations and coverage." actions={<label className="filter-select"><span className="sr-only">Reporting period</span><select value={period} onChange={event => setPeriod(event.target.value)} aria-label="Reporting period">{periods.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>} />
    <KPIGrid columns={5}>
      <KPI label="Total tickets" value={base.total} icon={Ticket} hint={periodLabel} />
      <KPI label="Open" value={base.open} icon={ClipboardList} tone="info" />
      <KPI label="Completed" value={base.completed} icon={Wrench} tone="success" />
      <KPI label="Closed" value={base.closed} icon={CircleCheck} tone="success" />
      <KPI label="Avg. resolution time" value={avgDays === null ? '—' : `${avgDays.toFixed(1)} days`} icon={Clock3} hint={closed.length ? `Created → closed, ${closed.length} tickets` : 'No closed tickets in period'} />
    </KPIGrid>
    <div className="grid-main-side">
      <Card title="How many requests are we receiving?" description={`Tickets created per month, ${new Date().getFullYear()}`}><ColumnChart data={monthlyVolume(tickets)} dataKey="tickets" nameKey="month" seriesName="Tickets" emptyText="No tickets created this year yet." /></Card>
      <Card title="Where does the work stand?" description={`Tickets by status · ${periodLabel}`}><BarList data={groupBy(tickets, ticket => ticket.status)} emptyText="No tickets in this period." /></Card>
    </div>
    <div className="grid-2">
      <Card title="Are we meeting SLA targets?" description={resolvedCount ? `${Math.round((resolvedClean / resolvedCount) * 100)}% of ${pluralize(resolvedCount, 'resolved ticket')} had no breach recorded · ${periodLabel}` : `No resolved tickets · ${periodLabel}`}><BarList data={slaOutcome} emptyText="No tickets in this period." /></Card>
      <Card title="Who is carrying the open work?" description="Active tickets per engineer" actions={<Button size="sm" variant="ghost" to="/service/engineers">Engineers</Button>}><BarList data={workload} emptyText="No active tickets in this period." /></Card>
    </div>
    <div className="grid-3">
      <Card title="Where are requests coming from?" description="Tickets by service location"><BarList data={base.locations} emptyText="No tickets in this period." /></Card>
      <Card title="What service is requested?" description="Tickets by request category"><BarList data={groupBy(tickets, ticket => ticket.category || 'Service')} emptyText="No tickets in this period." /></Card>
      <Card title="Which devices need service?" description="Tickets by device type"><BarList data={base.deviceTypes} emptyText="No tickets in this period." /></Card>
    </div>
    <div className="grid-main-side">
      <Card title="What issues are most common?" description="Most frequently reported issues"><ColumnChart data={[...(base.issueTypes || [])].sort((a, b) => b.value - a.value)} seriesName="Tickets" emptyText="No tickets in this period." /></Card>
      <Card title="How much of the fleet has AMC?" description="All enrolled devices by AMC status"><BarList data={groupBy(coverage.devices || [], device => device.amcStatus)} tone="#34c759" emptyText="No devices enrolled yet." /></Card>
    </div>
    <Card title="When are health camps requested?" description={`Health Camp requests per month, ${new Date().getFullYear()}`}><ColumnChart data={healthCamp} dataKey="tickets" nameKey="month" seriesName="Health camp requests" height={200} emptyText="No health camp requests this year." /></Card>
  </ServiceShell>;
}
