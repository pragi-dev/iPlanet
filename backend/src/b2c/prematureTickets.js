// Tickets created before tickets waited for customer registration: the ticket (and its
// reference number) was created as the email arrived, and a registration request was
// opened for it automatically. Read only: nothing is changed, deleted or re-routed. Requests
// that staff sent for an existing ticket (send_registration) are not counted: that ticket
// was created deliberately. Customer details are never listed.
//
// A ticket is reported when its registration request carries the ticket from creation
// (`ticketCreatedBy` unset) and was opened automatically, or when it was marked
// 'not_requested' (registration was needed but no email could be sent). `state`:
// - 'awaiting_registration': the customer has not completed registration (open, expired,
//   needs review, or never sent): a ticket that the current rules would not have created yet.
// - 'registered_later': registration completed afterwards and the ticket was continued.
export async function findPrematureTickets({ B2CEscalation, B2CRegistrationRequest, B2CAuditEvent }) {
  const requests = await B2CRegistrationRequest.find({ ticketId: { $type: 'objectId' }, ticketCreatedBy: null }).select('ticketId status reason createdAt').lean();
  const ticketIds = requests.map(request => request.ticketId);
  // Requests staff opened for an existing ticket are recorded as manual.
  const manual = new Set((await B2CAuditEvent.find({ ticketId: { $in: ticketIds }, action: 'registration_requested', 'details.manual': true }).select('ticketId').lean()).map(event => String(event.ticketId)));
  const automatic = requests.filter(request => !manual.has(String(request.ticketId)));
  // 'not_requested' set automatically is audited; a failed staff request is not.
  const notRequested = (await B2CAuditEvent.find({ ticketId: { $type: 'objectId' }, action: 'registration_not_requested' }).select('ticketId').lean()).map(event => event.ticketId);
  const tickets = await B2CEscalation.find({ $or: [{ _id: { $in: automatic.map(request => request.ticketId) } }, { _id: { $in: notRequested }, 'registration.status': 'not_requested' }] })
    .select('reference status registration.status registration.reason createdAt workflow.assignee.userId').sort({ createdAt: 1 }).lean();
  const byTicket = new Map(automatic.map(request => [String(request.ticketId), request]));
  return tickets.map(ticket => {
    const request = byTicket.get(String(ticket._id));
    const registrationStatus = request?.status || ticket.registration?.status || null;
    return {
      ticketId: String(ticket._id), reference: ticket.reference, ticketStatus: ticket.status, createdAt: ticket.createdAt,
      registrationStatus, registrationReason: request?.reason || ticket.registration?.reason || null, requestId: request ? String(request._id) : null,
      assigned: Boolean(ticket.workflow?.assignee?.userId),
      state: registrationStatus === 'completed' ? 'registered_later' : 'awaiting_registration',
    };
  });
}
