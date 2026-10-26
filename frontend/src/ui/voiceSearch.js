// Voice input for the command bar. Speech is turned into an ordinary text query
// and handed to the existing search; nothing here runs an action, calls the API
// or keeps audio. Recognition is done by the browser's Web Speech API (Chrome and
// Edge send the audio to their own speech service; this app's backend never sees it).
// Kept free of React so it can be tested under `node --test`.

export const DEFAULT_SPEECH_LANG = 'en-US';

export function getSpeechRecognition(win = globalThis.window) {
  if (!win) return null;
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

// Browsers only grant the microphone on secure origins (https or localhost).
export function voiceSupport(win = globalThis.window) {
  if (!getSpeechRecognition(win)) return { supported: false, reason: 'unsupported' };
  if (win.isSecureContext === false) return { supported: false, reason: 'insecure' };
  return { supported: true, reason: null };
}

export function speechLanguage(configured, win = globalThis.window) {
  return String(configured || '').trim() || win?.navigator?.language || DEFAULT_SPEECH_LANG;
}

const MESSAGES = {
  unsupported: 'Voice search isn’t supported in this browser. Type your search instead.',
  insecure: 'Voice search needs a secure (https) connection. Type your search instead.',
  'not-allowed': 'Microphone access is blocked. Allow the microphone for this site in your browser settings, or type your search.',
  'service-not-allowed': 'This browser doesn’t allow voice recognition here. Type your search instead.',
  'audio-capture': 'No microphone was found. Check that one is connected, or type your search.',
  'no-speech': 'We didn’t hear anything. Try again, or type your search.',
  'no-match': 'We couldn’t make out a search. Try again, saying the ticket ID, serial number or model clearly.',
  network: 'Voice recognition couldn’t reach the browser’s speech service. Check your connection, or type your search.',
  'language-not-supported': 'Voice search isn’t available for the configured language. Type your search instead.',
};

export function voiceErrorMessage(code) {
  return MESSAGES[code] || 'Voice search stopped unexpectedly. Type your search instead.';
}

// The command bar requires every term to appear in a record, so spoken phrasing
// ("show my …", "ticket number …") has to be reduced to the identifying words.
// This is keyword clean-up only — it does not add filters the search can't apply.
const LEADING_COMMAND = /^(?:(?:please|can you|could you)\s+)?(?:search\s+for|search|find\s+me|find|show\s+me|show|look\s+up|look\s+for|go\s+to|get)\s+/i;
const FILLER = new Set(['my', 'me', 'our', 'the', 'a', 'an', 'all', 'any', 'for', 'with', 'of', 'please', 'that', 'which', 'have', 'has', 'is', 'are']);
const RECORD_PHRASES = /\b(?:serial\s+numbers?|serial\s+no|serial|s\/n|ticket\s+(?:numbers?|ids?)|tickets?|service\s+requests?|requests?|reference|ref|numbers?|devices?|ids?)\b/gi;

function cleanUp(text) {
  return text
    .replace(/\s+(?:dash|hyphen)\s+/gi, '-')
    .replace(/[“”"'‘’?!,;:]/g, ' ')
    .replace(/\.+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Spelled-out identifiers ("c 0 2 z k") become one token ("c02zk").
function joinSpelled(tokens) {
  const out = [];
  let run = '';
  const flush = () => { if (run) out.push(run); run = ''; };
  tokens.forEach(token => {
    if (/^[a-z0-9]$/i.test(token)) { run += token; return; }
    flush();
    out.push(token);
  });
  flush();
  return out;
}

const display = token => (/[a-z]/i.test(token) && /\d/.test(token) ? token.toUpperCase() : token);

function reduce(text, stripRecordWords) {
  let working = text.replace(LEADING_COMMAND, '');
  if (stripRecordWords) working = working.replace(RECORD_PHRASES, ' ');
  // Join spelled letters first so an "a" inside a serial isn't dropped as filler.
  return joinSpelled(working.split(' ').filter(Boolean)).filter(token => !FILLER.has(token.toLowerCase())).map(display).join(' ');
}

// Falls back to a gentler reduction when the strict one leaves nothing
// ("show my tickets" → "tickets", which still matches the ticket-queue action).
// Returns '' when nothing searchable was said ("show me the").
export function spokenToQuery(transcript) {
  const cleaned = cleanUp(String(transcript || ''));
  if (!cleaned) return '';
  return reduce(cleaned, true) || reduce(cleaned, false);
}

// One recognition session per start(): single utterance, no continuous listening.
// `onChange` receives { status, interim, transcript, query, error } where status is
// idle | listening | processing | done | error.
export function createVoiceSearch({ Recognition, lang = DEFAULT_SPEECH_LANG, onChange = () => {}, onQuery = () => {} }) {
  let recognition = null;
  const cancelled = new WeakSet();
  let state = { status: 'idle', interim: '', transcript: '', query: '', error: null };
  const set = patch => { state = { ...state, ...patch }; onChange(state); };
  const fail = code => set({ status: 'error', interim: '', error: { code, message: voiceErrorMessage(code) } });

  function start() {
    if (recognition) return;
    if (!Recognition) { fail('unsupported'); return; }
    const session = new Recognition();
    recognition = session;
    let finalText = '';
    let errored = false;
    session.lang = lang;
    session.continuous = false;
    session.interimResults = true;
    session.maxAlternatives = 1;

    session.onresult = event => {
      let interim = '';
      for (let i = event.resultIndex || 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript || '';
        if (result.isFinal) finalText += text;
        else interim += text;
      }
      if (finalText) { set({ status: 'processing', interim: finalText }); session.stop(); }
      else set({ interim });
    };
    session.onspeechend = () => { if (state.status === 'listening') set({ status: 'processing' }); };
    session.onerror = event => {
      if (cancelled.has(session)) return;
      errored = true;
      fail(event?.error || 'unknown');
    };
    session.onend = () => {
      if (recognition === session) recognition = null;
      if (cancelled.has(session) || errored) return;
      const query = spokenToQuery(finalText);
      if (!query) { fail(finalText.trim() ? 'no-match' : 'no-speech'); return; }
      set({ status: 'done', interim: '', transcript: finalText.trim(), query, error: null });
      onQuery(query, finalText.trim());
    };
    set({ status: 'listening', interim: '', transcript: '', query: '', error: null });
    try {
      session.start();
    } catch {
      recognition = null;
      fail('unknown');
    }
  }

  // Stop listening but keep what was said so far.
  function stop() {
    recognition?.stop();
  }

  // Discard the session entirely (closing the search, typing over it).
  function cancel() {
    const session = recognition;
    recognition = null;
    if (session) { cancelled.add(session); session.abort(); }
    if (state.status !== 'idle') set({ status: 'idle', interim: '', error: null });
  }

  return { start, stop, cancel, getState: () => state };
}
