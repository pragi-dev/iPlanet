import { Link } from 'react-router-dom';
import { Inbox, PlugZap } from 'lucide-react';
import { AllClear, Button, Card, ErrorState, MetricSummary, PageHeader, PageSkeleton, RowAction, StatusDistribution, formatRelative, friendlyError, pluralize, useAsync } from '../ui';
import { getB2CDashboard } from './api';
import { B2CShell, B2CStatus, B2C_ROLE_LABELS, CategoryBadge, NoB2CAccess } from './shared';

const STATUS_TONE = { 'Pending Triage': 'warning', 'Pending Validation': 'warning', Reopened: 'warning', Completed: 'success', Closed: 'neutral', 'Awaiting Customer': 'neutral' };

function CountList({ items, empty, to }) {
  if (!items?.length) return <p className="text-muted text-small">{empty}</p>;
  return <ul className="b2c-count-list">{items.map(item => <li key={item.name}>
    {to ? <Link to={to(item.name)}>{item.name}</Link> : <span>{item.name}</span>}<strong>{item.value}</strong>
  </li>)}</ul>;
}

export function B2CDashboard() {
  const state = useAsync(getB2CDashboard, []);
  if (state.loading && !state.data) return <B2CShell title="B2C Escalations"><PageSkeleton kpis={6} /></B2CShell>;
  if (state.error?.status === 403) return <B2CShell title="B2C Escalations"><PageHeader title="B2C Escalations" /><NoB2CAccess /></B2CShell>;
  if (state.error) return <B2CShell title="B2C Escalations"><PageHeader title="B2C Escalations" /><div className="card"><ErrorState title="Unable to load B2C escalations" message={friendlyError(state.error)} onRetry={state.reload} /></div></B2CShell>;

  const { summary, byStatus, byCategory, byRegion, byLevel, recent, health, registrations, role } = state.data;
  const admin = role === 'b2c_admin';
  const metrics = [
    { label: 'Active', value: summary.active, hint: 'Not yet resolved', to: '/b2c/tickets?status=active' },
    admin && { label: 'Needs triage', value: summary.triage, tone: summary.triage ? 'warning' : undefined, hint: 'Missing or unclear details', to: '/b2c/tickets?view=triage' },
    { label: 'Assigned to me', value: summary.mine, hint: 'Active, owned by you', to: '/b2c/tickets?view=mine' },
    { label: 'Waiting for an owner', value: summary.unassigned, tone: summary.unassigned ? 'warning' : undefined, hint: 'Open at a level', to: '/b2c/tickets?view=unassigned' },
    { label: 'Pending validation', value: summary.pendingValidation, hint: 'Resolution submitted', to: '/b2c/tickets?view=validation' },
    { label: 'Awaiting customer', value: summary.awaitingCustomer, hint: 'Clarification requested', to: '/b2c/tickets?status=Awaiting%20Customer' },
    { label: 'Resolved', value: summary.resolved30d, hint: 'Last 30 days' },
    // Emails that have no ticket until the customer registers.
    registrations && { label: 'Awaiting registration', value: registrations.awaitingCustomer, hint: 'No ticket until the customer registers', to: '/b2c/registrations' },
    registrations && { label: 'Registrations to decide', value: registrations.needDecision, tone: registrations.needDecision ? 'warning' : undefined, hint: 'Under review, expired or not sent', to: '/b2c/registrations?view=decide' },
  ];
  const healthIssues = health ? health.failedInbound + health.failedOutbound + health.integrationErrors : 0;

  return <B2CShell title="B2C Escalations">
    <PageHeader eyebrow={B2C_ROLE_LABELS[role]} title="B2C Escalations" description={admin ? 'Customer escalations received by email across every TCM inbox.' : 'Customer escalations at your level and those you are handling.'} actions={<Button variant="primary" icon={Inbox} to="/b2c/tickets">Open queue</Button>} />

    <section className="cc-band" aria-label="Escalation summary">
      <div className="cc-band-head"><p className="cc-band-label">Escalations</p><span className="cc-band-note">Select a figure to open the matching queue</span></div>
      <MetricSummary label="Escalation summary" items={metrics} />
    </section>

    {health && <Card title="Integration health" description="Email processing, customer email and CRM lookups" actions={<Button size="sm" variant="ghost" icon={PlugZap} to="/b2c/integrations">Details</Button>}>
      {healthIssues || health.heldOutbound
        ? <ul className="b2c-count-list">
          <li><span>Emails that failed processing</span><strong>{health.failedInbound}</strong></li>
          <li><span>Customer emails failed or retrying</span><strong>{health.failedOutbound}</strong></li>
          <li><span>Customer emails held (template not approved)</span><strong>{health.heldOutbound}</strong></li>
          <li><span>Connectors reporting errors</span><strong>{health.integrationErrors}</strong></li>
        </ul>
        : <AllClear>Email processing and integrations are running without errors.</AllClear>}
    </Card>}

    <div className="grid-main-side">
      <Card title="Where escalations stand" description={`${pluralize(byStatus.reduce((sum, item) => sum + item.value, 0), 'escalation')} you can see`}>
        <StatusDistribution label="Escalations by status" segments={byStatus.map(item => ({ label: item.name, value: item.value, tone: STATUS_TONE[item.name] || 'info', to: `/b2c/tickets?status=${encodeURIComponent(item.name)}` }))} />
      </Card>
      <Card title="Active by category"><CountList items={byCategory} empty="No active escalations." to={name => `/b2c/tickets?status=active&category=${encodeURIComponent(name)}`} /></Card>
    </div>
    <div className="grid-2">
      <Card title="Active by region"><CountList items={byRegion} empty="No active escalations." to={name => (name === 'Not set' ? '/b2c/tickets?status=active' : `/b2c/tickets?status=active&region=${encodeURIComponent(name)}`)} /></Card>
      <Card title="Active by workflow level"><CountList items={byLevel} empty="No escalations are in the workflow yet." /></Card>
    </div>

    <Card title="Recently active" flush actions={<Button size="sm" variant="ghost" to="/b2c/tickets">All escalations</Button>}>
      {recent.length ? <div className="table-scroll"><table className="table table-compact">
        <thead><tr><th>Reference</th><th>Category</th><th>Status</th><th>Owner</th><th>Last activity</th><th><span className="sr-only">Open</span></th></tr></thead>
        <tbody>{recent.map(ticket => <tr key={ticket._id}>
          <td><Link className="cell-link mono" to={`/b2c/tickets/${ticket._id}`}>{ticket.reference}</Link><span className="cell-sub">{ticket.subject}</span></td>
          <td><CategoryBadge category={ticket.category} /></td>
          <td><B2CStatus status={ticket.status} /></td>
          <td>{ticket.workflow?.assignee?.name || <span className="text-muted">Unassigned</span>}</td>
          <td className="cell-nowrap">{formatRelative(ticket.lastActivityAt)}</td>
          <td className="cell-right"><RowAction to={`/b2c/tickets/${ticket._id}`} label="Open" /></td>
        </tr>)}</tbody>
      </table></div> : <div className="card-body"><AllClear>No active escalations right now.</AllClear></div>}
    </Card>
  </B2CShell>;
}
