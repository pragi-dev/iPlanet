import { useEffect, useMemo, useState } from 'react';
import { Phone } from 'lucide-react';
import { getTicketCalls, saveTicketCall } from './api';
import { Button, Drawer, Field, InfoList, InlineAlert, formatDateTime, friendlyError } from '../ui';

const outcomeOptions = ['Issue Resolved Remotely', 'Customer Needs Further Assistance', 'Engineer Visit Required', 'Customer Unavailable', 'Call Back Required'];

export function CallCustomerPanel({ ticket, open, onClose, onSaved }) {
  const [history, setHistory] = useState([]);
  const [form, setForm] = useState({ outcome: 'Customer Unavailable', notes: '', callStatus: 'Call Attempted' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const phoneNumber = ticket?.customerId?.phone || ticket?.companyId?.phone || '';
  const phoneHref = useMemo(() => { const digits = String(phoneNumber).replace(/\D/g, ''); return digits ? `tel:+${digits}` : ''; }, [phoneNumber]);

  const loadHistory = async () => {
    if (!ticket?._id) return;
    try { setHistory((await getTicketCalls(ticket._id)) || []); } catch { setHistory([]); }
  };

  useEffect(() => {
    if (!open) return;
    void loadHistory();
    setForm({ outcome: 'Customer Unavailable', notes: '', callStatus: 'Call Attempted' });
    setError('');
  }, [open, ticket?._id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async event => {
    event.preventDefault();
    if (!ticket?._id) return;
    setBusy(true);
    setError('');
    try {
      await saveTicketCall(ticket._id, { ...form, customerPhone: phoneNumber });
      await loadHistory();
      onSaved?.();
      onClose();
    } catch (submitError) {
      setError(friendlyError(submitError, 'Unable to save the call record.'));
    } finally {
      setBusy(false);
    }
  };

  if (!open || !ticket) return null;

  return <Drawer title="Call customer" eyebrow="Remote L1 support" icon={<Phone size={18} />} onClose={onClose}
    footer={<div className="row-between"><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="call-form" disabled={busy}>{busy ? 'Saving…' : 'Save call notes'}</Button></div>}>
    <div>
      <p className="subheading">Customer</p>
      <InfoList items={[['Company', ticket.customerId?.company || ticket.companyId?.name], ['Contact person', ticket.customerId?.name], ['Phone', phoneNumber], ['Ticket', <span className="mono">{ticket.ticketId}</span>], ['Device', [ticket.deviceId?.model, ticket.deviceId?.serialNumber].filter(Boolean).join(' · ')], ['Issue', ticket.issueType]]} />
    </div>
    {phoneHref ? <a className="btn btn-primary btn-lg btn-block" href={phoneHref}><Phone size={16} aria-hidden="true" />Call {phoneNumber}</a> : <InlineAlert tone="warning" title="No phone number on record for this customer." />}
    <form id="call-form" className="stack-16" onSubmit={submit}>
      <Field label="Call outcome">{props => <select {...props} value={form.outcome} onChange={event => setForm(current => ({ ...current, outcome: event.target.value }))}>{outcomeOptions.map(option => <option key={option}>{option}</option>)}</select>}</Field>
      <Field label="Notes" hint="Visible to the service team on this ticket.">{props => <textarea {...props} value={form.notes} onChange={event => setForm(current => ({ ...current, notes: event.target.value }))} placeholder="What was discussed and agreed on the call" />}</Field>
      {error && <InlineAlert title={error} />}
    </form>
    {history.length > 0 && <div>
      <p className="subheading">Call history</p>
      <ol className="timeline">{history.map(item => <li key={item._id} className="timeline-item timeline-neutral">
        <span className="timeline-marker" aria-hidden="true" />
        <div className="timeline-content">
          <p className="timeline-title">{item.outcome}</p>
          {item.notes && <p className="timeline-text">{item.notes}</p>}
          <p className="timeline-meta"><span>{item.agentName || 'Service agent'} · {item.callStatus || 'Call Attempted'}</span><time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time></p>
        </div>
      </li>)}</ol>
    </div>}
  </Drawer>;
}
