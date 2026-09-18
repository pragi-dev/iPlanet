import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Star } from 'lucide-react';
import { ServiceShell } from './servicePages';
import { Badge, Empty, PageTitle } from './components';
import { getServiceReview, getServiceReviews } from './api';

export function InternalReviews() {
  const [reviews, setReviews] = useState([]); const [filters, setFilters] = useState({ search: '', rating: 'All' }); const [error, setError] = useState('');
  useEffect(() => { getServiceReviews(filters).then(setReviews).catch(loadError => setError(loadError.message || 'Unable to load reviews.')); }, [filters]);
  return <ServiceShell title="Customer Reviews"><PageTitle title="Customer Reviews" description="Feedback submitted after closed iPlanet service requests." />{error && <p className="form-error">{error}</p>}<div className="toolbar service-toolbar"><input value={filters.search} onChange={event => setFilters({ ...filters, search: event.target.value })} placeholder="Search ticket ID" /><select value={filters.rating} onChange={event => setFilters({ ...filters, rating: event.target.value })}><option>All</option>{[5, 4, 3, 2, 1].map(value => <option key={value} value={value}>{value} star</option>)}</select></div><section className="panel table-panel"><div className="table-wrap"><table><thead><tr><th>Ticket ID</th><th>Corporate</th><th>Service Centre</th><th>Rating</th><th>Review</th><th>Submitted</th><th>Action</th></tr></thead><tbody>{reviews.map(review => <tr key={review._id}><td>{review.ticketId?.ticketId || '—'}</td><td>{review.corporateId?.name || '—'}</td><td>{review.serviceCentreId?.name || '—'}</td><td><span className="review-stars">{Array.from({ length: review.rating }, (_, index) => <Star key={index} size={15} fill="currentColor" />)}</span></td><td>{review.comment}</td><td>{new Date(review.createdAt).toLocaleDateString()}</td><td><Link className="text-link" to={`/service/reviews/${review._id}`}>View</Link></td></tr>)}</tbody></table>{!reviews.length && !error && <Empty message="No internal customer reviews yet." />}</div></section></ServiceShell>;
}

export function InternalReviewDetail() {
  const { reviewId } = useParams(); const [review, setReview] = useState(null); const [error, setError] = useState('');
  useEffect(() => { getServiceReview(reviewId).then(setReview).catch(loadError => setError(loadError.message || 'Unable to load this review.')); }, [reviewId]);
  if (!review) return <ServiceShell title="Review details"><div className="loading">{error || 'Loading review...'}</div></ServiceShell>;
  return <ServiceShell title="Review details"><Link className="back-link" to="/service/reviews">Back to reviews</Link><section className="panel review-form-panel"><span className="kicker">Customer feedback</span><h2>{review.ticketId?.ticketId || 'Service request'}</h2><div className="info-row"><span>Customer</span><strong>{review.customerId?.name || 'Customer'}</strong></div><div className="info-row"><span>Corporate</span><strong>{review.corporateId?.name || '—'}</strong></div><div className="info-row"><span>Service Centre</span><strong>{review.serviceCentreId?.name || '—'}</strong></div><div className="info-row"><span>Device</span><strong>{review.deviceId?.model || '—'}</strong></div><div className="info-row"><span>Rating</span><strong className="review-stars">{Array.from({ length: review.rating }, (_, index) => <Star key={index} size={16} fill="currentColor" />)}</strong></div><div className="review-block"><span className="kicker">Review</span><p>{review.comment}</p></div><small>Submitted {new Date(review.createdAt).toLocaleString()}</small></section></ServiceShell>;
}
