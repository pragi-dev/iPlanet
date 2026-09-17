function headerValue(message, name) {
  return message?.payload?.headers?.find(header => String(header.name).toLowerCase() === name.toLowerCase())?.value || '';
}

function decodeBase64Url(value = '') {
  if (!value) return '';
  return Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function stripHtml(value = '') {
  return String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectBodyParts(part, output = []) {
  if (!part) return output;
  if (part.body?.data) output.push({ mimeType: part.mimeType || '', text: decodeBase64Url(part.body.data) });
  for (const child of part.parts || []) collectBodyParts(child, output);
  return output;
}

function messageText(message) {
  const parts = collectBodyParts(message?.payload);
  const plain = parts.filter(part => part.mimeType === 'text/plain').map(part => part.text).join('\n');
  const html = parts.filter(part => part.mimeType === 'text/html').map(part => stripHtml(part.text)).join('\n');
  return (plain || html || parts.map(part => part.text).join('\n') || '').replace(/\r/g, '').trim();
}

function parseRating(text) {
  const match = String(text).match(/(?:rating|rated|gave|review)\D{0,30}([1-5])\s*(?:\/\s*5|stars?|out of five)?/i)
    || String(text).match(/([1-5])\s*(?:\u2605|stars?)(?:\s*(?:out of|\/)?\s*5)?/i);
  return match ? Number(match[1]) : null;
}

function parseReviewUrl(text) {
  return String(text).match(/https?:\/\/[^\s<>]*(?:google\.[^\s<>]*|goo\.gl\/[^\s<>]*)/i)?.[0]?.replace(/[),.]+$/, '') || null;
}

function parseReviewer(text, businessName) {
  const lines = String(text).split('\n').map(line => line.trim()).filter(Boolean);
  const ratingIndex = lines.findIndex(line => /(?:[1-5]\s*(?:\u2605|stars?)|rating)/i.test(line));
  const candidates = (ratingIndex >= 0 ? lines.slice(Math.max(0, ratingIndex - 3), ratingIndex) : lines.slice(0, 6))
    .filter(line => !/^(google|new review|review|view review|phoenixx it)$/i.test(line))
    .filter(line => !/https?:\/\//i.test(line))
    .filter(line => !/\b(?:star|rating|received|gave|business profile)\b/i.test(line));
  return candidates.find(line => line.length >= 2 && line.length <= 100 && (!businessName || line.toLowerCase() !== businessName.toLowerCase())) || null;
}

function parseComment(text, reviewerName, rating, reviewUrl, businessName) {
  const lines = String(text).split('\n').map(line => line.trim()).filter(Boolean);
  const ignored = new Set([reviewerName, businessName].filter(Boolean).map(value => value.toLowerCase()));
  const result = lines.filter(line => {
    const lower = line.toLowerCase();
    return !ignored.has(lower) && !/https?:\/\//i.test(line) && !/(?:^|\s)(?:[1-5])\s*(?:\u2605|stars?)(?:\s|$)/i.test(line) && !/^(?:view|read) (?:review|more)/i.test(line) && !/^(?:new )?review(?: received)?[.!]?$/i.test(line) && !/\b(?:rating|received a new review|business profile)\b/i.test(line);
  });
  const comment = result.join(' ').replace(/\s+/g, ' ').trim();
  return comment || null;
}

function parseTimestamp(internalDate, headerDate) {
  const candidates = [internalDate ? new Date(Number(internalDate)) : null, headerDate ? new Date(headerDate) : null];
  const valid = candidates.find(value => value && !Number.isNaN(value.getTime()));
  return valid ? valid.toISOString() : null;
}

export function parseGoogleReviewEmail(message, { placeId = null, businessName = null } = {}) {
  const subject = headerValue(message, 'Subject');
  const from = headerValue(message, 'From');
  const text = messageText(message);
  const combined = `${subject}\n${from}\n${text}`;
  if (!/(?:google|business profile|maps)/i.test(combined) || !/(?:review|rating|star)/i.test(combined)) return null;

  const emailDate = headerValue(message, 'Date');
  const emailReceivedAt = parseTimestamp(message.internalDate, emailDate);
  const businessMentioned = businessName && combined.toLowerCase().includes(String(businessName).toLowerCase());
  const rating = parseRating(combined);
  const reviewerName = parseReviewer(text, businessName);
  const reviewUrl = parseReviewUrl(combined);
  const comment = parseComment(text, reviewerName, rating, reviewUrl, businessName);

  return {
    source: 'google-email',
    externalId: message.id || null,
    gmailMessageId: message.id || null,
    placeId,
    businessName: businessMentioned ? businessName : null,
    reviewerName,
    rating,
    comment,
    reviewCreatedAt: emailReceivedAt,
    reviewUrl,
    emailReceivedAt,
    rawSource: 'gmail',
  };
}

export function getGmailMessageText(message) {
  return messageText(message);
}

export function describeGoogleReviewEmailStructure(message) {
  const parts = collectBodyParts(message?.payload);
  return {
    messageId: message?.id || null,
    headerNames: (message?.payload?.headers || []).map(header => header.name),
    mimeTypes: parts.map(part => part.mimeType),
    bodyLengths: parts.map(part => part.text.length),
  };
}
