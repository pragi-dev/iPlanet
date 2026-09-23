import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, Sparkles, Star } from 'lucide-react';
import { Shell } from './components';
import { getTicket, mediaUrl } from './api';
import { Badge, Button, CoverageTiles, DeviceIcon, ErrorState, Evidence, InfoList, Lightbox, PageHeader, PageSkeleton, SLAPanel, Section, Surface, Timeline, Workflow, formatDate, formatDateTime, friendlyError, slaBadgeText, slaLabel, statusTone, useAIAssistant, useAsync } from '../ui';

export function TicketDetailEnhanced() {
  const { id } = useParams();
  const ai = useAIAssistant();
  const state = useAsync(() => getTicket(id), [id]);
  const [selectedImage, setSelectedImage] = useState(null);
  const crumbs = [{ label: 'Service Requests', to: '/corporate/service-requests' }, { label: state.data?.ticket?.ticketId || 'Request details' }];

  if (state.loading && !state.data) return <Shell title="Request details" crumbs={crumbs}><PageSkeleton variant="detail" kpis={0} /></Shell>;
  if (state.error) return <Shell title="Request details" crumbs={crumbs}><PageHeader title="Request details" back={{ to: '/corporate/service-requests', label: 'Service Requests' }} /><div className="card"><ErrorState title={state.error.status === 404 ? 'Request not found' : 'Unable to load this request'} message={friendlyError(state.error)} onRetry={state.reload} /></div></Shell>;

  const { ticket, timeline, escalation, escalationContact } = state.data;
  const device = ticket.deviceId || {};
  const engineer = ticket.assignedEngineerId && typeof ticket.assignedEngineerId === 'object' ? ticket.assignedEngineerId : null;

  return <Shell title={ticket.ticketId} crumbs={crumbs}>
    <div className="page-header">
      <Link className="back-link" to="/corporate/service-requests"><ChevronLeft size={16} aria-hidden="true" />Service Requests</Link>
      <div className="page-header-row">
        <div className="page-header-text">
          <p className="eyebrow">{ticket.category || 'Service'} request · {ticket.issueType}</p>
          <h1 className="page-title">Ticket <span className="mono" style={{ fontSize: '0.86em' }}>#{ticket.ticketId}</span></h1>
          <div className="page-meta"><Badge dot>{ticket.status}</Badge><Badge tone={statusTone(slaLabel(ticket))}>{slaBadgeText(ticket)}</Badge><Badge>{`${ticket.priority || 'Medium'} priority`}</Badge></div>
        </div>
        <div className="page-actions">
          <Button icon={Sparkles} onClick={ai.open}>Get help</Button>
          {state.data.reviewEligible && <Button variant="primary" icon={Star} to={`/corporate/reviews/${ticket._id}`}>Rate our service</Button>}
          {state.data.reviewSubmitted && <Badge tone="success" dot>Service rated</Badge>}
        </div>
      </div>
    </div>

    <div className="summary-strip">
      <div><span className="summary-label">Status</span><span className="summary-value">{ticket.status}</span></div>
      <div><span className="summary-label">Engineer</span><span className="summary-value">{ticket.assignedEngineer || 'Not yet assigned'}</span></div>
      <div><span className="summary-label">Raised</span><span className="summary-value">{formatDateTime(ticket.createdAt)}</span></div>
      <div><span className="summary-label">Resolve by</span><span className="summary-value">{formatDateTime(ticket.slaTargetAt)}</span></div>
    </div>

    <Surface label="Service case">
      <Section title="Issue" description={ticket.issueType}>
        <div className="stack-16">
          <p className="description-text">{ticket.description || 'No description provided.'}</p>
          <InfoList columns={2} items={[['Request type', ticket.category || 'Service'], ['Priority', ticket.priority], ['Service location', ticket.location], ['Preferred date', formatDate(ticket.preferredServiceDate, '')], ['Service centre', ticket.serviceCentreId?.name], ['Expected turnaround', ticket.expectedTAT]]} />
        </div>
      </Section>
      <Section title="Device" actions={device._id ? <Button size="sm" variant="ghost" to={`/corporate/devices/${device._id}`}>View device</Button> : null}>
        <div className="stack-16">
          <div className="person-cell"><span className="thumb thumb-lg"><DeviceIcon type={device.deviceType} model={device.model} /></span><div><strong>{device.model || 'Device'}</strong><span className="cell-sub mono">{device.serialNumber}</span></div></div>
          <InfoList columns={2} items={[['Asset ID', device.assetId], ['Employee', device.employeeName]]} />
        </div>
      </Section>
      <Section title="Coverage"><CoverageTiles device={device} /></Section>
      <Section title="Engineer" description={ticket.assignedEngineer ? 'Assigned by iPlanet Service' : 'An engineer will be assigned shortly'}>
        {ticket.assignedEngineer ? <InfoList columns={2} items={[['Name', ticket.assignedEngineer], ['Location', engineer?.location], ['Assigned', formatDateTime(ticket.assignedAt, '')]]} /> : <p className="text-muted">Not yet assigned.</p>}
      </Section>
      <Section title="SLA" description="Service targets for this request"><SLAPanel ticket={ticket} reason={escalation?.reason} contact={escalationContact} /></Section>
      <Section title="Progress"><Workflow ticket={ticket} timeline={timeline} /></Section>
      <Section title="Timeline" description="Every update on this request"><Timeline events={timeline} /></Section>
      <Section title="Evidence" description="Original photos and damage markings"><Evidence ticket={ticket} resolve={mediaUrl} onOpen={setSelectedImage} /></Section>
    </Surface>
    {selectedImage && <Lightbox src={selectedImage} alt="Ticket attachment preview" onClose={() => setSelectedImage(null)} />}
  </Shell>;
}
