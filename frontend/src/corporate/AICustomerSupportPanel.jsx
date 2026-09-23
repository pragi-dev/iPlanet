import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, FilePlus2, Info, Laptop, Mic, RefreshCcw, SendHorizonal, ShieldCheck, Sparkles, Stethoscope, Ticket, Volume2, Wrench } from 'lucide-react';
import { Button, Drawer, IconButton, InlineAlert } from '../ui';
import { getTicketAITroubleshooting, sendAiSupportMessage } from './api';

const unavailablePattern = /AI (Support|troubleshooting) is (temporarily |currently )?unavailable/i;

function contextDevice(ticket, device) {
  return ticket?.deviceId && typeof ticket.deviceId === 'object' ? ticket.deviceId : device;
}

// Suggested actions use whatever the current page already knows, so the
// assistant is never asked for a device or ticket that is on screen.
function suggestedActions(ticket, device) {
  const known = contextDevice(ticket, device);
  const name = known?.model ? `my ${known.model}${known.serialNumber ? ` (${known.serialNumber})` : ''}` : 'my device';
  return [
    { key: 'diagnose', icon: Stethoscope, label: 'Diagnose an issue', prompt: `I need help diagnosing an issue with ${name}.` },
    { key: 'warranty', icon: ShieldCheck, label: 'Check warranty', prompt: `What is the warranty status of ${name}?` },
    { key: 'amc', icon: Wrench, label: 'Check AMC', prompt: `What is the AMC coverage status of ${name}?` },
    { key: 'track', icon: Ticket, label: 'Track service', prompt: ticket?.ticketId ? `What is the current status of service request ${ticket.ticketId}?` : `Where is the latest service request for ${name}?` },
    { key: 'raise', icon: FilePlus2, label: 'Raise service request', navigate: true },
  ];
}

export function AICustomerSupportPanel({ ticket, device, open = false, onClose }) {
  const navigate = useNavigate();
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [failedMessage, setFailedMessage] = useState('');
  const [conversationId, setConversationId] = useState(null);
  const [requestData, setRequestData] = useState(null);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [speakingIndex, setSpeakingIndex] = useState(null);
  const listRef = useRef(null);
  const recognitionRef = useRef(null);
  const inputRef = useRef(null);

  const reset = () => { setMessages([]); setConversationId(null); setRequestData(null); setError(''); setFailedMessage(''); };

  useEffect(() => {
    if (!open) return undefined;
    let ignore = false;
    reset();
    if (ticket?._id) {
      getTicketAITroubleshooting(ticket._id).then(result => {
        if (ignore) return;
        const session = result?.session;
        const visible = (session?.messages || []).filter(message => !(message.role === 'assistant' && unavailablePattern.test(message.content))).map(message => ({ role: message.role, content: message.content }));
        setMessages(visible);
        setConversationId(visible.length ? session.sessionId || session._id || null : null);
      }).catch(() => { /* A new conversation starts when no session exists. */ });
    }
    return () => { ignore = true; };
  }, [open, ticket?._id]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, loading, requestData, error]);

  useEffect(() => {
    setVoiceSupported(Boolean(window.SpeechRecognition || window.webkitSpeechRecognition));
    return () => { recognitionRef.current?.stop(); window.speechSynthesis?.cancel(); };
  }, []);

  const sendMessage = async (nextMessage, { appendUser = true } = {}) => {
    const value = String(nextMessage ?? draft).trim();
    if (!value || loading) return;
    if (appendUser) setMessages(current => [...current, { role: 'user', content: value }]);
    setDraft('');
    setLoading(true);
    setError('');
    setFailedMessage('');
    try {
      const result = await sendAiSupportMessage(ticket?._id || null, {
        message: value,
        conversationId,
        deviceId: contextDevice(ticket, device)?._id || null,
        // Preserves the recent non-ticket conversation through the backend.
        conversation: messages,
      });
      const response = result?.reply || result?.message;
      if (!response || unavailablePattern.test(response)) throw new Error('unavailable');
      setMessages(current => [...current, { role: 'assistant', content: response }]);
      setConversationId(result?.conversationId || conversationId);
      setRequestData(result?.requestData || null);
    } catch {
      setError('AI Support is temporarily unavailable. Please try again.');
      setFailedMessage(value);
    } finally {
      setLoading(false);
    }
  };

  const speakMessage = (content, index) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    if (speakingIndex === index) { setSpeakingIndex(null); return; }
    const utterance = new SpeechSynthesisUtterance(content);
    utterance.lang = navigator.language || 'en-IN';
    utterance.onend = () => setSpeakingIndex(null);
    utterance.onerror = () => setSpeakingIndex(null);
    setSpeakingIndex(index);
    window.speechSynthesis.speak(utterance);
  };

  const toggleVoiceCapture = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { setError('Voice input is not supported in this browser.'); return; }
    if (voiceActive && recognitionRef.current) { recognitionRef.current.stop(); setVoiceActive(false); return; }
    const recognition = new SpeechRecognition();
    recognition.lang = navigator.language || 'en-IN';
    recognition.continuous = false;
    recognition.interimResults = false;
    let finalTranscript = '';
    recognition.onstart = () => setVoiceActive(true);
    recognition.onresult = event => {
      finalTranscript = Array.from(event.results).map(result => result[0]?.transcript || '').join(' ').trim();
      if (finalTranscript) setDraft(finalTranscript);
    };
    recognition.onend = () => { setVoiceActive(false); if (finalTranscript.trim()) setDraft(finalTranscript.trim()); };
    recognition.onerror = () => { setVoiceActive(false); setError('Voice capture was interrupted. Please try again.'); };
    recognitionRef.current = recognition;
    recognition.start();
  };

  const runSuggestion = action => {
    if (action.navigate) {
      const known = contextDevice(ticket, device);
      onClose?.();
      navigate(known?._id ? `/corporate/raise-request?device=${known._id}` : '/corporate/raise-request');
      return;
    }
    void sendMessage(action.prompt);
  };

  if (!open) return null;

  const known = contextDevice(ticket, device);
  const hasConversation = messages.some(item => item.role === 'user');
  const speechAvailable = voiceSupported && 'speechSynthesis' in window;

  return <Drawer
    className="ai-drawer"
    width={400}
    title="AI Support"
    eyebrow="Device assistance"
    icon={<Sparkles size={18} />}
    onClose={onClose}
    actions={<IconButton label="Start a new conversation" icon={RefreshCcw} onClick={reset} />}
  >
    <div className="ai-context">
      {known ? <><Laptop size={15} aria-hidden="true" /><span>Using <strong>{known.model || 'device'}</strong>{known.serialNumber && <> · <span className="mono">{known.serialNumber}</span></>}{ticket?.ticketId && <> · Ticket <strong>{ticket.ticketId}</strong></>}</span></>
        : <><Info size={15} aria-hidden="true" /><span>No device selected. Share a serial number and the assistant will look it up.</span></>}
    </div>

    <div className="ai-thread" ref={listRef} aria-live="polite">
      {!hasConversation && <div className="ai-welcome">
        <h3>How can I help with your device?</h3>
        <p>Ask in any language and I'll reply in the same language.</p>
      </div>}

      {messages.map((message, index) => <div key={`${message.role}-${index}`} className={`ai-msg ${message.role}`}>
        {message.role === 'assistant' && <span className="ai-msg-avatar" aria-hidden="true"><Bot size={15} /></span>}
        <div>
          <div className="ai-msg-bubble">{message.content}</div>
          {message.role === 'assistant' && speechAvailable && <div className="ai-msg-tools">
            <button type="button" className={speakingIndex === index ? 'active' : ''} aria-label={speakingIndex === index ? 'Stop reading response' : 'Read response aloud'} onClick={() => speakMessage(message.content, index)}><Volume2 size={12} aria-hidden="true" />{speakingIndex === index ? 'Stop' : 'Listen'}</button>
          </div>}
        </div>
      </div>)}

      {loading && <div className="ai-msg assistant"><span className="ai-msg-avatar" aria-hidden="true"><Bot size={15} /></span><div className="ai-msg-bubble"><span className="typing" aria-label="Assistant is typing"><i /><i /><i /></span></div></div>}

      {!hasConversation && !loading && <div className="ai-suggestions">
        <p>Suggested actions</p>
        {suggestedActions(ticket, device).map(action => <button key={action.key} type="button" className="ai-suggestion" onClick={() => runSuggestion(action)}><action.icon size={16} aria-hidden="true" />{action.label}</button>)}
      </div>}

      {error && <InlineAlert title={error} action={failedMessage ? <Button size="sm" onClick={() => void sendMessage(failedMessage, { appendUser: false })} disabled={loading}>Retry</Button> : null} />}

      {requestData && <div className="ai-draft">
        <strong>Service request draft ready</strong>
        <span>{[requestData.deviceName, requestData.issueType].filter(Boolean).join(' · ')}</span>
        <Button variant="primary" size="sm" icon={FilePlus2} onClick={() => { onClose?.(); navigate(`/corporate/raise-request?source=ai&conversationId=${encodeURIComponent(conversationId || '')}`, { state: { aiRequest: requestData } }); }}>Review request</Button>
      </div>}
    </div>

    <form className="ai-composer" onSubmit={event => { event.preventDefault(); void sendMessage(); }}>
      <div className="ai-composer-box">
        <label htmlFor="ai-composer-input" className="sr-only">Message AI Support</label>
        <textarea id="ai-composer-input" data-autofocus ref={inputRef} rows={1} value={draft} placeholder="Describe your issue…" onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} />
        {voiceSupported && <IconButton className={voiceActive ? 'recording' : ''} label={voiceActive ? 'Stop voice input' : 'Start voice input'} icon={Mic} aria-pressed={voiceActive} onClick={toggleVoiceCapture} />}
        <button type="submit" className="btn btn-primary ai-send" aria-label="Send message" disabled={!draft.trim() || loading}><SendHorizonal size={16} aria-hidden="true" /></button>
      </div>
      <p className="ai-footnote">AI guidance may be incomplete. Raise a service request for hardware faults.</p>
    </form>
  </Drawer>;
}
