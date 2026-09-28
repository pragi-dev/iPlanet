import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Check, ChevronDown, CircleCheck, Info, Lightbulb, ShieldAlert } from 'lucide-react';
import { formatDateTime, formatRelative } from './format';

// ---------------------------------------------------------------------------
// Next action — answers "what should I do next?" for the current state.
// `actions` only ever contains transitions the current state supports; when
// nothing is actionable the component reads as a calm status line.
// ---------------------------------------------------------------------------
const nextActionIcon = { info: Info, success: CircleCheck, warning: AlertTriangle, critical: ShieldAlert, neutral: Info };

function ActionControl({ action, primary }) {
  const Icon = action.icon;
  const className = `btn ${primary ? 'btn-primary' : 'btn-secondary'} ${action.size === 'sm' ? 'btn-sm' : ''}`;
  const content = <>{Icon && <Icon size={16} aria-hidden="true" />}{action.label}</>;
  if (action.to) return <Link className={className} to={action.to}>{content}</Link>;
  if (action.href) return <a className={className} href={action.href}>{content}</a>;
  return <button type="button" className={className} disabled={action.disabled} onClick={action.onClick}>{content}</button>;
}

export function NextAction({ tone = 'info', eyebrow = 'Next action', title, description, actions = [], children, live = true }) {
  const Icon = nextActionIcon[tone] || Info;
  const titleId = useId();
  return <section className={`next-action next-action-${tone}`} aria-labelledby={titleId} aria-live={live ? 'polite' : undefined}>
    <span className="next-action-icon" aria-hidden="true"><Icon size={18} /></span>
    <div className="next-action-body">
      <p className="next-action-eyebrow">{eyebrow}</p>
      <h2 className="next-action-title" id={titleId}>{title}</h2>
      {description && <p className="next-action-description">{description}</p>}
      {children}
    </div>
    {actions.length > 0 && <div className="next-action-actions">{actions.map((action, index) => <ActionControl key={action.label} action={action} primary={index === 0 && !action.secondary} />)}</div>}
  </section>;
}

// ---------------------------------------------------------------------------
// Attention list — individual items that need a decision, each with the one
// action that resolves it. Severity is carried by a small dot plus text.
// ---------------------------------------------------------------------------
export function AttentionList({ items, empty }) {
  if (!items.length) return empty || null;
  return <ul className="attention-feed">
    {items.map(item => <li key={item.key} className={`attention-row attention-${item.tone || 'info'}`}>
      <span className="attention-dot" aria-hidden="true" />
      <div className="attention-row-body">
        <p className="attention-row-kicker">{item.kicker}</p>
        <p className="attention-row-title">{item.to && !item.action ? <Link to={item.to}>{item.title}</Link> : item.title}</p>
        {item.detail && <p className="attention-row-detail">{item.detail}</p>}
      </div>
      {item.action && <div className="attention-row-action">
        {item.action.to ? <Link className="btn btn-secondary btn-sm" to={item.action.to}>{item.action.label}</Link>
          : <button type="button" className="btn btn-secondary btn-sm" onClick={item.action.onClick}>{item.action.label}</button>}
      </div>}
    </li>)}
  </ul>;
}

export function AllClear({ children }) {
  return <div className="all-clear"><CircleCheck size={18} aria-hidden="true" />{children}</div>;
}

// ---------------------------------------------------------------------------
// Journey track — ordered stages with done / current / hold / upcoming state.
// Used for the ticket service journey and the device lifecycle.
// ---------------------------------------------------------------------------
export function JourneyTrack({ steps, label, orientation = 'vertical' }) {
  return <ol className={`journey journey-${orientation}`} aria-label={label}>
    {steps.map(step => <li key={step.key || step.label} className={`journey-step journey-${step.state}`} aria-current={step.state === 'current' || step.state === 'hold' ? 'step' : undefined}>
      <span className="journey-dot" aria-hidden="true">{step.state === 'done' && <Check size={12} strokeWidth={3} />}</span>
      <span className="journey-text">
        <span className="journey-label">{step.label}{step.state === 'hold' && <span className="sr-only"> (on hold)</span>}{step.state === 'current' && <span className="sr-only"> (current stage)</span>}</span>
        {step.meta && <span className="journey-meta">{step.meta}</span>}
      </span>
    </li>)}
  </ol>;
}

const journeyStages = [
  { status: 'Open', label: 'Request created' },
  { status: 'Engineer Assigned', label: 'Engineer assigned' },
  { status: 'Engineer Accepted', label: 'Engineer accepted' },
  { status: 'In Progress', label: 'Work started' },
  { status: 'Waiting for Parts', label: 'Waiting for parts', optional: true },
  { status: 'Completed', label: 'Repair completed' },
  { status: 'Closed', label: 'Closed' },
];

// Stages come from the ticket's status and its recorded timeline. "Waiting for
// parts" only appears when the ticket is, or has been, in that state. Each
// reached stage shows when it was last entered.
export function ServiceJourney({ ticket, timeline = [] }) {
  const status = ticket?.status || 'Open';
  const lastAt = stage => {
    if (stage === 'Open') return ticket.createdAt;
    const events = timeline.filter(event => event.status === stage);
    return events.length ? events[events.length - 1].timestamp : null;
  };
  const stages = journeyStages.filter(stage => !stage.optional || status === stage.status || timeline.some(event => event.status === stage.status));
  const currentIndex = Math.max(0, stages.findIndex(stage => stage.status === status));
  const closed = status === 'Closed';
  const steps = stages.map((stage, index) => {
    const state = index < currentIndex || (closed && index === currentIndex) ? 'done' : index === currentIndex ? (stage.status === 'Waiting for Parts' ? 'hold' : 'current') : 'upcoming';
    const at = state !== 'upcoming' ? lastAt(stage.status) : null;
    return { key: stage.status, label: stage.label, state, meta: at ? formatDateTime(at) : state === 'upcoming' ? null : undefined };
  });
  return <JourneyTrack steps={steps} label="Service journey" />;
}

// ---------------------------------------------------------------------------
// Activity timeline — action, actor, time and description for every event.
// ---------------------------------------------------------------------------
const roleLabels = { iplanet_service: 'iPlanet Service', corporate_admin: 'Corporate Admin', system: 'System' };

export function ActivityTimeline({ events, newestFirst = true, emptyText = 'No activity recorded yet.', limit }) {
  const [expanded, setExpanded] = useState(false);
  if (!events?.length) return <p className="text-muted text-small">{emptyText}</p>;
  const ordered = newestFirst ? [...events].reverse() : events;
  const visible = limit && !expanded ? ordered.slice(0, limit) : ordered;
  return <div className="stack-12">
    <ol className="activity-timeline">
      {visible.map((event, index) => {
        const role = roleLabels[event.userRole] || event.userRole;
        return <li className={`activity-event ${index === 0 && newestFirst ? 'activity-event-latest' : ''}`} key={`${event._id || event.status}-${index}`}>
          <span className="activity-event-marker" aria-hidden="true" />
          <div className="activity-event-body">
            <div className="activity-event-head">
              <p className="activity-event-title">{event.status || 'Update'}</p>
              {event.timestamp && <time dateTime={event.timestamp} title={formatDateTime(event.timestamp)}>{formatRelative(event.timestamp)}</time>}
            </div>
            {(event.message || event.note) && <p className="activity-event-text">{event.message || event.note}</p>}
            <p className="activity-event-meta">
              {event.updatedBy && <span>{event.updatedBy}{role ? ` · ${role}` : ''}</span>}
              {event.timestamp && <span>{formatDateTime(event.timestamp)}</span>}
            </p>
          </div>
        </li>;
      })}
    </ol>
    {limit && ordered.length > limit && <button type="button" className="btn-link text-small" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{expanded ? 'Show fewer updates' : `Show all ${ordered.length} updates`}</button>}
  </div>;
}

// ---------------------------------------------------------------------------
// Insight — a rule-based observation drawn from service records, with the
// evidence stated in plain language and one follow-up action.
// ---------------------------------------------------------------------------
export function Insight({ title, children, action, eyebrow = 'Service insight' }) {
  return <aside className="insight" aria-label={eyebrow}>
    <span className="insight-icon" aria-hidden="true"><Lightbulb size={16} /></span>
    <div className="insight-body">
      <p className="insight-eyebrow">{eyebrow}</p>
      <p className="insight-title">{title}</p>
      {children && <div className="insight-text">{children}</div>}
      {action && (action.to ? <Link className="btn-link insight-action" to={action.to}>{action.label}<ArrowRight size={14} aria-hidden="true" /></Link>
        : <button type="button" className="btn-link insight-action" onClick={action.onClick}>{action.label}<ArrowRight size={14} aria-hidden="true" /></button>)}
    </div>
  </aside>;
}

// ---------------------------------------------------------------------------
// Disclosure row — compact list row that expands for details.
// ---------------------------------------------------------------------------
export function DisclosureRow({ summary, children, defaultOpen = false, id }) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  return <li className={`disclosure ${open ? 'disclosure-open' : ''}`} id={id}>
    <button type="button" className="disclosure-trigger" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
      <span className="disclosure-summary">{summary}</span>
      <ChevronDown size={16} aria-hidden="true" className="disclosure-chevron" />
    </button>
    {open && <div className="disclosure-panel" id={panelId}>{children}</div>}
  </li>;
}

// A single line of facts with hairline separators ("24 devices · 2 in service").
export function FactLine({ items }) {
  return <p className="fact-line">{items.filter(Boolean).map((item, index) => <span key={index}>{item}</span>)}</p>;
}
