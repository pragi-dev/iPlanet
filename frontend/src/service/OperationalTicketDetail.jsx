import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, PauseCircle, Phone, Play, UserCheck, XCircle } from 'lucide-react';
import { ServiceShell } from './components';
import { assignEngineer, getEngineers, getServiceTicket, mediaUrl, serviceAction } from './api';
import { CallCustomerPanel } from './CallCustomerPanel';
import { Badge, Button, Card, CoverageTiles, DeviceIcon, ErrorState, Evidence, Field, InfoList, InlineAlert, Lightbox, Modal, PageSkeleton, SLAPanel, Timeline, Workflow, formatDate, formatDateTime, friendlyError, slaLabel, useAsync } from '../ui';

// Valid next actions per status, mirroring the backend transition table.
const actionsByStatus = {
  'Engineer Assigned': ['accept'],
  'Engineer Accepted': ['start'],
  'In Progress': ['waiting-parts', 'complete'],
  'Waiting for Parts': ['start'],
  Completed: ['close'],
};
const actionMeta = {
  accept: { label: 'Accept ticket', icon: UserCheck, variant: 'primary' },
  start: { label: 'Start work', icon: Play, variant: 'primary' },
  'waiting-parts': { label: 'Waiting for parts', icon: PauseCircle, variant: 'secondary' },
  complete: { label: 'Mark completed', icon: CheckCircle2, variant: 'primary' },
  close: { label: 'Close ticket', icon: XCircle, variant: 'primary' },
};

export function OperationalTicketDetail() {
  const { id } = useParams();
  const state = useAsync(() => Promise.all([getServiceTicket(id), getEngineers()]).then(([ticketData, engineers]) => ({ ...ticketData, engineers })), [id]);
  const [selectedEngineer, setSelectedEngineer] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selectedImage, setSelectedImage] = useState(null);
  const [callOpen, setCallOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const crumbs = [{ label: 'Tickets', to: '/service/tickets' }, { label: state.data?.ticket?.ticketId || 'Ticket details' }];

  if (state.loading && !state.data) return <ServiceShell title="Ticket details" crumbs={crumbs}><PageSkeleton variant="detail" /></ServiceShell>;
  if (state.error && !state.data) return <ServiceShell title="Ticket details" crumbs={crumbs}><div className="card"><ErrorState title="Unable to load this ticket" message={friendlyError(state.error)} onRetry={state.reload} /></div></ServiceShell>;

  const { ticket, timeline, engineers, coverage, escalationContact, callHistory } = state.data;
  const device = ticket.deviceId || {};
  const canAssign = ['Open', 'Engineer Assigned'].includes(ticket.status);
  const actions = actionsByStatus[ticket.status] || [];
  const currentEngineer = ticket.assignedEngineerId?._id || '';
  const engineerChoice = selectedEngineer || currentEngineer;

  const refresh = () => state.reload({ silent: true });
  const assign = async () => {
    if (!engineerChoice) return;
    setBusy(true);
    setError('');
    try { await assignEngineer(id, engineerChoice); setSelectedEngineer(''); await refresh(); }
    catch (assignError) { setError(friendlyError(assignError, 'Unable to assign engineer.')); }
    finally { setBusy(false); }
  };
  const act = async action => {
    setBusy(true);
    setError('');
    try { await serviceAction(id, action, { note }); setNote(''); setConfirmClose(false); await refresh(); }
    catch (actionError) { setError(friendlyError(actionError, `Unable to ${actionMeta[action].label.toLowerCase()}.`)); }
    finally { setBusy(false); }
  };
  const labelFor = action => action === 'start' && ticket.status === 'Waiting for Parts' ? 'Resume work' : actionMeta[action].label;

  return <ServiceShell title={ticket.ticketId} crumbs={crumbs}>
    <div className="page-header">
      <Link className="back-link" to="/service/tickets"><ArrowLeft size={15} aria-hidden="true" />Tickets</Link>
      <div className="page-header-row">
        <div className="page-header-text">
          <p className="eyebrow">{ticket.companyId?.name || ticket.customerId?.company || 'Corporate'} · {ticket.category || 'Service'}</p>
          <h1 className="page-title mono" style={{ fontSize: 26 }}>{ticket.ticketId}</h1>
          <div className="page-meta"><Badge dot>{ticket.status}</Badge><Badge>{`${ticket.priority || 'Medium'} priority`}</Badge><Badge>{`SLA: ${slaLabel(ticket)}`}</Badge><span>{ticket.issueType}{ticket.location ? ` · ${ticket.location}` : ''}</span></div>
        </div>
        <div className="page-actions">
          <Button icon={Phone} onClick={() => setCallOpen(true)}>Call customer</Button>
          {actions.map(action => { const meta = actionMeta[action]; return <Button key={action} variant={meta.variant} icon={meta.icon} disabled={busy} onClick={() => action === 'close' ? setConfirmClose(true) : act(action)}>{labelFor(action)}</Button>; })}
        </div>
      </div>
    </div>
    {error && <InlineAlert title={error} action={<Button size="sm" variant="ghost" onClick={() => setError('')}>Dismiss</Button>} />}

    <div className="summary-strip">
      <div><span className="summary-label">Engineer</span><span className="summary-value">{ticket.assignedEngineer || 'Unassigned'}</span></div>
      <div><span className="summary-label">Created</span><span className="summary-value">{formatDateTime(ticket.createdAt)}</span></div>
      <div><span className="summary-label">Resolve by</span><span className="summary-value">{formatDateTime(ticket.slaTargetAt)}</span></div>
      <div><span className="summary-label">Coverage</span><span className="summary-value"><Badge>{coverage?.status || 'Not available'}</Badge></span></div>
    </div>

    <div className="detail-layout">
      <div className="detail-main">
        <Card title="Request summary">
          <InfoList columns={2} items={[['Corporate', ticket.companyId?.name || ticket.customerId?.company], ['Contact person', ticket.customerId?.name], ['Contact phone', ticket.customerId?.phone || ticket.companyId?.phone], ['Service centre', ticket.serviceCentreId?.name], ['Issue type', ticket.issueType], ['Service location', ticket.location], ['Preferred date', formatDate(ticket.preferredServiceDate, '')], ['Expected TAT', ticket.expectedTAT]]} />
        </Card>
        <Card title="Device information">
          <div className="stack-12">
            <div className="person-cell"><span className="asset-icon" style={{ width: 40, height: 40 }}><DeviceIcon type={device.deviceType} model={device.model} /></span><div><strong>{device.model || 'Device'}</strong><span className="cell-sub mono">{device.serialNumber}</span></div></div>
            <InfoList columns={2} items={[['Asset ID', device.assetId], ['Device type', device.deviceType], ['Employee', device.employeeName], ['Department', device.department]]} />
          </div>
        </Card>
        <Card title="Issue details"><p className="description-text">{ticket.description || 'No description provided.'}</p></Card>
        <Card title="Issue evidence" description="Original photos and customer damage annotations"><Evidence ticket={ticket} resolve={mediaUrl} onOpen={setSelectedImage} /></Card>
        <Card title="Timeline"><Timeline events={timeline} /></Card>
      </div>

      <aside className="detail-side">
        <Card title="Workflow" description={`Current status: ${ticket.status}`}>
          <div className="stack-16">
            {canAssign && <div className="assign-row">
              <Field label={ticket.assignedEngineer ? 'Reassign engineer' : 'Assign engineer'}>{props => <select {...props} value={engineerChoice} onChange={event => setSelectedEngineer(event.target.value)}><option value="">Select an engineer</option>{engineers.map(engineer => <option key={engineer._id} value={engineer._id}>{engineer.name} · {engineer.location} · {engineer.assignedTicketCount} active · {engineer.status}</option>)}</select>}</Field>
              <Button variant="primary" icon={UserCheck} className="btn-lg" disabled={!engineerChoice || busy || engineerChoice === currentEngineer} onClick={assign}>Assign</Button>
            </div>}
            {actions.length > 0 && <Field label="Update note" hint="Added to the customer-visible timeline with the next action.">{props => <textarea {...props} value={note} onChange={event => setNote(event.target.value)} placeholder="e.g. Diagnosed faulty display cable; replacement ordered." style={{ minHeight: 88 }} />}</Field>}
            {actions.length > 0 && <div className="action-buttons">{actions.map(action => { const meta = actionMeta[action]; return <Button key={action} variant={meta.variant} icon={meta.icon} disabled={busy} onClick={() => action === 'close' ? setConfirmClose(true) : act(action)}>{labelFor(action)}</Button>; })}</div>}
            {ticket.status === 'Open' && !ticket.assignedEngineer && <p className="text-muted text-small">Assign an engineer to start the workflow.</p>}
            {ticket.status === 'Closed' && <p className="text-muted text-small">This ticket is closed. No further actions are available.</p>}
            <hr className="divider" />
            <Workflow ticket={ticket} timeline={timeline} />
          </div>
        </Card>
        <Card title="SLA & escalation"><SLAPanel ticket={ticket} contact={escalationContact} showElapsed /></Card>
        <Card title="Warranty & coverage"><CoverageTiles device={{ warrantyStatus: coverage?.warrantyStatus || device.warrantyStatus, warrantyExpiry: coverage?.warrantyExpiry || device.warrantyExpiry, amcStatus: coverage?.amcStatus || device.amcStatus, amcExpiry: coverage?.amcExpiry || device.amcExpiry }} entitlements={coverage?.entitlements || []} /></Card>
        <Card title="Call history" actions={<Button size="sm" variant="ghost" icon={Phone} onClick={() => setCallOpen(true)}>Log call</Button>}>
          {callHistory?.length ? <ul className="stack-12">{callHistory.slice(0, 4).map(call => <li key={call._id} className="stack-8" style={{ gap: 2 }}>
            <span className="row"><strong style={{ fontSize: 13 }}>{call.outcome}</strong></span>
            <span className="text-muted text-small">{call.agentName || 'Service agent'} · {formatDateTime(call.createdAt)}</span>
            {call.notes && <span className="text-small">{call.notes}</span>}
          </li>)}</ul> : <p className="text-muted text-small">No calls logged yet.</p>}
        </Card>
      </aside>
    </div>

    {selectedImage && <Lightbox src={selectedImage} alt="Ticket attachment preview" onClose={() => setSelectedImage(null)} />}
    {confirmClose && <Modal size="sm" title={`Close ${ticket.ticketId}?`} description="Closing ends the service workflow and asks the customer to review the service. This cannot be undone." onClose={() => setConfirmClose(false)}
      footer={<><Button onClick={() => setConfirmClose(false)}>Cancel</Button><Button variant="primary" icon={XCircle} disabled={busy} onClick={() => act('close')}>{busy ? 'Closing…' : 'Close ticket'}</Button></>}>
      {note ? <InfoList items={[['Closing note', note]]} /> : <p className="text-muted text-small">No note added. The default closure message will be recorded.</p>}
    </Modal>}
    <CallCustomerPanel ticket={ticket} open={callOpen} onClose={() => setCallOpen(false)} onSaved={refresh} />
  </ServiceShell>;
}
