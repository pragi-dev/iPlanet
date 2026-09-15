import { useEffect, useState } from 'react';
import { Bot, MessageSquareText, RefreshCcw, ShieldAlert, X } from 'lucide-react';
import { ModalLayer } from './ModalLayer';
import { getTicketAITroubleshooting, startTicketAITroubleshooting, saveTicketCall } from './api';

export function AITroubleshootingPanel({ ticket, open, onClose }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [customerReply, setCustomerReply] = useState('');
  const [error, setError] = useState('');
  const [resolved, setResolved] = useState(false);

  const startSession = async () => {
    if (!ticket?._id) return;
    setLoading(true);
    setError('');
    try {
      const result = await startTicketAITroubleshooting(ticket._id, {
        customerResponse: '',
        stepResult: 'Started',
        stepLabel: 'Initial AI troubleshooting started'
      });
      setSession(result.session || null);
      setMessage(result.message || 'I can help troubleshoot this. Let’s start with a quick check.');
    } catch (loadError) {
      setError(loadError.message || 'AI troubleshooting is currently unavailable.');
      setMessage('AI troubleshooting is currently unavailable.');
    } finally {
      setLoading(false);
    }
  };

  const refresh = async () => {
    if (!ticket?._id) return;
    try {
      const result = await getTicketAITroubleshooting(ticket._id);
      setSession(result.session || null);
    } catch {
      setSession(null);
    }
  };

  useEffect(() => {
    if (!open || !ticket?._id) return;
    void refresh().then(() => {
      if (!session) void startSession();
    });
  }, [open, ticket?._id]);

  const handleSubmit = async () => {
    if (!ticket?._id || !customerReply.trim()) return;
    setLoading(true);
    setError('');
    try {
      const result = await startTicketAITroubleshooting(ticket._id, {
        customerResponse: customerReply,
        resolved: resolved ? 'true' : undefined,
        unresolved: resolved ? undefined : 'true'
      });
      setSession(result.session || null);
      setMessage(result.message || 'Thanks. Let’s try one more check.');
      if (resolved) {
        setCustomerReply('');
      } else {
        setCustomerReply('');
      }
    } catch (submitError) {
      setError(submitError.message || 'AI troubleshooting is currently unavailable.');
      setMessage('AI troubleshooting is currently unavailable.');
    } finally {
      setLoading(false);
    }
  };

  if (!open || !ticket) return null;

  return <ModalLayer className="modal-backdrop"><div className="modal panel ai-panel" role="dialog" aria-modal="true">
    <div className="panel-heading ai-header">
      <div>
        <span className="kicker">AI L1 support</span>
        <h3>Apple Device Assistant</h3>
      </div>
      <button type="button" className="modal-close" aria-label="Close AI support panel" onClick={onClose}><X size={18} /></button>
    </div>
    <div className="ai-context-box">
      <p><strong>Device:</strong> {ticket.deviceId?.model || 'Unknown'} · {ticket.deviceId?.serialNumber || 'Unknown serial'}</p>
      <p><strong>Issue:</strong> {ticket.issueType || 'General support'}</p>
      <p><strong>Ticket:</strong> {ticket.ticketId}</p>
    </div>

    <div className="ai-chat-box">
      <div className="ai-bubble ai-bot">
        <Bot size={15} />
        <span>{message || 'I can help you troubleshoot this. Let’s start with a quick check.'}</span>
      </div>
      {session?.troubleshootingSteps?.length ? session.troubleshootingSteps.map((step, index) => <div key={`${step.step}-${index}`} className="ai-bubble ai-step"><MessageSquareText size={14} /><span>{step.step}</span></div>) : null}
    </div>

    <div className="ai-controls">
      <label>Customer response
        <textarea value={customerReply} onChange={event => setCustomerReply(event.target.value)} placeholder="Describe what happened after the step" />
      </label>
      <label className="checkbox-row"><input type="checkbox" checked={resolved} onChange={event => setResolved(event.target.checked)} />Issue resolved remotely</label>
      {error && <p className="form-error">{error}</p>}
      <div className="action-row">
        <button type="button" className="button secondary" onClick={() => void startSession()} disabled={loading}><RefreshCcw size={15} />Restart</button>
        <button type="button" className="button primary" onClick={() => void handleSubmit()} disabled={loading || !customerReply.trim()}>{loading ? 'Working...' : 'Send reply'}</button>
      </div>
    </div>

    {session?.result === 'AI unavailable' && <div className="alert-box">
      <ShieldAlert size={16} />
      <span>AI troubleshooting is currently unavailable.</span>
      <button type="button" className="button secondary" onClick={onClose}>Contact Service Team</button>
    </div>}
  </div></ModalLayer>;
}
