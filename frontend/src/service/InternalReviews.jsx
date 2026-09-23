import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MessageSquareText, Star } from 'lucide-react';
import { ServiceShell } from './components';
import { getServiceReview, getServiceReviews } from './api';
import { Badge, Card, EmptyState, ErrorState, FilterBar, FilterSelect, InfoList, KPI, KPIGrid, PageHeader, PageSkeleton, RowAction, SearchInput, Stars, TableCard, Tabs, formatDate, formatDateTime, friendlyError, useAsync } from '../ui';

export function ReviewTabs({ current }) {
  return <Tabs label="Review source" value={current} tabs={[{ to: '/service/reviews', label: 'Internal reviews' }, { to: '/service/reviews/google', label: 'Google reviews' }]} />;
}

export function InternalReviews() {
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ search: '', rating: 'All' });
  useEffect(() => { const timer = window.setTimeout(() => setFilters(current => ({ ...current, search })), 300); return () => window.clearTimeout(timer); }, [search]);
  const state = useAsync(() => getServiceReviews(filters), [filters.search, filters.rating]);
  const reviews = state.data || [];
  const average = reviews.length ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length : null;
  return <ServiceShell title="Reviews">
    <PageHeader title="Reviews" description="Customer feedback from closed service requests and your Google Business Profile." />
    <ReviewTabs current="/service/reviews" />
    <KPIGrid columns={3}>
      <KPI label="Internal reviews" value={state.data ? reviews.length : '—'} icon={MessageSquareText} hint={filters.rating !== 'All' || filters.search ? 'Matching current filters' : 'All submitted reviews'} />
      <KPI label="Average rating" value={average === null ? '—' : average.toFixed(1)} icon={Star} tone="warning" hint={average === null ? 'No reviews yet' : 'Out of 5'} />
      <KPI label="Low ratings (1–2★)" value={state.data ? reviews.filter(review => review.rating <= 2).length : '—'} icon={Star} tone={reviews.some(review => review.rating <= 2) ? 'critical' : 'neutral'} />
    </KPIGrid>
    <TableCard columns={7} loading={state.loading && !state.data} error={state.error && friendlyError(state.error)} errorTitle="Unable to load reviews" onRetry={state.reload}
      toolbar={<FilterBar summary={state.data ? `${reviews.length} review${reviews.length === 1 ? '' : 's'}` : null}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search ticket ID" label="Search reviews" />
        <FilterSelect label="Rating" value={filters.rating} onChange={rating => setFilters(current => ({ ...current, rating }))} options={[5, 4, 3, 2, 1].map(value => ({ value: String(value), label: `${value} star${value === 1 ? '' : 's'}` }))} allLabel="All ratings" />
      </FilterBar>}
      isEmpty={!reviews.length} empty={<EmptyState icon={MessageSquareText} title={filters.search || filters.rating !== 'All' ? 'No reviews match these filters' : 'No internal reviews yet'} description="Customers can rate a service request after it is closed." />}>
      <table className="table">
        <thead><tr><th>Source</th><th>Ticket</th><th>Corporate</th><th>Service centre</th><th>Rating</th><th>Review</th><th>Submitted</th><th><span className="sr-only">Action</span></th></tr></thead>
        <tbody>{reviews.map(review => <tr key={review._id}>
          <td><Badge tone="info">Internal</Badge></td>
          <td className="mono cell-nowrap">{review.ticketId?.ticketId || '—'}</td>
          <td>{review.corporateId?.name || '—'}</td>
          <td>{review.serviceCentreId?.name || '—'}</td>
          <td><Stars rating={review.rating} /></td>
          <td style={{ maxWidth: 360 }}><span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{review.comment}</span></td>
          <td className="cell-nowrap">{formatDate(review.createdAt)}</td>
          <td className="cell-right"><RowAction to={`/service/reviews/${review._id}`} /></td>
        </tr>)}</tbody>
      </table>
    </TableCard>
  </ServiceShell>;
}

export function InternalReviewDetail() {
  const { reviewId } = useParams();
  const state = useAsync(() => getServiceReview(reviewId), [reviewId]);
  const crumbs = [{ label: 'Reviews', to: '/service/reviews' }, { label: 'Review details' }];
  if (state.loading && !state.data) return <ServiceShell title="Review details" crumbs={crumbs}><PageSkeleton variant="detail" kpis={0} /></ServiceShell>;
  if (state.error) return <ServiceShell title="Review details" crumbs={crumbs}><PageHeader title="Review details" back={{ to: '/service/reviews', label: 'Reviews' }} /><div className="card"><ErrorState title="Unable to load this review" message={friendlyError(state.error)} onRetry={state.reload} /></div></ServiceShell>;
  const review = state.data;
  return <ServiceShell title="Review details" crumbs={crumbs}>
    <PageHeader title={review.ticketId?.ticketId ? `Review for ${review.ticketId.ticketId}` : 'Customer review'} back={{ to: '/service/reviews', label: 'Reviews' }} meta={<><Badge tone="info">Internal review</Badge><span>Submitted {formatDateTime(review.createdAt)}</span></>} />
    <div className="grid-main-side">
      <Card title="Feedback">
        <div className="stack-12"><Stars rating={review.rating} size={20} /><p className="review-text">{review.comment}</p></div>
      </Card>
      <Card title="Service request">
        <InfoList items={[['Customer', review.customerId?.name], ['Corporate', review.corporateId?.name], ['Service centre', review.serviceCentreId?.name], ['Device', review.deviceId?.model], ['Ticket', review.ticketId?._id ? <Link className="btn-link mono" to={`/service/tickets/${review.ticketId._id}`}>{review.ticketId.ticketId}</Link> : null]]} />
      </Card>
    </div>
  </ServiceShell>;
}
