import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Sparkles, Star } from 'lucide-react';
import { Shell } from './components';
import { getTicket, mediaUrl } from './api';
import { Badge, Button, Card, DeviceIcon, ErrorState, Evidence, InfoList, Lightbox, PageHeader, PageSkeleton, SLAPanel, Timeline, Workflow, formatDate, formatDateTime, friendlyError, slaLabel, useAIAssistant, useAsync } from '../ui';

export function TicketDetailEnhanced() {
  const { id } = useParams();
  const ai = useAIAssistant();
  const state = useAsync(() => getTicket(id), [id]);
  const [selectedImage, setSelectedImage] = useState(null);
  const crumbs = [{ label: 'Service Requests', to: '/corporate/service-requests' }, { label: state.data?.ticket?.ticketId || 'Request details' }];

  if (state.loading && !state.data) return <Shell title="Request details" crumbs={crumbs}><PageSkeleton variant="detail" /></Shell>;
  if (state.error) return <Shell title="Request details" crumbs={crumbs}><PageHeader title="Request details" back={{ to: '/corporate/service-requests', label: 'Service Requests' }} /><div className="card"><ErrorState title={state.error.status === 404 ? 'Request not found' : 'Unable to load this request'} message={friendlyError(state.error)} onRetry={state.reload} /></div></Shell>;

  const { ticket, timeline, escalation, escalationContact } = state.data;
  const device = ticket.deviceId || {};
  const sla = slaLabel(ticket);

  return <Shell title={ticket.ticketId} crumbs={crumbs}>
    <div className="page-header">
      <Link className="back-link" to="/corporate/service-requests"><ArrowLeft size={15} aria-hidden="true" />Service Requests</Link>
      <div className="page-header-row">
        <div className="page-header-text">
          <p className="eyebrow">{ticket.category || 'Service'} request</p>
          <h1 className="page-title mono" style={{ fontSize: 26 }}>{ticket.ticketId}</h1>
          <div className="page-meta"><Badge dot>{ticket.status}</Badge><Badge>{`${ticket.priority || 'Medium'} priority`}</Badge><Badge>{`SLA: ${sla}`}</Badge><span>{ticket.issueType}{ticket.location ? ` · ${ticket.location}` : ''}</span></div>
        </div>
        <div className="page-actions">
          <Button icon={Sparkles} onClick={ai.open}>Get AI help</Button>
          {state.data.reviewEligible && <Button variant="primary" icon={Star} to={`/corporate/reviews/${ticket._id}`}>Rate our service</Button>}
          {state.data.reviewSubmitted && <Badge tone="success" dot>Service rated</Badge>}
        </div>
      </div>
    </div>

    <div className="summary-strip">
      <div><span className="summary-label">Status</span><span className="summary-value">{ticket.status}</span></div>
      <div><span className="summary-label">Engineer</span><span className="summary-value">{ticket.assignedEngineer || 'Not yet assigned'}</span></div>
      <div><span className="summary-label">Created</span><span className="summary-value">{formatDateTime(ticket.createdAt)}</span></div>
      <div><span className="summary-label">Expected turnaround</span><span className="summary-value">{ticket.expectedTAT || ticket.resolutionTarget || '—'}</span></div>
    </div>

    <div className="detail-layout">
      <div className="detail-main">
        <Card title="Request summary">
          <InfoList columns={2} items={[['Category', ticket.category || 'Service'], ['Issue type', ticket.issueType], ['Priority', ticket.priority], ['Service location', ticket.location], ['Preferred date', formatDate(ticket.preferredServiceDate, '')], ['Service centre', ticket.serviceCentreId?.name]]} />
        </Card>
        <Card title="Issue details"><p className="description-text">{ticket.description || 'No description provided.'}</p></Card>
        <Card title="Issue evidence" description="Original photos and annotated damage markings"><Evidence ticket={ticket} resolve={mediaUrl} onOpen={setSelectedImage} /></Card>
        <Card title="Timeline" description="Every update on this request"><Timeline events={timeline} /></Card>
      </div>
      <aside className="detail-side">
        <Card title="Device" actions={device._id && <Button size="sm" variant="ghost" to={`/corporate/devices/${device._id}`}>View device</Button>}>
          <div className="stack-12">
            <div className="person-cell"><span className="asset-icon" style={{ width: 40, height: 40 }}><DeviceIcon type={device.deviceType} model={device.model} /></span><div><strong>{device.model || 'Device'}</strong><span className="cell-sub mono">{device.serialNumber}</span></div></div>
            <InfoList items={[['Employee', device.employeeName], ['Warranty', device.warrantyStatus && <Badge>{device.warrantyStatus}</Badge>], ['AMC', device.amcStatus && <Badge>{device.amcStatus}</Badge>]]} />
          </div>
        </Card>
        <Card title="SLA & escalation"><SLAPanel ticket={ticket} reason={escalation?.reason} contact={escalationContact} /></Card>
        <Card title="Progress"><Workflow ticket={ticket} timeline={timeline} /></Card>
      </aside>
    </div>
    {selectedImage && <Lightbox src={selectedImage} alt="Ticket attachment preview" onClose={() => setSelectedImage(null)} />}
  </Shell>;
}
