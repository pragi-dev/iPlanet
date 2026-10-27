import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FlaskConical, Mail, PlugZap, RefreshCcw, Send } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, Field, FilterSelect, InfoList, InlineAlert, PageHeader, PageSkeleton, formatDateTime, formatRelative, friendlyError, useAsync } from '../ui';
import { getB2CHealth, getB2CInbound, getB2COutbound, getB2CTestOutbox, injectB2CTestEmail, retryB2CInbound, retryB2COutbound, runB2CCycle, verifyB2CImap } from './api';
import { B2CShell, NoB2CAccess } from './shared';

const MODES = {
  test: ['Test adapter', 'warning'],
  live: ['Live', 'success'],
  not_configured: ['Not configured', 'neutral'],
  disabled: ['Disabled in this environment', 'neutral'],
};
const PROVIDERS = { test: 'Test adapter (in-memory)', microsoft_graph: 'Microsoft 365 (Graph API)', imap: 'IMAP mailbox', none: 'None' };
const OUTCOMES = {
  ignored_auto_submitted: 'Ignored: automatic reply', ignored_bulk_precedence: 'Ignored: bulk or list mail', ignored_auto_reply_header: 'Ignored: auto-responder', ignored_delivery_report: 'Ignored: delivery report',
  ignored_own_address: 'Ignored: sent from a TCM inbox', ignored_invalid_sender: 'Ignored: no valid sender', ticket_created: 'Escalation created', appended_to_ticket: 'Added to existing escalation',
  awaiting_registration: 'Waiting for customer registration (no escalation yet)', appended_to_registration: 'Added to a pending registration', ticket_created_after_registration: 'Escalation created after registration', ticket_created_by_staff: 'Escalation created by an admin without registration',
};

function ModeBadge({ mode }) {
  const [label, tone] = MODES[mode] || [mode, 'neutral'];
  return <Badge tone={tone}>{label}</Badge>;
}

function ConnectorStatus({ status, mode }) {
  if (!status) return <p className="text-muted text-small">{mode === 'not_configured' || mode === 'disabled' ? 'Not running.' : 'No activity recorded yet.'}</p>;
  return <InfoList items={[
    ['Last success', status.lastSuccessAt ? `${formatRelative(status.lastSuccessAt)} · ${formatDateTime(status.lastSuccessAt)}` : 'Never'],
    ['Last error', status.lastErrorAt ? `${formatDateTime(status.lastErrorAt)} — ${status.lastError}` : 'None'],
    ['Consecutive failures', String(status.consecutiveFailures || 0)],
  ]} />;
}

export function B2CIntegrations() {
  const health = useAsync(getB2CHealth, []);
  const [inboundFilter, setInboundFilter] = useState('All');
  const inbound = useAsync(() => getB2CInbound(inboundFilter === 'All' ? {} : { status: inboundFilter }), [inboundFilter]);
  const outbound = useAsync(() => getB2COutbound(), []);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const refresh = () => Promise.all([health.reload({ silent: true }), inbound.reload({ silent: true }), outbound.reload({ silent: true })]);
  const perform = async (key, task, message) => {
    setBusy(key); setError(''); setNotice('');
    try { const result = await task(); setNotice(typeof message === 'function' ? message(result) : message); await refresh(); } catch (taskError) { setError(friendlyError(taskError)); } finally { setBusy(''); }
  };

  if (health.error?.status === 403) return <B2CShell title="Integration health"><PageHeader title="Integration health" /><NoB2CAccess /></B2CShell>;
  if (health.loading && !health.data) return <B2CShell title="Integration health"><PageSkeleton kpis={3} /></B2CShell>;
  if (health.error) return <B2CShell title="Integration health"><PageHeader title="Integration health" /><div className="card"><ErrorState title="Unable to load integration health" message={friendlyError(health.error)} onRetry={health.reload} /></div></B2CShell>;
  const data = health.data;
  const queues = data.queues;
  const testInboxes = data.inboxes.filter(inbox => inbox.provider === 'test' && inbox.mode === 'test');

  return <B2CShell title="Integration health">
    <PageHeader title="Integration health" description="Inbox polling, CRM lookups and customer email, with anything that failed and needs attention."
      actions={<Button variant="primary" icon={RefreshCcw} disabled={Boolean(busy)} onClick={() => perform('run', runB2CCycle, result => (result.skipped ? result.reason : `Processing run finished: ${result.polled.reduce((sum, item) => sum + (item.stored || 0), 0)} new email(s), ${result.processed} processed, ${result.sent} sent.`))}>{busy === 'run' ? 'Running…' : 'Run processing now'}</Button>} />
    {notice && <InlineAlert tone="success" title={notice} action={<Button size="sm" variant="ghost" onClick={() => setNotice('')}>Dismiss</Button>} />}
    {error && <InlineAlert title={error} action={<Button size="sm" variant="ghost" onClick={() => setError('')}>Dismiss</Button>} />}
    {(data.testAdapters.email || data.testAdapters.crm) && <InlineAlert tone="warning" title="Test adapters are active">{[data.testAdapters.email && 'inboxes using the test email adapter neither receive nor send real email', data.testAdapters.crm && "customer lookups use fictitious test records, not TCM's CRM"].filter(Boolean).join('; ')}. Test adapters are disabled in production.</InlineAlert>}

    <div className="grid-3">
      {data.inboxes.map(inbox => <Card key={inbox.key} title={inbox.displayName || inbox.address} description={inbox.address} actions={<ModeBadge mode={inbox.enabled ? inbox.mode : 'disabled'} />}>
        <div className="stack-12">
          <p className="text-small">{PROVIDERS[inbox.provider] || inbox.provider} · {inbox.defaultCategory ? `all mail classed as ${inbox.defaultCategory}` : 'classified by keyword rules'}{inbox.enabled ? '' : ' · polling disabled'}</p>
          {!inbox.outbound && <p className="text-muted text-small">Receive only: acknowledgements and other customer emails are recorded on the ticket but not sent.</p>}
          {['microsoft_graph', 'imap'].includes(inbox.provider) && inbox.mode === 'live' && !inbox.status?.lastSuccessAt && <p className="text-muted text-small">Credentials are configured but no successful call has been made yet.</p>}
          <ConnectorStatus status={inbox.status} mode={inbox.mode} />
          {inbox.status?.details?.fetched !== undefined && <p className="text-muted text-small">Last poll: {inbox.status.details.fetched} fetched, {inbox.status.details.stored} new, {inbox.status.details.duplicates} duplicate.</p>}
        </div>
      </Card>)}
      <Card title="Customer database (CRM)" description={PROVIDERS[data.crm.provider] || data.crm.provider} actions={<ModeBadge mode={data.crm.mode} />}>
        {data.crm.mode === 'not_configured' ? <p className="text-muted text-small">No CRM connector is configured. Escalations are created from the email alone; staff can complete customer details manually. A live connector needs TCM's CRM API documentation and credentials.</p> : <ConnectorStatus status={data.crm.status} mode={data.crm.mode} />}
      </Card>
      <Card title="Customer email (outbound)" description="Acknowledgements, clarifications and final emails">
        <ConnectorStatus status={data.outbound} />
      </Card>
      {data.ackSender && <Card title="Acknowledgement sender" description={data.ackSender.server?.from || 'Company address not set'} actions={<ModeBadge mode={!data.ackSender.enabled ? 'disabled' : data.ackSender.configured ? 'live' : 'not_configured'} />}>
        <div className="stack-12">
          {!data.ackSender.enabled
            ? <p className="text-muted text-small">Off. Acknowledgements are sent by the ticket's inbox where it can send (not IMAP). Set B2C_ACK_EMAIL_ENABLED=true to send them from a company address.</p>
            : !data.ackSender.configured
              ? <InlineAlert tone="warning" title="Not configured">{data.ackSender.missing.join(', ')} not set on the server. Acknowledgements fail until this is fixed.</InlineAlert>
              : <p className="text-small">SMTP {data.ackSender.server.host}:{data.ackSender.server.port} ({data.ackSender.server.security}) · {data.ackSender.unmatchedPolicy === 'sender' ? 'unmatched senders are acknowledged too' : 'only matched customers are acknowledged, at their registered address'}</p>}
          <ConnectorStatus status={data.ackSender.status} />
        </div>
      </Card>}
    </div>

    {data.imap && <ImapPanel imap={data.imap} onDone={refresh} />}

    <div className="grid-2">
      <Card title="Processing queues">
        <InfoList columns={2} items={[
          ['Emails processed', String(queues.inbound.processed || 0)], ['Emails waiting', String((queues.inbound.received || 0) + (queues.inbound.processing || 0))],
          ['Emails retrying', String(queues.inbound.retrying || 0)], ['Emails failed', String(queues.inbound.failed || 0)],
          ['Emails ignored', String(queues.inbound.ignored || 0)], ['Escalations in triage', String(queues.triage)],
          ['Customer emails sent', String(queues.outbound.sent || 0)], ['Customer emails held', String(queues.outbound.held || 0)],
          ['Customer emails retrying', String(queues.outbound.retrying || 0)], ['Customer emails failed', String(queues.outbound.failed || 0)],
        ]} />
      </Card>
      <Card title="Processing schedule">
        <InfoList items={[
          ['Automatic polling', data.scheduler.pollMinutes ? `Every ${data.scheduler.pollMinutes} minute${data.scheduler.pollMinutes === 1 ? '' : 's'}` : 'Off — triggered by an external scheduler'],
          ['Last run', data.scheduler.status?.lastRunAt ? formatDateTime(data.scheduler.status.lastRunAt) : 'Not yet run'],
          ['Last run result', data.scheduler.status?.lastError || (data.scheduler.status?.lastSuccessAt ? 'Completed' : '—')],
        ]} />
      </Card>
    </div>

    <Card title="Inbound email needing attention" description="Failed, retrying and ignored emails. Reprocessing an ignored email treats it as a real customer email." flush
      actions={<FilterSelect label="Inbound status" value={inboundFilter} onChange={setInboundFilter} options={['failed', 'retrying', 'ignored', 'processed']} allLabel="Failed, retrying & ignored" />}>
      {inbound.error ? <ErrorState compact message={friendlyError(inbound.error)} onRetry={inbound.reload} /> : !inbound.data?.length ? <EmptyState compact icon={Mail} title="Nothing needs attention" /> : <div className="table-scroll"><table className="table table-compact">
        <thead><tr><th>Received</th><th>From · subject</th><th>Status</th><th>Attempts</th><th>Detail</th><th><span className="sr-only">Action</span></th></tr></thead>
        <tbody>{inbound.data.map(item => <tr key={item._id}>
          <td className="cell-nowrap">{formatDateTime(item.receivedAt)}<span className="cell-sub">{item.inboxKey}</span></td>
          <td>{item.from?.address}<span className="cell-sub">{item.subject || 'No subject'}</span></td>
          <td><Badge tone={item.status === 'failed' ? 'critical' : item.status === 'retrying' ? 'warning' : 'neutral'}>{item.status}</Badge></td>
          <td>{item.attempts}{item.nextAttemptAt && <span className="cell-sub">next {formatRelative(item.nextAttemptAt)}</span>}</td>
          <td>{item.lastError || OUTCOMES[item.outcome] || item.outcome || '—'}{item.ticketId?.reference && <span className="cell-sub"><Link to={`/b2c/tickets/${item.ticketId._id}`}>{item.ticketId.reference}</Link></span>}</td>
          <td className="cell-right">{['failed', 'retrying', 'ignored'].includes(item.status) && <Button size="sm" disabled={Boolean(busy)} onClick={() => perform(`in-${item._id}`, () => retryB2CInbound(item._id), result => `Reprocessed: ${result.status}.`)}>{item.status === 'ignored' ? 'Process anyway' : 'Retry now'}</Button>}</td>
        </tr>)}</tbody>
      </table></div>}
    </Card>

    <Card title="Customer email needing attention" description="Held emails are sent automatically once their template is approved in B2C Settings." flush>
      {outbound.error ? <ErrorState compact message={friendlyError(outbound.error)} onRetry={outbound.reload} /> : !outbound.data?.length ? <EmptyState compact icon={Send} title="No held or failed customer emails" /> : <div className="table-scroll"><table className="table table-compact">
        <thead><tr><th>Created</th><th>Escalation</th><th>Email</th><th>Status</th><th>Detail</th><th><span className="sr-only">Action</span></th></tr></thead>
        <tbody>{outbound.data.map(item => <tr key={item._id}>
          <td className="cell-nowrap">{formatDateTime(item.createdAt)}</td>
          <td>{item.ticketId ? <Link className="mono" to={`/b2c/tickets/${item.ticketId._id}`}>{item.ticketId.reference}</Link> : '—'}</td>
          <td>{item.kind}<span className="cell-sub">{item.to}</span></td>
          <td><Badge tone={item.status === 'failed' ? 'critical' : 'warning'}>{item.status}</Badge></td>
          <td>{item.heldReason === 'template_not_approved' ? `Template "${item.templateKey}" is not approved` : item.lastError || '—'}</td>
          <td className="cell-right">{item.status === 'failed' && <Button size="sm" disabled={Boolean(busy)} onClick={() => perform(`out-${item._id}`, () => retryB2COutbound(item._id), result => `Customer email ${result.status}.`)}>Retry</Button>}{item.status === 'held' && <Button size="sm" variant="ghost" to="/b2c/settings#templates">Templates</Button>}</td>
        </tr>)}</tbody>
      </table></div>}
    </Card>

    {data.testAdapters.email && testInboxes.length > 0 && <TestAdapterPanel inboxes={testInboxes} onDone={refresh} />}
  </B2CShell>;
}

// Checks the IMAP login and mailbox folder. Reads nothing; credentials stay on the server.
function ImapPanel({ imap, onDone }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const check = async () => {
    setBusy(true); setError(''); setResult(null);
    try { setResult(await verifyB2CImap()); await onDone(); } catch (taskError) { setError(friendlyError(taskError)); } finally { setBusy(false); }
  };
  const mode = imap.configured ? 'live' : 'not_configured';
  return <Card title="IMAP mailbox (incoming email)" description={imap.server.host ? `${imap.server.host}:${imap.server.port} · ${imap.server.secure ? 'SSL/TLS' : 'STARTTLS'} · folder ${imap.server.mailbox} · ${imap.server.user || '—'}` : 'Not set up on the server'} actions={<ModeBadge mode={mode} />}>
    <div className="grid-2">
      <div className="stack-12">
        {imap.missing.length > 0 && <InlineAlert tone="warning" title="IMAP is not ready">{imap.missing.map(name => `${name} is not set`).join('; ')}. Set these on the backend server; they are never entered here.</InlineAlert>}
        <p className="text-small">{imap.inboxes.length ? `Inboxes read from this mailbox: ${imap.inboxes.join(', ')}.` : 'No inbox reads this mailbox yet. Choose “IMAP mailbox” as the provider in B2C Settings.'}</p>
        <p className="text-muted text-small">IMAP only reads mail. Customer emails for IMAP inboxes are recorded on the ticket as not sent.</p>
        <ConnectorStatus status={imap.status} mode={mode} />
      </div>
      <div className="stack-12">
        <div><Button icon={PlugZap} disabled={busy || !imap.configured} onClick={check}>{busy ? 'Checking…' : 'Check connection and login'}</Button></div>
        {error && <InlineAlert title={error} />}
        {result && <InlineAlert tone={result.ok ? 'success' : 'critical'} title={result.ok ? result.message : result.error}>{!result.ok && (result.retryable ? 'This looks temporary; try again shortly.' : 'Check the IMAP settings on the server.')}</InlineAlert>}
      </div>
    </div>
  </Card>;
}

// TEST ADAPTER ONLY: puts an email in a test inbox and runs processing.
function TestAdapterPanel({ inboxes, onDone }) {
  const [form, setForm] = useState({ inboxKey: inboxes[0].key, from: 'test.customer.one@example.test', fromName: 'Test Customer One', subject: 'Repair delay', body: 'Hello,\n\nCase ID: TEST-CASE-0001\nSerial No: DEMOCHN0001\nMy device repair is delayed.\n' });
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const outbox = useAsync(getB2CTestOutbox, []);
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  // Only the messages for the escalation the last test email created or updated.
  const reference = result?.email?.ticket?.reference;
  const replies = reference ? (outbox.data || []).filter(message => message.subject?.startsWith(`[${reference}]`)) : [];
  const submit = async event => {
    event.preventDefault();
    setBusy(true); setError(''); setResult(null);
    try { setResult(await injectB2CTestEmail(form)); await Promise.all([onDone(), outbox.reload({ silent: true })]); } catch (submitError) { setError(friendlyError(submitError)); } finally { setBusy(false); }
  };
  return <Card title="Test adapter: simulate a customer email" description="For development and acceptance testing only. Nothing here is sent to or received from a real mailbox." actions={<Badge tone="warning"><FlaskConical size={12} aria-hidden="true" /> Test only</Badge>}>
    <div className="grid-2">
      <form className="stack-16" onSubmit={submit}>
        <p className="text-muted text-small">Write the serial number in the body after a label, e.g. “Serial No: DEMOCHN0001”. It is looked up in the device records and the escalation goes to that device's region; without a serial number it goes to triage. Test CRM records: case IDs TEST-CASE-0001 / TEST-CASE-0002 and the matching @example.test addresses.</p>
        <Field label="Test inbox">{props => <select {...props} value={form.inboxKey} onChange={event => set('inboxKey', event.target.value)}>{inboxes.map(inbox => <option key={inbox.key} value={inbox.key}>{inbox.displayName || inbox.address}</option>)}</select>}</Field>
        <div className="grid-2"><Field label="Sender email">{props => <input {...props} type="email" value={form.from} onChange={event => set('from', event.target.value)} required />}</Field><Field label="Sender name">{props => <input {...props} value={form.fromName} onChange={event => set('fromName', event.target.value)} />}</Field></div>
        <Field label="Subject">{props => <input {...props} value={form.subject} onChange={event => set('subject', event.target.value)} />}</Field>
        <Field label="Body">{props => <textarea {...props} rows={6} value={form.body} onChange={event => set('body', event.target.value)} />}</Field>
        {error && <InlineAlert title={error} />}
        {result?.email && <InlineAlert tone={result.email.status === 'processed' ? 'success' : 'warning'} title={OUTCOMES[result.email.outcome] || result.email.status}>{result.email.ticket ? <>Escalation <Link to={`/b2c/tickets/${result.email.ticket._id}`}>{result.email.ticket.reference}</Link> · {result.email.ticket.status}</> : result.email.lastError}</InlineAlert>}
        <div><Button type="submit" variant="primary" icon={PlugZap} disabled={busy}>{busy ? 'Processing…' : 'Send test email and process'}</Button></div>
      </form>
      <div className="stack-12">
        <p className="side-section-title">Test outbox (not delivered)</p>
        {!reference ? <p className="text-muted text-small">Send a test email to see what the customer receives for it.</p>
          : replies.length ? <ul className="b2c-outbox">{replies.map(message => <li key={message.providerMessageId}><strong>{message.subject}</strong><span className="text-muted text-small">To {message.to} · {formatDateTime(message.sentAt)}</span><p className="text-small description-text">{message.text}</p></li>)}</ul>
          : <p className="text-muted text-small">Nothing "sent" to the customer for {reference} yet. The acknowledgement is held until its template is approved in B2C Settings.</p>}
      </div>
    </div>
  </Card>;
}
