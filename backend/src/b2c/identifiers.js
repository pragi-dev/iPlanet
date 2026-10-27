import { IDENTIFIER_TYPES } from './b2cDefaults.js';

// Identifier extraction runs only the patterns configured in B2CSettings.
// Patterns are compiled and length-checked when saved, and run over bounded
// text so a long email cannot make extraction slow.
const SCAN_LIMIT = 20_000;
const MAX_PATTERN = 300;
const MAX_VALUE = 60;

export function compileIdentifierRule(rule) {
  if (!rule || !IDENTIFIER_TYPES.includes(rule.type)) throw new Error('Identifier rule type is invalid.');
  const pattern = String(rule.pattern || '');
  if (!pattern || pattern.length > MAX_PATTERN) throw new Error(`Identifier pattern must be 1–${MAX_PATTERN} characters.`);
  const flags = String(rule.flags || '').replace(/[^imsu]/g, '');
  let regex;
  try { regex = new RegExp(pattern, `${flags}g`); } catch (error) { throw new Error(`Identifier pattern "${rule.key || rule.label}" is not a valid regular expression: ${error.message}`); }
  return regex;
}

const normaliseValue = (type, value) => {
  const trimmed = String(value || '').trim().replace(/[.,;:]+$/, '').slice(0, MAX_VALUE);
  return type === 'serialNumber' || type === 'caseId' ? trimmed.toUpperCase() : trimmed;
};

export function extractIdentifiers({ subject = '', body = '' }, rules = []) {
  const found = new Map();
  const sources = [['subject', String(subject).slice(0, 1000)], ['body', String(body).slice(0, SCAN_LIMIT)]];
  for (const rule of rules) {
    if (!rule?.enabled) continue;
    let regex;
    try { regex = compileIdentifierRule(rule); } catch { continue; }
    for (const [source, text] of sources) {
      for (const match of text.matchAll(regex)) {
        const value = normaliseValue(rule.type, match[1] ?? match[0]);
        if (!value) continue;
        const key = `${rule.type}:${value}`;
        if (!found.has(key)) found.set(key, { type: rule.type, value, ruleKey: rule.key, source });
        if (found.size >= 20) return [...found.values()];
      }
    }
  }
  return [...found.values()];
}
