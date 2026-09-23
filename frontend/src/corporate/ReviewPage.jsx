import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, MessageSquareText, Star } from 'lucide-react';
import { Shell } from './components';
import { getMyReviews, getTicket, getTickets, submitReview } from './api';
import { Badge, Button, Card, EmptyState, ErrorState, Field, InfoList, InlineAlert, PageHeader, PageSkeleton, RatingPicker, RowAction, Stars, TableCard, Tabs, formatDate, friendlyError, useAsync } from '../ui';

export function ReviewPage() {
  const { ticketId } = useParams();
  const state = useAsync(() => getTicket(ticketId), [ticketId]);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [complete, setComplete] = useState(false);
  const crumbs = [{ label: 'Reviews', to: '/corporate/reviews' }, { label: 'Rate service' }];

  const submit = async event => {
    event.preventDefault();
    if (!rating || !comment.trim()) { setError('Choose a rating and tell us about your experience.'); return; }
    try {
      setBusy(true);
      setError('');
      await submitReview({ ticketId: state.data.ticket._id, rating, comment });
      setComplete(true);
    } catch (submitError) {
      const message = submitError.status === 401 ? 'Your session has expired. Please sign in again.' : submitError.status === 403 ? 'You are not authorized to submit this review.' : submitError.status === 404 ? submitError.message || 'Ticket not found.' : submitError.status === 409 ? 'This service request has already been reviewed.' : submitError.status === 400 ? submitError.message : submitError.status >= 500 ? 'Something went wrong. Please try again.' : submitError.message || 'Unable to submit your review.';
      setError(message);
      if (submitError.status === 409) setComplete(true);
    } finally {
      setBusy(false);
    }
  };

  if (state.loading && !state.data) return <Shell title="Rate service" crumbs={crumbs}><PageSkeleton variant="detail" kpis={0} /></Shell>;
  if (state.error) return <Shell title="Rate service" crumbs={crumbs}><PageHeader title="Rate your service" back={{ to: '/corporate/reviews', label: 'Reviews' }} /><div className="card"><ErrorState title={state.error.status === 404 ? 'Ticket not found' : 'Unable to load this service request'} message={friendlyError(state.error)} onRetry={state.reload} /></div></Shell>;

  const { ticket, reviewEligible, reviewSubmitted } = state.data;
  const rated = complete || reviewSubmitted;
  return <Shell title="Rate service" crumbs={crumbs}>
    <PageHeader title="Rate your service" description="Your feedback goes directly to the iPlanet service team and helps them improve." back={{ to: `/corporate/service-requests/${ticketId}`, label: `Back to ${ticket.ticketId}` }} />
    <div className="grid-main-side">
      <Card>
        {rated ? <div className="success-panel">
          <span className="success-mark"><CheckCircle2 size={26} aria-hidden="true" /></span>
          <h2>Thank you for your feedback</h2>
          <p>This service request has been reviewed.</p>
          <div className="row" style={{ justifyContent: 'center' }}><Button to="/corporate/reviews">All reviews</Button><Button variant="primary" to={`/corporate/service-requests/${ticketId}`}>Back to request</Button></div>
        </div> : !reviewEligible ? <EmptyState icon={Star} title="Not ready for review yet" description="You can rate the service once this request is closed." action={<Button to={`/corporate/service-requests/${ticketId}`}>Back to request</Button>} />
        : <form className="stack-24" onSubmit={submit} noValidate>
          <RatingPicker label="How was your service experience?" required value={rating} onChange={setRating} />
          <Field label="Tell us about your experience" required hint={`${comment.length}/2000 characters`}>
            {props => <textarea {...props} required maxLength={2000} value={comment} onChange={event => setComment(event.target.value)} placeholder="What went well, and what could be better?" />}
          </Field>
          {error && <InlineAlert title={error} />}
          <div className="form-actions"><Button to={`/corporate/service-requests/${ticketId}`}>Cancel</Button><Button variant="primary" type="submit" disabled={busy || !rating || !comment.trim()}>{busy ? 'Submitting…' : 'Submit review'}</Button></div>
        </form>}
      </Card>
      <Card title="Service request">
        <InfoList items={[['Request', <span className="mono">{ticket.ticketId}</span>], ['Device', ticket.deviceId?.model], ['Issue', ticket.issueType], ['Service centre', ticket.serviceCentreId?.name || ticket.location], ['Engineer', ticket.assignedEngineer]]} />
      </Card>
    </div>
  </Shell>;
}

export function CorporateReviews() {
  const state = useAsync(() => Promise.all([getMyReviews(), getTickets()]).then(([reviews, tickets]) => {
    const reviewed = new Set(reviews.map(review => String(review.ticketId?._id || review.ticketId)));
    return { reviews, pending: tickets.filter(ticket => ticket.status === 'Closed' && !reviewed.has(String(ticket._id))) };
  }), []);
  const [tab, setTab] = useState('pending');
  const pending = state.data?.pending || [];
  const reviews = state.data?.reviews || [];
  return <Shell title="Reviews">
    <PageHeader title="Reviews" description="Rate completed service requests and see the feedback you've shared." />
    <Tabs label="Review sections" value={tab} onChange={setTab} tabs={[{ value: 'pending', label: 'Awaiting your review', count: state.data ? pending.length : undefined }, { value: 'submitted', label: 'Submitted', count: state.data ? reviews.length : undefined }]} />
    {tab === 'pending' ? <TableCard columns={5} loading={state.loading && !state.data} error={state.error && friendlyError(state.error)} errorTitle="Unable to load reviews" onRetry={state.reload} isEmpty={!pending.length}
      empty={<EmptyState icon={CheckCircle2} title="No requests awaiting review" description="Closed service requests you haven't rated yet will appear here." />}>
      <table className="table">
        <thead><tr><th>Request</th><th>Device</th><th>Issue</th><th>Closed</th><th><span className="sr-only">Action</span></th></tr></thead>
        <tbody>{pending.map(ticket => <tr key={ticket._id}>
          <td><Link className="cell-link mono" to={`/corporate/service-requests/${ticket._id}`}>{ticket.ticketId}</Link></td>
          <td>{ticket.deviceId?.model || '—'}<span className="cell-sub mono">{ticket.deviceId?.serialNumber}</span></td>
          <td>{ticket.issueType}</td>
          <td className="cell-nowrap">{formatDate(ticket.updatedAt)}</td>
          <td className="cell-right"><Button size="sm" variant="primary" icon={Star} to={`/corporate/reviews/${ticket._id}`}>Rate service</Button></td>
        </tr>)}</tbody>
      </table>
    </TableCard>
      : state.loading && !state.data ? <PageSkeleton variant="none" kpis={0} />
      : state.error ? <div className="card"><ErrorState title="Unable to load reviews" message={friendlyError(state.error)} onRetry={state.reload} /></div>
      : !reviews.length ? <div className="card"><EmptyState icon={MessageSquareText} title="No reviews submitted yet" description="Reviews you submit after a request is closed will appear here." /></div>
      : <div className="review-cards">{reviews.map(review => <article className="review-card" key={review._id}>
        <div className="review-card-head"><Stars rating={review.rating} size={16} /><Badge tone="info">Internal review</Badge></div>
        <p className="review-text">{review.comment}</p>
        <div className="review-card-foot">
          <span>{review.ticketId?.ticketId ? <span className="mono">{review.ticketId.ticketId}</span> : 'Service request'}{review.deviceId?.model ? ` · ${review.deviceId.model}` : ''}</span>
          <span className="row"><time dateTime={review.createdAt}>{formatDate(review.createdAt)}</time>{review.ticketId?._id && <RowAction to={`/corporate/service-requests/${review.ticketId._id}`} label="Request" />}</span>
        </div>
      </article>)}</div>}
  </Shell>;
}
