import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, FilePlus2, Sparkles, Star } from 'lucide-react';
import { Shell } from './components';
import { getTicket, mediaUrl } from './api';
import {
  ActivityTimeline, Avatar, Badge, Button, CoverageTiles, DeviceIcon, ErrorState, Evidence, InfoList, Lightbox, NextAction, PageHeader, PageSkeleton, SLAPanel, Section, ServiceJourney, Surface,
  formatDate, formatDateTime, formatRelative, formatTat, friendlyError, riskLabel, riskTone, slaBadgeText, slaLabel, slaRisk, statusTone, useAIAssistant, useAsync,
} from '../ui';

// What the customer can expect next. Actions are limited to what a
// Corporate Admin can actually do: ask AI Support, rate a closed request, or
// raise a new request for the device.
function customerNextAction(data, ai) {
  const { ticket, reviewEligible, reviewSubmitted, escalationContact } = data;
  const engineer = ticket.assignedEngineer;
  const help = ai.available ? [{ label: 'Get help', icon: Sparkles, onClick: ai.open, secondary: true }] : [];
  let next;
  switch (ticket.status) {
    case 'Open':
      next = { tone: 'info', eyebrow: 'What happens next', title: 'iPlanet Service is reviewing your request', description: 'An engineer will be assigned shortly. Every update appears in Notifications.', actions: help };
      break;
    case 'Engineer Assigned':
      next = { tone: 'info', eyebrow: 'What happens next', title: `${engineer || 'An engineer'} has been assigned`, description: `Assigned ${formatRelative(ticket.assignedAt) || 'recently'}. Waiting for the engineer to accept the request.`, actions: help };
      break;
    case 'Engineer Accepted':
      next = { tone: 'info', eyebrow: 'What happens next', title: `${engineer || 'Your engineer'} accepted the request`, description: 'Work will start on your device soon.', actions: help };
      break;
    case 'In Progress':
      next = { tone: 'info', eyebrow: 'In progress', title: 'Your device is being repaired', description: `${engineer || 'The engineer'} is working on it. You'll be notified when the repair is complete.`, actions: help };
      break;
    case 'Waiting for Parts':
      next = { tone: 'warning', eyebrow: 'On hold', title: 'Waiting for replacement parts', description: 'The repair resumes as soon as the parts arrive.', actions: help };
      break;
    case 'Completed':
      next = { tone: 'success', eyebrow: 'Repair completed', title: 'Your device has been repaired', description: 'iPlanet Service will close the request, and you will then be asked to rate the service.', actions: [] };
      break;
    default:
      next = reviewEligible
        ? { tone: 'info', eyebrow: 'Your feedback', title: 'How was the service?', description: 'This request is closed. Rating it helps the iPlanet service team improve.', actions: [{ label: 'Rate service', icon: Star, to: `/corporate/reviews/${ticket._id}` }] }
        : { tone: reviewSubmitted ? 'success' : 'neutral', eyebrow: 'Closed', title: reviewSubmitted ? 'Request closed · thanks for your review' : 'Request closed', description: 'If the issue comes back, raise a new request for this device.', actions: ticket.deviceId?._id ? [{ label: 'Raise new request', icon: FilePlus2, to: `/corporate/raise-request?device=${ticket.deviceId._id}`, secondary: true }] : [] };
  }
  const risk = slaRisk(ticket);
  if (risk) {
    next.tone = riskTone(risk);
    next.eyebrow = riskLabel(risk);
    const escalatedTo = Number(ticket.escalationLevel) > 0 && escalationContact ? ` It has been escalated to ${escalationContact.name}.` : '';
    next.description = `${next.description}${ticket.slaTargetAt ? ` Resolution target ${formatDateTime(ticket.slaTargetAt)}.` : ''}${escalatedTo}`;
  }
  return next;
}

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
  const next = customerNextAction(state.data, ai);

  return <Shell title={ticket.ticketId} crumbs={crumbs}>
    <header className="case-header">
      <Link className="back-link" to="/corporate/service-requests"><ChevronLeft size={16} aria-hidden="true" />Service Requests</Link>
      <div className="case-header-row">
        <div className="page-header-text">
          <p className="case-id mono">{ticket.ticketId}</p>
          <h1 className="case-title">{ticket.issueType || 'Service request'}</h1>
          <p className="case-sub">{[device.model, ticket.location].filter(Boolean).join(' · ')}</p>
          <div className="case-badges"><Badge dot>{ticket.status}</Badge><Badge>{`${ticket.priority || 'Medium'} priority`}</Badge><Badge tone={statusTone(slaLabel(ticket))}>{slaBadgeText(ticket)}</Badge>{state.data.reviewSubmitted && <Badge tone="success" dot>Service rated</Badge>}</div>
        </div>
        <div className="page-actions">{ai.available && <Button icon={Sparkles} onClick={ai.open}>Ask AI about this request</Button>}</div>
      </div>
    </header>

    <NextAction {...next} />

    <div className="workspace">
      <div className="workspace-main">
        <Surface label="Service request">
          <Section stacked title="Issue" description={ticket.category ? `${ticket.category} request` : undefined}>
            <div className="stack-16">
              <p className="description-text">{ticket.description || 'No description provided.'}</p>
              <InfoList columns={2} items={[['Priority', ticket.priority], ['Service location', ticket.location], ['Preferred date', formatDate(ticket.preferredServiceDate, '')], ['Service centre', ticket.serviceCentreId?.name], ['Raised', formatDateTime(ticket.createdAt, '')], ['Expected turnaround', formatTat(ticket.expectedTAT)]]} />
            </div>
          </Section>
          <Section stacked title="Device">
            <div className="stack-16">
              <div className="row-between">
                <div className="person-cell"><span className="thumb thumb-lg"><DeviceIcon type={device.deviceType} model={device.model} /></span><div><strong>{device.model || 'Device'}</strong><span className="cell-sub mono">{device.serialNumber}</span></div></div>
                {device._id && <Link className="row-action" to={`/corporate/devices/${device._id}`}>View device passport</Link>}
              </div>
              <InfoList columns={2} items={[['Asset ID', device.assetId], ['Employee', device.employeeName]]} />
              <CoverageTiles device={device} />
            </div>
          </Section>
          <Section stacked title="Evidence" description="Original photos and damage markings"><Evidence ticket={ticket} resolve={mediaUrl} onOpen={setSelectedImage} /></Section>
          <Section stacked title="Timeline" description="Every update on this request, newest first"><ActivityTimeline events={timeline} limit={6} /></Section>
        </Surface>
      </div>

      <aside className="workspace-side" aria-label="Request status">
        <div className="card">
          <section className="side-section" aria-label="Service journey"><p className="side-section-title">Service journey</p><ServiceJourney ticket={ticket} timeline={timeline} /></section>
          <section className="side-section" aria-label="Engineer">
            <p className="side-section-title">Engineer</p>
            {ticket.assignedEngineer ? <div className="person-block"><Avatar name={ticket.assignedEngineer} size={40} /><div><strong>{ticket.assignedEngineer}</strong><small>{engineer?.location || 'iPlanet Service engineer'}</small>{ticket.assignedAt && <small>Assigned {formatDateTime(ticket.assignedAt)}</small>}</div></div>
              : <p className="text-muted text-small">An engineer will be assigned by iPlanet Service.</p>}
          </section>
          <section className="side-section" aria-label="SLA"><p className="side-section-title">Service targets</p><SLAPanel ticket={ticket} reason={escalation?.reason} contact={escalationContact} /></section>
        </div>
      </aside>
    </div>
    {selectedImage && <Lightbox src={selectedImage} alt="Ticket attachment preview" onClose={() => setSelectedImage(null)} />}
  </Shell>;
}
