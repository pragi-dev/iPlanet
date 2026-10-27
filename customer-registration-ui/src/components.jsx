import { AlertTriangle, Check, CheckCircle2, Info } from 'lucide-react';

// Copies of Button, Field and InlineAlert from frontend/src/ui/primitives.jsx (minus router
// links), and of JourneyTrack from frontend/src/ui/experience.jsx, so the markup and class
// names match the portal without importing from it.

export function Button({ variant = 'secondary', size, icon: Icon, children, className = '', type = 'button', ...props }) {
  const classes = `btn btn-${variant}${size ? ` btn-${size}` : ''} ${className}`.trim();
  return <button type={type} className={classes} {...props}>{Icon && <Icon size={size === 'sm' ? 14 : 16} aria-hidden="true" />}{children}</button>;
}

export function Field({ id, label, hint, error, children, required, className = '' }) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  const control = children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined });
  return <div className={`field ${error ? 'field-invalid' : ''} ${className}`}>
    <label className="field-label" htmlFor={id}>{label}{required && <span className="field-required" aria-hidden="true"> *</span>}</label>
    {control}
    {error ? <p className="field-error" id={`${id}-error`}>{error}</p> : hint ? <p className="field-hint" id={`${id}-hint`}>{hint}</p> : null}
  </div>;
}

const alertIcons = { critical: AlertTriangle, warning: AlertTriangle, info: Info, success: CheckCircle2 };

const stateLabels = { done: 'completed', current: 'in progress', upcoming: 'upcoming' };
const timeFormat = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

// Vertical steps: done (check), current (outlined, filled centre), upcoming (grey).
export function JourneyTrack({ steps, label }) {
  return <ol className="journey" aria-label={label}>
    {steps.map(step => {
      const meta = [step.note, step.at ? timeFormat.format(step.at) : null].filter(Boolean).join(' · ');
      return <li key={step.key} className={`journey-step journey-${step.state}`} aria-current={step.state === 'current' ? 'step' : undefined}>
        <span className="journey-dot" aria-hidden="true">{step.state === 'done' && <Check size={12} strokeWidth={3} />}</span>
        <span className="journey-text">
          <span className="journey-label">{step.label}<span className="sr-only">, {stateLabels[step.state]}</span>{step.state === 'current' && <span className="journey-flag"> (current stage)</span>}</span>
          {meta && <span className="journey-meta">{meta}</span>}
        </span>
      </li>;
    })}
  </ol>;
}

export function InlineAlert({ tone = 'critical', title, children }) {
  const Icon = alertIcons[tone] || AlertTriangle;
  return <div className={`inline-alert inline-alert-${tone}`} role={tone === 'critical' ? 'alert' : 'status'}>
    <Icon size={16} aria-hidden="true" />
    <div>{title && <strong>{title}</strong>}{children && <span>{children}</span>}</div>
  </div>;
}
