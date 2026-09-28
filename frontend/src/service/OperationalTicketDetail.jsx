import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, ChevronLeft, PauseCircle, Phone, Play, UserCheck, UserPlus, XCircle } from 'lucide-react';
import { ServiceShell } from './components';
import { getEngineers, getServiceTicket, getServiceTickets, mediaUrl, serviceAction } from './api';
import { CallCustomerPanel } from './CallCustomerPanel';
import { EngineerAssignDrawer } from './EngineerAssignDrawer';
import {
  ActivityTimeline, Avatar, Badge, Button, ConfirmDialog, CoverageTiles, DeviceIcon, ErrorState, Evidence, Field, InfoList, InlineAlert, Insight, Lightbox, NextAction, PageSkeleton,
  SLAPanel, Section, ServiceJourney, Surface, formatDate, formatTat, formatDateTime, formatRelative, friendlyError, idOf, pluralize, recurringIssues, riskLabel, riskTone, slaBadgeText, slaLabel, slaRisk, statusTone,
  suggestEngineer, useAsync,
} from '../ui';

// Labels for the workflow endpoints; availability per status mirrors the
// backend transition table, so only valid transitions are ever offered.
const actionMeta = {
  accept: { label: 'Accept ticket', icon: UserCheck },
  start: { label: 'Start work', icon: Play },
  'waiting-parts': { label: 'Waiting for parts', icon: PauseCircle },
  complete: { label: 'Mark completed', icon: CheckCircle2 },
  close: { label: 'Close ticket', icon: XCircle },
};

function serviceNextAction(ticket, engineers, handlers) {
  const engineer = ticket.assignedEngineer;
  const since = value => (value ? formatRelative(value) : null);
  const workflow = action => ({ label: action === 'start' && ticket.status === 'Waiting for Parts' ? 'Resume work' : actionMeta[action].label, icon: actionMeta[action].icon, onClick: () => handlers.act(action), disabled: handlers.busy });
  let next;
  switch (ticket.status) {
    case 'Open': {
      const suggestion = suggestEngineer(engineers, ticket);
      next = { tone: 'warning', title: 'Engineer assignment required', description: suggestion ? `No engineer assigned yet. ${suggestion.engineer.name} is available in ${suggestion.engineer.location} with ${pluralize(suggestion.engineer.assignedTicketCount || 0, 'open ticket')}.` : 'No engineer assigned yet. Choose one by location, availability and workload.', actions: [{ label: 'Assign engineer', icon: UserPlus, onClick: handlers.openAssign }], workflow: false };
      break;
    }
    case 'Engineer Assigned':
      next = { tone: 'info', title: `Waiting for ${engineer || 'the engineer'} to accept`, description: `Assigned ${since(ticket.assignedAt) || 'recently'}. Record acceptance once the engineer confirms.`, actions: [workflow('accept'), { label: 'Reassign', icon: UserPlus, onClick: handlers.openAssign, secondary: true }], workflow: true };
      break;
    case 'Engineer Accepted':
      next = { tone: 'info', title: 'Ready to start work', description: `${engineer || 'The engineer'} accepted this ticket. Start work when the repair begins.`, actions: [workflow('start')], workflow: true };
      break;
    case 'In Progress':
      next = { tone: 'info', title: 'Repair in progress', description: `${engineer || 'The engineer'} is working on this device. Mark it completed once repaired and tested, or pause it while parts are ordered.`, actions: [workflow('complete'), { ...workflow('waiting-parts'), secondary: true }], workflow: true };
      break;
    case 'Waiting for Parts':
      next = { tone: 'warning', eyebrow: 'On hold', title: 'Paused — waiting for parts', description: `Paused ${since(ticket.updatedAt) || 'recently'}. Resume work when the parts arrive.`, actions: [workflow('start')], workflow: true };
      break;
    case 'Completed':
      next = { tone: 'success', title: 'Repair completed — ready to close', description: 'Closing ends the workflow, notifies the customer and asks them to rate the service.', actions: [{ label: 'Close ticket', icon: XCircle, onClick: handlers.openClose, disabled: handlers.busy }], workflow: true };
      break;
    default:
      next = { tone: 'neutral', eyebrow: 'Status', title: 'Ticket closed', description: 'No further actions are available. The customer was asked to review the service when it closed.', actions: [], workflow: false };
  }
  const risk = slaRisk(ticket);
  if (risk) {
    next.tone = riskTone(risk);
    next.eyebrow = `${riskLabel(risk)} · Next action`;
    next.description = `${ticket.slaTargetAt ? `Resolution target ${formatDateTime(ticket.slaTargetAt)}. ` : ''}${next.description}`;
    if (!next.actions.some(action => action.label === 'Call customer')) next.actions = [...next.actions, { label: 'Call customer', icon: Phone, onClick: handlers.openCall, secondary: true }];
  }
  return next;
}

export function OperationalTicketDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const state = useAsync(() => Promise.all([getServiceTicket(id), getEngineers()]).then(([ticketData, engineers]) => ({ ...ticketData, engineers })), [id]);
  const serial = state.data?.ticket?.deviceId?.serialNumber;
  // Other tickets for the same device, used for the recurring-issue insight.
  const history = useAsync(() => (serial ? getServiceTickets({ search: serial }) : Promise.resolve([])), [serial]);
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedImage, setSelectedImage] = useState(null);
  const [callOpen, setCallOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const crumbs = [{ label: 'Tickets', to: '/service/tickets' }, { label: state.data?.ticket?.ticketId || 'Ticket details' }];

  const canAssign = ['Open', 'Engineer Assigned'].includes(state.data?.ticket?.status);
  useEffect(() => {
    if (params.get('assign') !== '1' || !state.data) return;
    if (canAssign) setAssignOpen(true);
    setParams({}, { replace: true });
  }, [params, state.data, canAssign, setParams]);

  if (state.loading && !state.data) return <ServiceShell title="Ticket details" crumbs={crumbs}><PageSkeleton variant="detail" kpis={0} /></ServiceShell>;
  if (state.error && !state.data) return <ServiceShell title="Ticket details" crumbs={crumbs}><div className="card"><ErrorState title="Unable to load this ticket" message={friendlyError(state.error)} onRetry={state.reload} /></div></ServiceShell>;

  const { ticket, timeline, engineers, coverage, escalationContact, callHistory } = state.data;
  const device = ticket.deviceId || {};
  const engineer = ticket.assignedEngineerId && typeof ticket.assignedEngineerId === 'object' ? ticket.assignedEngineerId : null;
  const company = ticket.companyId?.name || ticket.customerId?.company || 'Corporate';
  const refresh = () => state.reload({ silent: true });

  const act = async action => {
    setBusy(true);
    setError('');
    try {
      await serviceAction(id, action, { note });
      setNote(''); setNoteOpen(false); setConfirmClose(false);
      const done = { accept: 'accepted', start: ticket.status === 'Waiting for Parts' ? 'resumed' : 'started', 'waiting-parts': 'paused for parts', complete: 'marked completed', close: 'closed' }[action];
      setNotice(`${ticket.ticketId} ${done}.`);
      await refresh();
    } catch (actionError) { setError(friendlyError(actionError, `Unable to ${actionMeta[action].label.toLowerCase()}.`)); }
    finally { setBusy(false); }
  };
  const next = serviceNextAction(ticket, engineers, { act, busy, openAssign: () => setAssignOpen(true), openClose: () => setConfirmClose(true), openCall: () => setCallOpen(true) });
  const recurring = recurringIssues((history.data || []).filter(item => idOf(item.deviceId) === idOf(ticket.deviceId)), { windowDays: 0 }).find(group => group.issueType === ticket.issueType);

  return <ServiceShell title={ticket.ticketId} crumbs={crumbs}>
    <header className="case-header">
      <Link className="back-link" to="/service/tickets"><ChevronLeft size={16} aria-hidden="true" />Tickets</Link>
      <div className="case-header-row">
        <div className="page-header-text">
          <p className="case-id mono">{ticket.ticketId}</p>
          <h1 className="case-title">{ticket.issueType || 'Service request'}</h1>
          <p className="case-sub">{[company, ticket.location].filter(Boolean).join(' · ')}</p>
          <div className="case-badges"><Badge dot>{ticket.status}</Badge><Badge>{`${ticket.priority || 'Medium'} priority`}</Badge><Badge tone={statusTone(slaLabel(ticket))}>{slaBadgeText(ticket)}</Badge></div>
        </div>
        <div className="page-actions"><Button icon={Phone} onClick={() => setCallOpen(true)}>Call customer</Button></div>
      </div>
    </header>

    {notice && <InlineAlert tone="success" title={notice} action={<Button size="sm" variant="ghost" onClick={() => setNotice('')}>Dismiss</Button>} />}
    {error && <InlineAlert title={error} action={<Button size="sm" variant="ghost" onClick={() => setError('')}>Dismiss</Button>} />}

    <NextAction tone={next.tone} eyebrow={next.eyebrow} title={next.title} description={next.description} actions={next.actions}>
      {next.workflow && next.actions.length > 0 && (noteOpen
        ? <div className="next-action-extra"><Field label="Update note" hint="Recorded on the timeline with the next action and visible to the customer.">{props => <textarea {...props} value={note} onChange={event => setNote(event.target.value)} placeholder="e.g. Diagnosed faulty display cable; replacement ordered." style={{ minHeight: 80 }} data-autofocus />}</Field></div>
        : <button type="button" className="btn-link text-small next-action-extra" style={{ width: 'fit-content' }} onClick={() => setNoteOpen(true)}>Add an update note</button>)}
    </NextAction>

    <div className="workspace">
      <div className="workspace-main">
        <Surface label="Service case">
          <Section stacked title="Issue" description={ticket.category ? `${ticket.category} request` : undefined}>
            <p className="description-text">{ticket.description || 'No description provided.'}</p>
          </Section>
          <Section stacked title="Device">
            <div className="stack-16">
              <div className="row-between">
                <div className="person-cell"><span className="thumb thumb-lg"><DeviceIcon type={device.deviceType} model={device.model} /></span><div><strong>{device.model || 'Device'}</strong><span className="cell-sub mono">{device.serialNumber}</span></div></div>
                {device.serialNumber && <Link className="row-action" to={`/service/tickets?search=${encodeURIComponent(device.serialNumber)}`}>All tickets for this device</Link>}
              </div>
              {recurring && <Insight title={`${pluralize(recurring.count, `${recurring.issueType} request`)} for this device`}>Raised on {recurring.tickets.map(item => formatDate(item.createdAt)).join(', ')}. Consider checking for an underlying fault during this repair.</Insight>}
              <InfoList columns={2} items={[['Asset ID', device.assetId], ['Device type', device.deviceType], ['Employee', device.employeeName], ['Department', device.department]]} />
            </div>
          </Section>
          <Section stacked title="Service information">
            <InfoList columns={2} items={[['Corporate', company], ['Contact person', ticket.customerId?.name], ['Contact phone', ticket.customerId?.phone || ticket.companyId?.phone], ['Service centre', ticket.serviceCentreId?.name], ['Service location', ticket.location], ['Preferred date', formatDate(ticket.preferredServiceDate, '')], ['Raised', formatDateTime(ticket.createdAt, '')], ['Expected TAT', formatTat(ticket.expectedTAT)]]} />
          </Section>
          <Section stacked title="Evidence" description="Original photos and customer damage markings"><Evidence ticket={ticket} resolve={mediaUrl} onOpen={setSelectedImage} /></Section>
          <Section stacked title="Timeline" description="Every update, newest first"><ActivityTimeline events={timeline} limit={6} /></Section>
        </Surface>
      </div>

      <aside className="workspace-side" aria-label="Case status">
        <div className="card">
          <section className="side-section" aria-label="Service journey"><p className="side-section-title">Service journey</p><ServiceJourney ticket={ticket} timeline={timeline} /></section>
          <section className="side-section" aria-label="Engineer">
            <div className="side-section-head"><p className="side-section-title">Engineer</p>{canAssign && ticket.assignedEngineer && <Button size="sm" variant="ghost" onClick={() => setAssignOpen(true)}>Reassign</Button>}</div>
            {ticket.assignedEngineer ? <div className="person-block"><Avatar name={ticket.assignedEngineer} size={40} /><div><strong>{ticket.assignedEngineer}</strong><small>{[engineer?.location, engineer?.phone].filter(Boolean).join(' · ') || 'Assigned engineer'}</small>{ticket.assignedAt && <small>Assigned {formatDateTime(ticket.assignedAt)}</small>}</div></div>
              : <div className="stack-12"><p className="text-muted text-small">No engineer assigned yet.</p>{canAssign && <div><Button size="sm" variant="primary" icon={UserPlus} onClick={() => setAssignOpen(true)}>Assign engineer</Button></div>}</div>}
          </section>
          <section className="side-section" aria-label="SLA"><p className="side-section-title">SLA</p><SLAPanel ticket={ticket} contact={escalationContact} showElapsed /></section>
          <section className="side-section" aria-label="Warranty and coverage"><p className="side-section-title">Warranty &amp; coverage</p><CoverageTiles device={{ warrantyStatus: coverage?.warrantyStatus || device.warrantyStatus, warrantyExpiry: coverage?.warrantyExpiry || device.warrantyExpiry, amcStatus: coverage?.amcStatus || device.amcStatus, amcExpiry: coverage?.amcExpiry || device.amcExpiry }} entitlements={coverage?.entitlements || []} /></section>
          <section className="side-section" aria-label="Call history">
            <div className="side-section-head"><p className="side-section-title">Call history</p><Button size="sm" variant="ghost" icon={Phone} onClick={() => setCallOpen(true)}>Log call</Button></div>
            {callHistory?.length ? <ul className="call-list">{callHistory.slice(0, 4).map(call => <li key={call._id}>
              <strong>{call.outcome}</strong>
              <span>{call.agentName || 'Service agent'} · {formatDateTime(call.createdAt)}</span>
              {call.notes && <p>{call.notes}</p>}
            </li>)}</ul> : <p className="text-muted text-small">No calls logged yet.</p>}
          </section>
        </div>
      </aside>
    </div>

    {selectedImage && <Lightbox src={selectedImage} alt="Ticket attachment preview" onClose={() => setSelectedImage(null)} />}
    {confirmClose && <ConfirmDialog title={`Close ${ticket.ticketId}?`} description="Closing ends the service workflow and asks the customer to review the service. This cannot be undone." confirmLabel="Close ticket" busy={busy} onConfirm={() => act('close')} onClose={() => setConfirmClose(false)}>
      {note ? <InfoList items={[['Closing note', note]]} /> : <p className="text-muted text-small">No note added. The default closure message will be recorded.</p>}
    </ConfirmDialog>}
    {assignOpen && <EngineerAssignDrawer ticket={ticket} engineers={engineers} onClose={() => setAssignOpen(false)} onAssigned={chosen => { setAssignOpen(false); setNotice(`${chosen?.name || 'Engineer'} assigned to ${ticket.ticketId}.`); void refresh(); }} />}
    <CallCustomerPanel ticket={ticket} open={callOpen} onClose={() => setCallOpen(false)} onSaved={refresh} />
  </ServiceShell>;
}
