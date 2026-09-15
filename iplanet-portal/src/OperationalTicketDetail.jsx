import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Bot, CheckCircle2, PauseCircle, Phone, Play, ShieldAlert, UserCheck, XCircle } from 'lucide-react';
import { ServiceShell } from './servicePages';
import { Badge, PageTitle } from './components';
import { assignEngineer, getEngineers, getServiceTicket, mediaUrl, serviceAction } from './api';
import { CallCustomerPanel } from './CallCustomerPanel';
import { AITroubleshootingPanel } from './AITroubleshootingPanel';

const actionLabels = { accept: 'Accept ticket', start: 'Start work', 'waiting-parts': 'Waiting for parts', complete: 'Mark completed', close: 'Close ticket' };
function InfoRow({ label, value }) { return <div className="info-row"><span>{label}</span><strong>{value || 'Not available'}</strong></div>; }

export function OperationalTicketDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [engineers, setEngineers] = useState([]);
  const [selectedEngineer, setSelectedEngineer] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selectedImage, setSelectedImage] = useState(null);
  const [callOpen, setCallOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const load = async () => { try { setError(''); const [ticketData, availableEngineers] = await Promise.all([getServiceTicket(id), getEngineers()]); setData(ticketData); setEngineers(availableEngineers); setSelectedEngineer(ticketData.ticket.assignedEngineerId?._id || ''); } catch (loadError) { setError(loadError.message || 'Unable to load ticket details.'); } };
  useEffect(() => { void load(); }, [id]);
  const assign = async () => { if (!selectedEngineer) return; setBusy(true); try { setError(''); await assignEngineer(id, selectedEngineer); await load(); } catch (assignError) { setError(assignError.message || 'Unable to assign engineer.'); } finally { setBusy(false); } };
  const act = async action => { setBusy(true); try { setError(''); await serviceAction(id, action, { note }); setNote(''); await load(); } catch (actionError) { setError(actionError.message || `Unable to perform ${actionLabels[action].toLowerCase()}.`); } finally { setBusy(false); } };
  if (!data) return <ServiceShell title="Ticket details"><div className="loading">{error || 'Loading ticket...'}</div></ServiceShell>;
  const { ticket, timeline, escalation } = data;
  const images = [...new Set([...(ticket.originalImages || ticket.images || []), ...(ticket.annotatedImages || [])])];
  const canAssign = ['Open', 'Engineer Assigned'].includes(ticket.status);
  const actions = ticket.status === 'Engineer Assigned' ? ['accept'] : ticket.status === 'Engineer Accepted' ? ['start'] : ticket.status === 'In Progress' ? ['waiting-parts', 'complete'] : ticket.status === 'Completed' ? ['close'] : [];
  const slaStatus = ticket.slaStatus || (ticket.escalationStatus === 'Not Escalated' ? 'Healthy' : ticket.escalationStatus) || 'Healthy';
  const elapsedTime = ticket.createdAt ? `${Math.max(0, Math.floor((Date.now() - new Date(ticket.createdAt).getTime()) / 3600000))} hours` : 'Not available';
  return <ServiceShell title="Ticket details">
    <Link className="back-link" to="/my-tickets"><ArrowLeft size={16} />Back to My Tickets</Link>
    <div className="ticket-header-row">
      <PageTitle title={ticket.ticketId} description={`${ticket.companyId?.name || ticket.customerId?.company || 'Corporate company'} · ${ticket.issueType}`} action={<Badge>{ticket.status}</Badge>} />
      <div className="header-call-action">
        <button type="button" className="button primary" onClick={() => setCallOpen(true)}><Phone size={16} />Call customer</button>
      </div>
    </div>
    {error && <p className="form-error request-error">{error}</p>}
    <div className="ticket-summary"><section className="panel info-card"><h3>Service information</h3><InfoRow label="Corporate" value={ticket.companyId?.name || ticket.customerId?.company} /><InfoRow label="Service Centre" value={ticket.serviceCentreId?.name || ticket.location} /><InfoRow label="Device" value={ticket.deviceId?.model} /><InfoRow label="Serial" value={ticket.deviceId?.serialNumber} /><InfoRow label="Priority" value={ticket.priority} /><InfoRow label="Engineer" value={ticket.assignedEngineer || 'Unassigned'} /></section><section className="panel issue-card"><span className="kicker">Issue</span><h3>{ticket.issueType}</h3><p>{ticket.description}</p><div className="upload-preview">{images.length ? images.map(image => <button type="button" key={image} className="image-thumb-button" onClick={() => setSelectedImage(mediaUrl(image))}><img src={mediaUrl(image)} alt="Reported issue" /></button>) : <span>No issue photos attached</span>}</div></section></div>{selectedImage && <div className="image-lightbox" role="dialog" aria-modal="true" onClick={() => setSelectedImage(null)}><button type="button" className="image-lightbox-close" aria-label="Close image preview" onClick={() => setSelectedImage(null)}>×</button><img src={selectedImage} alt="Ticket attachment preview" /></div>}
    <section className="panel coverage-detail"><div className="panel-heading"><div><span className="kicker">Coverage visibility</span><h3>Warranty & Coverage</h3></div><Badge>{data.coverage?.status || 'Not covered'}</Badge></div><div className="coverage-detail-grid"><InfoRow label="Warranty" value={`${data.coverage?.warrantyStatus || ticket.deviceId?.warrantyStatus || 'Not available'} · ${data.coverage?.warrantyExpiry?.slice?.(0, 10) || ticket.deviceId?.warrantyExpiry?.slice?.(0, 10) || ''}`} /><InfoRow label="AMC" value={`${data.coverage?.amcStatus || ticket.deviceId?.amcStatus || 'Not available'} · ${data.coverage?.amcExpiry?.slice?.(0, 10) || ticket.deviceId?.amcExpiry?.slice?.(0, 10) || ''}`} /><InfoRow label="Entitlements" value={data.coverage?.entitlements?.join(', ') || 'Not available'} /></div></section>
    <section className="panel escalation-card"><div className="escalation-icon"><ShieldAlert size={18} /></div><div className="sla-heading"><span className="kicker">SLA operational status</span><h3><Badge>{slaStatus}</Badge></h3><p>{ticket.escalationReason || (slaStatus === 'Healthy' ? 'SLA is within target.' : 'SLA requires attention.')}</p></div><div className="sla-table" role="table" aria-label="SLA details"><div className="sla-row" role="row"><span role="cell">Elapsed Time</span><strong role="cell">{elapsedTime}</strong></div><div className="sla-row" role="row"><span role="cell">Response Target</span><strong role="cell">{ticket.responseTarget || 'Not available'}</strong></div><div className="sla-row" role="row"><span role="cell">Resolution Target</span><strong role="cell">{ticket.resolutionTarget || 'Not available'}</strong></div><div className="sla-row" role="row"><span role="cell">SLA Target</span><strong role="cell">{ticket.slaTargetAt ? new Date(ticket.slaTargetAt).toLocaleString() : 'Not available'}</strong></div><div className="sla-row" role="row"><span role="cell">Escalation</span><strong role="cell">{ticket.escalationStatus || 'Not Escalated'} · Level {ticket.escalationLevel || 0}</strong></div><div className="sla-row" role="row"><span role="cell">Escalated At</span><strong role="cell">{ticket.escalatedAt ? new Date(ticket.escalatedAt).toLocaleString() : 'Not escalated'}</strong></div></div></section>
    <section className="panel service-update-panel"><span className="kicker">Update workflow</span><h3>Current status: {ticket.status}</h3>{canAssign && <div className="assign-row"><select value={selectedEngineer} onChange={event => setSelectedEngineer(event.target.value)}><option value="">Select an engineer</option>{engineers.map(engineer => <option key={engineer._id} value={engineer._id}>{engineer.name} · {engineer.employeeId} · {engineer.location} · {engineer.status}</option>)}</select><button type="button" className="button primary" disabled={!selectedEngineer || busy} onClick={assign}><UserCheck size={16} />Assign Engineer</button></div>}{ticket.assignedEngineer && <p className="workflow-assignee">Assigned engineer: <strong>{ticket.assignedEngineer}</strong></p>}{actions.length > 0 && <><label className="workflow-note">Update / comment<textarea className="service-note" value={note} onChange={event => setNote(event.target.value)} placeholder="Add a service note for the customer timeline" /></label><div className="action-row">{actions.map(action => <button type="button" key={action} className={`button ${action === 'complete' ? 'primary' : action === 'close' ? 'danger' : 'secondary'}`} disabled={busy} onClick={() => act(action)}>{action === 'accept' && <UserCheck size={16} />}{action === 'start' && <Play size={16} />}{action === 'waiting-parts' && <PauseCircle size={16} />}{action === 'complete' && <CheckCircle2 size={16} />}{action === 'close' && <XCircle size={16} />}{actionLabels[action]}</button>)}</div></>}</section>
    <section className="panel timeline-panel"><span className="kicker">Timeline</span><h3>Ticket history</h3><div className="timeline">{timeline.map((event, index) => <div className="timeline-item" key={`${event.status}-${index}`}><div className="timeline-dot"><CheckCircle2 size={14} /></div><div><strong>{event.status}</strong><p>{event.message}</p><small>{event.updatedBy || 'Service Desk'} · {event.timestamp ? new Date(event.timestamp).toLocaleString() : 'Recently'}</small></div></div>)}</div></section>
    <CallCustomerPanel ticket={ticket} open={callOpen} onClose={() => setCallOpen(false)} onSaved={() => void load()} />
    <AITroubleshootingPanel ticket={ticket} open={aiOpen} onClose={() => setAiOpen(false)} />
  </ServiceShell>;
}
