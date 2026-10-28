import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, Mail, MailCheck, Paperclip, RefreshCw, Save, Sparkles, X } from 'lucide-react';
import { ServiceShell } from './components';
import { approveEmailRequest, checkEmailInbox, getCompanies, getEmailRequest, getEmailRequestOptions, getEmailRequestStatus, getEmailRequests, mediaUrl, rejectEmailRequest, updateEmailRequest } from './api';
import { Badge, Button, ConfirmDialog, Drawer, EmptyState, Field, InlineAlert, PageHeader, Skeleton, TableCard, Tabs, formatDateTime, formatRelative, friendlyError, useAsync } from '../ui';

// B2B service requests received by email. Claude reads each message and drafts the
// ticket; the service team checks the draft against the email, corrects it, and
// approves it into a ticket or rejects it. Nothing becomes a ticket without approval.

const categories = ['Service', 'Health Camp', 'Buyback / E-Waste'];
const issueTypes = ['Screen / Display', 'Battery', 'Charging', 'Keyboard', 'Trackpad', 'Camera', 'Speaker', 'Software', 'Performance', 'Physical Damage', 'Other'];
const priorities = ['Low', 'Medium', 'High', 'Critical'];
const isOnSite = category => category === 'Health Camp' || category === 'Buyback / E-Waste';
const FIELDS = ['companyId', 'customerId', 'deviceId', 'category', 'issueType', 'description', 'priority', 'location', 'preferredServiceDate', 'deviceCount'];
const formFrom = draft => Object.fromEntries(FIELDS.map(field => [field, draft?.[field] == null ? '' : String(draft[field])]));
const sizeLabel = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function InboxStatus({ status, onChecked }) {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState(null);
  const data = status.data;
  const check = async () => {
    setChecking(true);
    setMessage(null);
    try {
      const result = await checkEmailInbox();
      setMessage({ tone: 'success', text: result.received ? `${result.received} new email request${result.received === 1 ? '' : 's'} received.` : 'No new emails.' });
      onChecked();
    } catch (error) {
      setMessage({ tone: 'critical', text: friendlyError(error, 'The inbox could not be checked.') });
    } finally {
      setChecking(false);
      status.reload();
    }
  };
  return <div className="stack-16">
    <div className="row-between email-inbox-status">
      <span className="row text-muted">
        <Mail size={16} aria-hidden="true" />
        {status.loading && !data ? <Skeleton width={220} />
          : data ? <>{data.inbox || 'No inbox configured'}{data.lastCheckedAt && <> · checked {formatRelative(data.lastCheckedAt)}</>}{!data.claudeConfigured && <Badge tone="warning">Claude off</Badge>}</>
            : 'Inbox status unavailable'}
      </span>
      <Button size="sm" icon={RefreshCw} onClick={check} disabled={checking || (data && !data.inboxConfigured)}>{checking ? 'Checking…' : 'Check inbox now'}</Button>
    </div>
    {data && !data.inboxConfigured && <InlineAlert tone="warning" title="Inbox not connected">Set B2B_EMAIL_IMAP_HOST, B2B_EMAIL_USER and B2B_EMAIL_PASSWORD in backend/.env.b2b-email and restart the API.</InlineAlert>}
    {data?.lastError && data.inboxConfigured && <InlineAlert title="Last inbox check failed">{data.lastError}</InlineAlert>}
    {message && <InlineAlert tone={message.tone}>{message.text}</InlineAlert>}
  </div>;
}

function ReviewDrawer({ id, onClose, onReviewed }) {
  const detail = useAsync(() => getEmailRequest(id), [id]);
  const companies = useAsync(getCompanies, []);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  useEffect(() => { if (detail.data) setForm(formFrom(detail.data.draft)); }, [detail.data]);
  const companyId = form?.companyId || '';
  const options = useAsync(() => (companyId ? getEmailRequestOptions(companyId) : Promise.resolve({ customers: [], devices: [] })), [companyId]);

  const request = detail.data;
  const pending = request?.status === 'pending';
  const onSite = isOnSite(form?.category);
  const set = (field, value) => {
    setSaved(false);
    setForm(current => ({ ...current, [field]: value, ...(field === 'companyId' ? { customerId: '', deviceId: '' } : {}) }));
  };
  const act = async action => {
    setBusy(action);
    setError('');
    try {
      if (action === 'save') { detail.setData(await updateEmailRequest(id, form)); setSaved(true); }
      if (action === 'approve') { onReviewed(await approveEmailRequest(id, form), 'approved'); }
      if (action === 'reject') { onReviewed(await rejectEmailRequest(id, reason), 'rejected'); }
    } catch (actionError) {
      setError(friendlyError(actionError, 'The request could not be updated. Please try again.'));
      setRejecting(false);
    } finally {
      setBusy('');
    }
  };

  const footer = request && pending && form ? <div className="row-between">
    <Button icon={X} onClick={() => setRejecting(true)} disabled={Boolean(busy)}>Reject</Button>
    <span className="row">
      <Button icon={Save} onClick={() => act('save')} disabled={Boolean(busy)}>{busy === 'save' ? 'Saving…' : 'Save draft'}</Button>
      <Button variant="primary" icon={Check} onClick={() => act('approve')} disabled={Boolean(busy)}>{busy === 'approve' ? 'Creating ticket…' : 'Approve & create ticket'}</Button>
    </span>
  </div> : null;

  return <Drawer title={request?.subject || 'Email request'} eyebrow={request ? `${request.from?.name || request.from?.address} · ${formatDateTime(request.receivedAt)}` : 'Loading…'} icon={<Mail size={18} />} width={680} onClose={onClose} footer={footer} className="email-review">
    {detail.loading && !request ? <div className="stack-16"><Skeleton width="70%" /><Skeleton height={120} /><Skeleton width="50%" /></div>
      : detail.error ? <InlineAlert title="Unable to load this email">{friendlyError(detail.error)}</InlineAlert>
        : request && form && <>
          {error && <InlineAlert title="Not updated">{error}</InlineAlert>}
          {saved && <InlineAlert tone="success">Draft saved.</InlineAlert>}
          {request.status === 'approved' && <InlineAlert tone="success" title="Approved">{request.ticket ? <>Ticket <Link className="cell-link mono" to={`/service/tickets/${request.ticket.id}`}>{request.ticket.ticketId}</Link> was created {formatDateTime(request.reviewedAt)}.</> : 'A ticket was created.'}</InlineAlert>}
          {request.status === 'rejected' && <InlineAlert tone="warning" title="Rejected">{request.rejectionReason || 'No reason given.'}</InlineAlert>}
          {pending && request.isServiceRequest === false && <InlineAlert tone="warning" title="May not be a service request">Claude thinks this email is not asking for service. Reject it if that's right.</InlineAlert>}
          {pending && request.extraction?.error && <InlineAlert tone="warning">{request.extraction.error}</InlineAlert>}
          {pending && request.matchNotes.length > 0 && <InlineAlert tone="warning" title="Check before approving"><ul className="email-notes">{request.matchNotes.map(note => <li key={note}>{note}</li>)}</ul></InlineAlert>}

          <section className="stack-16" aria-label="Email">
            <div className="row-between"><h3 className="email-section-title">Email</h3><span className="cell-sub">{request.from?.address}</span></div>
            <pre className="email-body">{request.text || '(no text)'}</pre>
            {request.attachments.length > 0 && <ul className="email-attachments">{request.attachments.map(item => <li key={item.path}><a className="cell-link" href={mediaUrl(item.path)} target="_blank" rel="noreferrer"><Paperclip size={14} aria-hidden="true" /> {item.filename}</a> <span className="cell-sub">{sizeLabel(item.size)}{/^image\//.test(item.contentType) ? ' · added to the ticket' : ''}</span></li>)}</ul>}
          </section>

          {request.extraction?.source === 'claude' && <section className="email-claude" aria-label="What Claude found">
            <h3 className="email-section-title row"><Sparkles size={15} aria-hidden="true" /> What Claude found</h3>
            {request.summary && <p>{request.summary}</p>}
            <dl className="email-facts">
              {request.extraction.contactName && <><dt>Contact</dt><dd>{request.extraction.contactName}{request.extraction.contactPhone ? ` · ${request.extraction.contactPhone}` : ''}</dd></>}
              {[...(request.extraction.serialNumbers || []), ...(request.extraction.assetIds || [])].length > 0 && <><dt>Devices mentioned</dt><dd className="mono">{[...request.extraction.serialNumbers, ...request.extraction.assetIds].join(', ')}</dd></>}
              {request.extraction.deviceModel && <><dt>Model</dt><dd>{request.extraction.deviceModel}</dd></>}
              {request.extraction.preferredDateText && <><dt>Wants service</dt><dd>“{request.extraction.preferredDateText}”</dd></>}
              {request.extraction.missingDetails?.length > 0 && <><dt>Missing</dt><dd>{request.extraction.missingDetails.join(', ')}</dd></>}
            </dl>
          </section>}

          <section className="stack-16" aria-label="Ticket details">
            <h3 className="email-section-title">Ticket details</h3>
            <fieldset className="form-grid email-form" disabled={!pending}>
              <Field label="Organization" required>{props => <select {...props} value={form.companyId} onChange={event => set('companyId', event.target.value)}>
                <option value="">{companies.loading ? 'Loading…' : 'Select organization'}</option>
                {(companies.data || []).map(company => <option key={company._id} value={company._id}>{company.name}</option>)}
              </select>}</Field>
              <Field label="Requested by" required hint="A Corporate Self-Care user of the organization">{props => <select {...props} value={form.customerId} onChange={event => set('customerId', event.target.value)} disabled={!companyId}>
                <option value="">{options.loading ? 'Loading…' : 'Select requester'}</option>
                {(options.data?.customers || []).map(user => <option key={user.id} value={user.id}>{user.name} ({user.email})</option>)}
              </select>}</Field>
              <Field label="Category" required>{props => <select {...props} value={form.category} onChange={event => set('category', event.target.value)}>
                <option value="">Select category</option>
                {categories.map(value => <option key={value}>{value}</option>)}
              </select>}</Field>
              <Field label="Priority" required>{props => <select {...props} value={form.priority} onChange={event => set('priority', event.target.value)}>
                <option value="">Select priority</option>
                {priorities.map(value => <option key={value}>{value}</option>)}
              </select>}</Field>
              {onSite
                ? <Field label="Number of devices" required>{props => <input {...props} type="number" min="1" max="1000" value={form.deviceCount} onChange={event => set('deviceCount', event.target.value)} />}</Field>
                : <>
                  <Field label="Device" required className="span-2">{props => <select {...props} value={form.deviceId} onChange={event => set('deviceId', event.target.value)} disabled={!companyId}>
                    <option value="">{options.loading ? 'Loading…' : 'Select device'}</option>
                    {(options.data?.devices || []).map(device => <option key={device.id} value={device.id}>{device.model} · {device.serialNumber}{device.assetId ? ` · ${device.assetId}` : ''}</option>)}
                  </select>}</Field>
                  <Field label="Issue type" required>{props => <select {...props} value={form.issueType} onChange={event => set('issueType', event.target.value)}>
                    <option value="">Select issue type</option>
                    {issueTypes.map(value => <option key={value}>{value}</option>)}
                  </select>}</Field>
                </>}
              <Field label="Preferred date" hint={onSite ? 'Required for on-site visits' : 'Optional'} required={onSite}>{props => <input {...props} type="date" value={form.preferredServiceDate} onChange={event => set('preferredServiceDate', event.target.value)} />}</Field>
              <Field label="Location">{props => <input {...props} value={form.location} onChange={event => set('location', event.target.value)} maxLength={100} />}</Field>
              <Field label="Description" required className="span-2">{props => <textarea {...props} rows={5} value={form.description} onChange={event => set('description', event.target.value)} maxLength={4000} />}</Field>
            </fieldset>
          </section>
        </>}
    {rejecting && <ConfirmDialog title="Reject this email request?" description="No ticket will be created. The reason is kept for your team." confirmLabel="Reject" tone="danger" busy={busy === 'reject'} onConfirm={() => act('reject')} onClose={() => setRejecting(false)}>
      <Field label="Reason" hint="Optional, for example: not a customer, duplicate, spam">{props => <input {...props} value={reason} onChange={event => setReason(event.target.value)} maxLength={500} />}</Field>
    </ConfirmDialog>}
  </Drawer>;
}

export function EmailRequests() {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState('pending');
  const [notice, setNotice] = useState(null);
  const status = useAsync(getEmailRequestStatus, []);
  const list = useAsync(() => getEmailRequests(tab), [tab]);
  const openId = params.get('id');
  const open = id => setParams(id ? { id } : {});
  const reviewed = (request, outcome) => {
    open(null);
    list.setData(current => (current || []).filter(item => item.id !== request.id));
    status.reload();
    setNotice(outcome === 'approved'
      ? <>Ticket <Link className="cell-link mono" to={`/service/tickets/${request.ticket?.id}`}>{request.ticket?.ticketId}</Link> was created from “{request.subject}”.</>
      : <>“{request.subject}” was rejected.</>);
  };
  const items = list.data || [];

  return <ServiceShell title="Email Requests">
    <PageHeader title="Email Requests" description="Service requests emailed by corporate customers. Claude drafts each ticket; check it against the email, then approve or reject." />
    <div className="stack-16">
      <InboxStatus status={status} onChecked={() => { if (tab === 'pending') list.reload(); }} />
      {notice && <InlineAlert tone="success">{notice}</InlineAlert>}
      <Tabs label="Email request status" value={tab} onChange={value => { setTab(value); setNotice(null); }} tabs={[
        { value: 'pending', label: 'To review', count: status.data?.pending },
        { value: 'approved', label: 'Approved' },
        { value: 'rejected', label: 'Rejected' },
      ]} />
      <TableCard
        columns={6}
        loading={list.loading && !list.data}
        error={list.error && friendlyError(list.error)}
        errorTitle="Unable to load email requests"
        onRetry={list.reload}
        isEmpty={!items.length}
        empty={<EmptyState icon={MailCheck} title={tab === 'pending' ? 'Nothing to review' : `No ${tab} requests`} description={tab === 'pending' ? 'New service-request emails appear here after the inbox is checked.' : 'Reviewed email requests appear here.'} />}
      >
        <table className="table table-compact">
          <thead><tr><th>Received</th><th>From</th><th>Subject</th><th>Organization</th><th>Request</th><th>{tab === 'approved' ? 'Ticket' : 'Status'}</th></tr></thead>
          <tbody>{items.map(item => <tr key={item.id} className="row-clickable" onClick={() => open(item.id)}>
            <td className="cell-nowrap">{formatDateTime(item.receivedAt)}</td>
            <td><span className="cell-primary">{item.from?.name || item.from?.address}</span>{item.from?.name && <span className="cell-sub">{item.from.address}</span>}</td>
            <td><button type="button" className="link-button cell-link" onClick={event => { event.stopPropagation(); open(item.id); }}>{item.subject || '(no subject)'}</button>{item.summary && <span className="cell-sub">{item.summary}</span>}</td>
            <td className="cell-nowrap">{item.company?.name || <span className="text-muted">Not matched</span>}</td>
            <td>{item.issueType || item.category || '—'}{item.device && <span className="cell-sub mono">{item.device.serialNumber}</span>}</td>
            <td className="cell-nowrap">{tab === 'approved' ? (item.ticket ? <Link className="cell-link mono" to={`/service/tickets/${item.ticket.id}`} onClick={event => event.stopPropagation()}>{item.ticket.ticketId}</Link> : '—')
              : tab === 'rejected' ? <Badge>Rejected</Badge>
                : item.isServiceRequest === false ? <Badge tone="neutral">Maybe not service</Badge>
                  : item.needsAttention ? <Badge tone="warning">Needs details</Badge> : <Badge tone="success">Ready</Badge>}{item.priority && tab === 'pending' && <span className="cell-sub">{item.priority}</span>}</td>
          </tr>)}</tbody>
        </table>
      </TableCard>
    </div>
    {openId && <ReviewDrawer key={openId} id={openId} onClose={() => open(null)} onReviewed={reviewed} />}
  </ServiceShell>;
}
