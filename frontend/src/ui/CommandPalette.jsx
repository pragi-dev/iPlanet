import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CornerDownLeft, LoaderCircle, Mic, RefreshCcw, Search, Square } from 'lucide-react';
import { ModalLayer } from './overlay';
import { friendlyError } from './format';
import { matches, searchTerms } from './commandSearch';
import { createVoiceSearch, getSpeechRecognition, speechLanguage, voiceErrorMessage, voiceSupport } from './voiceSearch';

const SPEECH_LANG = speechLanguage(import.meta.env.VITE_SPEECH_RECOGNITION_LANG);

const MAX_PER_GROUP = 5;

// One recognition session at a time, owned by the open palette and abandoned
// when it closes. The microphone is only requested when start() is called.
function useVoiceSearch(onQuery) {
  const support = useMemo(() => voiceSupport(), []);
  const [voice, setVoice] = useState({ status: 'idle', interim: '', transcript: '', query: '', error: null });
  const onQueryRef = useRef(onQuery);
  onQueryRef.current = onQuery;
  const controllerRef = useRef(null);
  if (!controllerRef.current) {
    controllerRef.current = createVoiceSearch({
      Recognition: support.supported ? getSpeechRecognition() : null,
      lang: SPEECH_LANG,
      onChange: setVoice,
      onQuery: (query, transcript) => onQueryRef.current(query, transcript),
    });
  }
  const controller = controllerRef.current;
  useEffect(() => () => controller.cancel(), [controller]);
  return { support, voice, controller };
}

function VoiceStatus({ support, voice, query, onCancel, onRetry }) {
  if (voice.status === 'listening') return <div className="voice-status voice-status-live">
    <span className="voice-pulse" aria-hidden="true" />
    <span className="voice-status-text">{voice.interim ? <>Listening… <q>{voice.interim}</q></> : 'Listening… say a ticket ID, serial number, model or name.'}</span>
    <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
  </div>;
  if (voice.status === 'processing') return <div className="voice-status">
    <LoaderCircle size={16} aria-hidden="true" className="voice-spinner" />
    <span className="voice-status-text">Interpreting{voice.interim ? <> <q>{voice.interim}</q></> : '…'}</span>
    <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
  </div>;
  if (voice.status === 'error') {
    const retryable = support.supported && voice.error?.code !== 'service-not-allowed' && voice.error?.code !== 'language-not-supported';
    return <div className="voice-status voice-status-error" role="alert">
      <span className="voice-status-text">{voice.error?.message}</span>
      {retryable && <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}><Mic size={14} aria-hidden="true" />Try again</button>}
    </div>;
  }
  if (voice.status === 'done' && query === voice.query) return <div className="voice-status">
    <Mic size={16} aria-hidden="true" className="voice-heard-icon" />
    <span className="voice-status-text">Heard <q>{voice.transcript}</q>{voice.query !== voice.transcript && <> · searching for <q>{voice.query}</q></>}. Edit the search if it isn’t right.</span>
  </div>;
  return null;
}

// Global search across the records the current role can already load
// (tickets, devices, engineers, corporates, employees) plus navigation
// actions. Results come only from those API responses. Voice input only fills
// the query; choosing a result still takes an explicit click or Enter.
export function CommandPalette({ onClose, index, actions, onRunAction, startWithVoice = false }) {
  const navigate = useNavigate();
  const inputId = useId();
  const listId = useId();
  const listRef = useRef(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const { support, voice, controller } = useVoiceSearch(spoken => { setQuery(spoken); inputRef.current?.focus({ preventScroll: true }); });
  const [unsupportedNotice, setUnsupportedNotice] = useState(false);
  useEffect(() => { if (startWithVoice && support.supported) controller.start(); }, [startWithVoice, support.supported, controller]);
  const voiceActive = voice.status === 'listening' || voice.status === 'processing';
  const onMic = () => {
    if (!support.supported) { setUnsupportedNotice(true); return; }
    if (voiceActive) controller.stop();
    else controller.start();
  };
  const onType = event => {
    if (voiceActive) controller.cancel();
    setQuery(event.target.value);
  };
  const terms = searchTerms(query);

  const groups = useMemo(() => {
    const result = [];
    const actionHits = actions.filter(action => matches(action, terms));
    if (actionHits.length) result.push({ label: 'Actions', items: actionHits.slice(0, terms.length ? MAX_PER_GROUP : actions.length) });
    if (terms.length && index.data) {
      const byGroup = new Map();
      index.data.forEach(entry => {
        if (!matches(entry, terms)) return;
        const list = byGroup.get(entry.group) || [];
        if (list.length < MAX_PER_GROUP) list.push(entry);
        byGroup.set(entry.group, list);
      });
      byGroup.forEach((items, label) => result.push({ label, items }));
    }
    return result;
  }, [actions, index.data, terms.join(' ')]); // eslint-disable-line react-hooks/exhaustive-deps

  const flat = groups.flatMap(group => group.items);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const run = entry => {
    if (!entry) return;
    onClose();
    if (entry.run) onRunAction(entry);
    else if (entry.to) navigate(entry.to);
  };
  const onKeyDown = event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(current => Math.min(flat.length - 1, current + 1)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive(current => Math.max(0, current - 1)); }
    if (event.key === 'Enter') { event.preventDefault(); run(flat[active]); }
  };

  let position = -1;
  const activeId = flat[active] ? `${listId}-${active}` : undefined;
  return <ModalLayer className="overlay overlay-command" onDismiss={onClose} label="Search">
    <div className="command" role="dialog" aria-modal="true" aria-label="Search and actions">
      <div className="command-input">
        <Search size={18} aria-hidden="true" />
        <label htmlFor={inputId} className="sr-only">Search tickets, devices, people and actions</label>
        <input ref={inputRef} id={inputId} data-autofocus type="text" role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeId} aria-autocomplete="list" autoComplete="off" spellCheck="false"
          placeholder="Search tickets, devices, people or actions…" value={query} onChange={onType} onKeyDown={onKeyDown} />
        <button type="button" className={`voice-button${voiceActive ? ' voice-button-active' : ''}`} onClick={onMic}
          aria-disabled={!support.supported || undefined} aria-pressed={voiceActive}
          aria-label={!support.supported ? 'Voice search unavailable' : voiceActive ? 'Stop listening' : 'Search by voice'}
          title={!support.supported ? voiceErrorMessage(support.reason) : voiceActive ? 'Stop listening' : 'Search by voice'}>
          {voiceActive ? <Square size={14} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
        </button>
        <kbd className="kbd">Esc</kbd>
      </div>
      <div className="voice-status-region" aria-live="polite">
        {!support.supported && unsupportedNotice
          ? <div className="voice-status voice-status-error" role="alert"><span className="voice-status-text">{voiceErrorMessage(support.reason)}</span></div>
          : <VoiceStatus support={support} voice={voice} query={query} onCancel={controller.cancel} onRetry={controller.start} />}
      </div>
      <div className="command-results" ref={listRef} id={listId} role="listbox" aria-label="Results">
        {groups.map(group => <div className="command-group" key={group.label} role="group" aria-label={group.label}>
          <p className="command-group-label" aria-hidden="true">{group.label}</p>
          {group.items.map(entry => {
            position += 1;
            const current = position;
            const Icon = entry.icon;
            return <button type="button" key={entry.id} id={`${listId}-${current}`} role="option" aria-selected={current === active} data-active={current === active} tabIndex={-1}
              className="command-item" onMouseMove={() => setActive(current)} onClick={() => run(entry)}>
              {Icon && <span className="command-item-icon" aria-hidden="true"><Icon size={16} /></span>}
              <span className="command-item-text"><span className={entry.mono ? 'mono' : undefined}>{entry.title}</span>{entry.subtitle && <small>{entry.subtitle}</small>}</span>
              {current === active && <CornerDownLeft size={14} aria-hidden="true" className="command-item-enter" />}
            </button>;
          })}
        </div>)}
        {terms.length > 0 && index.loading && !index.data && <p className="command-status" role="status">Loading records…</p>}
        {terms.length > 0 && index.error && !index.data && <div className="command-status" role="alert">
          <span>{friendlyError(index.error, 'Search is unavailable right now.')}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={index.reload}><RefreshCcw size={14} aria-hidden="true" />Retry</button>
        </div>}
        {terms.length > 0 && index.data && !flat.length && <p className="command-status" role="status">No results for “{query.trim()}”. Try a ticket ID, serial number, model or name.</p>}
      </div>
      <footer className="command-footer" aria-hidden="true"><span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> to navigate</span><span><kbd className="kbd">Enter</kbd> to open</span></footer>
    </div>
  </ModalLayer>;
}
