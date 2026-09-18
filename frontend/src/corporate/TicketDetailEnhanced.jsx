import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, ShieldAlert } from 'lucide-react';
import { Shell, Badge, PageTitle } from './components';
import { getTicket, mediaUrl } from './api';
import { ModalLayer } from './ModalLayer';

export function TicketDetailEnhanced() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [selectedImage, setSelectedImage] = useState(null);

  useEffect(() => { setData(null); setError(''); getTicket(id).then(setData).catch(loadError => setError(loadError.message || 'Unable to load this ticket.')); }, [id]);
  if (!data) return <Shell title="Ticket details"><div className="loading">{error || 'Loading ticket...'}</div></Shell>;

  const { ticket, timeline, escalation } = data;
  const images = [...new Set([...(ticket.originalImages || ticket.images || []), ...(ticket.annotatedImages || [])])];

  return <Shell title="Ticket details">
    <div className="ticket-detail-layout">
      <div className="ticket-detail-main">
        <Link className="back-link" to="/tickets"><ArrowLeft size={16} />Back to My Tickets</Link>
        <PageTitle title={ticket.ticketId} showTitle description={`${ticket.issueType} · ${ticket.location}`} action={<div className="ticket-detail-actions"><Badge>{ticket.status}</Badge>{data.reviewEligible && <Link className="button primary" to={`/corporate/reviews/${ticket._id}`}>Rate Our Service</Link>}{data.reviewSubmitted && <Badge>Service Rated</Badge>}</div>} />
        <div className="ticket-summary">
          <section className="panel info-card"><h3>Request details</h3>{[['Device', ticket.deviceId?.model], ['Serial number', ticket.deviceId?.serialNumber], ['Priority', ticket.priority], ['Expected TAT', ticket.expectedTAT], ['Assigned engineer', ticket.assignedEngineer || 'Unassigned']].map(([label, value]) => <div className="info-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}</section>
          <section className="panel issue-card"><span className="kicker">Issue description</span><h3>{ticket.issueType}</h3><p>{ticket.description}</p><div className="upload-preview">{images.length ? images.map(image => <button type="button" key={image} className="image-thumb-button" onClick={() => setSelectedImage(mediaUrl(image))}><img src={mediaUrl(image)} alt="Reported issue" /></button>) : <span>No issue photos attached</span>}</div></section>
        </div>
        {selectedImage && <ModalLayer className="image-lightbox"><div role="dialog" aria-modal="true" aria-label="Ticket attachment preview" onClick={() => setSelectedImage(null)}><button type="button" className="image-lightbox-close" aria-label="Close image preview" onClick={() => setSelectedImage(null)}>×</button><img src={selectedImage} alt="Ticket attachment preview" onClick={event => event.stopPropagation()} /></div></ModalLayer>}
        <section className="panel escalation-card">
          <div className="escalation-status-compact">
            <div className="escalation-icon"><ShieldAlert size={18} /></div>
            <div className="sla-heading">
              <span className="kicker">Support status</span>
              <h3><Badge>{escalation?.status || 'Healthy'}</Badge></h3>
              <p>{escalation?.reason || 'Ticket health is normal.'}</p>
            </div>
          </div>
          <div className="sla-table" role="table" aria-label="Escalation details">
            <div className="sla-row" role="row"><span role="cell">Response target</span><strong role="cell">{ticket.responseTarget || 'Not available'}</strong></div>
            <div className="sla-row" role="row"><span role="cell">Resolution target</span><strong role="cell">{ticket.resolutionTarget || 'Not available'}</strong></div>
            <div className="sla-row" role="row"><span role="cell">Escalation</span><strong role="cell">{ticket.escalationStatus || 'Not escalated'} · Level {ticket.escalationLevel || 0}</strong></div>
          </div>
        </section>
        <section className="panel timeline-panel"><span className="kicker">Timeline</span><h3>Ticket history</h3><div className="timeline">{timeline.map((event, index) => <div className="timeline-item" key={`${event.status}-${index}`}><div className="timeline-dot"><CheckCircle2 size={14} /></div><div><strong>{event.status}</strong><p>{event.message}</p><small>{event.updatedBy || 'Support Desk'} · {event.timestamp ? new Date(event.timestamp).toLocaleString() : 'Recently'}</small></div></div>)}</div></section>
      </div>
    </div>
  </Shell>;
}
