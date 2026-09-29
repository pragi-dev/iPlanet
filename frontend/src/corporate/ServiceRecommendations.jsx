import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarCheck2, CalendarClock, CircleSlash, FilePlus2 } from 'lucide-react';
import { Shell } from './components';
import { getServiceRecommendations, respondToServiceRecommendation } from './api';
import {
  Badge, Button, EmptyState, Field, InlineAlert, Modal, PageHeader, TableCard, canRespond, customerStatus, dueLabel, formatDate, friendlyError, pluralize, useAsync,
} from '../ui';

// Tomorrow in India as YYYY-MM-DD, the earliest allowed reminder date.
function indiaTomorrow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Date.now() + 86400000)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function ServiceRecommendations() {
  const [params] = useSearchParams();
  const focusId = params.get('followUp');
  const state = useAsync(getServiceRecommendations, []);
  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState('');
  const items = [...(state.data?.items || [])].sort((a, b) => Number(b._id === focusId) - Number(a._id === focusId));
  const open = items.filter(canRespond).length;

  const responded = message => { setDialog(null); setNotice(message); state.reload(); };

  return <Shell title="Service Recommended" crumbs={[{ label: 'Service Recommended' }]}>
    <PageHeader title="Service recommended"
      description={state.data ? (open ? `${pluralize(open, 'device')} may be due for preventive service. Request service, set a reminder, or let iPlanet know it isn't needed.` : 'None of your devices needs preventive service right now.') : 'Devices approaching their recommended preventive service date.'} />
    {notice && <InlineAlert tone="success" title={notice} />}
    <TableCard
      columns={7}
      loading={state.loading && !state.data}
      error={state.error && friendlyError(state.error)}
      errorTitle="Unable to load service recommendations"
      onRetry={state.reload}
      isEmpty={!items.length}
      empty={<EmptyState icon={CalendarCheck2} title="You're all caught up." description={`Devices appear here ${state.data?.config?.upcomingDays || 30} days before their recommended service date.`} />}
    >
      <table className="table pro-table">
        <thead><tr><th>Device</th><th className="pro-col-optional">Location</th><th>Last service</th><th>Recommended</th><th className="pro-col-optional">Coverage</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{items.map(item => {
          const status = customerStatus(item);
          return <tr key={item._id} className={item._id === focusId ? 'row-selected' : undefined}>
            <td className="pro-cell-device"><Link className="cell-link" to={`/corporate/devices/${item.deviceId}`}>{item.device.model}</Link><span className="cell-sub mono">{item.device.serialNumber}{item.device.employeeName ? ` · ${item.device.employeeName}` : ''}</span></td>
            <td className="pro-col-optional" data-label="Location">{item.device.location || '—'}</td>
            <td data-label="Last service">{formatDate(item.lastServiceDate, 'None recorded')}</td>
            <td data-label="Recommended"><span className="pro-due"><strong>{formatDate(item.nextServiceDate)}</strong><small>{dueLabel(item.daysUntil)}</small></span></td>
            <td className="pro-col-optional" data-label="Coverage"><span className="pro-coverage"><span>Warranty · {item.coverage.warrantyStatus || '—'}</span><span>AMC · {item.coverage.amcStatus || '—'}</span></span></td>
            <td className="pro-cell-status"><Badge dot tone={status.tone}>{status.label}</Badge></td>
            <td className="pro-cell-actions"><div className="pro-actions">
              {canRespond(item) ? <>
                <Button size="sm" variant="primary" icon={FilePlus2} to={`/corporate/raise-request?serviceFollowUp=${item._id}`}>{item.stage === 'Scheduled' ? 'Confirm request' : 'Request service'}</Button>
                <Button size="sm" icon={CalendarClock} onClick={() => { setNotice(''); setDialog({ type: 'later', item }); }}>Later</Button>
                <Button size="sm" variant="ghost" icon={CircleSlash} onClick={() => { setNotice(''); setDialog({ type: 'not-required', item }); }}>Not required</Button>
              </> : item.ticket?._id ? <Button size="sm" to={`/corporate/service-requests/${item.ticket._id}`}>Track request</Button> : null}
            </div></td>
          </tr>;
        })}</tbody>
      </table>
    </TableCard>
    {dialog?.type === 'later' && <ScheduleLaterDialog item={dialog.item} onClose={() => setDialog(null)} onDone={date => responded(`We'll remind you about ${dialog.item.device.model} on ${formatDate(date)}.`)} />}
    {dialog?.type === 'not-required' && <NotRequiredDialog item={dialog.item} reasons={state.data?.config?.notRequiredReasons || []} onClose={() => setDialog(null)} onDone={() => responded(`Preventive service for ${dialog.item.device.model} is marked as not required. The next service date will still be tracked.`)} />}
  </Shell>;
}

export function ScheduleLaterDialog({ item, onClose, onDone }) {
  const [date, setDate] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async event => {
    event.preventDefault();
    if (!date || busy) return;
    setBusy(true);
    setError('');
    try { await respondToServiceRecommendation(item._id, 'schedule-later', { followUpDate: date, notes }); onDone(date); }
    catch (submitError) { setError(friendlyError(submitError, 'Unable to set the reminder.')); setBusy(false); }
  };
  return <Modal as="form" onSubmit={submit} size="sm" title="Remind me later" description={`${item.device.model} · ${item.device.serialNumber}`} onClose={onClose}
    footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={!date || busy}>{busy ? 'Saving…' : 'Set reminder'}</Button></>}>
    <div className="pro-form">
      <Field label="Remind me on" required hint="The recommendation comes back to your attention on this date.">{props => <input {...props} type="date" min={indiaTomorrow()} value={date} onChange={event => setDate(event.target.value)} required data-autofocus />}</Field>
      <Field label="Note for iPlanet Service">{props => <textarea {...props} rows={3} maxLength={1000} value={notes} onChange={event => setNotes(event.target.value)} placeholder="Optional" />}</Field>
      {error && <InlineAlert title={error} />}
    </div>
  </Modal>;
}

export function NotRequiredDialog({ item, reasons, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const invalid = !reason || (reason === 'Other' && !notes.trim());
  const submit = async event => {
    event.preventDefault();
    if (invalid || busy) return;
    setBusy(true);
    setError('');
    try { await respondToServiceRecommendation(item._id, 'not-required', { reason, notes }); onDone(); }
    catch (submitError) { setError(friendlyError(submitError, 'Unable to save your response.')); setBusy(false); }
  };
  return <Modal as="form" onSubmit={submit} size="sm" title="Service not required" description={`${item.device.model} · ${item.device.serialNumber}`} onClose={onClose}
    footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={invalid || busy}>{busy ? 'Saving…' : 'Confirm'}</Button></>}>
    <div className="pro-form">
      <fieldset className="pro-choice-list" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-label" style={{ marginBottom: 8 }}>Why isn't service needed?</legend>
        {reasons.map(value => <label className="pro-choice" key={value}><input type="radio" name="reason" value={value} checked={reason === value} onChange={() => setReason(value)} />{value}</label>)}
      </fieldset>
      <Field label={reason === 'Other' ? 'Details (required)' : 'Details'}>{props => <textarea {...props} rows={3} maxLength={1000} value={notes} onChange={event => setNotes(event.target.value)} placeholder="Optional" />}</Field>
      <p className="text-small text-muted">This only skips the current service cycle. Future service dates are still tracked.</p>
      {error && <InlineAlert title={error} />}
    </div>
  </Modal>;
}
