import { retrieveRelevantKnowledge } from './knowledgeRetriever.js';

function normalizeConversation(conversation) {
  if (!Array.isArray(conversation)) return [];
  return conversation
    .filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string')
    .slice(-6)
    .map(item => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.content.trim().slice(0, 1000)}`)
    .filter(Boolean);
}

export function buildSupportContext({ message, conversation } = {}) {
  const retrievedKnowledge = retrieveRelevantKnowledge(message);
  const history = normalizeConversation(conversation);

  return {
    retrievedKnowledge: retrievedKnowledge.results,
    portalContext: history.length ? `Recent conversation:\n${history.join('\n')}` : ''
  };
}
