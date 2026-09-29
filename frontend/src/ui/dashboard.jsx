import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight, CircleCheck, Info, ShieldAlert } from 'lucide-react';
import { formatDateTime, formatRelative, statusTone } from './format';

// ---------------------------------------------------------------------------
// Command-center building blocks shared by the Corporate and Service home
// dashboards. They are presentational only: each portal decides what goes in
// them from its own records.
// ---------------------------------------------------------------------------

export function DashboardHeader({ eyebrow, title, summary, actions }) {
  return <header className="cc-header">
    <div className="cc-header-text">
      {eyebrow && <p className="cc-eyebrow">{eyebrow}</p>}
      <h1 className="cc-title">{title}</h1>
      {summary && <p className="cc-summary" aria-live="polite">{summary}</p>}
    </div>
    {actions && <div className="cc-header-actions">{actions}</div>}
  </header>;
}

export function DashboardSection({ title, description, actions, children, className = '' }) {
  const headingId = useId();
  return <section className={`cc-section ${className}`} aria-labelledby={headingId}>
    <div className="cc-section-head">
      <div className="cc-section-heading">
        <h2 className="cc-section-title" id={headingId}>{title}</h2>
        {description && <p className="cc-section-description">{description}</p>}
      </div>
      {actions && <div className="cc-section-actions">{actions}</div>}
    </div>
    {children}
  </section>;
}

// A row of figures separated by hairlines. Items with `to` link to the list
// they count, items with `onClick` act as toggles (`active` marks the pressed one); `tone` colours the figure only when it signals a problem.
export function MetricSummary({ items, size = 'md', label }) {
  return <ul className={`cc-metrics cc-metrics-${size}`} aria-label={label}>
    {items.filter(Boolean).map(item => {
      const body = <>
        <strong className="cc-metric-value">{item.value ?? '—'}</strong>
        <span className="cc-metric-label">{item.label}</span>
        {item.hint && <span className="cc-metric-hint">{item.hint}</span>}
      </>;
      const className = `cc-metric cc-metric-${item.tone || 'neutral'}${item.active ? ' cc-metric-active' : ''}`;
      return <li key={item.label}>{item.to ? <Link className={`${className} cc-metric-link`} to={item.to}>{body}</Link>
        : item.onClick ? <button type="button" className={`${className} cc-metric-link`} aria-pressed={Boolean(item.active)} onClick={item.onClick}>{body}</button>
        : <div className={className}>{body}</div>}</li>;
    })}
  </ul>;
}

// Proportional bar plus a legend of counts; legend entries link when `to` is set.
export function StatusDistribution({ segments, label }) {
  const total = segments.reduce((sum, segment) => sum + (segment.value || 0), 0);
  return <div className="cc-distribution">
    <div className="cc-distribution-bar" role="img" aria-label={`${label}: ${segments.map(segment => `${segment.value} ${segment.label}`).join(', ')}`}>
      {total > 0 && segments.filter(segment => segment.value > 0).map(segment => <i key={segment.label} className={`tone-fill-${segment.tone || 'neutral'}`} style={{ flexGrow: segment.value }} />)}
    </div>
    <ul className="cc-distribution-legend">
      {segments.map(segment => {
        const body = <><i className={`cc-dot tone-fill-${segment.tone || 'neutral'}`} aria-hidden="true" /><span className="cc-distribution-label">{segment.label}</span><strong>{segment.value}</strong></>;
        return <li key={segment.label}>{segment.to ? <Link className="cc-distribution-item" to={segment.to}>{body}</Link> : <span className="cc-distribution-item">{body}</span>}</li>;
      })}
    </ul>
  </div>;
}

// Ring showing `value` out of `total`, with the count in the centre.
export function HealthRing({ value, total, label, tone = 'success', size = 148 }) {
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = total ? Math.min(1, value / total) : 0;
  const centre = size / 2;
  return <div className="cc-ring" style={{ width: size, height: size }} role="img" aria-label={`${value} of ${total} ${label}`}>
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
      <circle className="cc-ring-track" cx={centre} cy={centre} r={radius} strokeWidth={stroke} />
      {ratio > 0 && <circle className={`cc-ring-value cc-ring-${tone}`} cx={centre} cy={centre} r={radius} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={circumference} strokeDashoffset={circumference * (1 - ratio)} transform={`rotate(-90 ${centre} ${centre})`} />}
    </svg>
    <span className="cc-ring-centre" aria-hidden="true"><strong>{value}</strong><span>{label}</span></span>
  </div>;
}

export function StatusIndicator({ status, tone }) {
  if (!status) return null;
  return <span className={`cc-status cc-status-${tone || statusTone(status)}`}><i aria-hidden="true" />{status}</span>;
}

function ActionButton({ action, className }) {
  const Icon = action.icon;
  const content = <>{Icon && <Icon size={15} aria-hidden="true" />}{action.label}</>;
  const classes = `btn ${action.primary ? 'btn-primary' : 'btn-secondary'} btn-sm ${className || ''}`;
  if (action.to) return <Link className={classes} to={action.to}>{content}</Link>;
  return <button type="button" className={classes} onClick={action.onClick}>{content}</button>;
}

// ---------------------------------------------------------------------------
// Attention — every item answers WHAT (category + title), WHY (reason) and
// WHAT NOW (a single action). `meta` carries timing such as an SLA countdown.
// ---------------------------------------------------------------------------
const attentionIcons = { critical: ShieldAlert, warning: AlertTriangle, info: Info, success: CircleCheck, neutral: Info };

export function AttentionItem({ item }) {
  const Icon = item.icon || attentionIcons[item.tone] || Info;
  return <li className={`cc-attention cc-attention-${item.tone || 'info'}`}>
    <span className="cc-attention-icon" aria-hidden="true"><Icon size={16} /></span>
    <div className="cc-attention-body">
      <p className="cc-attention-category">{item.category}{item.meta && <span className="cc-attention-meta">{item.meta}</span>}</p>
      <p className="cc-attention-title">{item.title}</p>
      {item.reason && <p className="cc-attention-reason">{item.reason}</p>}
      {item.context && <p className="cc-attention-context">{item.context}</p>}
    </div>
    {item.action && <div className="cc-attention-action"><ActionButton action={item.action} /></div>}
  </li>;
}

// Only the most urgent item gets a filled button, and only when it is critical,
// so one clear next step stands out instead of a column of blue buttons.
export function AttentionFeed({ items, limit = 6, empty }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return empty || null;
  const visible = (expanded ? items : items.slice(0, limit)).map((item, index) => (index === 0 && item.tone === 'critical' && item.action ? { ...item, action: { ...item.action, primary: true } } : item));
  return <div className="cc-panel">
    <ul className="cc-attention-list">{visible.map(item => <AttentionItem key={item.key} item={item} />)}</ul>
    {items.length > limit && <button type="button" className="cc-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? 'Show fewer' : `Show ${items.length - limit} more`}
    </button>}
  </div>;
}

export function CalmState({ title, children }) {
  return <div className="cc-panel cc-calm" role="status">
    <span className="cc-calm-icon" aria-hidden="true"><CircleCheck size={18} /></span>
    <div><p className="cc-calm-title">{title}</p>{children && <p className="cc-calm-text">{children}</p>}</div>
  </div>;
}

// ---------------------------------------------------------------------------
// Quick actions — compact rows. `hint` and `count` let each portal make an
// action contextual ("3 expiring soon").
// ---------------------------------------------------------------------------
export function QuickActions({ actions, label = 'Quick actions' }) {
  return <ul className="cc-actions" aria-label={label}>
    {actions.filter(Boolean).map(action => {
      const Icon = action.icon;
      const body = <>
        <span className="cc-action-icon" aria-hidden="true">{Icon && <Icon size={17} />}</span>
        <span className="cc-action-text"><span className="cc-action-label">{action.label}</span>{action.hint && <span className="cc-action-hint">{action.hint}</span>}</span>
        {action.count ? <span className={`cc-action-count cc-action-count-${action.tone || 'neutral'}`}>{action.count}</span> : null}
        <ChevronRight className="cc-action-chevron" size={16} aria-hidden="true" />
      </>;
      return <li key={action.label}>{action.to ? <Link className="cc-action" to={action.to}>{body}</Link> : <button type="button" className="cc-action" onClick={action.onClick}>{body}</button>}</li>;
    })}
  </ul>;
}

// ---------------------------------------------------------------------------
// Activity — clickable rows: title, subtitle, status and relative time.
// ---------------------------------------------------------------------------
export function ActivityFeed({ items, empty }) {
  if (!items.length) return empty || null;
  return <div className="cc-panel">
    <ul className="cc-activity">
      {items.map(item => <li key={item.key}>
        <Link className="cc-activity-row" to={item.to}>
          <span className="cc-activity-main">
            <span className="cc-activity-title">{item.title}</span>
            {item.subtitle && <span className="cc-activity-sub">{item.subtitle}</span>}
          </span>
          <span className="cc-activity-side">
            <StatusIndicator status={item.status} tone={item.tone} />
            {item.time && <time className="cc-activity-time" dateTime={String(item.time)} title={formatDateTime(item.time)}>{formatRelative(item.time)}</time>}
          </span>
        </Link>
      </li>)}
    </ul>
  </div>;
}
