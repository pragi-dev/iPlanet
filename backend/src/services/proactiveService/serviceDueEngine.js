// Proactive service engine: the single source of truth for which devices need
// preventive service, what has been done about each one, and which
// notifications have gone out. Pages and the AI assistant read from here; none
// of them calculate service status themselves.
import { Device, ServiceCentre, ServiceFollowUp, Ticket, User } from '../../models.js';
import { proactiveConfig } from './serviceConfig.js';
import {
  ACTIVE_STAGES, CONTACT_METHODS, CONTACT_OUTCOMES, NOT_REQUIRED_REASONS, addMonths, calendarDate, daysBetween, displayStatus, futureDay,
  isoDay, nextServiceDate, timingStatus, today,
} from './serviceStatus.js';

const ACTIVE_TICKET_STATUSES = ['Open', 'Engineer Assigned', 'Engineer Accepted', 'In Progress', 'Waiting for Parts'];
const ACTIONABLE_BY_TEAM = ['Open', 'Contacted', 'Remind Later', 'Scheduled'];
const COMPLETED_WINDOW_DAYS = 30;
const NON_SERVICE_CATEGORIES = ['Buyback', 'E-Waste'];

export class ProactiveServiceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const notes = value => String(value || '').trim().slice(0, 1000);
// Who acted, from the database (the auth token only carries the user id and role).
async function actorOf(user, fallback) {
  const record = user?.id ? await User.findById(user.id).select('name') : null;
  return { byUserId: user?.id, byName: record?.name || fallback };
}
const utcDate = cal => new Date(Date.UTC(cal.y, cal.m - 1, cal.d));
const idString = value => String(value?._id || value || '');
// A recorded history date, only when it is today or earlier.
const pastDay = (value, current) => { const cal = calendarDate(value); return cal && daysBetween(cal, current) >= 0 ? isoDay(cal) : null; };

// A device's service centre: the centre it was enrolled to, otherwise the
// active centre in the device's location. Null when neither applies.
function centreFor(device, centres) {
  if (device.selectedEntityType === 'service_centre' && device.selectedEntityId) return centres.find(centre => idString(centre) === idString(device.selectedEntityId)) || null;
  const location = String(device.location || '').trim().toLowerCase();
  return location ? centres.find(centre => String(centre.location || '').trim().toLowerCase() === location) || null : null;
}

function coverageOf(device) {
  const covered = device.warrantyStatus === 'Active' || device.amcStatus === 'Active' || device.warrantyStatus === 'Expiring Soon' || device.amcStatus === 'Expiring Soon';
  return { warrantyStatus: device.warrantyStatus || null, warrantyExpiry: device.warrantyExpiry || null, amcStatus: device.amcStatus || null, amcExpiry: device.amcExpiry || null, status: covered ? 'Covered' : 'Not Covered' };
}

export function createProactiveEngine({ notifyUsers, config = proactiveConfig, clock = () => new Date() }) {
  // ------------------------------------------------------------------------
  // Describe one device (and its current follow-up) for the portals.
  // ------------------------------------------------------------------------
  function describe({ device, followUp, centre, activeTicket, current, now }) {
    const plan = nextServiceDate(device, { now, config });
    const daysUntil = plan.date ? daysBetween(current, plan.date) : null;
    const timing = timingStatus(daysUntil, config);
    const stage = followUp?.stage || null;
    const { status, actionable } = followUp ? displayStatus({ stage, timing, followUpDate: followUp.followUpDate }, current) : { status: timing, actionable: false };
    const company = device.companyId && typeof device.companyId === 'object' ? device.companyId : null;
    const lastContact = followUp?.contactLog?.length ? followUp.contactLog[followUp.contactLog.length - 1] : null;
    return {
      _id: followUp ? String(followUp._id) : null,
      deviceId: String(device._id),
      device: { model: device.model, serialNumber: device.serialNumber, deviceType: device.deviceType, assetId: device.assetId, employeeName: device.employeeName, department: device.department, location: device.location, deviceStatus: device.deviceStatus },
      company: company ? { _id: String(company._id), name: company.name } : null,
      serviceCentre: centre ? { _id: String(centre._id), name: centre.name, location: centre.location } : null,
      purchaseDate: device.purchaseDate || null,
      installationDate: device.installationDate || null,
      lastServiceDate: pastDay(device.lastServiceDate, current),
      nextServiceDate: plan.date ? isoDay(plan.date) : null,
      cycleDueDate: followUp?.dueDate || null,
      intervalMonths: plan.intervalMonths,
      basis: plan.basis,
      daysUntil,
      timing,
      stage,
      status,
      actionable,
      followUpDate: followUp?.followUpDate || null,
      followUpSetBy: followUp?.followUpSetBy || null,
      scheduledDate: followUp?.scheduledDate || null,
      ticket: activeTicket ? { _id: String(activeTicket._id), ticketId: activeTicket.ticketId, status: activeTicket.status } : followUp?.ticketId ? { _id: idString(followUp.ticketId) } : null,
      lastContact: lastContact ? { at: lastContact.at, byName: lastContact.byName, method: lastContact.method, outcome: lastContact.outcome, notes: lastContact.notes } : null,
      contactCount: followUp?.contactLog?.length || 0,
      customerResponse: followUp?.customerResponse?.type ? followUp.customerResponse : null,
      notRequiredReason: followUp?.notRequiredReason || null,
      completedAt: followUp?.completedAt || null,
      coverage: coverageOf(device),
      dataIssues: plan.issues,
    };
  }

  // ------------------------------------------------------------------------
  // Notifications. A key is recorded on the follow-up with an atomic
  // conditional update before anything is sent, so re-runs (or two runs at
  // once) never send the same notification twice.
  // ------------------------------------------------------------------------
  async function claim(followUpId, key) {
    const result = await ServiceFollowUp.updateOne({ _id: followUpId, notifiedStates: { $ne: key } }, { $addToSet: { notifiedStates: key } });
    return result.modifiedCount === 1;
  }
  const serviceRecipients = async centreId => User.find({ role: 'iplanet_service', ...(centreId ? { $or: [{ serviceCentreId: centreId }, { serviceCentreId: null }] } : {}) });
  const corporateRecipients = companyId => (companyId ? User.find({ role: 'corporate_admin', companyId }) : []);
  const label = item => [item.device.model, item.company?.name].filter(Boolean).join(' · ');

  async function sendTransitionNotifications(entries) {
    const upcoming = [];
    for (const { item, followUp, device } of entries) {
      const centreId = item.serviceCentre?._id || null;
      const companyId = item.company?._id || null;
      const serviceRoute = { type: 'PROACTIVE_SERVICE', route: `/service/proactive?followUp=${followUp._id}` };
      const corporateRoute = { type: 'SERVICE_RECOMMENDATION', route: `/corporate/service-recommendations?followUp=${followUp._id}` };
      if (followUp.stage === 'Open' && ['Due', 'Overdue'].includes(item.timing) && await claim(followUp._id, `service:${item.timing}`)) {
        await notifyUsers({ users: await serviceRecipients(centreId), company: companyId, device, serviceCentreId: centreId, type: 'PROACTIVE_SERVICE_DUE', priority: item.timing === 'Overdue' ? 'high' : 'normal',
          title: item.timing === 'Overdue' ? 'Preventive service overdue' : 'Preventive service due',
          message: `${label(item)} ${item.timing === 'Overdue' ? 'is overdue' : 'is due'} for preventive service (recommended ${item.nextServiceDate}).`, action: serviceRoute });
      }
      if (followUp.stage === 'Open' && item.timing === 'Upcoming' && await claim(followUp._id, 'service:Upcoming')) upcoming.push(item);
      if (['Open', 'Contacted'].includes(followUp.stage) && ['Upcoming', 'Due', 'Overdue'].includes(item.timing) && await claim(followUp._id, 'corporate:recommended')) {
        await notifyUsers({ users: await corporateRecipients(companyId), company: companyId, device, type: 'SERVICE_RECOMMENDED',
          title: 'Service recommended', message: `Your ${item.device.model} (${item.device.serialNumber}) may be due for preventive service. Recommended date: ${item.nextServiceDate}.`, action: corporateRoute });
      }
      if (followUp.stage === 'Remind Later' && item.status === 'Reminder Due' && await claim(followUp._id, `reminder:${followUp.followUpDate}`)) {
        await notifyUsers({ users: await serviceRecipients(centreId), company: companyId, device, serviceCentreId: centreId, type: 'PROACTIVE_SERVICE_REMINDER',
          title: 'Service follow-up is due', message: `Follow up with ${item.company?.name || 'the customer'} about preventive service for ${item.device.model} (${item.device.serialNumber}).`, action: serviceRoute });
        if (followUp.followUpSetBy === 'corporate_admin') await notifyUsers({ users: await corporateRecipients(companyId), company: companyId, device, type: 'SERVICE_RECOMMENDED',
          title: 'Service follow-up is due', message: `You asked to be reminded about preventive service for your ${item.device.model}. You can request service now.`, action: corporateRoute });
      }
    }
    // Upcoming devices go out as one digest per audience instead of one per device.
    if (upcoming.length) {
      const unscoped = await User.find({ role: 'iplanet_service', serviceCentreId: null });
      await notifyUsers({ users: unscoped, type: 'PROACTIVE_SERVICE_DIGEST', title: 'Proactive service follow-ups',
        message: `${upcoming.length} device${upcoming.length === 1 ? '' : 's'} ${upcoming.length === 1 ? 'requires' : 'require'} proactive service follow-up.`, action: { type: 'PROACTIVE_SERVICE', route: '/service/proactive?status=Upcoming' } });
      const byCentre = new Map();
      upcoming.filter(item => item.serviceCentre).forEach(item => byCentre.set(item.serviceCentre._id, [...(byCentre.get(item.serviceCentre._id) || []), item]));
      for (const [centreId, items] of byCentre) {
        await notifyUsers({ users: await User.find({ role: 'iplanet_service', serviceCentreId: centreId }), serviceCentreId: centreId, type: 'PROACTIVE_SERVICE_DIGEST', title: 'Proactive service follow-ups',
          message: `${items.length} device${items.length === 1 ? '' : 's'} ${items.length === 1 ? 'requires' : 'require'} proactive service follow-up.`, action: { type: 'PROACTIVE_SERVICE', route: '/service/proactive?status=Upcoming' } });
      }
    }
  }

  // ------------------------------------------------------------------------
  // Sync: make sure every device inside the service window has a follow-up
  // for its current cycle, move follow-ups whose device is already being
  // repaired to In Service, and (when notify is set) send transition
  // notifications. Safe to run repeatedly.
  // ------------------------------------------------------------------------
  async function sync({ notify = false, deviceFilter = {} } = {}) {
    const now = clock();
    const current = today(now, config.timeZone);
    const [devices, centres, activeTickets, active] = await Promise.all([
      Device.find({ deviceStatus: { $ne: 'Retired' }, ...deviceFilter }).populate('companyId', 'name location'),
      ServiceCentre.find({ status: 'Active' }),
      Ticket.find({ status: { $in: ACTIVE_TICKET_STATUSES }, deviceId: { $ne: null } }).select('ticketId status deviceId serviceFollowUpId createdAt'),
      ServiceFollowUp.find({ stage: { $in: ACTIVE_STAGES }, ...(deviceFilter._id ? { deviceId: deviceFilter._id } : {}) }),
    ]);
    const ticketByDevice = new Map();
    activeTickets.forEach(ticket => { if (!ticketByDevice.has(idString(ticket.deviceId))) ticketByDevice.set(idString(ticket.deviceId), ticket); });
    const followUpByDevice = new Map(active.map(followUp => [idString(followUp.deviceId), followUp]));
    const entries = [];
    let insufficientData = 0;
    for (const device of devices) {
      const deviceId = String(device._id);
      const centre = centreFor(device, centres);
      const activeTicket = ticketByDevice.get(deviceId) || null;
      const plan = nextServiceDate(device, { now, config });
      if (!plan.date) insufficientData += 1;
      const dueDate = plan.date ? isoDay(plan.date) : null;
      const timing = plan.date ? timingStatus(daysBetween(current, plan.date), config) : null;
      let followUp = followUpByDevice.get(deviceId) || null;
      // The recommended date moved (e.g. the service plan changed) before anyone acted: retire the stale cycle.
      if (followUp && followUp.stage === 'Open' && followUp.dueDate !== dueDate) {
        followUp.stage = 'Superseded';
        followUp.closedAt = now;
        await followUp.save();
        followUp = null;
      }
      if (!followUp && dueDate && ['Upcoming', 'Due', 'Overdue'].includes(timing)) {
        const found = await ServiceFollowUp.findOneAndUpdate(
          { deviceId: device._id, dueDate },
          { $setOnInsert: { deviceId: device._id, dueDate, companyId: device.companyId?._id || device.companyId || null, serviceCentreId: centre?._id || null, intervalMonths: plan.intervalMonths, basis: plan.basis, stage: 'Open' } },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
        // A cycle that was already closed (completed / not required) is never reopened.
        followUp = ACTIVE_STAGES.includes(found.stage) ? found : null;
      }
      if (followUp && activeTicket && ACTIONABLE_BY_TEAM.includes(followUp.stage)) {
        followUp.stage = 'In Service';
        followUp.ticketId = activeTicket._id;
        await followUp.save();
      }
      if (!followUp) continue;
      const item = describe({ device, followUp, centre, activeTicket, current, now });
      entries.push({ item, followUp, device });
    }
    if (notify) await sendTransitionNotifications(entries);
    return { items: entries.map(entry => entry.item), insufficientData, checkedDevices: devices.length, ranAt: now };
  }

  // ------------------------------------------------------------------------
  // Lists
  // ------------------------------------------------------------------------
  const SEARCH_FIELDS = item => [item.device.model, item.device.serialNumber, item.device.assetId, item.device.employeeName, item.device.location, item.company?.name, item.serviceCentre?.name];
  function applyFilters(items, filters = {}) {
    const term = String(filters.search || '').trim().toLowerCase();
    const within = Number.parseInt(filters.dueWithin, 10);
    return items.filter(item => {
      if (filters.status && filters.status !== 'All') {
        if (filters.status === 'Needs action' ? !item.actionable : filters.status === 'Awaiting customer' ? item.stage !== 'Contacted' : item.status !== filters.status) return false;
      }
      if (filters.companyId && filters.companyId !== 'All' && item.company?._id !== filters.companyId) return false;
      if (filters.serviceCentreId && filters.serviceCentreId !== 'All' && item.serviceCentre?._id !== filters.serviceCentreId) return false;
      if (filters.location && filters.location !== 'All' && item.device.location !== filters.location) return false;
      if (filters.deviceType && filters.deviceType !== 'All' && item.device.deviceType !== filters.deviceType) return false;
      if (filters.warranty && filters.warranty !== 'All' && item.coverage.warrantyStatus !== filters.warranty) return false;
      if (filters.amc && filters.amc !== 'All' && item.coverage.amcStatus !== filters.amc) return false;
      if (filters.dueWithin === 'overdue' && !(item.daysUntil !== null && item.daysUntil < 0)) return false;
      if (Number.isInteger(within) && !(item.daysUntil !== null && item.daysUntil <= within)) return false;
      if (term && !SEARCH_FIELDS(item).some(value => String(value || '').toLowerCase().includes(term))) return false;
      return true;
    });
  }

  function summarise(items, devices) {
    const count = predicate => items.filter(predicate).length;
    return {
      needsAction: count(item => item.actionable),
      upcoming: count(item => item.status === 'Upcoming'),
      due: count(item => item.status === 'Due'),
      overdue: count(item => item.status === 'Overdue'),
      reminderDue: count(item => item.status === 'Reminder Due'),
      awaitingCustomer: count(item => item.stage === 'Contacted'),
      remindLater: count(item => item.status === 'Remind Later'),
      scheduled: count(item => item.stage === 'Scheduled'),
      inService: count(item => item.stage === 'In Service'),
      amcExpiringSoon: devices.filter(device => device.amcStatus === 'Expiring Soon').length,
      warrantyExpiringSoon: devices.filter(device => device.warrantyStatus === 'Expiring Soon').length,
    };
  }

  // Recently completed or declined cycles, for the "completed" view and history.
  async function recentlyClosed({ scope, now }) {
    const since = new Date(now.getTime() - COMPLETED_WINDOW_DAYS * 86400000);
    const closed = await ServiceFollowUp.find({ stage: { $in: ['Completed', 'Not Required'] }, updatedAt: { $gte: since }, ...scope }).sort({ updatedAt: -1 });
    const devices = await Device.find({ _id: { $in: closed.map(followUp => followUp.deviceId) } }).populate('companyId', 'name location');
    const centres = await ServiceCentre.find({ status: 'Active' });
    const current = today(now, config.timeZone);
    return closed.map(followUp => {
      const device = devices.find(item => idString(item) === idString(followUp.deviceId));
      return device ? describe({ device, followUp, centre: centreFor(device, centres), activeTicket: null, current, now }) : null;
    }).filter(Boolean);
  }

  function facetsOf(items) {
    const unique = (values, key) => [...new Map(values.filter(Boolean).map(value => [key ? value[key] : value, value])).values()];
    return {
      companies: unique(items.map(item => item.company), '_id').sort((a, b) => a.name.localeCompare(b.name)),
      serviceCentres: unique(items.map(item => item.serviceCentre), '_id').sort((a, b) => a.name.localeCompare(b.name)),
      locations: unique(items.map(item => item.device.location)).sort(),
      deviceTypes: unique(items.map(item => item.device.deviceType)).sort(),
    };
  }

  // scope: { companyId } for corporate users, { serviceCentreId } for centre-bound service users.
  async function list({ scope = {}, filters = {} } = {}) {
    const deviceFilter = scope.companyId ? { companyId: scope.companyId } : {};
    const result = await sync({ deviceFilter });
    const now = result.ranAt;
    let items = result.items;
    if (scope.serviceCentreId) items = items.filter(item => item.serviceCentre?._id === String(scope.serviceCentreId));
    const devices = await Device.find({ deviceStatus: { $ne: 'Retired' }, ...deviceFilter }).select('amcStatus warrantyStatus location selectedEntityId selectedEntityType');
    const summary = summarise(items, devices);
    if (filters.view === 'completed') {
      const closedScope = scope.companyId ? { companyId: scope.companyId } : scope.serviceCentreId ? { serviceCentreId: scope.serviceCentreId } : {};
      items = await recentlyClosed({ scope: closedScope, now });
    }
    const facets = facetsOf(items);
    const filtered = applyFilters(items, filters).sort((a, b) => Number(b.actionable) - Number(a.actionable) || (a.daysUntil ?? 0) - (b.daysUntil ?? 0));
    return { items: filtered, total: items.length, summary: { ...summary, insufficientData: result.insufficientData }, facets, config: { upcomingDays: config.upcomingDays, overdueGraceDays: config.overdueGraceDays, defaultIntervalMonths: config.defaultIntervalMonths, timeZone: config.timeZone, notRequiredReasons: NOT_REQUIRED_REASONS }, generatedAt: now };
  }

  async function loadOwned(id, scope) {
    if (!/^[a-f0-9]{24}$/i.test(String(id))) throw new ProactiveServiceError(404, 'Follow-up not found');
    const followUp = await ServiceFollowUp.findOne({ _id: id, ...(scope.companyId ? { companyId: scope.companyId } : {}), ...(scope.serviceCentreId ? { serviceCentreId: scope.serviceCentreId } : {}) });
    if (!followUp) throw new ProactiveServiceError(404, 'Follow-up not found');
    const device = await Device.findById(followUp.deviceId).populate('companyId', 'name location contactName contactEmail phone');
    if (!device) throw new ProactiveServiceError(404, 'Device not found');
    return { followUp, device };
  }

  async function detail(id, scope = {}) {
    const { followUp, device } = await loadOwned(id, scope);
    const now = clock();
    const [centres, tickets, history] = await Promise.all([
      ServiceCentre.find({ status: 'Active' }),
      Ticket.find({ deviceId: device._id }).sort({ createdAt: -1 }).select('ticketId status issueType category assignedEngineer createdAt updatedAt serviceFollowUpId'),
      ServiceFollowUp.find({ deviceId: device._id, _id: { $ne: followUp._id }, stage: { $ne: 'Superseded' } }).sort({ dueDate: -1 }).limit(5),
    ]);
    const activeTicket = tickets.find(ticket => ACTIVE_TICKET_STATUSES.includes(ticket.status)) || null;
    const item = describe({ device, followUp, centre: centreFor(device, centres), activeTicket, current: today(now, config.timeZone), now });
    const company = device.companyId && typeof device.companyId === 'object' ? device.companyId : null;
    return {
      ...item,
      contact: company ? { name: company.contactName, email: company.contactEmail, phone: company.phone } : null,
      contactLog: followUp.contactLog,
      tickets: tickets.slice(0, 10),
      previousCycles: history.map(cycle => ({ _id: String(cycle._id), dueDate: cycle.dueDate, stage: cycle.stage, completedAt: cycle.completedAt, notRequiredReason: cycle.notRequiredReason, closedAt: cycle.closedAt })),
      options: { contactMethods: CONTACT_METHODS, contactOutcomes: CONTACT_OUTCOMES, notRequiredReasons: NOT_REQUIRED_REASONS },
    };
  }

  // ------------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------------
  function requireStage(followUp, allowed) {
    if (!allowed.includes(followUp.stage)) throw new ProactiveServiceError(409, `This follow-up is ${followUp.stage.toLowerCase()} and can no longer be updated this way.`);
  }
  function requireDay(value, { allowToday, field }) {
    const day = futureDay(value, { now: clock(), allowToday, config });
    if (!day) throw new ProactiveServiceError(400, `${field} must be a valid date ${allowToday ? 'from today onwards' : 'after today'}.`);
    return day;
  }

  // Closing a cycle as not required moves the device's next recommended
  // date forward by one interval, so future cycles are still tracked.
  async function closeNotRequired(followUp, device, { reason, detail: extra }) {
    if (!NOT_REQUIRED_REASONS.includes(reason)) throw new ProactiveServiceError(400, 'Choose a reason from the list.');
    if (reason === 'Other' && !notes(extra)) throw new ProactiveServiceError(400, 'Add a short note explaining why service is not required.');
    const due = calendarDate(followUp.dueDate);
    const months = followUp.intervalMonths || device.serviceIntervalMonths || config.defaultIntervalMonths;
    followUp.stage = 'Not Required';
    followUp.notRequiredReason = reason;
    followUp.closedAt = clock();
    device.nextServiceDate = utcDate(addMonths(due, months));
    await Promise.all([followUp.save(), device.save()]);
    return { nextServiceDate: isoDay(addMonths(due, months)) };
  }

  async function notifyCorporateScheduled(followUp, device) {
    await notifyUsers({ users: await corporateRecipients(followUp.companyId), company: followUp.companyId, device, type: 'SERVICE_SCHEDULED', title: 'Service scheduled',
      message: `Preventive service for your ${device.model} (${device.serialNumber}) has been scheduled for ${followUp.scheduledDate}. Confirm it by requesting service.`,
      action: { type: 'SERVICE_RECOMMENDATION', route: `/corporate/raise-request?serviceFollowUp=${followUp._id}` } });
  }

  async function serviceAction(id, action, body = {}, user, scope = {}) {
    const { followUp, device } = await loadOwned(id, scope);
    const actor = await actorOf(user, 'iPlanet Service');
    if (action === 'contact') {
      requireStage(followUp, ACTIONABLE_BY_TEAM);
      if (!CONTACT_METHODS.includes(body.method)) throw new ProactiveServiceError(400, 'Choose how the customer was contacted.');
      if (!CONTACT_OUTCOMES.includes(body.outcome)) throw new ProactiveServiceError(400, 'Choose the outcome of the contact.');
      const entry = { ...actor, at: clock(), method: body.method, outcome: body.outcome, notes: notes(body.notes) };
      if (body.outcome === 'Customer Requested Later') {
        followUp.followUpDate = requireDay(body.followUpDate, { allowToday: false, field: 'Follow-up date' });
        followUp.followUpSetBy = 'iplanet_service';
        followUp.stage = 'Remind Later';
      } else if (body.outcome === 'Service Scheduled') {
        followUp.scheduledDate = requireDay(body.scheduledDate, { allowToday: true, field: 'Service date' });
        followUp.stage = 'Scheduled';
      } else {
        followUp.stage = 'Contacted';
      }
      followUp.contactLog.push(entry);
      await followUp.save();
      if (followUp.stage === 'Scheduled') await notifyCorporateScheduled(followUp, device);
    } else if (action === 'schedule') {
      requireStage(followUp, ACTIONABLE_BY_TEAM);
      followUp.scheduledDate = requireDay(body.scheduledDate, { allowToday: true, field: 'Service date' });
      followUp.stage = 'Scheduled';
      followUp.contactLog.push({ ...actor, at: clock(), method: CONTACT_METHODS.includes(body.method) ? body.method : undefined, outcome: 'Service Scheduled', notes: notes(body.notes) });
      await followUp.save();
      await notifyCorporateScheduled(followUp, device);
    } else if (action === 'remind-later') {
      requireStage(followUp, ACTIONABLE_BY_TEAM);
      followUp.followUpDate = requireDay(body.followUpDate, { allowToday: false, field: 'Follow-up date' });
      followUp.followUpSetBy = 'iplanet_service';
      followUp.stage = 'Remind Later';
      if (notes(body.notes)) followUp.contactLog.push({ ...actor, at: clock(), outcome: 'Reminder set', notes: notes(body.notes) });
      await followUp.save();
    } else if (action === 'mark-not-required') {
      requireStage(followUp, ACTIONABLE_BY_TEAM);
      followUp.contactLog.push({ ...actor, at: clock(), outcome: `Not required: ${body.reason}`, notes: notes(body.notes) });
      await closeNotRequired(followUp, device, { reason: body.reason, detail: body.notes });
    } else {
      throw new ProactiveServiceError(404, 'Unknown action');
    }
    return detail(id, scope);
  }

  async function corporateAction(id, action, body = {}, user) {
    const scope = { companyId: user.companyId };
    const { followUp, device } = await loadOwned(id, scope);
    requireStage(followUp, ACTIONABLE_BY_TEAM);
    const response = { ...(await actorOf(user, 'Corporate Admin')), at: clock(), notes: notes(body.notes) };
    const centreId = followUp.serviceCentreId || null;
    if (action === 'schedule-later') {
      followUp.followUpDate = requireDay(body.followUpDate, { allowToday: false, field: 'Reminder date' });
      followUp.followUpSetBy = 'corporate_admin';
      followUp.stage = 'Remind Later';
      followUp.customerResponse = { ...response, type: 'Schedule Later' };
      await followUp.save();
      await notifyUsers({ users: await serviceRecipients(centreId), company: followUp.companyId, device, serviceCentreId: centreId, type: 'PROACTIVE_SERVICE_RESPONSE', title: 'Customer asked to be reminded later',
        message: `${device.companyId?.name || 'The customer'} asked to be reminded on ${followUp.followUpDate} about preventive service for ${device.model} (${device.serialNumber}).`, action: { type: 'PROACTIVE_SERVICE', route: `/service/proactive?followUp=${followUp._id}` } });
    } else if (action === 'not-required') {
      followUp.customerResponse = { ...response, type: 'Not Required', reason: body.reason };
      const result = await closeNotRequired(followUp, device, { reason: body.reason, detail: body.notes });
      await notifyUsers({ users: await serviceRecipients(centreId), company: followUp.companyId, device, serviceCentreId: centreId, type: 'PROACTIVE_SERVICE_RESPONSE', title: 'Customer declined preventive service',
        message: `${device.companyId?.name || 'The customer'} marked preventive service for ${device.model} (${device.serialNumber}) as not required: ${body.reason}. Next recommended date ${result.nextServiceDate}.`, action: { type: 'PROACTIVE_SERVICE', route: '/service/proactive?view=completed' } });
    } else {
      throw new ProactiveServiceError(404, 'Unknown action');
    }
    return detail(id, scope);
  }

  // ------------------------------------------------------------------------
  // Ticket integration
  // ------------------------------------------------------------------------
  // Checks a follow-up id sent with a new service request. Ownership comes
  // from the database: same company as the caller and same device as the ticket.
  async function validateTicketLink(followUpId, { companyId, deviceId }) {
    if (!followUpId) return null;
    if (!/^[a-f0-9]{24}$/i.test(String(followUpId))) throw new ProactiveServiceError(400, 'Invalid service recommendation.');
    const followUp = await ServiceFollowUp.findOne({ _id: followUpId, companyId });
    if (!followUp || idString(followUp.deviceId) !== idString(deviceId)) throw new ProactiveServiceError(400, 'This service recommendation does not match the selected device.');
    requireStage(followUp, ACTIONABLE_BY_TEAM);
    return followUp;
  }

  async function linkTicket(followUp, ticket, user) {
    followUp.stage = 'In Service';
    followUp.ticketId = ticket._id;
    followUp.customerResponse = { type: 'Requested Service', at: clock(), ...(await actorOf(user, 'Corporate Admin')) };
    await followUp.save();
  }

  // A completed repair counts as a service: the device's last service becomes
  // the completion day, the explicit next date is cleared so the next cycle is
  // calculated from it, and any open cycle for the device is closed.
  async function onTicketCompleted(ticket) {
    const deviceId = idString(ticket.deviceId);
    // Buyback and e-waste requests end the device's use; they are not a service of it.
    if (!deviceId || NON_SERVICE_CATEGORIES.includes(ticket.category)) return;
    const now = clock();
    const completedOn = today(now, config.timeZone);
    await Device.updateOne({ _id: deviceId }, { $set: { lastServiceDate: utcDate(completedOn) }, $unset: { nextServiceDate: '' } });
    await ServiceFollowUp.updateMany({ deviceId, stage: { $in: ACTIVE_STAGES } }, { $set: { stage: 'Completed', completedAt: now, closedAt: now, ticketId: ticket._id } });
  }

  // The lifecycle for one device, including devices not yet in the service window.
  async function devicePlan(deviceId, scope = {}) {
    const device = await Device.findOne({ _id: deviceId, ...(scope.companyId ? { companyId: scope.companyId } : {}) }).populate('companyId', 'name location');
    if (!device) throw new ProactiveServiceError(404, 'Device not found');
    if (device.deviceStatus !== 'Retired') await sync({ deviceFilter: { _id: device._id } });
    const now = clock();
    const [centres, followUp, cycles, activeTicket] = await Promise.all([
      ServiceCentre.find({ status: 'Active' }),
      ServiceFollowUp.findOne({ deviceId: device._id, stage: { $in: ACTIVE_STAGES } }),
      ServiceFollowUp.find({ deviceId: device._id, stage: { $in: ['Completed', 'Not Required'] } }).sort({ dueDate: -1 }).limit(5),
      Ticket.findOne({ deviceId: device._id, status: { $in: ACTIVE_TICKET_STATUSES } }).select('ticketId status'),
    ]);
    const item = describe({ device, followUp, centre: centreFor(device, centres), activeTicket, current: today(now, config.timeZone), now });
    return { ...item, retired: device.deviceStatus === 'Retired', options: { notRequiredReasons: NOT_REQUIRED_REASONS }, previousCycles: cycles.map(cycle => ({ _id: String(cycle._id), dueDate: cycle.dueDate, stage: cycle.stage, completedAt: cycle.completedAt, notRequiredReason: cycle.notRequiredReason, ticketId: cycle.ticketId ? String(cycle.ticketId) : null })) };
  }

  // Service-side plan edits: interval, installation date or an explicit next date.
  async function updatePlan(deviceId, body = {}) {
    const device = await Device.findById(deviceId);
    if (!device) throw new ProactiveServiceError(404, 'Device not found');
    if (body.serviceIntervalMonths !== undefined) {
      const months = Number(body.serviceIntervalMonths);
      if (!Number.isInteger(months) || months < 1 || months > 60) throw new ProactiveServiceError(400, 'Service interval must be between 1 and 60 months.');
      device.serviceIntervalMonths = months;
    }
    if (body.installationDate !== undefined) {
      const cal = body.installationDate ? calendarDate(body.installationDate) : null;
      if (body.installationDate && (!cal || daysBetween(cal, today(clock(), config.timeZone)) < 0)) throw new ProactiveServiceError(400, 'Installation date must be a valid date that is not in the future.');
      device.installationDate = cal ? utcDate(cal) : undefined;
    }
    if (body.nextServiceDate !== undefined) {
      const cal = body.nextServiceDate ? calendarDate(body.nextServiceDate) : null;
      if (body.nextServiceDate && !cal) throw new ProactiveServiceError(400, 'Next service date must be a valid date.');
      device.nextServiceDate = cal ? utcDate(cal) : undefined;
    }
    await device.save();
    return devicePlan(device._id);
  }

  return { sync, list, detail, serviceAction, corporateAction, validateTicketLink, linkTicket, onTicketCompleted, devicePlan, updatePlan };
}
