import { CATEGORIES, IDENTIFIER_TYPES, LEVEL_KEYS, TEMPLATE_KEYS } from './b2cDefaults.js';
import { compileIdentifierRule } from './identifiers.js';
import { normaliseAddress } from './emailContent.js';

// Validates a partial B2CSettings update from the admin page. Only sections
// present in `input` are returned; anything malformed is rejected as a whole
// so a half-valid configuration is never saved.
export class SettingsValidationError extends Error {
  constructor(message) { super(message); this.status = 400; }
}
const fail = message => { throw new SettingsValidationError(message); };
const text = (value, max, label, { required = false } = {}) => {
  const result = String(value ?? '').trim();
  if (required && !result) fail(`${label} is required.`);
  if (result.length > max) fail(`${label} must be ${max} characters or fewer.`);
  return result;
};
const bool = value => value === true;
const unique = (items, key, label) => { const seen = new Set(); for (const item of items) { if (seen.has(item[key])) fail(`${label} "${item[key]}" is used more than once.`); seen.add(item[key]); } };

export function validateSettingsUpdate(input = {}, current = {}, user = {}) {
  const update = {};
  if (input.inboxes !== undefined) {
    if (!Array.isArray(input.inboxes) || input.inboxes.length > 10) fail('Up to 10 inboxes can be configured.');
    update.inboxes = input.inboxes.map(inbox => {
      const key = text(inbox.key, 40, 'Inbox key', { required: true }).toLowerCase();
      if (!/^[a-z0-9-]{2,40}$/.test(key)) fail('Inbox keys use lowercase letters, digits and hyphens.');
      const address = normaliseAddress(inbox.address);
      if (!address) fail(`Inbox "${key}" needs a valid email address.`);
      if (!['test', 'microsoft_graph', 'imap'].includes(inbox.provider)) fail(`Inbox "${key}" has an unsupported provider.`);
      const defaultCategory = inbox.defaultCategory || null;
      if (defaultCategory && !CATEGORIES.includes(defaultCategory)) fail(`Inbox "${key}" has an invalid default category.`);
      return { key, address, displayName: text(inbox.displayName, 80, 'Inbox name'), provider: inbox.provider, defaultCategory, defaultRegion: text(inbox.defaultRegion, 80, 'Default region'), enabled: bool(inbox.enabled) };
    });
    unique(update.inboxes, 'key', 'Inbox key');
    unique(update.inboxes, 'address', 'Inbox address');
  }
  if (input.identifierRules !== undefined) {
    if (!Array.isArray(input.identifierRules) || input.identifierRules.length > 30) fail('Up to 30 identifier rules can be configured.');
    update.identifierRules = input.identifierRules.map((rule, index) => {
      const normalised = { key: text(rule.key || `rule-${index + 1}`, 40, 'Rule key'), type: rule.type, label: text(rule.label, 120, 'Rule label'), pattern: String(rule.pattern || ''), flags: String(rule.flags ?? 'i').replace(/[^imsu]/g, ''), enabled: bool(rule.enabled), confirmed: bool(rule.confirmed) };
      if (!IDENTIFIER_TYPES.includes(normalised.type)) fail(`Identifier rule "${normalised.key}" has an invalid type.`);
      try { compileIdentifierRule(normalised); } catch (error) { fail(error.message); }
      return normalised;
    });
    unique(update.identifierRules, 'key', 'Identifier rule key');
  }
  if (input.classificationRules !== undefined) {
    if (!Array.isArray(input.classificationRules)) fail('Classification rules must be a list.');
    update.classificationRules = input.classificationRules.map(rule => {
      if (!CATEGORIES.includes(rule.category)) fail('Classification rules must target Service or Retail.');
      const keywords = (Array.isArray(rule.keywords) ? rule.keywords : []).map(word => text(word, 80, 'Keyword')).filter(Boolean);
      if (keywords.length > 100) fail('Up to 100 keywords per category.');
      return { category: rule.category, keywords: [...new Set(keywords)], enabled: bool(rule.enabled) };
    });
  }
  if (input.workflowLevels !== undefined) {
    if (!Array.isArray(input.workflowLevels)) fail('Workflow levels must be a list.');
    const keys = input.workflowLevels.map(level => level.key).sort();
    // Level keys are the role names held by users, so the set cannot change here.
    if (keys.join() !== [...LEVEL_KEYS].sort().join()) fail('Workflow levels must contain each defined level exactly once.');
    update.workflowLevels = input.workflowLevels.map(level => ({ key: level.key, label: text(level.label, 80, 'Level name', { required: true }), order: Number.isInteger(Number(level.order)) ? Number(level.order) : 99, enabled: bool(level.enabled) }));
  }
  if (input.validation !== undefined) {
    const mode = input.validation?.mode;
    if (!['next_level', 'level', 'none'].includes(mode)) fail('Validation mode is invalid.');
    const levelKey = mode === 'level' ? input.validation.levelKey : null;
    if (mode === 'level' && !LEVEL_KEYS.includes(levelKey)) fail('Choose the level that validates resolutions.');
    update.validation = { mode, levelKey };
  }
  if (input.templates !== undefined) {
    if (!Array.isArray(input.templates)) fail('Templates must be a list.');
    update.templates = TEMPLATE_KEYS.map(key => {
      const incoming = input.templates.find(item => item.key === key);
      const existing = (current.templates || []).find(item => item.key === key) || {};
      if (!incoming) return existing;
      const subject = text(incoming.subject, 200, 'Template subject', { required: true });
      const body = text(incoming.body, 5000, 'Template body', { required: true });
      const approved = bool(incoming.approved);
      const changed = subject !== existing.subject || body !== existing.body;
      // Approval is recorded per wording: approving, or editing approved wording, re-stamps it.
      const stamp = approved && (!existing.approved || changed) ? { approvedBy: user.name || user.email || 'B2C admin', approvedAt: new Date() } : approved ? { approvedBy: existing.approvedBy, approvedAt: existing.approvedAt } : { approvedBy: null, approvedAt: null };
      return { key, label: existing.label || key, subject, body, approved, ...stamp };
    });
  }
  return update;
}
