import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProviderError, getGeminiReply } from './geminiProvider.js';

const environment = { GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-2.5-flash', GEMINI_TIMEOUT_MS: '1000' };

test('Gemini provider keeps system messages server-side and normalizes text', async () => {
  let received;
  const client = { models: { generateContent: async request => { received = request; return { text: '  Safe troubleshooting step.  ' }; } } };
  const reply = await getGeminiReply({ environment, client, messages: [{ role: 'system', content: 'System policy' }, { role: 'user', content: 'My phone is not charging' }] });
  assert.equal(reply, 'Safe troubleshooting step.');
  assert.equal(received.config.systemInstruction, 'System policy');
  assert.deepEqual(received.contents, [{ role: 'user', parts: [{ text: 'My phone is not charging' }] }]);
});

test('Gemini provider rejects a missing server-side API key', async () => {
  await assert.rejects(() => getGeminiReply({ environment: {}, messages: [{ role: 'user', content: 'Help' }] }), error => error instanceof GeminiProviderError && error.code === 'GEMINI_API_KEY_NOT_CONFIGURED');
});

test('Gemini provider enables JSON mode only for structured application data', async () => {
  let received;
  const client = { models: { generateContent: async request => { received = request; return { text: '{"intent":"create_service_request"}' }; } } };
  await getGeminiReply({ environment, client, structuredOutput: true, messages: [{ role: 'user', content: 'Please arrange service' }] });
  assert.equal(received.config.responseMimeType, 'application/json');
});
