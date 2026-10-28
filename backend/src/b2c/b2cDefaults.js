// Starting values for B2CSettings. None of these are TCM-approved rules: the
// identifier patterns, templates and validation mode are generic placeholders
// marked `confirmed: false` / `approved: false`, and the workflow uses the
// proposed hierarchy as configurable data. Classification keywords start empty.
export const CATEGORIES = ['Service', 'Retail'];
export const UNCLASSIFIED = 'Unclassified';
// B2C has no priority levels. Every ticket uses this B2B priority's SLA targets (resolution within 24 hours).
export const STANDARD_PRIORITY = 'Medium';
export const B2C_ADMIN = 'b2c_admin';

export const DEFAULT_LEVELS = [
  { key: 'cluster_manager', label: 'Cluster Manager' },
  { key: 'rbh', label: 'Regional Business Head' },
  { key: 'trainer', label: 'Trainer' },
  { key: 'cd_team_am', label: 'CD Team Assistant Manager' },
  { key: 'service_excellence_lead', label: 'Service Excellence Lead' },
];
export const LEVEL_KEYS = DEFAULT_LEVELS.map(level => level.key);
export const B2C_ROLES = [B2C_ADMIN, ...LEVEL_KEYS];

export const IDENTIFIER_TYPES = ['caseId', 'serialNumber', 'orderNumber', 'other'];

export const DEFAULT_IDENTIFIER_RULES = [
  { key: 'case-id-labelled', type: 'caseId', label: 'Case ID written after a "Case ID / Case No / Case #" label', pattern: '\\bcase\\s*(?:id|no\\.?|number|#|ref(?:erence)?)\\s*[:#-]?\\s*([A-Z0-9][A-Z0-9-]{3,29})', flags: 'i', enabled: true, confirmed: false },
  { key: 'serial-labelled', type: 'serialNumber', label: 'Serial number written after a "Serial No / S/N" label', pattern: '\\b(?:serial\\s*(?:no\\.?|number|#)?|s\\/n)\\s*[:#-]?\\s*([A-Z0-9]{8,14})\\b', flags: 'i', enabled: true, confirmed: false },
];

export const TEMPLATE_KEYS = ['acknowledgement', 'clarification', 'final_resolution'];
export const DEFAULT_TEMPLATES = [
  { key: 'acknowledgement', label: 'Acknowledgement (sent automatically)', subject: 'We have received your email', body: 'Dear {{customerName}},\n\nThank you for writing to us. Your concern has been registered under reference {{reference}}.\n\nPlease keep {{reference}} in the subject line if you reply to this email.\n\nThis is an automated acknowledgement.', approved: false },
  { key: 'clarification', label: 'Clarification request', subject: 'Additional information required', body: 'Dear {{customerName}},\n\n{{message}}\n\nPlease reply to this email and keep {{reference}} in the subject line.', approved: false },
  { key: 'final_resolution', label: 'Final customer communication', subject: 'Update on your concern', body: 'Dear {{customerName}},\n\n{{message}}\n\nReference: {{reference}}', approved: false },
];

export function defaultSettings({ testInboxAddress }) {
  return {
    key: 'default',
    // Start with one test inbox; add the four TCM inboxes once confirmed.
    inboxes: [{ key: 'test-inbox', address: testInboxAddress, displayName: 'Test inbox', provider: 'test', defaultCategory: null, defaultRegion: '', enabled: true }],
    identifierRules: DEFAULT_IDENTIFIER_RULES,
    classificationRules: [
      { category: 'Service', keywords: [], enabled: true },
      { category: 'Retail', keywords: [], enabled: true },
    ],
    workflowLevels: DEFAULT_LEVELS.map((level, index) => ({ ...level, order: index + 1, enabled: true })),
    // 'next_level': the next level on the ticket's path validates (B2C admin at the top).
    // 'level': one configured level validates. 'none': resolutions are not validated.
    validation: { mode: 'next_level', levelKey: null },
    templates: DEFAULT_TEMPLATES,
  };
}
