import { knowledgeDocuments } from './knowledge/index.js';

const tokenize = value => String(value || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const normalized = value => ` ${tokenize(value).join(' ')} `;
const genericSymptomTerms = new Set(['battery', 'device', 'devices', 'app', 'apps', 'software', 'issue', 'problem']);

function documentContent(document) {
  return [
    `Symptoms: ${document.symptoms.join('; ')}`,
    `Possible non-hardware causes: ${document.possibleCauses.join('; ')}`,
    `Safe Level-1 steps: ${document.troubleshootingSteps.map((step, index) => `${index + 1}. ${step}`).join(' ')}`,
    `Questions to ask: ${document.questions.join('; ')}`,
    `Escalate to service when: ${document.escalationConditions.join('; ')}`
  ].join('\n');
}

function relevanceScore(message, document) {
  const haystack = normalized(message);
  const messageTokens = new Set(tokenize(message));
  let score = 0;
  for (const keyword of document.keywords) {
    const keywordTokens = tokenize(keyword);
    if (keywordTokens.length && keywordTokens.every(token => messageTokens.has(token))) score += keywordTokens.length > 1 ? 5 : 3;
    else if (keywordTokens.some(token => messageTokens.has(token))) score += 1;
  }
  for (const symptom of document.symptoms) {
    const tokens = tokenize(symptom).filter(token => token.length > 3 && !genericSymptomTerms.has(token));
    if (tokens.some(token => haystack.includes(` ${token} `))) score += 1;
  }
  return score;
}

// Stable local-retrieval interface; replace its scoring implementation with vector search later.
export function retrieveRelevantKnowledge(message, { limit = 3 } = {}) {
  if (typeof message !== 'string' || !message.trim()) return { results: [] };
  const results = knowledgeDocuments
    .map(document => ({ document, score: relevanceScore(message, document) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.document.title.localeCompare(b.document.title))
    .slice(0, Math.max(1, Math.min(limit, knowledgeDocuments.length)))
    .map(({ document, score }) => ({ id: document.id, title: document.title, category: document.category, relevanceScore: score, content: documentContent(document) }));
  return { results };
}
