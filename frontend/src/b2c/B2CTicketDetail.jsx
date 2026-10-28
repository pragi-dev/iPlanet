import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Ban, CheckCircle2, ChevronLeft, ClipboardCheck, Download, Hand, Mail, MessageSquare, Paperclip, Play, RefreshCcw, RotateCcw, Route, Send, StickyNote, Undo2, UserPlus, XCircle,
} from 'lucide-react';
import {
  ActivityTimeline, Badge, Button, ErrorState, Field, InfoList, InlineAlert, JourneyTrack, Modal, NextAction, PageSkeleton, Section, Surface, formatDate, formatDateTime, friendlyError, useAsync,
} from '../ui';
import { b2cTicketAction, downloadB2CAttachment, getB2CStaff, getB2CTicket } from './api';
import { ACK_STATUS, b2cJourneySteps, B2CShell, B2CStatus, B2C_ROLE_LABELS, CRM_STATUS, CategoryBadge, IDENTIFIER_LABELS, NoB2CAccess, TRIAGE_REASONS, auditTimeline } from './shared';

const ACTION_META = {
  complete_triage: { label: 'Complete triage', icon: ClipboardCheck },
  retry_crm: { label: 'Retry CRM lookup', icon: RefreshCcw, direct: true },
  claim: { label: 'Take ownership', icon: Hand, direct: true },
  assign: { label: 'Assign', icon: UserPlus },
  accept: { label: 'Accept assignment', icon: CheckCircle2, direct: true },
  start: { label: 'Start work', icon: Play, direct: true },
  reroute: { label: 'Reroute', icon: Route },
  set_path: { label: 'Edit workflow path', icon: Route },
  request_clarification: { label: 'Request clarification', icon: MessageSquare },
  propose_resolution: { label: 'Complete repair', icon: CheckCircle2 },
  approve_resolution: { label: 'Approve resolution', icon: CheckCircle2 },
  reject_resolution: { label: 'Return for rework', icon: Undo2 },
  close: { label: 'Close', icon: XCircle },
  close_unresolved: { label: 'Close without resolution', icon: Ban },
  reopen: { label: 'Reopen', icon: RotateCcw },
  add_note: { label: 'Add internal note', icon: StickyNote },
};
const DONE = { claim: 'You now own this escalation.', accept: 'Assignment accepted.', start: 'Work started.', retry_crm: 'CRM lookup repeated.', complete_triage: 'Triage completed and the escalation was routed.', assign: 'Assigned.', reroute: 'Rerouted.', set_path: 'Workflow path updated.', request_clarification: 'Clarification request queued for the customer.', propose_resolution: 'Repair completion submitted.', approve_resolution: 'Resolution approved. The final customer email has been queued.', reject_resolution: 'Returned to the owner for rework.', close: 'Escalation closed.', close_unresolved: 'Escalation closed.', reopen: 'Escalation reopened.', add_note: 'Note added.' };
const OUTBOUND_STATUS = { queued: ['Queued', 'info'], sending: ['Sending', 'info'], retrying: ['Retrying', 'warning'], held: ['Held — template not approved', 'warning'], sent: ['Sent', 'success'], failed: ['Failed', 'critical'] };
const REJECT_REASONS = { type_not_allowed: 'file type not allowed', content_does_not_match_type: 'content does not match its type', too_large: 'too large', empty_file: 'empty', content_unavailable: 'not downloadable', too_many_attachments: 'too many attachments' };
const levelName = (levels, key) => levels.find(level => level.key === key)?.label || B2C_ROLE_LABELS[key] || key;

// What the signed-in user should do next, from the status and allowed actions.
function nextStep(ticket, allowed, levels, open) {
  const can = action => allowed.includes(action);
  const button = (action, extra = {}) => ({ label: ACTION_META[action].label, icon: ACTION_META[action].icon, onClick: () => open(action), ...extra });
  const level = levelName(levels, ticket.workflow?.currentLevel);
  switch (ticket.status) {
    case 'Pending Triage':
      return { tone: 'warning', eyebrow: 'Triage', title: 'Review before routing', description: (ticket.triage?.reasons || []).map(reason => TRIAGE_REASONS[reason] || reason).join('. ') || 'This escalation needs review.', actions: [can('complete_triage') && button('complete_triage'), can('retry_crm') && button('retry_crm', { secondary: true })] };
    case 'Open':
    case 'Reopened':
      return { tone: ticket.status === 'Reopened' ? 'warning' : 'info', title: ticket.workflow?.assignee?.name ? `Reopened — with ${ticket.workflow.assignee.name}` : `Waiting for a ${level} to take ownership`, description: ticket.workflow?.assignee?.name ? 'Start work again or hand it to someone else.' : 'Take ownership to accept the work, or assign it to a colleague at this level.', actions: [can('claim') && button('claim'), can('start') && button('start'), can('assign') && button('assign', { secondary: true }), can('reroute') && button('reroute', { secondary: true })] };
    case 'Engineer Assigned':
      return { tone: 'info', title: `Assigned to ${ticket.workflow?.assignee?.name}`, description: `Waiting for them to accept. Current level: ${level}.`, actions: [can('accept') && button('accept'), can('assign') && button('assign', { secondary: true })] };
    case 'Engineer Accepted':
      return { tone: 'info', title: `${ticket.workflow?.assignee?.name} accepted`, description: `Accepted but work has not started. Current level: ${level}.`, actions: [can('start') && button('start'), can('assign') && button('assign', { secondary: true })] };
    case 'In Progress':
      return { tone: 'info', title: `Work in progress (${level})`, description: 'Complete the repair when ready, or ask the customer for details. Overdue escalations are escalated automatically.', actions: [can('propose_resolution') && button('propose_resolution'), can('request_clarification') && button('request_clarification', { secondary: true })] };
    case 'Awaiting Customer':
      return { tone: 'neutral', title: 'Waiting for the customer', description: 'The escalation returns to In Progress automatically when the customer replies to the clarification email.', actions: [can('escalate') && button('escalate', { secondary: true })] };
    case 'Pending Validation':
      return { tone: 'warning', eyebrow: 'Validation', title: can('approve_resolution') ? 'Resolution awaiting your validation' : `Resolution awaiting validation by ${ticket.validation?.validatorLevel ? levelName(levels, ticket.validation.validatorLevel) : 'a B2C admin'}`, description: ticket.validation?.resolutionSummary, actions: [can('approve_resolution') && button('approve_resolution'), can('reject_resolution') && button('reject_resolution', { secondary: true })] };
    case 'Completed':
      return { tone: 'success', title: 'Repair completed', description: 'The final customer email has been queued. Close the escalation once nothing further is needed.', actions: [can('close') && button('close'), can('reopen') && button('reopen', { secondary: true })] };
    default:
      return { tone: 'neutral', eyebrow: 'Status', title: 'Closed', description: ticket.closure?.reason && ticket.closure.reason !== 'Resolved' ? `Closed without resolution: ${ticket.closure.reason}` : 'This escalation is closed.', actions: [can('reopen') && button('reopen', { secondary: true })] };
  }
}

export function B2CTicketDetail() {
  const { id } = useParams();
  const state = useAsync(() => getB2CTicket(id), [id]);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const data = state.data && String(state.data.ticket?._id) === String(id) ? state.data : null;
  const crumbs = [{ label: 'Escalation queue', to: '/b2c/tickets' }, { label: data?.ticket?.reference || 'Escalation' }];

  if (state.error?.status === 403) return <B2CShell title="Escalation" crumbs={crumbs}><NoB2CAccess /></B2CShell>;
  if (!data && !state.error) return <B2CShell title="Escalation" crumbs={crumbs}><PageSkeleton variant="detail" kpis={0} /></B2CShell>;
  if (!data) return <B2CShell title="Escalation" crumbs={crumbs}><div className="card"><ErrorState title={state.error?.status === 404 ? 'Escalation not found' : 'Unable to load this escalation'} message={state.error?.status === 404 ? 'It does not exist or is not visible to your account.' : friendlyError(state.error)} onRetry={state.error?.status === 404 ? undefined : state.reload} /></div></B2CShell>;

  const { ticket, conversation, audit, allowedActions: allowed, workflow, templates, crmConfigured } = data;
  const levels = workflow.levels;

  const run = async (action, payload = {}) => {
    setBusy(true);
    setError('');
    try {
      const updated = await b2cTicketAction(id, action, payload);
      state.setData(updated);
      setDialog(null);
      setNotice(DONE[action] || 'Updated.');
      return true;
    } catch (actionError) {
      setError(friendlyError(actionError, `Unable to ${ACTION_META[action].label.toLowerCase()}.`));
      if (actionError.status === 409) void state.reload({ silent: true });
      return false;
    } finally { setBusy(false); }
  };
  const open = action => (ACTION_META[action].direct ? void run(action) : setDialog(action));
  const next = nextStep(ticket, allowed, levels, open);
  next.actions = next.actions.filter(Boolean).map(action => ({ ...action, disabled: busy }));
  const secondary = allowed.filter(action => !next.actions.some(item => item.label === ACTION_META[action].label) && action !== 'add_note');

  return <B2CShell title={ticket.reference} crumbs={crumbs}>
    <header className="case-header">
      <Link className="back-link" to="/b2c/tickets"><ChevronLeft size={16} aria-hidden="true" />Escalation queue</Link>
      <div className="case-header-row">
        <div className="page-header-text">
          <p className="case-id mono">{ticket.reference}</p>
          <h1 className="case-title">{ticket.subject || 'No subject'}</h1>
          <p className="case-sub">{[ticket.customer?.name || ticket.customer?.email, ticket.region, `received ${formatDateTime(ticket.createdAt)}`].filter(Boolean).join(' · ')}</p>
          <div className="case-badges"><B2CStatus status={ticket.status} /><CategoryBadge category={ticket.category} /><Badge tone={CRM_STATUS[ticket.crm?.status]?.tone}>{CRM_STATUS[ticket.crm?.status]?.label}</Badge><Badge tone={ticket.acknowledgement?.status === 'sent' ? 'success' : ticket.acknowledgement?.status === 'failed' ? 'critical' : 'neutral'}>{ACK_STATUS[ticket.acknowledgement?.status]}</Badge></div>
        </div>
        <div className="page-actions">{allowed.includes('add_note') && <Button icon={StickyNote} onClick={() => setDialog('add_note')}>Add note</Button>}</div>
      </div>
    </header>

    {notice && <InlineAlert tone="success" title={notice} action={<Button size="sm" variant="ghost" onClick={() => setNotice('')}>Dismiss</Button>} />}
    {error && <InlineAlert title={error} action={<Button size="sm" variant="ghost" onClick={() => setError('')}>Dismiss</Button>} />}

    <NextAction tone={next.tone} eyebrow={next.eyebrow} title={next.title} description={next.description} actions={next.actions} />
    {secondary.length > 0 && <div className="row b2c-more-actions"><span className="text-muted text-small">More actions:</span>{secondary.map(action => <Button key={action} size="sm" variant="ghost" icon={ACTION_META[action].icon} disabled={busy} onClick={() => open(action)}>{ACTION_META[action].label}</Button>)}</div>}

    <div className="workspace">
      <div className="workspace-main">
        <Surface label="Escalation">
          <Section stacked title="Email conversation" description="Emails are shown as plain text. Attachments download as files and are never opened in the browser.">
            <ol className="b2c-thread">{conversation.map(message => <EmailMessage key={message._id} message={message} ticketId={ticket._id} onError={setError} />)}</ol>
          </Section>
          {(ticket.validation?.resolutionSummary || ticket.resolution?.summary) && <Section stacked title="Resolution">
            <InfoList columns={2} items={[
              ['Summary', ticket.resolution?.summary || ticket.validation?.resolutionSummary],
              ['Submitted by', ticket.validation?.proposedBy?.name ? `${ticket.validation.proposedBy.name} · ${formatDateTime(ticket.validation.proposedAt)}` : null],
              ['Validation', ticket.validation?.decision ? `${ticket.validation.decision === 'approved' ? 'Approved' : 'Returned'} by ${ticket.validation.decidedBy?.name} · ${formatDateTime(ticket.validation.decidedAt)}` : ticket.status === 'Pending Validation' ? 'Awaiting validation' : null],
              ['Returned because', ticket.validation?.decision === 'rejected' ? ticket.validation.rejectionReason : null],
              ['Resolved', ticket.resolution?.resolvedAt ? `${ticket.resolution.resolvedBy?.name} · ${formatDateTime(ticket.resolution.resolvedAt)}` : null],
            ].filter(([, value]) => value)} />
          </Section>}
          <Section stacked title="Escalation history" description="Every automatic step and staff action, newest first"><ActivityTimeline events={auditTimeline(audit)} limit={8} /></Section>
        </Surface>
      </div>

      <aside className="workspace-side" aria-label="Escalation details">
        <div className="card">
          <section className="side-section" aria-label="Service journey">
            <p className="side-section-title">Service journey</p>
            <JourneyTrack steps={b2cJourneySteps(ticket, audit)} label="Service journey" />
          </section>
          <section className="side-section" aria-label="Customer">
            <div className="side-section-head"><p className="side-section-title">Customer</p>{allowed.includes('retry_crm') && crmConfigured && <Button size="sm" variant="ghost" icon={RefreshCcw} disabled={busy} onClick={() => run('retry_crm')}>CRM lookup</Button>}</div>
            {ticket.crm?.status === 'not_configured' && <p className="text-muted text-small">The CRM connector is not configured, so customer and device details come from the email only.</p>}
            {ticket.crm?.status === 'error' && <InlineAlert tone="warning" title="CRM lookup failed">{ticket.crm.nextAttemptAt ? `Retrying automatically after ${formatDateTime(ticket.crm.nextAttemptAt)}.` : 'Automatic retries have stopped. Retry manually.'}</InlineAlert>}
            {ticket.crm?.mode === 'test' && <p className="b2c-test-label">Data from the CRM TEST adapter — not TCM's CRM</p>}
            <InfoList items={[['Name', ticket.customer?.name], ['Email', ticket.customer?.email], ['Phone', ticket.customer?.phone], ['CRM customer ID', ticket.customer?.crmCustomerId], ['Region', ticket.region]]} />
          </section>
          <section className="side-section" aria-label="Devices">
            <p className="side-section-title">Devices</p>
            {ticket.devices?.length ? <ul className="b2c-device-list">{ticket.devices.map(device => <li key={device.serialNumber || device.crmDeviceId}>
              <strong>{device.productName || device.model || 'Device'}</strong>
              <span className="mono">{device.serialNumber}</span>
              <span className="text-muted text-small">{[device.model, device.warrantyStatus && `Warranty: ${device.warrantyStatus}`, device.purchaseDate && `Purchased ${formatDate(device.purchaseDate)}`].filter(Boolean).join(' · ')}</span>
            </li>)}</ul> : <p className="text-muted text-small">No device details from the CRM.</p>}
            {ticket.crmCases?.length > 0 && <InfoList items={ticket.crmCases.map(item => [`CRM case ${item.caseId}`, [item.status, item.openedAt && `opened ${formatDate(item.openedAt)}`].filter(Boolean).join(' · ')])} />}
          </section>
          <section className="side-section" aria-label="Identifiers and classification">
            <p className="side-section-title">Identifiers &amp; classification</p>
            <InfoList items={[
              ...(ticket.identifiers?.length ? ticket.identifiers.map((item, index) => [`${IDENTIFIER_LABELS[item.type] || item.type}${ticket.identifiers.filter(other => other.type === item.type).length > 1 ? ` ${index + 1}` : ''}`, <span key={item.value}><span className="mono">{item.value}</span> <span className="text-muted text-small">({item.source === 'manual' ? 'added in triage' : `from ${item.source}`})</span></span>]) : [['Identifiers', 'None found']]),
              ['Category', `${ticket.category}${ticket.classification?.source ? ` · ${ticket.classification.source === 'inbox' ? 'from inbox' : ticket.classification.source === 'rule' ? `keywords: ${ticket.classification.matched.join(', ')}` : 'set manually'}` : ''}`],
              ['Inbox', ticket.inboxAddress],
            ]} />
          </section>
        </div>
      </aside>
    </div>

    {dialog && <ActionDialog action={dialog} ticket={ticket} workflow={workflow} templates={templates} busy={busy} error={error} onSubmit={payload => run(dialog, payload)} onClose={() => { setDialog(null); setError(''); }} />}
  </B2CShell>;
}

function EmailMessage({ message, ticketId, onError }) {
  const inbound = message.direction === 'inbound';
  const [status, tone] = OUTBOUND_STATUS[message.status] || [];
  return <li className={`b2c-message b2c-message-${message.direction}`}>
    <div className="b2c-message-head">
      <span className="b2c-message-icon" aria-hidden="true">{inbound ? <Mail size={15} /> : <Send size={15} />}</span>
      <div>
        <strong>{inbound ? (message.from?.name || message.from?.address) : `To ${message.to}`}</strong>
        <span className="text-muted text-small">{inbound ? message.from?.address : `${message.kind === 'final' ? 'Final customer email' : message.kind === 'clarification' ? 'Clarification request' : 'Acknowledgement'}${message.createdBy?.name ? ` · by ${message.createdBy.name}` : ' · automatic'}`} · {formatDateTime(message.at)}</span>
      </div>
      {!inbound && <span className="b2c-message-status">{message.mode === 'test' && <Badge tone="warning">Test adapter — not delivered</Badge>}<Badge tone={tone}>{status}</Badge></span>}
    </div>
    {message.subject && <p className="b2c-message-subject">{message.subject}</p>}
    <p className="description-text b2c-message-body">{message.bodyText || <span className="text-muted">No text content.</span>}</p>
    {message.bodyTruncated && <p className="text-muted text-small">This email was longer than the stored limit and has been shortened.</p>}
    {message.lastError && message.status !== 'sent' && <p className="text-muted text-small">Last error: {message.lastError}</p>}
    {message.attachments?.length > 0 && <ul className="b2c-attachments">{message.attachments.map((file, index) => <li key={`${file.filename}-${index}`}>
      {file.status === 'stored'
        ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => downloadB2CAttachment(ticketId, file.downloadKey, file.filename).catch(downloadError => onError(friendlyError(downloadError, 'Unable to download the attachment.')))}><Download size={14} aria-hidden="true" />{file.filename}<span className="text-muted">{Math.max(1, Math.round(file.size / 1024))} KB</span></button>
        : <span className="b2c-attachment-rejected"><Paperclip size={14} aria-hidden="true" />{file.filename} — not stored ({REJECT_REASONS[file.rejectReason] || file.rejectReason})</span>}
    </li>)}</ul>}
  </li>;
}

function TemplateNote({ template, label }) {
  if (!template) return null;
  return template.approved
    ? <p className="text-muted text-small">Sent with the approved “{label}” template. Subject: {template.subject}</p>
    : <InlineAlert tone="warning" title={`The “${label}” template is not approved yet`}>The email will be held until a B2C administrator approves the template wording in B2C Settings.</InlineAlert>;
}

function ActionDialog({ action, ticket, workflow, templates, busy, error, onSubmit, onClose }) {
  const [form, setForm] = useState(() => ({
    category: ticket.category === 'Unclassified' ? '' : ticket.category, region: ticket.region || '', identifiers: [], identifierType: 'caseId', identifierValue: '', rerunCrm: true,
    userId: '', levelKey: '', reason: '', message: '', note: '', resolutionSummary: '', customerMessage: action === 'approve_resolution' ? ticket.validation?.customerMessage || '' : '', path: ticket.path || [],
  }));
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const staff = useAsync(() => (['assign', 'reroute'].includes(action) ? getB2CStaff() : Promise.resolve([])), [action]);
  const targetLevel = action === 'assign' ? ticket.workflow?.currentLevel : form.levelKey;
  const eligible = (staff.data || []).filter(person => person.b2cRole === targetLevel && (!person.b2cRegions?.length || person.b2cRegions.includes(ticket.region)) && String(person._id) !== String(ticket.workflow?.assignee?.userId));
  const levelLabel = key => workflow.levels.find(level => level.key === key)?.label || key;

  const payload = () => {
    switch (action) {
      case 'complete_triage': return { category: form.category, region: form.region, identifiers: form.identifiers, rerunCrm: form.rerunCrm, note: form.note };
      case 'assign': return { userId: form.userId };
      case 'reroute': return { levelKey: form.levelKey, reason: form.reason, ...(form.userId ? { userId: form.userId } : {}) };
      case 'set_path': return { path: form.path };
      case 'request_clarification': return { message: form.message };
      case 'propose_resolution': return { resolutionSummary: form.resolutionSummary, customerMessage: form.customerMessage };
      case 'approve_resolution': return { customerMessage: form.customerMessage, note: form.note };
      case 'reject_resolution': case 'reopen': return { reason: form.reason };
      case 'close_unresolved': return { reason: form.reason, customerMessage: form.customerMessage };
      case 'close': case 'add_note': return { note: form.note };
      default: return {};
    }
  };
  const valid = {
    complete_triage: Boolean(form.category), assign: Boolean(form.userId), reroute: form.levelKey && form.reason.trim(), set_path: form.path.length > 0,
    request_clarification: form.message.trim(), propose_resolution: form.resolutionSummary.trim() && form.customerMessage.trim(), reject_resolution: form.reason.trim(), reopen: form.reason.trim(),
    close_unresolved: form.reason.trim(), add_note: form.note.trim(),
  }[action] ?? true;
  const textarea = (key, placeholder, rows = 4) => props => <textarea {...props} rows={rows} value={form[key]} onChange={event => set(key, event.target.value)} placeholder={placeholder} />;
  const staffSelect = (required, hint) => <Field label={required ? 'Staff member' : 'Assign to (optional)'} hint={hint}>{props => <select {...props} value={form.userId} onChange={event => set('userId', event.target.value)}>
    <option value="">{required ? 'Choose a person' : 'Leave in the level queue (or assign automatically if only one person holds it)'}</option>
    {eligible.map(person => <option key={person._id} value={person._id}>{person.name}{person.b2cRegions?.length ? ` · ${person.b2cRegions.join(', ')}` : ''}</option>)}
  </select>}</Field>;

  const descriptions = {
    complete_triage: 'Confirm the category and add any identifier the automatic extraction missed. The escalation is then routed using the configured workflow.',
    reroute: 'Moves the escalation to any enabled level. The level is added to the path if it is not already on it.',
    propose_resolution: workflow.validatorLevel === false ? 'Validation is not required: the escalation is resolved and the final email is queued.' : `The resolution goes to ${workflow.validatorLevel ? levelLabel(workflow.validatorLevel) : 'a B2C admin'} for validation before the customer is told.`,
    approve_resolution: 'Approving resolves the escalation and queues the final customer email below.',
    close_unresolved: 'Use for emails that are not escalations (for example spam or duplicates). Optionally send the customer a final email.',
  };

  return <Modal as="form" size="md" title={ACTION_META[action].label} eyebrow={ticket.reference} description={descriptions[action]} onClose={onClose}
    onSubmit={event => { event.preventDefault(); if (valid && !busy) onSubmit(payload()); }}
    footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant={['close_unresolved'].includes(action) ? 'danger' : 'primary'} disabled={!valid || busy}>{busy ? 'Working…' : ACTION_META[action].label}</Button></>}>
    <div className="stack-16">
      {error && <InlineAlert title={error} />}
      {action === 'complete_triage' && <>
        {ticket.triage?.reasons?.length > 0 && <InlineAlert tone="warning" title="Flagged for triage">{ticket.triage.reasons.map(reason => TRIAGE_REASONS[reason] || reason).join('. ')}</InlineAlert>}
        <Field label="Category" required>{props => <select {...props} value={form.category} onChange={event => set('category', event.target.value)}><option value="">Choose Service or Retail</option><option>Service</option><option>Retail</option></select>}</Field>
        <Field label="Region" hint="Filled from the CRM when it finds the customer.">{props => <input {...props} value={form.region} onChange={event => set('region', event.target.value)} maxLength={80} />}</Field>
        <div className="field"><span className="field-label">Add an identifier</span>
          <div className="row">
            <select aria-label="Identifier type" value={form.identifierType} onChange={event => set('identifierType', event.target.value)}>{Object.entries(IDENTIFIER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            <input aria-label="Identifier value" value={form.identifierValue} onChange={event => set('identifierValue', event.target.value)} maxLength={60} placeholder="e.g. case ID from the email" />
            <Button size="sm" disabled={!form.identifierValue.trim()} onClick={() => setForm(current => ({ ...current, identifiers: [...current.identifiers, { type: current.identifierType, value: current.identifierValue.trim() }], identifierValue: '' }))}>Add</Button>
          </div>
          {form.identifiers.length > 0 && <ul className="b2c-chip-list">{form.identifiers.map((item, index) => <li key={`${item.type}-${item.value}`}>{IDENTIFIER_LABELS[item.type]}: <span className="mono">{item.value}</span><button type="button" className="btn-link" onClick={() => set('identifiers', form.identifiers.filter((_, other) => other !== index))} aria-label={`Remove ${item.value}`}>Remove</button></li>)}</ul>}
        </div>
        <label className="row text-small"><input type="checkbox" checked={form.rerunCrm} onChange={event => set('rerunCrm', event.target.checked)} />Repeat the CRM lookup before routing</label>
        <Field label="Triage note (internal)">{textarea('note', 'Why this escalation can proceed', 3)}</Field>
      </>}
      {action === 'assign' && (staff.loading ? <p className="text-muted">Loading staff…</p> : eligible.length ? staffSelect(true, `People holding the ${levelLabel(targetLevel)} role for this region.`) : <InlineAlert tone="warning" title="Nobody else can take this level">No other active staff member holds the {levelLabel(targetLevel)} role for this region.</InlineAlert>)}
      {action === 'reroute' && <Field label="Move to level" required>{props => <select {...props} value={form.levelKey} onChange={event => setForm(current => ({ ...current, levelKey: event.target.value, userId: '' }))}><option value="">Choose a level</option>{workflow.levels.filter(level => level.key !== ticket.workflow?.currentLevel).map(level => <option key={level.key} value={level.key}>{level.label}</option>)}</select>}</Field>}
      {action === 'reroute' && targetLevel && !staff.loading && staffSelect(false)}
      {['reroute', 'reject_resolution', 'reopen', 'close_unresolved'].includes(action) && <Field label="Reason" required hint="Recorded in the escalation history.">{textarea('reason', '', 3)}</Field>}
      {action === 'set_path' && <fieldset className="field b2c-path-editor"><legend className="field-label">Levels on this escalation's path</legend>
        {workflow.levels.map(level => <label key={level.key} className="row text-small"><input type="checkbox" checked={form.path.includes(level.key)} disabled={level.key === ticket.workflow?.currentLevel} onChange={event => set('path', workflow.levels.map(item => item.key).filter(key => (key === level.key ? event.target.checked : form.path.includes(key))))} />{level.label}{level.key === ticket.workflow?.currentLevel && <span className="text-muted"> (current)</span>}</label>)}
      </fieldset>}
      {action === 'request_clarification' && <><Field label="Message to the customer" required hint="Inserted into the clarification template.">{textarea('message', 'What do you need from the customer?', 5)}</Field><TemplateNote template={templates.clarification} label="Clarification request" /></>}
      {action === 'propose_resolution' && <>
        <Field label="Resolution summary (internal)" required>{textarea('resolutionSummary', 'What was found and what was done', 4)}</Field>
        <Field label="Final message to the customer" required hint="Sent after validation, inside the final communication template.">{textarea('customerMessage', '', 5)}</Field>
        <TemplateNote template={templates.final_resolution} label="Final customer communication" />
      </>}
      {action === 'approve_resolution' && <>
        <InfoList items={[['Resolution summary', ticket.validation?.resolutionSummary], ['Submitted by', ticket.validation?.proposedBy?.name]]} />
        <Field label="Final message to the customer" required hint="You can correct the wording before it is sent.">{textarea('customerMessage', '', 5)}</Field>
        <TemplateNote template={templates.final_resolution} label="Final customer communication" />
        <Field label="Validation note (internal)">{textarea('note', '', 2)}</Field>
      </>}
      {action === 'close_unresolved' && <><Field label="Final message to the customer (optional)">{textarea('customerMessage', 'Leave empty to close without emailing the customer', 4)}</Field>{form.customerMessage.trim() && <TemplateNote template={templates.final_resolution} label="Final customer communication" />}</>}
      {['close', 'add_note'].includes(action) && <Field label={action === 'add_note' ? 'Note (internal, not sent to the customer)' : 'Closing note (internal, optional)'} required={action === 'add_note'}>{textarea('note', '', 4)}</Field>}
    </div>
  </Modal>;
}
