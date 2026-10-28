import { useParams } from 'react-router-dom';
import { getTicketTracking } from '../service/api';
import { Card, ErrorState, InfoList, Skeleton, StatusBadge, formatDate, formatDateTime, useAsync } from '../ui';

// Public page linked from the acknowledgement email of a ticket raised by email. The link's
// token is the only key; anyone with the email can follow the request without signing in.

// The stages a customer sees. Waiting for Parts is part of the repair.
const STEPS = [
  { label: 'Request logged', statuses: ['Open'] },
  { label: 'Engineer assigned', statuses: ['Engineer Assigned', 'Engineer Accepted'] },
  { label: 'Work in progress', statuses: ['In Progress', 'Waiting for Parts'] },
  { label: 'Completed', statuses: ['Completed'] },
  { label: 'Closed', statuses: ['Closed'] },
];

function Progress({ status }) {
  const current = Math.max(0, STEPS.findIndex(step => step.statuses.includes(status)));
  return <ol className="track-steps" aria-label="Progress">
    {STEPS.map((step, index) => <li key={step.label} className={index < current ? 'is-done' : index === current ? 'is-current' : ''} aria-current={index === current ? 'step' : undefined}>
      <span className="track-step-dot" aria-hidden="true" />
      <span>{step.label}{index === current && status === 'Waiting for Parts' ? ' · waiting for parts' : ''}</span>
    </li>)}
  </ol>;
}

export function TrackTicket() {
  const { token } = useParams();
  const { data: ticket, error, loading, reload } = useAsync(() => getTicketTracking(token), [token]);

  return <main className="login track">
    <header className="login-top">
      <div className="login-brand"><span className="login-brand-mark" aria-hidden="true">i</span><span><strong>iPlanet</strong> Service</span></div>
    </header>

    <div className="track-main">
      {loading && <div className="track-loading" role="status" aria-label="Loading your request"><Skeleton width="40%" height={32} /><Skeleton height={56} /><Skeleton height={200} /></div>}
      {error && <ErrorState
        title={error.status === 404 ? 'Tracking link not found' : 'Unable to load your request'}
        message={error.status === 404 ? 'This link is not valid. Use the link in your acknowledgement email.' : 'Please try again in a moment.'}
        onRetry={error.status === 404 ? undefined : reload} />}
      {ticket && <>
        <div className="track-head">
          <p className="login-eyebrow">Service request</p>
          <div className="track-title"><h1>{ticket.ticketId}</h1><StatusBadge status={ticket.status} /></div>
        </div>
        <Progress status={ticket.status} />
        <Card title="Request details">
          <InfoList columns={2} items={[
            ['Request', [ticket.category, ticket.issueType].filter(Boolean).join(' – ')],
            ['Organization', ticket.company],
            ticket.device && ['Device', `${ticket.device.model || 'Device'}${ticket.device.serialNumber ? ` (${ticket.device.serialNumber})` : ''}`],
            ticket.deviceCount && ['Devices', ticket.deviceCount],
            ['Location', ticket.location],
            ['Priority', ticket.priority],
            ['Preferred date', ticket.preferredServiceDate && formatDate(ticket.preferredServiceDate)],
            ['Engineer', ticket.engineer || 'Not assigned yet'],
            ['Raised on', formatDateTime(ticket.createdAt)],
            ticket.closedAt && ['Closed on', formatDateTime(ticket.closedAt)],
          ]} />
        </Card>
        <Card title="Updates">
          <ol className="track-updates">
            {[...ticket.timeline].reverse().map(entry => <li key={`${entry.status}-${entry.at}`}>
              <div className="track-update-head"><strong>{entry.status}</strong><time dateTime={entry.at}>{formatDateTime(entry.at)}</time></div>
              <p>{entry.message}</p>
            </li>)}
          </ol>
        </Card>
      </>}
    </div>

    <footer className="login-foot">
      <span>Copyright © {new Date().getFullYear()} iPlanet. All rights reserved.</span>
      <span>Questions? Reply to your acknowledgement email.</span>
    </footer>
  </main>;
}
