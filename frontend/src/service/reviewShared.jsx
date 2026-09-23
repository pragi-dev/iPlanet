import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { Avatar, Badge, Stars, Tabs, formatDate, formatRelative } from '../ui';

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

// Last Google review sync in this browser session. Syncing calls Google's
// rate-limited API, so the All tab reuses these results instead of re-syncing.
let lastGoogleSync = null;
export const getCachedGoogleSync = () => lastGoogleSync;
export const setCachedGoogleSync = result => { lastGoogleSync = result; };

export function flattenGoogleReviews(syncResult, centreName = () => null) {
  return (syncResult?.results || []).flatMap(result => (result.reviews || []).filter(Boolean).map(review => ({ ...review, source: 'google', serviceCentre: centreName(result.serviceCentreId) })));
}

export function GoogleReviewCard({ review }) {
  const place = review.locationName || review.serviceCentre || '';
  return <article className="review-card review-card-google">
    <div className="review-card-head"><GoogleBadge /><Stars rating={review.rating} /></div>
    <div className="review-author"><Avatar name={review.authorName} size={32} /><div><strong>{review.authorName}</strong><span>{place || 'Google Business Profile'}</span></div></div>
    {review.comment ? <p className="review-text">{review.comment}</p> : <p className="text-muted text-small">Rating only, no written review.</p>}
    <div className="review-card-foot">
      <time dateTime={review.createdAt} title={formatDate(review.createdAt)}>{formatRelative(review.createdAt)}</time>
      {place && <a className="row-action" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`} target="_blank" rel="noopener noreferrer">View on Google<ExternalLink size={13} aria-hidden="true" /></a>}
    </div>
  </article>;
}

export function InternalReviewCard({ review }) {
  return <article className="review-card">
    <div className="review-card-head"><Badge tone="info">Internal</Badge><Stars rating={review.rating} /></div>
    <div className="review-author"><Avatar name={review.customerId?.name || review.corporateId?.name} size={32} /><div><strong>{review.corporateId?.name || 'Corporate customer'}</strong><span>{[review.ticketId?.ticketId, review.serviceCentreId?.name].filter(Boolean).join(' · ') || 'Service request'}</span></div></div>
    <p className="review-text">{review.comment}</p>
    <div className="review-card-foot">
      <time dateTime={review.createdAt} title={formatDate(review.createdAt)}>{formatRelative(review.createdAt)}</time>
      <Link className="row-action" to={`/service/reviews/${review._id}`}>View review</Link>
    </div>
  </article>;
}
