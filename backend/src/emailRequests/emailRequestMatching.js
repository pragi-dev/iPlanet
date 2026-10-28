import { indiaToday, resolveServiceDateIntent } from '../ai/serviceDate.js';
import { ON_SITE_MAX_DEVICES, isOnSiteRequest, onSiteEarliestDate } from '../ticketRequests.js';

// Turns an email and Claude's extracted details into a ticket draft. The company comes from
// the sender's address matched against portal accounts and, when the sender doesn't
// identify one, from the device whose serial number the email gives (serial numbers are
// unique across organizations). A sender who does identify a company only ever gets that
// company's devices, so an email can't attach a request to another organization's
// devices. Every draft is reviewed before a ticket is created.

const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = value => new RegExp(`^${escapeRegex(String(value).trim())}$`, 'i');
const domainOf = address => String(address || '').split('@')[1]?.toLowerCase() || '';
// Free mail domains are shared by many organizations, so they never identify a company.
const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'rediffmail.com', 'proton.me', 'protonmail.com']);

export async function matchSender({ models, address }) {
  const { User, Company } = models;
  if (!address) return { notes: ['The sender address could not be read.'] };
  const user = await User.findOne({ email: exactly(address), role: 'corporate_admin' }).lean();
  if (user?.companyId) return { companyId: user.companyId, customerId: user._id, notes: [] };
  const domain = domainOf(address);
  if (!domain || PUBLIC_DOMAINS.has(domain)) return { notes: [`${address} is not a Corporate Self-Care user. Choose the organization and requester.`] };
  const sameDomain = new RegExp(`@${escapeRegex(domain)}$`, 'i');
  const colleague = await User.findOne({ email: sameDomain, role: 'corporate_admin', companyId: { $ne: null } }).lean();
  const company = colleague ? await Company.findById(colleague.companyId).lean() : await Company.findOne({ contactEmail: sameDomain }).lean();
  if (!company) return { notes: [`${address} is not a Corporate Self-Care user and no organization uses @${domain}. Choose the organization and requester.`] };
  return { companyId: company._id, notes: [`${address} is not a Corporate Self-Care user. Matched ${company.name} by the email domain.`] };
}

export async function matchDevice({ models, companyId, serialNumbers = [], assetIds = [] }) {
  const { Device } = models;
  if (!companyId) return { notes: [] };
  for (const serialNumber of serialNumbers) {
    const device = await Device.findOne({ companyId, serialNumber: exactly(serialNumber) }).lean();
    if (device) return { deviceId: device._id, location: device.location, notes: [] };
  }
  for (const assetId of assetIds) {
    const device = await Device.findOne({ companyId, assetId: exactly(assetId) }).lean();
    if (device) return { deviceId: device._id, location: device.location, notes: [] };
  }
  const named = [...serialNumbers, ...assetIds];
  return { notes: [named.length ? `No device of this organization matches ${named.join(', ')}. Choose the device.` : 'The email does not give a serial number or asset ID. Choose the device.'] };
}

// For a sender who doesn't identify an organization: the serial number names one device,
// and so its organization. Asset IDs repeat across organizations, so they aren't used here.
export async function matchDeviceBySerial({ models, serialNumbers = [] }) {
  const { Device } = models;
  for (const serialNumber of serialNumbers) {
    const device = await Device.findOne({ serialNumber: exactly(serialNumber), companyId: { $ne: null } }).lean();
    if (device) return { deviceId: device._id, companyId: device.companyId, location: device.location, serialNumber: device.serialNumber };
  }
  return null;
}

// The requester, when the contact named in the email (or the sender's display name) is
// exactly one Corporate Self-Care user of the organization.
export async function matchRequester({ models, companyId, names = [] }) {
  const { User } = models;
  for (const name of names.map(value => String(value || '').trim()).filter(Boolean)) {
    const users = await User.find({ companyId, role: 'corporate_admin', name: exactly(name) }).select('_id').limit(2).lean();
    if (users.length === 1) return users[0]._id;
  }
  return null;
}

// Returns { draft, matchNotes } for EmailRequest. The category is settled first, because it
// decides what the request needs, as in the Raise Request wizard: a Service request is for
// one device (found by serial number or asset ID); a Health Camp or Buyback / E-Waste visit
// needs a device count and a date far enough ahead, and no device.
export async function buildDraft({ models, from, extraction, now = new Date() }) {
  const sender = await matchSender({ models, address: from?.address });
  const details = extraction || {};
  const category = details.category || 'Service';
  const onSite = isOnSiteRequest(category);
  let device = { notes: [] };
  if (!onSite && sender.companyId) {
    device = await matchDevice({ models, companyId: sender.companyId, serialNumbers: details.serialNumbers, assetIds: details.assetIds });
  } else if (!onSite) {
    const found = await matchDeviceBySerial({ models, serialNumbers: details.serialNumbers });
    if (found) {
      const owner = await models.Company.findById(found.companyId).select('name').lean();
      sender.companyId = found.companyId;
      sender.notes = [`${from?.address || 'The sender'} is not a Corporate Self-Care user. Matched ${owner?.name || 'the organization'} by serial number ${found.serialNumber}; confirm the sender works there.`];
      device = { ...found, notes: [] };
    }
  }
  if (sender.companyId && !sender.customerId) {
    sender.customerId = await matchRequester({ models, companyId: sender.companyId, names: [details.contactName, from?.name] });
    if (!sender.customerId) sender.notes.push('Choose who the request is for.');
  }
  const company = sender.companyId ? await models.Company.findById(sender.companyId).lean() : null;
  const date = resolveServiceDateIntent(details.preferredDateText, now);
  const notes = [...sender.notes, ...device.notes];
  if (date.ambiguous) notes.push(`The preferred date "${details.preferredDateText}" is unclear or in the past. Confirm it with the customer.`);
  if (onSite) {
    if (!details.deviceCount || details.deviceCount > ON_SITE_MAX_DEVICES) notes.push(`A ${category} visit needs the number of devices (1 to ${ON_SITE_MAX_DEVICES}).`);
    const earliest = onSiteEarliestDate(category, indiaToday(now));
    if (!date.date && !date.ambiguous) notes.push(`A ${category} visit needs a date on or after ${earliest}. Confirm it with the customer.`);
    else if (date.date < earliest) notes.push(`A ${category} visit needs a date on or after ${earliest}; the customer asked for ${date.date}. Confirm a new date with the customer.`);
  }
  return {
    draft: {
      companyId: sender.companyId || null,
      customerId: sender.customerId || null,
      deviceId: device.deviceId || null,
      category,
      issueType: onSite ? null : details.issueType || 'Other',
      description: details.description || null,
      priority: details.priority || 'Medium',
      location: details.location || device.location || company?.location || null,
      preferredServiceDate: date.date,
      deviceCount: onSite ? details.deviceCount || null : null,
    },
    matchNotes: notes,
  };
}
