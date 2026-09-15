import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSupportContext } from './contextBuilder.js';
import { getAiSupportReply } from './aiEngine.js';
import { AI_SUPPORT_SYSTEM_PROMPT, buildSupportMessages } from './aiPrompt.js';
import { retrieveRelevantKnowledge } from './knowledgeRetriever.js';
import { getGeminiReply } from './providers/geminiProvider.js';

test('buildSupportContext adds relevant retrieved troubleshooting knowledge', () => {
  const context = buildSupportContext({ message: 'My iPhone is hot and battery draining quickly' });
  assert.deepEqual(context.retrievedKnowledge.map(item => item.id).sort(), ['battery-drain', 'device-overheating']);
});

test('local retriever identifies the five approved troubleshooting topics', () => {
  const cases = [
    ['My iPhone battery is draining very fast', 'battery-drain'],
    ['My iPhone gets very hot while using it', 'device-overheating'],
    ["My iPhone isn't charging", 'charging-problem'],
    ['Wi-Fi keeps disconnecting', 'wifi-connectivity'],
    ['My Mac is extremely slow', 'device-performance']
  ];
  for (const [message, expectedId] of cases) {
    assert.equal(retrieveRelevantKnowledge(message).results[0]?.id, expectedId, message);
  }
});

test('retriever returns no invented knowledge for physical damage or unrelated questions', () => {
  assert.deepEqual(retrieveRelevantKnowledge('My screen is physically cracked').results, []);
  assert.deepEqual(retrieveRelevantKnowledge('What is the capital of France?').results, []);
  const crackedScreenPrompt = buildSupportMessages({ message: 'My screen is physically cracked', context: buildSupportContext({ message: 'My screen is physically cracked' }) });
  assert.match(crackedScreenPrompt[0].content, /Do not instruct users to open, dismantle, modify, or attempt hardware repair/);
  assert.match(crackedScreenPrompt[0].content, /recommend the service team/);
});

test('prompt separates system instructions, trusted knowledge, portal context, and user message', () => {
  const messages = buildSupportMessages({ message: 'My battery drains quickly', context: buildSupportContext({ message: 'My battery drains quickly', conversation: [{ role: 'user', content: 'It started today.' }] }) });
  assert.equal(messages[0].content, AI_SUPPORT_SYSTEM_PROMPT);
  assert.match(messages[1].content, /Trusted iPlanetCare troubleshooting knowledge/);
  assert.match(messages[2].content, /Portal context supplied/);
  assert.deepEqual(messages.at(-1), { role: 'user', content: 'My battery drains quickly' });
});

test('Gemini provider keeps the system instructions server-side and returns the generated reply', async () => {
  const reply = await getGeminiReply({
    messages: [
      { role: 'system', content: AI_SUPPORT_SYSTEM_PROMPT },
      { role: 'user', content: 'My iPhone is not charging' }
    ],
    environment: { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-2.5-flash', GEMINI_TIMEOUT_MS: '1000' },
    client: {
      models: {
        generateContent: async ({ model, contents, config }) => {
          assert.equal(model, 'gemini-2.5-flash');
          assert.equal(config.systemInstruction, AI_SUPPORT_SYSTEM_PROMPT);
          assert.equal(contents[0].parts[0].text, 'My iPhone is not charging');
          return { text: 'Check the charging cable and port.' };
        }
      }
    }
  });
  assert.equal(reply, 'Check the charging cable and port.');
});

test('AI engine reports a missing Gemini key configuration error', async () => {
  await assert.rejects(
    () => getAiSupportReply({ message: 'Help', context: {}, environment: { AI_PROVIDER: 'gemini' } }),
    error => error.code === 'GEMINI_API_KEY_NOT_CONFIGURED' && error.statusCode === 503
  );
});
