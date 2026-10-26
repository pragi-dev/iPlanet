import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceSearch, speechLanguage, spokenToQuery, voiceErrorMessage, voiceSupport } from './voiceSearch.js';
import { matches, searchTerms } from './commandSearch.js';

// Stand-in for window.SpeechRecognition. Tests drive the events by hand.
class MockRecognition {
  static instances = [];
  static failStart = false;
  constructor() { MockRecognition.instances.push(this); this.started = false; this.stopped = false; this.aborted = false; }
  start() { if (MockRecognition.failStart) throw new Error('InvalidStateError'); this.started = true; }
  stop() { this.stopped = true; this.onend?.(); }
  abort() { this.aborted = true; this.onerror?.({ error: 'aborted' }); this.onend?.(); }
  say(text, isFinal = true) { this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] }); }
  fail(error) { this.onerror?.({ error }); this.onend?.(); }
}

function setup(options = {}) {
  const states = [];
  const queries = [];
  const voice = createVoiceSearch({ Recognition: MockRecognition, lang: 'en-IN', onChange: state => states.push(state), onQuery: (query, transcript) => queries.push({ query, transcript }), ...options });
  return { voice, states, queries, last: () => states[states.length - 1] };
}

// Shaped like the index entries the portals build in loadCommandIndex().
const corporateIndex = [
  { id: 'd-1', group: 'Devices', title: 'iPhone 15 Pro', subtitle: 'C02ZK3C1ABCE · Chennai', keywords: 'AST-1001 Finance Phone' },
  { id: 'd-2', group: 'Devices', title: 'MacBook Air M2', subtitle: 'FVFXK2ABQ6L4 · Bengaluru', keywords: 'AST-1002 Design Laptop' },
  { id: 't-1', group: 'Service requests', title: 'TKT-2026-0042', subtitle: 'Battery · iPhone 15 Pro · Open', keywords: 'C02ZK3C1ABCE Chennai' },
  { id: 't-2', group: 'Service requests', title: 'TKT-2026-0043', subtitle: 'Display · MacBook Air M2 · Resolved', keywords: 'FVFXK2ABQ6L4' },
  { id: 'a-coverage', title: 'Check coverage', keywords: 'warranty amc expiry expiring expired' },
  { id: 'a-track', title: 'Track service requests', keywords: 'status tickets progress open' },
];
const b2cIndex = [
  { id: 'b2c-1', group: 'Escalations', title: 'B2C-2026-000022', subtitle: 'Screen replacement · Repair · New', keywords: 'Asha asha@example.com DNPX12345678' },
];
const search = (index, query) => index.filter(entry => matches(entry, searchTerms(query))).map(entry => entry.id);

beforeEach(() => { MockRecognition.instances = []; MockRecognition.failStart = false; });

test('permission granted: the microphone is requested only on start, and the recognised text becomes the query', () => {
  const { voice, queries, last } = setup();
  assert.equal(MockRecognition.instances.length, 0, 'nothing listens before the user clicks the microphone');
  voice.start();
  const session = MockRecognition.instances[0];
  assert.equal(session.started, true);
  assert.equal(session.lang, 'en-IN');
  assert.equal(session.continuous, false, 'single utterance, no background listening');
  assert.equal(last().status, 'listening');
  session.say('Find iPhone', false);
  assert.equal(last().interim, 'Find iPhone');
  session.say('Find iPhone 15 Pro.');
  assert.equal(session.stopped, true, 'recording stops once a final result arrives');
  assert.equal(last().status, 'done');
  assert.equal(last().transcript, 'Find iPhone 15 Pro.');
  assert.deepEqual(queries, [{ query: 'iPhone 15 Pro', transcript: 'Find iPhone 15 Pro.' }]);
});

test('permission denied: a friendly error and no query', () => {
  const { voice, queries, last } = setup();
  voice.start();
  MockRecognition.instances[0].fail('not-allowed');
  assert.equal(last().status, 'error');
  assert.equal(last().error.code, 'not-allowed');
  assert.match(last().error.message, /Microphone access is blocked/);
  assert.deepEqual(queries, []);
});

test('other recognition failures map to readable messages', () => {
  for (const [code, pattern] of [['audio-capture', /No microphone/], ['network', /speech service/], ['service-not-allowed', /doesn’t allow/], ['language-not-supported', /language/], ['something-new', /stopped unexpectedly/]]) {
    const { voice, last } = setup();
    voice.start();
    MockRecognition.instances.at(-1).fail(code);
    assert.match(last().error.message, pattern, code);
  }
});

test('unsupported or insecure browsers are reported without throwing', () => {
  assert.deepEqual(voiceSupport({}), { supported: false, reason: 'unsupported' });
  assert.deepEqual(voiceSupport(undefined), { supported: false, reason: 'unsupported' });
  assert.deepEqual(voiceSupport({ webkitSpeechRecognition: MockRecognition, isSecureContext: false }), { supported: false, reason: 'insecure' });
  assert.deepEqual(voiceSupport({ webkitSpeechRecognition: MockRecognition, isSecureContext: true }), { supported: true, reason: null });
  assert.deepEqual(voiceSupport({ SpeechRecognition: MockRecognition, isSecureContext: true }), { supported: true, reason: null });
  const { voice, last } = setup({ Recognition: null });
  assert.doesNotThrow(() => voice.start());
  assert.equal(last().error.code, 'unsupported');
  assert.match(voiceErrorMessage('unsupported'), /Type your search/);
});

test('a start() that the browser rejects ends in an error state', () => {
  MockRecognition.failStart = true;
  const { voice, last } = setup();
  voice.start();
  assert.equal(last().status, 'error');
  MockRecognition.failStart = false;
  voice.start();
  assert.equal(last().status, 'listening', 'the user can try again');
});

test('cancel aborts the session, discards the speech and shows no error', () => {
  const { voice, queries, last } = setup();
  voice.start();
  const session = MockRecognition.instances[0];
  session.say('find ticket', false);
  voice.cancel();
  assert.equal(session.aborted, true);
  assert.equal(last().status, 'idle');
  assert.equal(last().error, null);
  assert.deepEqual(queries, []);
  session.say('late result arriving after cancel');
  assert.deepEqual(queries, [], 'events from a cancelled session are ignored');
});

test('stop keeps what has been said so far', () => {
  const { voice, last } = setup();
  voice.start();
  const session = MockRecognition.instances[0];
  session.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'MacBook Air' }], { isFinal: true })] });
  assert.equal(last().query, 'MacBook Air');
  voice.stop();
  assert.equal(MockRecognition.instances.length, 1);
});

test('only one recognition session runs at a time', () => {
  const { voice } = setup();
  voice.start();
  voice.start();
  assert.equal(MockRecognition.instances.length, 1);
});

test('empty or unclear speech asks the user to try again', () => {
  {
    const { voice, queries, last } = setup();
    voice.start();
    MockRecognition.instances[0].onend();
    assert.equal(last().error.code, 'no-speech');
    assert.deepEqual(queries, []);
  }
  {
    const { voice, queries, last } = setup();
    voice.start();
    MockRecognition.instances.at(-1).say('show me the');
    assert.equal(last().error.code, 'no-match');
    assert.deepEqual(queries, []);
  }
  {
    const { voice, last } = setup();
    voice.start();
    MockRecognition.instances.at(-1).fail('no-speech');
    assert.match(last().error.message, /didn’t hear anything/);
  }
  assert.equal(spokenToQuery(''), '');
  assert.equal(spokenToQuery(' ... '), '');
});

test('spoken phrasing reduces to the keywords the search can use', () => {
  assert.equal(spokenToQuery('Find iPhone 15 Pro.'), 'iPhone 15 Pro');
  assert.equal(spokenToQuery('Search serial number C02ZK3C1ABCE.'), 'C02ZK3C1ABCE');
  assert.equal(spokenToQuery('search serial number c 0 2 z k 3 c 1 a b c e'), 'C02ZK3C1ABCE');
  assert.equal(spokenToQuery('Find ticket B2C-2026-000022.'), 'B2C-2026-000022');
  assert.equal(spokenToQuery('find ticket b2c dash 2026 dash 000022'), 'B2C-2026-000022');
  assert.equal(spokenToQuery('Show my open service requests'), 'open');
  assert.equal(spokenToQuery('Show devices with expiring warranty'), 'expiring warranty');
  assert.equal(spokenToQuery('show my tickets'), 'tickets', 'falls back when only record words remain');
  assert.equal(spokenToQuery('Engineer Ravi'), 'Engineer Ravi');
});

test('device serial-number search finds the device and its service request', () => {
  assert.deepEqual(search(corporateIndex, spokenToQuery('Search serial number C02ZK3C1ABCE.')), ['d-1', 't-1']);
  assert.deepEqual(search(corporateIndex, spokenToQuery('search serial C02 ZK3 C1 ABCE')), ['d-1', 't-1'], 'split recognition still matches');
});

test('ticket-number search finds the ticket', () => {
  assert.deepEqual(search(b2cIndex, spokenToQuery('Find ticket B2C-2026-000022.')), ['b2c-1']);
  assert.deepEqual(search(corporateIndex, spokenToQuery('find ticket TKT 2026 0042')), ['t-1']);
});

test('the sample phrases land on existing records or navigation actions', () => {
  assert.deepEqual(search(corporateIndex, spokenToQuery('Find iPhone 15 Pro.')), ['d-1', 't-1']);
  assert.deepEqual(search(corporateIndex, spokenToQuery('Show my open service requests')), ['t-1', 'a-track']);
  assert.deepEqual(search(corporateIndex, spokenToQuery('Show devices with expiring warranty')), ['a-coverage']);
});

test('no results when nothing matches', () => {
  assert.deepEqual(search(corporateIndex, spokenToQuery('Find iPad Air')), []);
});

test('B2B/B2C separation: voice only searches the index the signed-in portal loaded', () => {
  // A B2C reference spoken in the corporate portal finds nothing, because the
  // corporate index is built from /api/tickets and /api/devices (company-scoped
  // on the server) and never contains B2C escalations, and vice versa.
  assert.deepEqual(search(corporateIndex, spokenToQuery('Find ticket B2C-2026-000022')), []);
  assert.deepEqual(search(b2cIndex, spokenToQuery('Search serial number C02ZK3C1ABCE')), []);
  // Voice input itself never calls the network.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('voice search must not make requests'); };
  try {
    const { voice } = setup();
    voice.start();
    MockRecognition.instances[0].say('Search serial number C02ZK3C1ABCE');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('typed search behaves as before', () => {
  assert.deepEqual(search(corporateIndex, 'c02zk'), ['d-1', 't-1']);
  assert.deepEqual(search(corporateIndex, 'macbook resolved'), ['t-2']);
  assert.equal(search(corporateIndex, '').length, corporateIndex.length);
});

test('recognition language: configured value, then the browser language, then en-US', () => {
  assert.equal(speechLanguage('hi-IN', { navigator: { language: 'en-GB' } }), 'hi-IN');
  assert.equal(speechLanguage('', { navigator: { language: 'en-GB' } }), 'en-GB');
  assert.equal(speechLanguage(undefined, undefined), 'en-US');
});
