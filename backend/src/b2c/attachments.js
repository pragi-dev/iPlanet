import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Email attachments are untrusted. Only a small allowlist of document and
// image types is kept, and the file's leading bytes must match its declared
// type. Files are stored under a random name outside any public folder and are
// downloaded only through the authorised ticket endpoint, as attachments.
const TYPES = {
  pdf: { contentType: 'application/pdf', magic: buffer => buffer.subarray(0, 5).toString('latin1') === '%PDF-' },
  jpg: { contentType: 'image/jpeg', magic: buffer => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  jpeg: { contentType: 'image/jpeg', magic: buffer => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  png: { contentType: 'image/png', magic: buffer => buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  heic: { contentType: 'image/heic', magic: buffer => buffer.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(buffer.subarray(8, 12).toString('latin1')) },
  txt: { contentType: 'text/plain', magic: buffer => !buffer.includes(0) },
};
export const ALLOWED_ATTACHMENT_EXTENSIONS = Object.keys(TYPES);
const STORAGE_KEY = /^[a-f0-9]{32}$/;

export function sanitiseFilename(name) {
  const base = String(name || 'attachment').split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩"<>:|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return (base || 'attachment').slice(-150);
}

export function inspectAttachment({ filename, content, size }, { maxBytes }) {
  const name = sanitiseFilename(filename);
  const extension = path.extname(name).slice(1).toLowerCase();
  const buffer = Buffer.isBuffer(content) ? content : null;
  const actualSize = buffer ? buffer.length : Number(size) || 0;
  const reject = rejectReason => ({ ok: false, filename: name, size: actualSize, rejectReason });
  if (!buffer) return reject('content_unavailable');
  if (actualSize === 0) return reject('empty_file');
  if (actualSize > maxBytes) return reject('too_large');
  const type = TYPES[extension];
  if (!type) return reject('type_not_allowed');
  if (!type.magic(buffer)) return reject('content_does_not_match_type');
  return { ok: true, filename: name, size: actualSize, contentType: type.contentType, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

export function createAttachmentStore({ dir }) {
  const fullPath = key => {
    if (!STORAGE_KEY.test(String(key))) throw Object.assign(new Error('Invalid attachment key'), { status: 404 });
    return path.join(dir, key);
  };
  return {
    async save(buffer) {
      await fs.mkdir(dir, { recursive: true });
      const key = crypto.randomBytes(16).toString('hex');
      await fs.writeFile(fullPath(key), buffer, { flag: 'wx', mode: 0o600 });
      return key;
    },
    async read(key) { return fs.readFile(fullPath(key)); },
    async remove(key) { await fs.rm(fullPath(key), { force: true }); },
  };
}

// Validates and stores every attachment of one email. Rejected files are
// recorded (name, size, reason) so staff can ask the customer to resend.
export async function storeAttachments(attachments = [], { store, maxBytes, maxCount }) {
  const results = [];
  for (const [index, attachment] of attachments.entries()) {
    if (index >= maxCount) { results.push({ filename: sanitiseFilename(attachment.filename), size: Number(attachment.size) || 0, status: 'rejected', rejectReason: 'too_many_attachments' }); continue; }
    const inspected = inspectAttachment(attachment, { maxBytes });
    if (!inspected.ok) { results.push({ filename: inspected.filename, size: inspected.size, status: 'rejected', rejectReason: inspected.rejectReason }); continue; }
    const storageKey = await store.save(attachment.content);
    results.push({ storageKey, filename: inspected.filename, contentType: inspected.contentType, size: inspected.size, sha256: inspected.sha256, status: 'stored' });
  }
  return results;
}
