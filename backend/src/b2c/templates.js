// Customer emails are sent as plain text from templates stored in
// B2CSettings. Only known placeholders are replaced; values are plain text,
// and line breaks are removed from anything placed in the subject so a value
// can never add an email header.
// `ticketNumber` is the same as `reference`.
// `registrationLink` and `linkExpiry` are given only to the registration request.
const PLACEHOLDERS = ['reference', 'ticketNumber', 'customerName', 'subject', 'category', 'message', 'serialNumber', 'issueSummary', 'companyName', 'registrationLink', 'linkExpiry'];
// A line using one of these is left out when its value is empty (e.g. no verified serial number).
const OPTIONAL_LINE = ['serialNumber'];

const oneLine = value => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
const valueOf = (vars, name) => (name === 'ticketNumber' ? vars.reference : vars[name]) ?? '';

export function renderTemplate(template, vars = {}) {
  const fill = (text, singleLine) => String(text || '').replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_, name) => {
    if (!PLACEHOLDERS.includes(name)) return '';
    const value = valueOf(vars, name);
    return singleLine ? oneLine(value) : String(value);
  });
  let subject = oneLine(fill(template?.subject, true)).slice(0, 250);
  // Every customer email carries the reference so replies thread to the ticket.
  if (vars.reference && !subject.includes(`[${vars.reference}]`)) subject = `[${vars.reference}] ${subject}`.trim();
  const body = String(template?.body || '').split('\n')
    .filter(line => !OPTIONAL_LINE.some(name => new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`).test(line) && !String(valueOf(vars, name)).trim()))
    .join('\n');
  return { subject, body: fill(body, false).slice(0, 20_000) };
}

// The issue summary: the email's subject, or else the start of its text.
const issueSummary = ticket => oneLine(ticket.subject) || oneLine(ticket.summary).slice(0, 200) || 'Your email to our support team';

export function templateVars(ticket, extra = {}) {
  return {
    reference: ticket.reference,
    customerName: ticket.customer?.name || 'Customer',
    subject: ticket.subject || '',
    category: ticket.category,
    issueSummary: issueSummary(ticket),
    ...extra,
  };
}
