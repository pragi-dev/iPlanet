// Corporate customers review iPlanet's service once per calendar month (India time),
// covering every request closed that month. A month can be reviewed once it has
// ended, and each company gives one review per month.
const INDIA_TIME_ZONE = 'Asia/Kolkata';
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export const isPeriod = value => PERIOD_PATTERN.test(String(value || ''));

export function periodOf(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: INDIA_TIME_ZONE, year: 'numeric', month: '2-digit' }).formatToParts(new Date(date)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}`;
}

export function previousPeriod(period) {
  const [year, month] = period.split('-').map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

export const periodEnded = (period, now = new Date()) => period < periodOf(now);
export const periodLabel = period => new Date(`${period}-15T00:00:00Z`).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// Closed requests for a company, each with the time it was closed. Older tickets have no
// closedAt, so the Closed timeline entry (or the last update) stands in for it.
async function closedTickets({ Ticket, TicketTimeline }, companyId) {
  const tickets = await Ticket.find({ companyId, status: 'Closed' }).populate('serviceCentreId', 'name').lean();
  const missing = tickets.filter(ticket => !ticket.closedAt).map(ticket => ticket._id);
  const closedEntries = missing.length ? await TicketTimeline.find({ ticketId: { $in: missing }, status: 'Closed' }).sort({ timestamp: -1 }).lean() : [];
  const closedFromTimeline = new Map();
  for (const entry of closedEntries) if (!closedFromTimeline.has(String(entry.ticketId))) closedFromTimeline.set(String(entry.ticketId), entry.timestamp);
  return tickets.map(ticket => ({ ...ticket, closedAt: ticket.closedAt || closedFromTimeline.get(String(ticket._id)) || ticket.updatedAt }));
}

function summarise(period, tickets, review, now) {
  const ended = periodEnded(period, now);
  return {
    period,
    label: periodLabel(period),
    ended,
    reviewable: ended && !review,
    ticketCount: tickets.length,
    tickets: tickets.sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt)).map(ticket => ({ _id: ticket._id, ticketId: ticket.ticketId, category: ticket.category, issueType: ticket.issueType, closedAt: ticket.closedAt, serviceCentre: ticket.serviceCentreId?.name || ticket.location || null })),
    review: review || null,
  };
}

// Every month in which the company had a request closed, newest first.
export async function reviewPeriods(models, companyId, now = new Date()) {
  const tickets = await closedTickets(models, companyId);
  const byPeriod = new Map();
  for (const ticket of tickets) {
    const period = periodOf(ticket.closedAt);
    byPeriod.set(period, [...(byPeriod.get(period) || []), ticket]);
  }
  const reviews = await models.Review.find({ corporateId: companyId, period: { $in: [...byPeriod.keys()] } }).populate('customerId', 'name').lean();
  const reviewByPeriod = new Map(reviews.map(review => [review.period, review]));
  return [...byPeriod.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([period, items]) => summarise(period, items, reviewByPeriod.get(period), now));
}

export async function reviewPeriod(models, companyId, period, now = new Date()) {
  return (await reviewPeriods(models, companyId, now)).find(item => item.period === period) || null;
}

// The period a closed ticket is reviewed under.
export async function ticketReviewPeriod(models, ticket) {
  if (ticket.status !== 'Closed') return null;
  const closedAt = ticket.closedAt || (await models.TicketTimeline.findOne({ ticketId: ticket._id, status: 'Closed' }).sort({ timestamp: -1 }).lean())?.timestamp || ticket.updatedAt;
  return periodOf(closedAt);
}

// Once a month has ended, ask each company that had requests closed in it for a review.
// Safe to run repeatedly: one notification per admin per month, none once reviewed.
export async function notifyMonthlyReviewRequests(models, now = new Date()) {
  const { Company, User, Notification, Review } = models;
  const period = previousPeriod(periodOf(now));
  const companies = await Company.find().select('_id').lean();
  let sent = 0;
  for (const company of companies) {
    const summary = await reviewPeriod(models, company._id, period, now);
    if (!summary || summary.review) continue;
    if (await Review.exists({ corporateId: company._id, period })) continue;
    const admins = await User.find({ companyId: company._id, role: 'corporate_admin' }).select('_id').lean();
    for (const admin of admins) {
      if (await Notification.exists({ user: admin._id, type: 'RATE_SERVICE', 'action.period': period })) continue;
      await Notification.create({ user: admin._id, company: company._id, portalRole: 'corporate_admin', type: 'RATE_SERVICE', title: `Rate your ${summary.label} service`, message: `${summary.ticketCount} service request${summary.ticketCount === 1 ? ' was' : 's were'} closed in ${summary.label}. Tell iPlanet how the month went.`, action: { type: 'RATE_SERVICE', period, route: `/corporate/reviews/${period}` }, read: false });
      sent += 1;
    }
  }
  return sent;
}

export function startMonthlyReviewScheduler(models, { intervalMinutes = 60, logger = console } = {}) {
  const run = () => notifyMonthlyReviewRequests(models).then(sent => { if (sent) logger.info?.(`[Reviews] Sent ${sent} monthly review request${sent === 1 ? '' : 's'}.`); }).catch(error => logger.error?.(`[Reviews] Monthly review requests failed: ${error.message}`));
  run();
  const timer = setInterval(run, intervalMinutes * 60000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
