import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { ServiceShell } from './servicePages';
import { Badge, Empty, PageTitle } from './components';
import { getServiceReviews } from './api';

export function InternalReviews() {
  const [reviews, setReviews] = useState([]); const [filters, setFilters] = useState({ search: '', rating: 'All' }); const [error, setError] = useState('');
  useEffect(() => { getServiceReviews(filters).then(setReviews).catch(loadError => setError(loadError.message || 'Unable to load reviews.')); }, [filters]);
  return <ServiceShell title="Customer Reviews"><PageTitle title="Customer Reviews" description="Feedback submitted after completed iPlanet service requests." />{error && <p className="form-error">{error}</p>}<div className="toolbar service-toolbar"><input value={filters.search} onChange={event => setFilters({ ...filters, search: event.target.value })} placeholder="Search ticket ID" /><select value={filters.rating} onChange={event => setFilters({ ...filters, rating: event.target.value })}><option>All</option>{[5, 4, 3, 2, 1].map(value => <option key={value} value={value}>{value} star</option>)}</select></div><section className="panel table-panel"><div className="table-wrap"><table><thead><tr><th>Ticket ID</th><th>Corporate</th><th>Service Centre</th><th>Rating</th><th>Review</th><th>Submitted Date</th><th>Status</th></tr></thead><tbody>{reviews.map(review => <tr key={review._id}><td>{review.ticketId?.ticketId || '—'}</td><td>{review.corporateId?.name || '—'}</td><td>{review.serviceCentreId?.name || '—'}</td><td><span className="review-stars">{Array.from({ length: review.rating }, (_, index) => <Star key={index} size={15} fill="currentColor" />)}</span></td><td>{review.comment}</td><td>{new Date(review.createdAt).toLocaleDateString()}</td><td><Badge>Internal Review</Badge></td></tr>)}</tbody></table>{!reviews.length && !error && <Empty message="No internal customer reviews yet." />}</div></section></ServiceShell>;
}
