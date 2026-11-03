// Starting values for B2CSettings. None of these are TCM-approved rules: the
// identifier patterns, templates and validation mode are generic placeholders
// marked `confirmed: false` / `approved: false`, and the workflow uses the
// proposed hierarchy as configurable data. Classification keywords start empty.
export const CATEGORIES = ['Service', 'Retail'];
export const UNCLASSIFIED = 'Unclassified';
// A Service case is an Enquiry (answered and closed by the B2C Admin) or an Escalation (sent to
// the region's Cluster Manager). Enquiry keywords decide; anything else is an Escalation.
export const CASE_TYPES = ['Enquiry', 'Escalation'];
export const DEFAULT_ENQUIRY_KEYWORDS = ['enquiry', 'inquiry', 'price', 'pricing', 'cost of', 'quotation', 'availability', 'in stock', 'how to', 'how do i', 'information about', 'details about', 'offer', 'EMI'];
// B2C has no priority levels. Every ticket uses this B2B priority's SLA targets (resolution within 24 hours).
export const STANDARD_PRIORITY = 'Medium';
export const B2C_ADMIN = 'b2c_admin';

// The flow is Cluster Manager → Service Executive: the region's Cluster Manager receives
// the ticket and assigns it to a Service Executive, who does the work.
export const DEFAULT_LEVELS = [
  { key: 'cluster_manager', label: 'Cluster Manager' },
  { key: 'service_excellence_lead', label: 'Service Executive' },
];
// Levels of the earlier five-level hierarchy, removed from settings, tickets and staff on startup.
export const REMOVED_LEVEL_KEYS = ['rbh', 'trainer', 'cd_team_am'];
export const LEVEL_KEYS = DEFAULT_LEVELS.map(level => level.key);
export const B2C_ROLES = [B2C_ADMIN, ...LEVEL_KEYS];

export const IDENTIFIER_TYPES = ['caseId', 'serialNumber', 'orderNumber', 'other'];

export const DEFAULT_IDENTIFIER_RULES = [
  { key: 'case-id-labelled', type: 'caseId', label: 'Case ID written after a "Case ID / Case No / Case #" label', pattern: '\\bcase\\s*(?:id|no\\.?|number|#|ref(?:erence)?)\\s*[:#-]?\\s*([A-Z0-9][A-Z0-9-]{3,29})', flags: 'i', enabled: true, confirmed: false },
  { key: 'serial-labelled', type: 'serialNumber', label: 'Serial number written after a "Serial No / S/N" label', pattern: '\\b(?:serial\\s*(?:no\\.?|number|#)?|s\\/n)\\s*[:#-]?\\s*([A-Z0-9]{8,14})\\b', flags: 'i', enabled: true, confirmed: false },
];

export const TEMPLATE_KEYS = ['acknowledgement', 'clarification', 'final_resolution', 'registration_request', 'retail_transfer'];
export const DEFAULT_TEMPLATES = [
  // The ticket number is in [brackets] in the subject so replies thread to the ticket.
  // The serial number line is left out when no verified serial number is known.
  { key: 'acknowledgement', label: 'Acknowledgement (sent automatically)', subject: 'Support Request Received – Ticket [{{ticketNumber}}]', body: 'Dear {{customerName}},\n\nWe have received your support request and created a support ticket.\n\nTicket Number: {{ticketNumber}}\nDevice Serial Number: {{serialNumber}}\nIssue Summary: {{issueSummary}}\n\nOur support team will review your request and follow the applicable support process. Please mention your ticket number in any further communication regarding this issue.\n\nThank you for contacting our support team.\n\nRegards,\n{{companyName}} Support Team', approved: false },
  { key: 'clarification', label: 'Clarification request', subject: 'Additional information required', body: 'Dear {{customerName}},\n\n{{message}}\n\nPlease reply to this email and keep {{reference}} in the subject line.', approved: false },
  { key: 'final_resolution', label: 'Final customer communication', subject: 'Update on your concern', body: 'Dear {{customerName}},\n\n{{message}}\n\nReference: {{reference}}', approved: false },
  // Sent when the sender cannot be matched to a registered customer. The link carries a
  // single-use token issued as the email is sent; it is never stored with the message.
  { key: 'registration_request', label: 'Customer registration request (sent automatically)', subject: 'Customer Registration Required – Complete Your Details', body: 'Dear Customer,\n\nThank you for contacting our support team.\n\nWe could not confidently match your customer and device details with our existing records. To help us process your support request, please complete the customer and mobile purchase registration form using the secure link below.\n\nComplete your registration: {{registrationLink}}\n\nThe link can be used once and expires on {{linkExpiry}}.\n\nPlease provide accurate customer and purchase information so that we can identify your registered device and direct your request to the appropriate regional support team.\n\nAfter you submit the form, our system will validate your information and continue processing your support request.\n\nIf you believe your details are already registered, please contact our support team rather than submitting duplicate information.\n\nRegards,\n{{companyName}} Support Team', approved: false },
  // To the retail team from the Retail matrix, not to the customer: an internal hand-over, so it
  // starts approved (a B2C admin can still edit it).
  { key: 'retail_transfer', label: 'Retail case transfer (to the retail team)', subject: 'Retail case transferred: {{issueSummary}}', body: 'Hello {{retailTeam}},\n\nA customer case has been transferred to you for closure as per the Retail process.\n\nReference: {{reference}}\nCustomer: {{customerName}} ({{customerEmail}})\nRegion: {{region}}\nSubject: {{subject}}\n\nNote from the B2C desk:\n{{message}}\n\nThe customer wrote:\n{{emailText}}\n\nRegards,\n{{companyName}} B2C Escalations', approved: true },
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
    // 'executive_direct': the Service Executive's repair needs no approval; a repair the Cluster
    // Manager did is approved by a B2C admin.
    // 'level': one configured level validates. 'none': resolutions are not validated.
    validation: { mode: 'executive_direct', levelKey: null },
    caseTypeRules: { enquiryKeywords: DEFAULT_ENQUIRY_KEYWORDS, enabled: true },
    // Retail teams Retail cases are transferred to: { key, region, name, email, enabled }.
    retailMatrix: [],
    templates: DEFAULT_TEMPLATES,
  };
}
