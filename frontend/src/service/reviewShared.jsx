import { Link } from 'react-router-dom';
import { ExternalLink, MessageSquareReply, Pencil, Trash2 } from 'lucide-react';
import { Avatar, Badge, Button, Stars, Tabs, formatDate, formatMonth, formatRelative } from '../ui';

export function ReviewTabs({ current }) {
  return <Tabs label="Review source" value={current} tabs={[
    { to: '/service/reviews', label: 'All' },
    { to: '/service/reviews?source=internal', label: 'Internal' },
    { to: '/service/reviews/google', label: 'Google' },
  ]} />;
}

export function GoogleBadge() {
  return <Badge tone="google"><span className="google-g" aria-hidden="true">G</span>Google</Badge>;
}

// Google reviews retrieved in this browser session. Review content is not
// stored by iPlanet; this only avoids re-requesting it on every tab switch.
let lastGoogleReviews = null;
export const getCachedGoogleReviews = () => lastGoogleReviews;
export const setCachedGoogleReviews = result => { lastGoogleReviews = result; };

export function flattenGoogleReviews(result) {
  return (result?.locations || []).flatMap(location => (location.reviews || []).map(review => ({ ...review, createdAt: review.createTime })));
}

// Backend Google errors carry a safe message and a category; prefer them over
// the generic error rewriting used elsewhere.
export function googleErrorMessage(error, fallback = 'Google Business Profile request failed.') {
  if (error?.google?.message) return error.google.message;
  const message = error?.message || '';
  return message && message.length <= 300 && !/[{}[\]]|failed to fetch/i.test(message) ? message : fallback;
}

export function reviewerName(review) {
  if (review.reviewer?.isAnonymous) return 'Anonymous Google user';
  return review.reviewer?.displayName || 'Name not provided';
}

export function GoogleReviewCard({ review, onReply, onDeleteReply }) {
  const place = review.location?.title || review.location?.serviceCentreName || 'Google Business Profile';
  const edited = review.updateTime && review.createTime && review.updateTime !== review.createTime;
  const replied = Boolean(review.reply?.comment);
  return <article className="review-card review-card-google">
    <div className="review-card-head"><GoogleBadge />{review.rating ? <Stars rating={review.rating} /> : <span className="text-muted text-small">No star rating</span>}</div>
    <div className="review-author"><Avatar name={reviewerName(review)} size={32} /><div><strong>{reviewerName(review)}</strong><span>{place}{review.location?.serviceCentreName && review.location?.title ? ` · ${review.location.serviceCentreName}` : ''}</span></div></div>
    {review.comment ? <p className="review-text">{review.comment}</p> : <p className="text-muted text-small">Rating only, no written review.</p>}
    {replied && <div className="review-reply"><p className="review-reply-label">Owner reply{review.reply.updateTime ? ` · ${formatRelative(review.reply.updateTime)}` : ''}</p><p>{review.reply.comment}</p></div>}
    <div className="review-card-foot">
      <span className="row">
        {review.createTime ? <time dateTime={review.createTime} title={formatDate(review.createTime)}>{formatRelative(review.createTime)}{edited ? ' · edited' : ''}</time> : <span>Date not provided</span>}
        <Badge tone={replied ? 'success' : 'warning'}>{replied ? 'Replied' : 'Awaiting reply'}</Badge>
      </span>
      {review.location?.mapsUri && <a className="row-action" href={review.location.mapsUri} target="_blank" rel="noopener noreferrer">Google Maps<ExternalLink size={13} aria-hidden="true" /></a>}
    </div>
    {onReply && <div className="row">
      <Button size="sm" icon={replied ? Pencil : MessageSquareReply} onClick={() => onReply(review)}>{replied ? 'Edit reply' : 'Reply'}</Button>
      {replied && onDeleteReply && <Button size="sm" variant="ghost" icon={Trash2} onClick={() => onDeleteReply(review)}>Delete reply</Button>}
    </div>}
  </article>;
}

// Internal reviews cover a calendar month of a corporate's closed requests. Older ones
// were for a single request and have a ticket instead of a period.
export function reviewCovers(review) {
  if (review.period) return [formatMonth(review.period), `${review.ticketIds?.length || 0} closed request${review.ticketIds?.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  return review.ticketId?.ticketId ? `Request ${review.ticketId.ticketId}` : 'Service request';
}
export const reviewCentres = review => review.period ? (review.serviceCentreIds || []).map(centre => centre?.name).filter(Boolean).join(', ') : review.serviceCentreId?.name || '';

export function InternalReviewCard({ review }) {
  return <article className="review-card">
    <div className="review-card-head"><Badge tone="info">Internal review</Badge><Stars rating={review.rating} /></div>
    <div className="review-author"><Avatar name={review.customerId?.name || review.corporateId?.name} size={32} /><div><strong>{review.corporateId?.name || 'Corporate customer'}</strong><span>{[reviewCovers(review), reviewCentres(review)].filter(Boolean).join(' · ')}</span></div></div>
    <p className="review-text">{review.comment}</p>
    <div className="review-card-foot">
      <time dateTime={review.createdAt} title={formatDate(review.createdAt)}>{formatRelative(review.createdAt)}</time>
      <Link className="row-action" to={`/service/reviews/${review._id}`}>View review</Link>
    </div>
  </article>;
}
