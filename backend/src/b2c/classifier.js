import { CATEGORIES, UNCLASSIFIED } from './b2cDefaults.js';

// Service/Retail classification uses only configured rules:
// 1. an inbox with a default category classifies everything it receives;
// 2. otherwise configured keywords are matched as whole words in the subject and body.
// No match, or matches for both categories, leaves the ticket Unclassified
// for triage instead of guessing.
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function classifyEscalation({ inbox, subject = '', body = '' }, rules = []) {
  if (inbox?.defaultCategory && CATEGORIES.includes(inbox.defaultCategory)) {
    return { category: inbox.defaultCategory, source: 'inbox', matched: [`inbox:${inbox.key}`], reason: null };
  }
  const text = `${subject}\n${String(body).slice(0, 20_000)}`;
  const hits = new Map();
  for (const rule of rules) {
    if (!rule?.enabled || !CATEGORIES.includes(rule.category)) continue;
    for (const keyword of rule.keywords || []) {
      const word = String(keyword || '').trim();
      if (!word || word.length > 80) continue;
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(word)}($|[^\\p{L}\\p{N}])`, 'iu').test(text)) {
        hits.set(rule.category, [...(hits.get(rule.category) || []), word]);
      }
    }
  }
  if (hits.size === 1) {
    const [[category, words]] = [...hits.entries()];
    return { category, source: 'rule', matched: words, reason: null };
  }
  if (hits.size > 1) return { category: UNCLASSIFIED, source: null, matched: [...hits.entries()].flatMap(([category, words]) => words.map(word => `${category}:${word}`)), reason: 'ambiguous_category' };
  return { category: UNCLASSIFIED, source: null, matched: [], reason: 'unclassified_category' };
}
