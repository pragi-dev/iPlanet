// Customer emails are sent as plain text from templates stored in
// B2CSettings. Only known placeholders are replaced; values are plain text,
// and line breaks are removed from anything placed in the subject so a value
// can never add an email header.
const PLACEHOLDERS = ['reference', 'customerName', 'subject', 'category', 'message'];

const oneLine = value => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();

export function renderTemplate(template, vars = {}) {
  const fill = (text, singleLine) => String(text || '').replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_, name) => {
    if (!PLACEHOLDERS.includes(name)) return '';
    const value = vars[name] ?? '';
    return singleLine ? oneLine(value) : String(value);
  });
  let subject = oneLine(fill(template?.subject, true)).slice(0, 250);
  // Every customer email carries the reference so replies thread to the ticket.
  if (vars.reference && !subject.includes(`[${vars.reference}]`)) subject = `[${vars.reference}] ${subject}`.trim();
  return { subject, body: fill(template?.body, false).slice(0, 20_000) };
}

export function templateVars(ticket, extra = {}) {
  return {
    reference: ticket.reference,
    customerName: ticket.customer?.name || 'Customer',
    subject: ticket.subject || '',
    category: ticket.category,
    ...extra,
  };
}
