import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, MessageSquareText, Star } from 'lucide-react';
import { Shell } from './components';
import { getMyReviews, getReviewPeriod, getReviewPeriods, submitReview } from './api';
import { Badge, Button, Card, EmptyState, ErrorState, Field, InlineAlert, PageHeader, PageSkeleton, RatingPicker, Stars, TableCard, Tabs, formatDate, formatMonth, friendlyError, useAsync } from '../ui';

// Reviews cover a calendar month of closed requests, one per company. Older reviews were
// for a single request; they are still listed under Submitted.
const reviewSubject = review => review.period ? formatMonth(review.period) : review.ticketId?.ticketId ? `Request ${review.ticketId.ticketId}` : 'Service request';
const pluralRequests = count => `${count} closed request${count === 1 ? '' : 's'}`;

// The period may also be a ticket ID from an older "rate this request" notification;
// the server resolves it to the month that request closed in.
export function ReviewPage() {
  const { periodKey } = useParams();
  const state = useAsync(() => getReviewPeriod(periodKey), [periodKey]);
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
      await submitReview({ period: state.data.period, rating, comment });
      setComplete(true);
    } catch (submitError) {
      const message = submitError.status === 401 ? 'Your session has expired. Please sign in again.' : submitError.status === 403 ? 'You are not authorized to submit this review.' : submitError.status >= 500 ? 'Something went wrong. Please try again.' : submitError.message || 'Unable to submit your review.';
      setError(message);
      if (submitError.status === 409) setComplete(true);
    } finally {
      setBusy(false);
    }
  };

  if (state.loading && !state.data) return <Shell title="Rate service" crumbs={crumbs}><PageSkeleton variant="detail" kpis={0} /></Shell>;
  if (state.error) return <Shell title="Rate service" crumbs={crumbs}><PageHeader title="Rate your service" back={{ to: '/corporate/reviews', label: 'Reviews' }} /><div className="card"><ErrorState title={state.error.status === 404 ? 'Nothing to review for this month' : 'Unable to load this month'} message={friendlyError(state.error)} onRetry={state.reload} /></div></Shell>;

  const month = state.data;
  const rated = complete || Boolean(month.review);
  return <Shell title="Rate service" crumbs={crumbs}>
    <PageHeader title={`Rate your ${month.label} service`} description="One review covers every service request closed that month. Your feedback goes directly to the iPlanet service team." back={{ to: '/corporate/reviews', label: 'Reviews' }} />
    <div className="grid-main-side">
      <Card>
        {rated ? <div className="success-panel">
          <span className="success-mark"><CheckCircle2 size={26} aria-hidden="true" /></span>
          <h2>Thank you for your feedback</h2>
          <p>{month.review?.customerId?.name && !complete ? `${month.label} was reviewed by ${month.review.customerId.name}.` : `${month.label} has been reviewed.`}</p>
          <div className="row" style={{ justifyContent: 'center' }}><Button variant="primary" to="/corporate/reviews">All reviews</Button></div>
        </div> : !month.ended ? <EmptyState icon={Star} title={`${month.label} isn't over yet`} description="You can rate the month once it has ended, so the review covers every request closed in it." action={<Button to="/corporate/reviews">Back to reviews</Button>} />
        : <form className="stack-24" onSubmit={submit} noValidate>
          <RatingPicker label={`How was iPlanet's service in ${month.label}?`} required value={rating} onChange={setRating} />
          <Field label="Tell us about your experience" required hint={`${comment.length}/2000 characters`}>
            {props => <textarea {...props} required maxLength={2000} value={comment} onChange={event => setComment(event.target.value)} placeholder="What went well this month, and what could be better?" />}
          </Field>
          {error && <InlineAlert title={error} />}
          <div className="form-actions"><Button to="/corporate/reviews">Cancel</Button><Button variant="primary" type="submit" disabled={busy || !rating || !comment.trim()}>{busy ? 'Submitting…' : 'Submit review'}</Button></div>
        </form>}
      </Card>
      <Card title={`Closed in ${month.label}`} description={pluralRequests(month.ticketCount)}>
        <ul className="stack-12" style={{ listStyle: 'none', margin: 0, padding: 0 }}>{month.tickets.map(ticket => <li key={ticket._id}>
          <Link className="cell-link mono" to={`/corporate/service-requests/${ticket._id}`}>{ticket.ticketId}</Link>
          <span className="cell-sub">{[ticket.issueType || ticket.category, `closed ${formatDate(ticket.closedAt)}`].filter(Boolean).join(' · ')}</span>
        </li>)}</ul>
      </Card>
    </div>
  </Shell>;
}

export function CorporateReviews() {
  const state = useAsync(() => Promise.all([getReviewPeriods(), getMyReviews()]).then(([months, reviews]) => ({ reviews, pending: months.filter(month => month.reviewable), upcoming: months.find(month => !month.ended) || null })), []);
  const [tab, setTab] = useState('pending');
  const pending = state.data?.pending || [];
  const reviews = state.data?.reviews || [];
  const upcoming = state.data?.upcoming;
  return <Shell title="Reviews">
    <PageHeader title="Reviews" description="Rate iPlanet's service once a month and see the feedback your organization has shared." />
    <Tabs label="Review sections" value={tab} onChange={setTab} tabs={[{ value: 'pending', label: 'Awaiting your review', count: state.data ? pending.length : undefined }, { value: 'submitted', label: 'Submitted', count: state.data ? reviews.length : undefined }]} />
    {tab === 'pending' ? <>
      {upcoming && <InlineAlert tone="info" title={`${upcoming.label}: ${pluralRequests(upcoming.ticketCount)} so far`}>You can rate {upcoming.label} once the month ends.</InlineAlert>}
      <TableCard columns={3} loading={state.loading && !state.data} error={state.error && friendlyError(state.error)} errorTitle="Unable to load reviews" onRetry={state.reload} isEmpty={!pending.length}
        empty={<EmptyState icon={CheckCircle2} title="No months awaiting review" description="When a month with closed service requests ends, it appears here for your organization to rate." />}>
        <table className="table">
          <thead><tr><th>Month</th><th>Requests closed</th><th><span className="sr-only">Action</span></th></tr></thead>
          <tbody>{pending.map(month => <tr key={month.period}>
            <td className="cell-nowrap"><span className="cell-primary">{month.label}</span></td>
            <td>{month.ticketCount}</td>
            <td className="cell-right"><Button size="sm" variant="primary" icon={Star} to={`/corporate/reviews/${month.period}`}>Rate {month.label}</Button></td>
          </tr>)}</tbody>
        </table>
      </TableCard>
    </>
      : state.loading && !state.data ? <PageSkeleton variant="none" kpis={0} />
      : state.error ? <div className="card"><ErrorState title="Unable to load reviews" message={friendlyError(state.error)} onRetry={state.reload} /></div>
      : !reviews.length ? <div className="card"><EmptyState icon={MessageSquareText} title="No reviews submitted yet" description="Monthly reviews your organization submits will appear here." /></div>
      : <div className="review-cards">{reviews.map(review => <article className="review-card" key={review._id}>
        <div className="review-card-head"><Stars rating={review.rating} size={16} /><Badge tone="info">{review.period ? 'Monthly review' : 'Request review'}</Badge></div>
        <p className="review-text">{review.comment}</p>
        <div className="review-card-foot">
          <span>{reviewSubject(review)}{review.period && review.ticketIds?.length ? ` · ${pluralRequests(review.ticketIds.length)}` : ''}{review.customerId?.name ? ` · by ${review.customerId.name}` : ''}</span>
          <time dateTime={review.createdAt}>{formatDate(review.createdAt)}</time>
        </div>
      </article>)}</div>}
  </Shell>;
}
