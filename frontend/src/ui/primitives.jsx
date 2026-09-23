import { useId } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Check, ChevronRight, Inbox, RefreshCcw, Search, Star } from 'lucide-react';
import { formatDateTime, initials, statusTone } from './format';

export function Button({ variant = 'secondary', size, icon: Icon, children, className = '', to, type = 'button', ...props }) {
  const classes = `btn btn-${variant}${size ? ` btn-${size}` : ''} ${className}`.trim();
  const content = <>{Icon && <Icon size={size === 'sm' ? 14 : 16} aria-hidden="true" />}{children}</>;
  if (to) return <Link className={classes} to={to} {...props}>{content}</Link>;
  return <button type={type} className={classes} {...props}>{content}</button>;
}

export function IconButton({ label, icon: Icon, className = '', badge, ...props }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}>
    <Icon size={18} aria-hidden="true" />
    {badge > 0 && <span className="icon-badge" aria-label={`${badge} unread`}>{badge > 99 ? '99+' : badge}</span>}
  </button>;
}

export function Badge({ children, tone, dot = false, className = '' }) {
  if (children === undefined || children === null || children === '') return null;
  const resolved = tone || statusTone(children);
  return <span className={`badge badge-${resolved} ${className}`}>{dot && <i className="badge-dot" aria-hidden="true" />}{children}</span>;
}

export function StatusBadge({ status, fallback = 'Not available' }) {
  return <Badge dot>{status || fallback}</Badge>;
}

export function PageHeader({ title, description, actions, back, meta, eyebrow }) {
  return <div className="page-header">
    {back && <Link className="back-link" to={back.to}><ArrowLeft size={15} aria-hidden="true" />{back.label}</Link>}
    <div className="page-header-row">
      <div className="page-header-text">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-description">{description}</p>}
        {meta && <div className="page-meta">{meta}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  </div>;
}

export function SectionHeader({ title, description, actions, as: Heading = 'h2', id }) {
  return <div className="section-header">
    <div>
      <Heading className="section-title" id={id}>{title}</Heading>
      {description && <p className="section-description">{description}</p>}
    </div>
    {actions && <div className="section-actions">{actions}</div>}
  </div>;
}

export function Card({ title, description, actions, children, className = '', flush = false, as: Element = 'section', footer }) {
  const headingId = useId();
  return <Element className={`card ${flush ? 'card-flush' : ''} ${className}`} aria-labelledby={title ? headingId : undefined}>
    {title && <div className="card-header">
      <div>
        <h2 className="card-title" id={headingId}>{title}</h2>
        {description && <p className="card-description">{description}</p>}
      </div>
      {actions && <div className="card-actions">{actions}</div>}
    </div>}
    <div className="card-body">{children}</div>
    {footer && <div className="card-footer">{footer}</div>}
  </Element>;
}

export function KPI({ label, value, hint, tone = 'neutral', icon: Icon, to }) {
  const content = <>
    <div className="kpi-top">
      <span className="kpi-label">{label}</span>
      {Icon && <span className={`kpi-icon kpi-icon-${tone}`} aria-hidden="true"><Icon size={16} /></span>}
    </div>
    <strong className="kpi-value">{value ?? '—'}</strong>
    {hint && <span className="kpi-hint">{hint}</span>}
  </>;
  if (to) return <Link className={`kpi kpi-link kpi-${tone}`} to={to}>{content}</Link>;
  return <div className={`kpi kpi-${tone}`}>{content}</div>;
}

export function KPIGrid({ children, columns }) {
  return <div className="kpi-grid" style={columns ? { '--kpi-columns': columns } : undefined}>{children}</div>;
}

export function EmptyState({ icon: Icon = Inbox, title, description, action, compact = false }) {
  return <div className={`state state-empty ${compact ? 'state-compact' : ''}`}>
    <span className="state-icon" aria-hidden="true"><Icon size={20} /></span>
    <p className="state-title">{title}</p>
    {description && <p className="state-description">{description}</p>}
    {action && <div className="state-action">{action}</div>}
  </div>;
}

export function ErrorState({ title = 'Unable to load this page', message, onRetry, compact = false }) {
  return <div className={`state state-error ${compact ? 'state-compact' : ''}`} role="alert">
    <span className="state-icon" aria-hidden="true"><AlertTriangle size={20} /></span>
    <p className="state-title">{title}</p>
    <p className="state-description">{message || 'Please try again.'}</p>
    {onRetry && <div className="state-action"><Button icon={RefreshCcw} onClick={() => onRetry()}>Retry</Button></div>}
  </div>;
}

export function InlineAlert({ tone = 'critical', title, children, action }) {
  return <div className={`inline-alert inline-alert-${tone}`} role={tone === 'critical' ? 'alert' : 'status'}>
    <AlertTriangle size={16} aria-hidden="true" />
    <div>{title && <strong>{title}</strong>}{children && <span>{children}</span>}</div>
    {action}
  </div>;
}

export function Skeleton({ width = '100%', height = 14, radius, className = '' }) {
  return <span className={`skeleton ${className}`} style={{ width, height, borderRadius: radius }} aria-hidden="true" />;
}

export function TableSkeleton({ rows = 6, columns = 6 }) {
  return <div className="table-skeleton" aria-busy="true" aria-label="Loading">
    {Array.from({ length: rows }, (_, row) => <div className="table-skeleton-row" key={row}>
      {Array.from({ length: columns }, (_, column) => <Skeleton key={column} width={column === 0 ? '70%' : `${45 + ((row + column) % 4) * 12}%`} />)}
    </div>)}
  </div>;
}

export function PageSkeleton({ kpis = 4, variant = 'dashboard' }) {
  return <div className="page-skeleton" aria-busy="true" aria-label="Loading">
    <div className="page-header"><Skeleton width={220} height={28} /><Skeleton width={340} height={14} /></div>
    {variant === 'dashboard' && <div className="kpi-grid">{Array.from({ length: kpis }, (_, index) => <div className="kpi" key={index}><Skeleton width="50%" /><Skeleton width="35%" height={28} /></div>)}</div>}
    {variant === 'detail' && <div className="detail-layout"><div className="card"><div className="card-body stack-16">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} width={`${60 + (index % 3) * 12}%`} />)}</div></div><div className="card"><div className="card-body stack-16">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} />)}</div></div></div>}
    <div className="card"><TableSkeleton /></div>
  </div>;
}

export function SearchInput({ value, onChange, placeholder = 'Search', label = 'Search', className = '' }) {
  return <label className={`search-input ${className}`}>
    <Search size={16} aria-hidden="true" />
    <span className="sr-only">{label}</span>
    <input type="search" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} />
  </label>;
}

export function FilterBar({ children, summary }) {
  return <div className="filter-bar">
    <div className="filter-bar-controls">{children}</div>
    {summary && <div className="filter-bar-summary">{summary}</div>}
  </div>;
}

export function FilterSelect({ label, value, onChange, options, allLabel = 'All' }) {
  return <label className="filter-select">
    <span className="sr-only">{label}</span>
    <select value={value} onChange={event => onChange(event.target.value)} aria-label={label}>
      <option value="All">{allLabel}</option>
      {options.map(option => typeof option === 'string'
        ? <option key={option} value={option}>{option}</option>
        : <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>;
}

export function Field({ label, hint, error, children, required, className = '', htmlFor }) {
  const generated = useId();
  const id = htmlFor || generated;
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  const control = typeof children === 'function' ? children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined }) : children;
  return <div className={`field ${error ? 'field-invalid' : ''} ${className}`}>
    <label className="field-label" htmlFor={id}>{label}{required && <span className="field-required" aria-hidden="true"> *</span>}</label>
    {control}
    {error ? <p className="field-error" id={`${id}-error`}>{error}</p> : hint ? <p className="field-hint" id={`${id}-hint`}>{hint}</p> : null}
  </div>;
}

export function Tabs({ tabs, value, onChange, label = 'Sections' }) {
  return <div className="tabs" role="tablist" aria-label={label}>
    {tabs.map(tab => {
      const key = tab.value ?? tab.to;
      const selected = value === key;
      const content = <>{tab.label}{tab.count !== undefined && <span className="tab-count">{tab.count}</span>}</>;
      if (tab.to) return <Link key={key} to={tab.to} role="tab" aria-selected={selected} className={`tab ${selected ? 'tab-active' : ''}`}>{content}</Link>;
      return <button key={key} type="button" role="tab" aria-selected={selected} className={`tab ${selected ? 'tab-active' : ''}`} onClick={() => onChange(key)}>{content}</button>;
    })}
  </div>;
}

export function Stepper({ steps, current, onStepClick }) {
  return <ol className="stepper" aria-label="Progress">
    {steps.map((step, index) => {
      const state = index < current ? 'done' : index === current ? 'current' : 'upcoming';
      const canClick = onStepClick && index < current;
      return <li key={step} className={`stepper-item stepper-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
        <button type="button" className="stepper-button" disabled={!canClick} onClick={() => canClick && onStepClick(index)}>
          <span className="stepper-index">{state === 'done' ? <Check size={13} aria-hidden="true" /> : index + 1}</span>
          <span className="stepper-label">{step}</span>
        </button>
      </li>;
    })}
  </ol>;
}

export function InfoList({ items, columns = 1 }) {
  return <dl className="info-list" style={{ '--info-columns': columns }}>
    {items.filter(Boolean).map(([label, value]) => <div className="info-item" key={label}>
      <dt>{label}</dt>
      <dd>{value === undefined || value === null || value === '' ? <span className="text-muted">Not available</span> : value}</dd>
    </div>)}
  </dl>;
}

export function Avatar({ name, size = 32, tone = 'default' }) {
  return <span className={`avatar avatar-${tone}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }} aria-hidden="true">{initials(name)}</span>;
}

export function Timeline({ events, emptyText = 'No activity recorded yet.' }) {
  if (!events?.length) return <EmptyState compact title={emptyText} />;
  return <ol className="timeline">
    {events.map((event, index) => {
      const tone = statusTone(event.status);
      const last = index === events.length - 1;
      return <li className={`timeline-item timeline-${tone} ${last ? 'timeline-latest' : ''}`} key={`${event._id || event.status}-${index}`}>
        <span className="timeline-marker" aria-hidden="true" />
        <div className="timeline-content">
          <p className="timeline-title">{event.status}</p>
          {(event.message || event.note) && <p className="timeline-text">{event.message || event.note}</p>}
          <p className="timeline-meta">{event.updatedBy && <span>{event.updatedBy}</span>}{event.timestamp && <time dateTime={event.timestamp}>{formatDateTime(event.timestamp)}</time>}</p>
        </div>
      </li>;
    })}
  </ol>;
}

export function Stars({ rating = 0, size = 14, label }) {
  const value = Math.max(0, Math.min(5, Number(rating) || 0));
  return <span className="stars" role="img" aria-label={label || `${value} out of 5 stars`}>
    {[1, 2, 3, 4, 5].map(index => <Star key={index} size={size} className={index <= value ? 'star-on' : 'star-off'} fill={index <= value ? 'currentColor' : 'none'} aria-hidden="true" />)}
  </span>;
}

export function RowAction({ to, label = 'View' }) {
  return <Link className="row-action" to={to}>{label}<ChevronRight size={14} aria-hidden="true" /></Link>;
}

export function TableCard({ loading, error, onRetry, errorTitle, isEmpty, empty, children, toolbar, footer, columns = 6 }) {
  return <div className="card card-flush table-card">
    {toolbar}
    {loading ? <TableSkeleton columns={columns} /> : error ? <ErrorState compact title={errorTitle} message={error} onRetry={onRetry} /> : isEmpty ? empty : <div className="table-scroll">{children}</div>}
    {footer}
  </div>;
}
