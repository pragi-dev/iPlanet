import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, FilePlus2, Send, UserPlus } from 'lucide-react';
import { ActivityTimeline, Badge, Button, Drawer, EmptyState, ErrorState, Field, FilterBar, InfoList, InlineAlert, Modal, PageHeader, TableCard, Tabs, formatDateTime, formatRelative, friendlyError, pluralize, useAsync } from '../ui';
import { b2cRegistrationAction, getB2CRegistration, getB2CRegistrations } from './api';
import { B2CShell, NoB2CAccess, REGISTRATION_REASONS, REGISTRATION_STATUS, auditTimeline } from './shared';

// Emails from customers who could not be identified. No ticket (and no ticket number) exists
// for them until the customer completes registration; then the ticket is created, routed and
// acknowledged by itself. B2C admins see them here, and decide those that need a person.
const VIEWS = {
  open: { label: 'Waiting for the customer', status: 'open' },
  decide: { label: 'Needs a decision', status: 'decide' },
  cancelled: { label: 'Withdrawn', status: 'cancelled' },
  all: { label: 'All', status: undefined },
};
// A completed registration without a ticket is one whose ticket creation is being retried.
const statusLabel = status => (status === 'completed' ? 'Registered — creating the ticket' : REGISTRATION_STATUS[status]?.label || status);
const statusTone = status => (status === 'completed' ? 'info' : REGISTRATION_STATUS[status]?.tone);
const reasonText = reason => (reason ? REGISTRATION_REASONS[reason] || reason.replace(/_/g, ' ') : null);
const REGISTRATION_CHECKS = { device_found: 'device record found', device_region_missing: 'device record has no region', purchase_region_confirmed: 'purchase region confirmed', purchase_date_confirmed: 'purchase date confirmed', customer_matched: 'existing customer matched', new_customer: 'no existing customer' };
const SUBMISSION_LABELS = [['name', 'Name'], ['email', 'Email'], ['phone', 'Mobile'], ['alternatePhone', 'Alternate phone'], ['serialNumber', 'Serial number'], ['brand', 'Brand'], ['model', 'Model'], ['purchaseDate', 'Purchase date'], ['purchaseLocation', 'Store or city'], ['purchaseRegion', 'Stated region'], ['dealer', 'Dealer'], ['invoiceNumber', 'Invoice']];

export function B2CRegistrations() {
  const [params, setParams] = useSearchParams();
  const view = VIEWS[params.get('view')] ? params.get('view') : 'open';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [openId, setOpenId] = useState(null);
  const state = useAsync(() => getB2CRegistrations({ status: VIEWS[view].status, page, limit: 25 }), [view, page]);
  const data = state.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  const counts = data?.counts || {};
  const count = statuses => statuses.reduce((sum, status) => sum + (counts[status] || 0), 0);
  const tabs = Object.entries(VIEWS).map(([value, item]) => ({ value, label: item.label, count: data ? { open: count(['email_pending', 'email_sent', 'email_failed', 'in_progress', 'processing']), decide: count(['required', 'manual_review', 'expired', 'completed']), cancelled: count(['cancelled']) }[value] : undefined }));
  const setPage = value => setParams(current => { const next = new URLSearchParams(current); next.set('page', String(value)); return next; }, { replace: true });

  if (state.error?.status === 403) return <B2CShell title="Awaiting registration"><PageHeader title="Awaiting registration" /><NoB2CAccess /></B2CShell>;

  return <B2CShell title="Awaiting registration">
    <PageHeader title="Awaiting registration" description="Emails from senders who could not be matched to a registered customer. No ticket exists for them until the customer completes the registration form; it is then created, routed by the device's region and acknowledged." />
    <Tabs label="Registration views" tabs={tabs} value={view} onChange={value => setParams(value === 'open' ? {} : { view: value }, { replace: true })} />
    <TableCard
      columns={6}
      loading={state.loading && !data}
      error={state.error && friendlyError(state.error)}
      errorTitle="Unable to load registration requests"
      onRetry={state.reload}
      toolbar={<FilterBar summary={data ? <span className="row">{state.loading && <span className="text-muted">Updating…</span>}{pluralize(data.total, 'request')}</span> : null} />}
      isEmpty={!data?.items.length}
      empty={<EmptyState icon={UserPlus} title={view === 'decide' ? 'Nothing needs a decision' : 'No registration requests here'} description="Requests appear here when a customer email cannot be matched to a registered customer." />}
      footer={data && pages > 1 ? <div className="b2c-pager">
        <Button size="sm" icon={ChevronLeft} disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
        <span className="text-muted text-small">Page {page} of {pages}</span>
        <Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next<ChevronRight size={14} aria-hidden="true" /></Button>
      </div> : null}
    >
      <table className="table table-compact">
        <thead><tr><th>Email</th><th>Sent to</th><th>Status</th><th>Registration emails</th><th>Received</th><th><span className="sr-only">Open</span></th></tr></thead>
        <tbody>{(data?.items || []).map(item => <tr key={item.id} className="row-clickable" onClick={() => setOpenId(item.id)}>
          <td>{item.subject || <span className="text-muted">No subject</span>}<span className="cell-sub">{item.relatedEmails ? `${pluralize(item.relatedEmails, 'reply', 'replies')} from the customer` : item.inboxKey}</span></td>
          <td className="mono">{item.recipient}</td>
          <td><Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge>{item.reason && <span className="cell-sub">{reasonText(item.reason)}</span>}</td>
          <td>{item.sendCount ? `${item.sendCount} of ${item.maxSends}` : 'None sent'}<span className="cell-sub">{item.lastSentAt ? `Last accepted ${formatRelative(item.lastSentAt)}` : item.expiresAt && !item.submittedAt ? `Link expires ${formatDateTime(item.expiresAt)}` : ''}</span></td>
          <td className="cell-nowrap" title={formatDateTime(item.requestedAt)}>{formatRelative(item.requestedAt)}</td>
          <td className="cell-right"><Button size="sm" variant="ghost" onClick={event => { event.stopPropagation(); setOpenId(item.id); }}>Open</Button></td>
        </tr>)}</tbody>
      </table>
    </TableCard>
    {openId && <RegistrationDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => state.reload({ silent: true })} />}
  </B2CShell>;
}

function RegistrationDrawer({ id, onClose, onChanged }) {
  const navigate = useNavigate();
  const state = useAsync(() => getB2CRegistration(id), [id]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const request = state.data;

  const run = async (action, payload) => {
    setBusy(action); setError(''); setNotice('');
    try {
      const result = await b2cRegistrationAction(id, action, payload);
      onChanged();
      if (action === 'create_ticket') return navigate(`/b2c/tickets/${result.ticketId}`);
      setNotice('A new registration link was queued for the customer.');
      await state.reload({ silent: true });
    } catch (actionError) { setError(friendlyError(actionError)); } finally { setBusy(''); }
  };

  return <Drawer title="Registration request" eyebrow={request ? statusLabel(request.status) : undefined} icon={<UserPlus size={18} aria-hidden="true" />} width={520} onClose={onClose}
    footer={request?.actions?.length ? <>
      {request.actions.includes('resend') && <Button icon={Send} disabled={Boolean(busy)} onClick={() => run('resend')}>{busy === 'resend' ? 'Sending…' : 'Send the link again'}</Button>}
      {request.actions.includes('create_ticket') && <Button variant={request.status === 'completed' ? 'primary' : 'secondary'} icon={FilePlus2} disabled={Boolean(busy)} onClick={() => (request.status === 'completed' ? run('create_ticket') : setCreating(true))}>{request.status === 'completed' ? 'Create the ticket now' : 'Create ticket without registration'}</Button>}
    </> : null}>
    {state.loading && !request && <p className="text-muted">Loading…</p>}
    {state.error && <ErrorState title="Unable to load this request" message={friendlyError(state.error)} onRetry={state.reload} />}
    {request && <div className="stack-16">
      {notice && <InlineAlert tone="success" title={notice} />}
      {error && <InlineAlert title={error} />}
      {request.status === 'manual_review' && <InlineAlert tone="warning" title="The customer's details could not be verified">{reasonText(request.reason)}. Send the link again, or create the ticket and decide the customer and region in triage.</InlineAlert>}
      {request.status === 'completed' && <InlineAlert tone="info" title="The customer has registered">The ticket is being created by the processing cycle. You can create it now.</InlineAlert>}
      <InfoList items={[
        ['Email subject', request.subject || null],
        ['Sent to', request.recipient],
        ['Why registration is needed', request.trigger === 'insufficient' ? 'Not enough details matched one registered customer' : 'No registered customer matched'],
        ['Reason', request.status !== 'manual_review' ? reasonText(request.reason) : null],
        ['Received', formatDateTime(request.requestedAt)],
        ['Registration emails', `${request.sendCount} of ${request.maxSends} allowed${request.lastSentAt ? ` · last accepted by the mail server ${formatDateTime(request.lastSentAt)}` : ''}`],
        ['Link expires', request.expiresAt && !request.submittedAt ? formatDateTime(request.expiresAt) : null],
        ['Opened', request.openedAt ? formatDateTime(request.openedAt) : null],
        ['Invalid submissions', request.failedAttempts || null],
        ['Submitted', request.submittedAt ? formatDateTime(request.submittedAt) : null],
        ['Checks passed', request.outcome?.checks?.length ? request.outcome.checks.filter(check => REGISTRATION_CHECKS[check]).map(check => REGISTRATION_CHECKS[check]).join(', ') : null],
      ].filter(([, value]) => value !== null && value !== undefined)} />
      {request.submission && <section aria-label="Submitted details" className="stack-12">
        <p className="side-section-title">What the customer submitted</p>
        <InfoList items={SUBMISSION_LABELS.map(([key, label]) => [label, key === 'purchaseDate' && request.submission[key] ? String(request.submission[key]).slice(0, 10) : request.submission[key]]).filter(([, value]) => value)} />
      </section>}
      <section aria-label="History" className="stack-12">
        <p className="side-section-title">History</p>
        <ActivityTimeline events={auditTimeline(request.history)} />
      </section>
    </div>}
    {creating && <CreateTicketDialog busy={busy === 'create_ticket'} error={error} onClose={() => { setCreating(false); setError(''); }} onSubmit={reason => run('create_ticket', { reason })} />}
  </Drawer>;
}

function CreateTicketDialog({ busy, error, onClose, onSubmit }) {
  const [reason, setReason] = useState('');
  const valid = reason.trim().length > 0;
  return <Modal as="form" size="md" title="Create ticket without registration" description="The ticket is created from the original email and goes to triage, where you decide the customer, the region and the assignee. Any open registration link is withdrawn." onClose={onClose}
    onSubmit={event => { event.preventDefault(); if (valid && !busy) onSubmit(reason.trim()); }}
    footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={!valid || busy}>{busy ? 'Creating…' : 'Create ticket'}</Button></>}>
    <div className="stack-16">
      {error && <InlineAlert title={error} />}
      <Field label="Reason" required hint="Recorded in the ticket history.">{props => <textarea {...props} rows={3} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} placeholder="e.g. customer confirmed their details by phone" />}</Field>
    </div>
  </Modal>;
}
