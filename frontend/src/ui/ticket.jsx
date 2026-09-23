import { Check, CircleAlert, Clock3, Laptop, Monitor, ShieldAlert, ShieldCheck, Smartphone, Tablet, Watch } from 'lucide-react';
import { Badge } from './primitives';
import { formatDateTime, slaLabel, statusTone } from './format';

export function DeviceIcon({ type = '', model = '', size = 20 }) {
  const text = `${type} ${model}`.toLowerCase();
  const Icon = /iphone|phone|mobile/.test(text) ? Smartphone : /ipad|tablet/.test(text) ? Tablet : /watch/.test(text) ? Watch : /imac|display|monitor|desktop|mac mini|studio/.test(text) ? Monitor : Laptop;
  return <Icon size={size} aria-hidden="true" />;
}

export function ticketImages(ticket) {
  const original = ticket?.originalImages?.length ? ticket.originalImages : ticket?.images || [];
  const annotated = ticket?.annotatedImages || [];
  const seen = new Set();
  return [...original.map(src => ({ src, kind: 'Original' })), ...annotated.map(src => ({ src, kind: 'Annotated' }))].filter(item => item.src && !seen.has(item.src) && seen.add(item.src));
}

export function Evidence({ ticket, resolve, onOpen }) {
  const images = ticketImages(ticket);
  if (!images.length) return <p className="text-muted text-small">No photos were attached to this request.</p>;
  return <div className="evidence-grid">
    {images.map((image, index) => <button type="button" key={image.src} className="evidence-thumb" onClick={() => onOpen(resolve(image.src))} aria-label={`Open ${image.kind.toLowerCase()} photo ${index + 1}`}>
      <img src={resolve(image.src)} alt="" loading="lazy" />
      <Badge tone={image.kind === 'Annotated' ? 'warning' : 'neutral'}>{image.kind}</Badge>
    </button>)}
  </div>;
}

export function levelLabel(level) {
  const value = Number(level) || 0;
  return value > 0 ? `Level ${String(value).padStart(2, '0')}` : 'Not escalated';
}

function elapsedSince(value) {
  if (!value) return null;
  const hours = Math.max(0, (Date.now() - new Date(value).getTime()) / 3600000);
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.floor(hours)} hr`;
  return `${Math.floor(hours / 24)} days`;
}

const slaCopy = {
  success: { icon: ShieldCheck, title: 'Within SLA' },
  warning: { icon: Clock3, title: 'At risk' },
  critical: { icon: ShieldAlert, title: 'Needs escalation' },
};

// SLA facts are rendered as separate labelled values so targets and
// escalation levels never run together into one string.
export function SLAPanel({ ticket, reason, contact, showElapsed = false }) {
  const status = slaLabel(ticket);
  const tone = ['Closed', 'Completed'].includes(ticket.status) && status === 'Healthy' ? 'success' : statusTone(status);
  const copy = slaCopy[tone] || slaCopy.success;
  const Icon = copy.icon;
  const escalated = Number(ticket.escalationLevel) > 0;
  return <div>
    <div className={`sla-status sla-status-${tone}`}>
      <Icon size={18} aria-hidden="true" />
      <div>
        <strong>{status}</strong>
        <p>{reason || ticket.escalationReason || (tone === 'success' ? 'This request is within its service targets.' : 'This request needs attention to stay within its service targets.')}</p>
      </div>
    </div>
    <div className="sla-grid">
      <div className="sla-cell"><span>SLA level</span><strong>{levelLabel(ticket.escalationLevel)}</strong></div>
      <div className="sla-cell"><span>Status</span><strong><Badge dot>{status}</Badge></strong></div>
      <div className="sla-cell"><span>Response target</span><strong>{ticket.responseTarget || '—'}</strong></div>
      <div className="sla-cell"><span>Resolution target</span><strong>{ticket.resolutionTarget || '—'}</strong></div>
      <div className="sla-cell"><span>Resolve by</span><strong>{formatDateTime(ticket.slaTargetAt)}</strong></div>
      {showElapsed ? <div className="sla-cell"><span>Elapsed since creation</span><strong>{elapsedSince(ticket.createdAt) || '—'}</strong></div>
        : <div className="sla-cell"><span>Escalation</span><strong>{ticket.escalationStatus || 'Not Escalated'}</strong></div>}
      {showElapsed && <div className="sla-cell"><span>Escalation</span><strong>{ticket.escalationStatus || 'Not Escalated'}</strong></div>}
      {showElapsed && <div className="sla-cell"><span>Escalated at</span><strong>{escalated ? formatDateTime(ticket.escalatedAt) : '—'}</strong></div>}
      {contact && escalated && <div className="sla-cell" style={{ gridColumn: '1 / -1' }}><span>Escalated to</span><strong>{contact.name} · {contact.contactName}{contact.email ? ` · ${contact.email}` : ''}</strong></div>}
    </div>
  </div>;
}

const baseFlow = ['Open', 'Engineer Assigned', 'Engineer Accepted', 'In Progress', 'Waiting for Parts', 'Completed', 'Closed'];

// Shows the service workflow. "Waiting for Parts" is only listed when the
// ticket is, or has been, in that state.
export function Workflow({ ticket, timeline = [] }) {
  const visited = new Set(timeline.map(event => event.status));
  const status = ticket.status || 'Open';
  const steps = baseFlow.filter(step => step !== 'Waiting for Parts' || status === step || visited.has(step));
  const currentIndex = Math.max(0, steps.indexOf(status));
  const closed = status === 'Closed';
  return <ol className="workflow" aria-label="Service workflow">
    {steps.map((step, index) => {
      const hold = step === 'Waiting for Parts' && index === currentIndex;
      const state = index < currentIndex || (closed && index === currentIndex) ? 'done' : index === currentIndex ? (hold ? 'hold' : 'current') : 'upcoming';
      return <li key={step} className={`workflow-step workflow-${state}`} aria-current={state === 'current' || state === 'hold' ? 'step' : undefined}>
        <span className="workflow-dot" aria-hidden="true">{state === 'done' && <Check size={13} strokeWidth={3} />}</span>
        <span className="workflow-label">{step}{hold && <span className="sr-only"> (on hold)</span>}</span>
      </li>;
    })}
  </ol>;
}

export function CoverageTiles({ device, entitlements }) {
  if (!device) return null;
  return <div className="stack-12">
    <div className="coverage-block">
      <div className="coverage-tile">
        <div className="coverage-tile-head"><strong>Warranty</strong><Badge dot>{device.warrantyStatus || 'Not available'}</Badge></div>
        <p>{device.warrantyExpiry ? `Valid until ${formatDateTime(device.warrantyExpiry).split(' • ')[0]}` : 'No expiry date on record'}</p>
      </div>
      <div className="coverage-tile">
        <div className="coverage-tile-head"><strong>AMC</strong><Badge dot>{device.amcStatus || 'Not available'}</Badge></div>
        <p>{device.amcExpiry ? `Valid until ${formatDateTime(device.amcExpiry).split(' • ')[0]}` : 'No expiry date on record'}</p>
      </div>
    </div>
    {entitlements !== undefined && <div>
      <p className="subheading">Service entitlements</p>
      {entitlements?.length ? <div className="chip-list">{entitlements.map(item => <span className="chip" key={item}>{item}</span>)}</div> : <p className="text-muted text-small"><CircleAlert size={13} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 4 }} />No active coverage entitlements.</p>}
    </div>}
  </div>;
}
