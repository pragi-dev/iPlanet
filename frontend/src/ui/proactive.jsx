// Presentation helpers for proactive device service. Status and dates come
// from the API (the backend engine); this file only decides how to show them.
import { ArrowRight } from 'lucide-react';
import { Badge } from './primitives';
import { formatDate } from './format';

const tones = {
  Upcoming: 'info', Due: 'warning', Overdue: 'critical', 'Reminder Due': 'warning', Contacted: 'info', 'Remind Later': 'neutral',
  Scheduled: 'info', 'In Service': 'info', Completed: 'success', 'Not Required': 'neutral', 'Not Due': 'success',
};
export const proactiveTone = status => tones[status] || 'neutral';

export function ProactiveStatus({ status }) {
  if (!status) return null;
  return <Badge dot tone={proactiveTone(status)}>{status}</Badge>;
}

// "Today", "In 3 days", "12 days ago" from the API's daysUntil.
export function dueLabel(daysUntil) {
  if (daysUntil === null || daysUntil === undefined) return 'Not scheduled';
  if (daysUntil === 0) return 'Today';
  if (daysUntil === 1) return 'Tomorrow';
  if (daysUntil === -1) return 'Yesterday';
  return daysUntil > 0 ? `In ${daysUntil} days` : `${-daysUntil} days ago`;
}

// How a corporate customer sees a recommendation's state.
export function customerStatus(item) {
  if (item.stage === 'Scheduled') return { label: `Scheduled for ${formatDate(item.scheduledDate)}`, tone: 'info' };
  if (item.stage === 'In Service') return { label: 'Service requested', tone: 'info' };
  if (item.stage === 'Completed') return { label: 'Serviced', tone: 'success' };
  if (item.stage === 'Not Required') return { label: 'Not required', tone: 'neutral' };
  if (item.status === 'Remind Later') return { label: `Reminder on ${formatDate(item.followUpDate)}`, tone: 'neutral' };
  if (item.status === 'Reminder Due') return { label: 'Reminder due', tone: 'warning' };
  if (item.timing === 'Overdue') return { label: 'Overdue', tone: 'critical' };
  if (item.timing === 'Due') return { label: 'Service due', tone: 'warning' };
  return { label: 'Service recommended', tone: 'info' };
}

// A customer can still act on a recommendation (request, postpone, decline).
export const canRespond = item => Boolean(item?._id) && ['Open', 'Contacted', 'Remind Later', 'Scheduled'].includes(item.stage);

const basisLabels = { purchase: 'purchase date', installation: 'installation date', lastService: 'last service', explicit: 'a date set by iPlanet Service' };

// Purchased → Last service → Next service → Status, read left to right.
// status: optional { label, tone } to show a customer-facing wording instead of the operational status.
export function ServiceLifecycle({ plan, status }) {
  const steps = [
    { label: 'Purchased', value: formatDate(plan.purchaseDate, 'Not on record') },
    { label: 'Last service', value: formatDate(plan.lastServiceDate, 'None recorded') },
    { label: 'Next service', value: plan.nextServiceDate ? formatDate(plan.nextServiceDate) : 'Not enough history', hint: plan.nextServiceDate ? dueLabel(plan.daysUntil) : null },
    { label: 'Status', value: status ? <Badge dot tone={status.tone}>{status.label}</Badge> : <ProactiveStatus status={plan.status || plan.timing || 'Not Due'} />, hint: plan.nextServiceDate ? `Every ${plan.intervalMonths} months from ${basisLabels[plan.basis] || 'records'}` : null },
  ];
  return <ol className="lifecycle-strip" aria-label="Service lifecycle">
    {steps.map((step, index) => <li key={step.label}>
      <span className="lifecycle-label">{step.label}</span>
      <span className="lifecycle-value">{step.value}</span>
      {step.hint && <span className="lifecycle-hint">{step.hint}</span>}
      {index < steps.length - 1 && <ArrowRight className="lifecycle-arrow" size={16} aria-hidden="true" />}
    </li>)}
  </ol>;
}
