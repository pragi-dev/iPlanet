import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Mic, RefreshCcw, SendHorizonal, ShieldAlert, Sparkles, Volume2, X } from 'lucide-react';
import { ModalLayer } from './ModalLayer';
import { useNavigate } from 'react-router-dom';
import { getTicketAITroubleshooting, sendAiSupportMessage } from './api';

const defaultMessage = "Hi! I'm your AI Support Assistant.\n\nTell me what you're experiencing with your device, and I'll help you troubleshoot it step by step.";
const welcomeSuggestions = [
  'My iPhone is not charging',
  'My MacBook is running slow',
  'My keyboard is not working',
  'My screen is flickering'
];
const localSupportFallback = message => {
  const normalized = String(message).toLowerCase();
  if (normalized.includes('charg')) return 'Here are safe steps for a device that is not charging:\n\nInspect the cable, adapter, and outlet for visible damage or loose connections. Try a known-good Apple or certified accessory and a different outlet. Allow a very low battery to charge undisturbed for several minutes, then restart the device if it is responsive.\n\nDoes the charging indicator appear, and have you tried another known-good cable, adapter, and outlet?';
  if (normalized.includes('battery')) return 'Here are safe steps for fast battery drain:\n\nCheck Battery usage for unusually high-use apps. Turn on Low Power Mode when immediate runtime is needed, install available compatible software updates, and restart the device after saving work.\n\nDid the drain begin after installing an app or update?';
  return 'I could not reach the AI service, but I can still help. Please describe the device, what changed, and any visible warning or damage.';
};

export function AICustomerSupportPanel({ ticket, device, open = false, onClose }) {
  const navigate = useNavigate();
  const [messages, setMessages] = useState([{ role: 'assistant', content: defaultMessage }]);
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

  const loadSession = async () => {
    if (!ticket?._id) {
      setMessages([{ role: 'assistant', content: defaultMessage }]);
      setConversationId(null);
      setRequestData(null);
      return;
    }

    try {
      const result = await getTicketAITroubleshooting(ticket._id);
      const session = result?.session;
      if (session?.messages?.length) {
        const visibleMessages = session.messages
          .filter(message => !(message.role === 'assistant' && /AI (Support|troubleshooting) is (temporarily )?unavailable/i.test(message.content)))
          .map(message => ({ role: message.role, content: message.content }));
        setMessages(visibleMessages.length ? visibleMessages : [{ role: 'assistant', content: defaultMessage }]);
        setConversationId(session.sessionId || session._id || null);
      } else {
        setMessages([{ role: 'assistant', content: defaultMessage }]);
        setConversationId(null);
      }
    } catch {
      setMessages([{ role: 'assistant', content: defaultMessage }]);
      setConversationId(null);
    }
  };

  useEffect(() => {
    if (!open) return;
    if (ticket?._id) {
      void loadSession();
      return;
    }
    setMessages([{ role: 'assistant', content: defaultMessage }]);
    setConversationId(null);
    setRequestData(null);
  }, [open, ticket?._id]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = event => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, loading]);

  const sendMessage = async (nextMessage, { appendUser = true } = {}) => {
    const value = String(nextMessage || draft).trim();
    if (!value || loading) return;

    const userMessage = { role: 'user', content: value };
    if (appendUser) setMessages(current => [...current, userMessage]);
    setDraft('');
    setLoading(true);
    setError('');
    setFailedMessage('');

    try {
      const result = await sendAiSupportMessage(ticket?._id || null, {
        message: value,
        conversationId,
        deviceId: device?._id || null,
        // Preserves the recent non-ticket conversation through the backend.
        conversation: messages
      });
      let response = result?.reply || result?.message;
      if (!response || /AI Support is temporarily unavailable|AI support is currently unavailable/i.test(response)) {
        response = localSupportFallback(value);
      }
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
    if (speakingIndex === index) {
      window.speechSynthesis.cancel();
      setSpeakingIndex(null);
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(content);
    utterance.lang = navigator.language || 'en-IN';
    utterance.onend = () => setSpeakingIndex(null);
    utterance.onerror = () => setSpeakingIndex(null);
    setSpeakingIndex(index);
    window.speechSynthesis.speak(utterance);
  };

  const toggleVoiceCapture = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError('Voice input is not supported in this browser.');
      return;
    }

    if (voiceActive && recognitionRef.current) {
      recognitionRef.current.stop();
      setVoiceActive(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = navigator.language || 'en-IN';
    recognition.continuous = false;
    recognition.interimResults = false;
    let finalTranscript = '';

    recognition.onstart = () => setVoiceActive(true);
    recognition.onresult = event => {
      const transcript = Array.from(event.results).map(result => result[0]?.transcript || '').join(' ').trim();
      finalTranscript = transcript;
      if (transcript) {
        setDraft(transcript);
      }
    };
    recognition.onend = () => {
      setVoiceActive(false);
      if (finalTranscript.trim()) setDraft(finalTranscript.trim());
    };
    recognition.onerror = () => {
      setVoiceActive(false);
      setError('Voice capture was interrupted. Please try again.');
    };
    recognitionRef.current = recognition;
    recognition.start();
  };

  const handleComposerKeyDown = event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };

  useEffect(() => {
    setVoiceSupported(Boolean(window.SpeechRecognition || window.webkitSpeechRecognition));
    return () => {
      recognitionRef.current?.stop();
      window.speechSynthesis?.cancel();
    };
  }, []);

  const suggestionList = useMemo(() => welcomeSuggestions, []);

  if (!open) return null;

  return <ModalLayer className="ai-chat-backdrop">
    <aside className="ai-chat-drawer" role="dialog" aria-modal="true" aria-label="AI Support chatbot panel">
      <div className="ai-chat-header">
        <div className="ai-chat-title">
          <div className="ai-icon"><Sparkles size={16} /></div>
          <div>
            <strong>AI Support</strong>
            <small>L1 Device Assistance</small>
          </div>
        </div>
        <div className="ai-header-actions">
          <span className="presence-dot" aria-label="AI Support" />
          <button type="button" className="icon-btn" aria-label="New conversation" onClick={() => { setMessages([{ role: 'assistant', content: defaultMessage }]); setConversationId(null); setRequestData(null); setError(''); setFailedMessage(''); }}><RefreshCcw size={14} /></button>
          {onClose && <button type="button" className="icon-btn" aria-label="Close AI panel" onClick={onClose}><X size={14} /></button>}
        </div>
      </div>

      <div className="ai-context-box">
        {ticket ? <>
          <p><strong>Device:</strong> {ticket.deviceId?.model || 'Unknown device'} · {ticket.deviceId?.serialNumber || 'Unknown serial'}</p>
          <p><strong>Issue:</strong> {ticket.issueType || 'General support'}</p>
          <p><strong>Ticket:</strong> {ticket.ticketId}</p>
        </> : device ? <p><strong>Device:</strong> {device.model || 'Device'} · {device.serialNumber || 'Verified device'}</p> : <p><strong>Context:</strong> General support conversation</p>}
      </div>

      <div className="ai-chat-body" ref={listRef}>
        {messages.map((message, index) => <div key={`${message.role}-${index}`} className={`ai-message ${message.role}`}>
          {message.role === 'assistant' && <div className="message-icon"><Bot size={14} /></div>}
          <div className="message-text-wrap">
            <div className="message-text">{message.content.split('\n').map((line, lineIndex) => <span key={`${line}-${lineIndex}`}>{line}{lineIndex < message.content.split('\n').length - 1 && <br />}</span>)}</div>
            {message.role === 'assistant' && voiceSupported && 'speechSynthesis' in window && <button type="button" className={`ai-listen-button ${speakingIndex === index ? 'active' : ''}`} aria-label="Listen to AI response" onClick={() => speakMessage(message.content, index)}><Volume2 size={12} /></button>}
          </div>
        </div>)}

        {loading && <div className="ai-message assistant typing"><div className="message-icon"><Bot size={14} /></div><div className="message-text"><span className="typing-dots"><i /><i /><i /></span></div></div>}

        {!messages.some(item => item.role === 'user') && !loading && <>
          <p className="ai-language-tip">Ask in any language — I'll reply in the same language.</p>
          <div className="ai-suggestions"><p>Try asking:</p>
            {suggestionList.map(item => <button key={item} type="button" className="suggestion-pill" onClick={() => void sendMessage(item)}>{item}</button>)}
          </div>
        </>}

        {error && <div className="ai-alert" role="alert"><ShieldAlert size={15} /><span>{error}</span>{failedMessage && <button type="button" onClick={() => void sendMessage(failedMessage, { appendUser: false })} disabled={loading}>Try Again</button>}</div>}
        {requestData && <div className="ai-review-request"><strong>Request draft ready</strong><span>{requestData.deviceName} · {requestData.issueType}</span><button type="button" className="button primary" onClick={() => { onClose?.(); navigate(`/request?source=ai&conversationId=${encodeURIComponent(conversationId || '')}`, { state: { aiRequest: requestData } }); }}>Review Request</button></div>}
      </div>

      <div className="ai-chat-form">
        <textarea value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder="Describe your issue..." aria-label="Describe your issue" rows={1} />
        {voiceSupported && <button type="button" className={`voice-button ${voiceActive ? 'active' : ''}`} aria-label={voiceActive ? 'Stop voice input' : 'Start voice input'} aria-pressed={voiceActive} onClick={toggleVoiceCapture}><Mic size={17} /><span>{voiceActive ? 'Stop' : 'Voice'}</span></button>}
        <button type="button" className="button primary ai-send-button" disabled={!draft.trim() || loading} onClick={() => void sendMessage()}><SendHorizonal size={15} />Send</button>
      </div>
    </aside>
  </ModalLayer>;
}
