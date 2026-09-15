import { useEffect, useMemo, useState } from 'react';
import { Phone, X } from 'lucide-react';
import { ModalLayer } from './ModalLayer';
import { getTicketCalls, saveTicketCall } from './api';

const outcomeOptions = [
  'Issue Resolved Remotely',
  'Customer Needs Further Assistance',
  'Engineer Visit Required',
  'Customer Unavailable',
  'Call Back Required'
];

export function CallCustomerPanel({ ticket, open, onClose, onSaved }) {
  const [history, setHistory] = useState([]);
  const [form, setForm] = useState({
    outcome: 'Customer Unavailable',
    notes: '',
    callStatus: 'Call Attempted'
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const phoneNumber = ticket?.customerId?.phone || ticket?.companyId?.phone || '';
  const phoneHref = useMemo(() => {
    const digits = String(phoneNumber).replace(/\D/g, '');
    return digits ? `tel:+${digits}` : '';
  }, [phoneNumber]);

  const loadHistory = async () => {
    if (!ticket?._id) return;
    try {
      const items = await getTicketCalls(ticket._id);
      setHistory(items || []);
    } catch (loadError) {
      setHistory([]);
    }
  };

  useEffect(() => {
    if (!open) return;
    void loadHistory();
    setForm({ outcome: 'Customer Unavailable', notes: '', callStatus: 'Call Attempted' });
    setError('');
  }, [open, ticket?._id]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = event => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const submit = async () => {
    if (!ticket?._id) return;
    setBusy(true);
    setError('');
    try {
      await saveTicketCall(ticket._id, {
        ...form,
        customerPhone: phoneNumber
      });
      await loadHistory();
      onSaved?.();
      onClose();
    } catch (submitError) {
      setError(submitError.message || 'Unable to save the call record.');
    } finally {
      setBusy(false);
    }
  };

  if (!open || !ticket) return null;

  return <ModalLayer className="call-drawer-backdrop">
    <div className="call-customer-drawer" role="dialog" aria-modal="true" aria-label="Call customer panel" onClick={event => event.stopPropagation()}>
      <div className="call-drawer-header">
        <div className="call-drawer-title-wrap">
          <div className="call-drawer-icon"><Phone size={18} /></div>
          <div>
            <h3>Call Customer</h3>
            <p>Contact customer for remote L1 support</p>
          </div>
        </div>
        <button type="button" className="call-drawer-close" aria-label="Close call customer" onClick={onClose}><X size={18} /></button>
      </div>

      <div className="call-drawer-body">
        <div className="call-drawer-section">
          <h4>Customer details</h4>
          <div className="call-detail-list">
            <div className="call-detail-row"><span>Customer / Company</span><strong>{ticket.customerId?.company || ticket.companyId?.name || 'Customer'}</strong></div>
            <div className="call-detail-row"><span>Contact Person</span><strong>{ticket.customerId?.name || 'Not available'}</strong></div>
            <div className="call-detail-row"><span>Phone Number</span><strong>{phoneNumber || 'Not available'}</strong></div>
            <div className="call-detail-row"><span>Ticket ID</span><strong>{ticket.ticketId}</strong></div>
            <div className="call-detail-row"><span>Device</span><strong>{ticket.deviceId?.model || 'Not available'}</strong></div>
            <div className="call-detail-row"><span>Serial Number</span><strong>{ticket.deviceId?.serialNumber || 'Not available'}</strong></div>
            <div className="call-detail-row"><span>Issue</span><strong>{ticket.issueType}</strong></div>
          </div>
        </div>

        <div className="call-drawer-section call-action-block">
          <h4>Call action</h4>
          <a className="button primary call-drawer-button" href={phoneHref || '#'} onClick={event => { if (!phoneHref) event.preventDefault(); }}>
            <Phone size={16} />Call Customer
          </a>
        </div>

        <div className="call-drawer-section">
          <label className="call-field-label">Call Outcome</label>
          <select value={form.outcome} onChange={event => setForm(current => ({ ...current, outcome: event.target.value }))}>
            {outcomeOptions.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        </div>

        <div className="call-drawer-section">
          <label className="call-field-label">Additional Notes</label>
          <textarea value={form.notes} onChange={event => setForm(current => ({ ...current, notes: event.target.value }))} placeholder="Add notes captured during the call" />
        </div>

        {error && <div className="call-error-box">{error}</div>}

        <div className="call-save-row">
          <button type="button" className="button primary call-save-button" disabled={busy} onClick={submit}>{busy ? 'Saving...' : 'Save Call Notes'}</button>
        </div>

        {history.length > 0 && <div className="call-drawer-section call-history-box">
          <h4>Call History</h4>
          <div className="call-history-list">
            {history.map(item => <div key={item._id} className="call-history-item">
              <strong>{new Date(item.createdAt).toLocaleString()}</strong>
              <span>{item.agentName || 'Service Agent'}</span>
              <p>Duration/Status: {item.callStatus || 'Call Attempted'}</p>
              <p>Outcome: {item.outcome}</p>
              <p>Notes: {item.notes || 'No notes recorded.'}</p>
            </div>)}
          </div>
        </div>}
      </div>
    </div>
  </ModalLayer>;
}
