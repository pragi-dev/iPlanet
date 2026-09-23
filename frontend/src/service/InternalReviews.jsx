import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ChevronLeft, MessageSquareText, RefreshCcw } from 'lucide-react';
import { ServiceShell } from './components';
import { getGoogleReviewsSync, getServiceReview, getServiceReviews } from './api';
import { GoogleReviewCard, InternalReviewCard, ReviewTabs, flattenGoogleReviews, getCachedGoogleSync, setCachedGoogleSync } from './reviewShared';
import { Badge, Button, EmptyState, ErrorState, FilterBar, FilterSelect, InfoList, InlineAlert, KPI, KPIGrid, PageHeader, PageSkeleton, RowAction, SearchInput, Section, Stars, Surface, TableCard, formatDate, formatDateTime, friendlyError, useAsync } from '../ui';

export { ReviewTabs };

export function InternalReviews() {
  const [params] = useSearchParams();
  const view = params.get('source') === 'internal' ? 'internal' : 'all';
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ search: '', rating: 'All' });
  const [googleSync, setGoogleSync] = useState(getCachedGoogleSync);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  useEffect(() => { const timer = window.setTimeout(() => setFilters(current => ({ ...current, search })), 300); return () => window.clearTimeout(timer); }, [search]);
  const state = useAsync(() => getServiceReviews(filters), [filters.search, filters.rating]);
  const reviews = state.data || [];
  const googleReviews = useMemo(() => flattenGoogleReviews(googleSync).filter(review => filters.rating === 'All' || Number(review.rating) === Number(filters.rating)), [googleSync, filters.rating]);
  const combined = useMemo(() => [...reviews.map(review => ({ ...review, source: 'internal' })), ...(filters.search ? [] : googleReviews)].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)), [reviews, googleReviews, filters.search]);
  const average = reviews.length ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length : null;

  const syncGoogle = async () => {
    setSyncing(true);
    setSyncError('');
    try { const result = await getGoogleReviewsSync(); setCachedGoogleSync(result); setGoogleSync(result); }
    catch (error) { setSyncError(friendlyError(error, 'Unable to sync Google reviews.')); }
    finally { setSyncing(false); }
  };

  const filterBar = <FilterBar summary={state.data ? `${view === 'all' ? combined.length : reviews.length} review${(view === 'all' ? combined.length : reviews.length) === 1 ? '' : 's'}` : null}>
    <SearchInput value={search} onChange={setSearch} placeholder="Search ticket ID" label="Search reviews" />
    <FilterSelect label="Rating" value={filters.rating} onChange={rating => setFilters(current => ({ ...current, rating }))} options={[5, 4, 3, 2, 1].map(value => ({ value: String(value), label: `${value} star${value === 1 ? '' : 's'}` }))} allLabel="All ratings" />
  </FilterBar>;

  return <ServiceShell title="Reviews">
    <PageHeader title="Reviews" description="Customer feedback from closed service requests and your Google Business Profile." />
    <ReviewTabs current={view === 'internal' ? '/service/reviews?source=internal' : '/service/reviews'} />
    <KPIGrid columns={3}>
      <KPI label="Internal reviews" value={state.data ? reviews.length : '—'} hint={filters.rating !== 'All' || filters.search ? 'Matching current filters' : 'After closed service requests'} />
      <KPI label="Average internal rating" value={average === null ? '—' : average.toFixed(1)} hint={average === null ? 'No reviews yet' : 'Out of 5'} />
      <KPI label="Google reviews" value={googleSync ? flattenGoogleReviews(googleSync).length : '—'} hint={googleSync ? 'From the last sync' : 'Not synced this session'} />
    </KPIGrid>

    {view === 'internal' ? <TableCard columns={7} loading={state.loading && !state.data} error={state.error && friendlyError(state.error)} errorTitle="Unable to load reviews" onRetry={state.reload} toolbar={filterBar}
      isEmpty={!reviews.length} empty={<EmptyState icon={MessageSquareText} title={filters.search || filters.rating !== 'All' ? 'No reviews match these filters' : 'No internal reviews yet'} description="Customers can rate a service request after it is closed." />}>
      <table className="table">
        <thead><tr><th>Ticket</th><th>Corporate</th><th>Service centre</th><th>Rating</th><th>Review</th><th>Submitted</th><th><span className="sr-only">Action</span></th></tr></thead>
        <tbody>{reviews.map(review => <tr key={review._id}>
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
      : <div className="stack-16">
        <div className="card card-flush">{filterBar}
          <div className="row-between" style={{ padding: '14px 24px' }}>
            <span className="text-muted text-small">{googleSync ? 'Includes Google reviews from the last sync in this session.' : 'Google reviews are retrieved on request from your Business Profile.'}</span>
            <Button size="sm" icon={RefreshCcw} onClick={syncGoogle} disabled={syncing}>{syncing ? 'Syncing…' : googleSync ? 'Refresh Google reviews' : 'Include Google reviews'}</Button>
          </div>
        </div>
        {syncError && <InlineAlert tone="warning" title="Google reviews unavailable">{syncError}</InlineAlert>}
        {state.loading && !state.data ? <PageSkeleton variant="none" kpis={0} />
          : state.error ? <div className="card"><ErrorState title="Unable to load reviews" message={friendlyError(state.error)} onRetry={state.reload} /></div>
          : !combined.length ? <div className="card"><EmptyState icon={MessageSquareText} title="No reviews yet" description="Internal reviews appear after customers rate closed requests. Google reviews appear after a sync." /></div>
          : <div className="review-cards">{combined.map((review, index) => review.source === 'google' ? <GoogleReviewCard key={review.googleReviewId || `g-${index}`} review={review} /> : <InternalReviewCard key={review._id} review={review} />)}</div>}
      </div>}
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
    <div className="page-header">
      <Link className="back-link" to="/service/reviews"><ChevronLeft size={16} aria-hidden="true" />Reviews</Link>
      <div className="page-header-text">
        <p className="eyebrow">{review.corporateId?.name || 'Customer review'}</p>
        <h1 className="page-title">{review.ticketId?.ticketId ? <>Review for <span className="mono" style={{ fontSize: '0.86em' }}>{review.ticketId.ticketId}</span></> : 'Customer review'}</h1>
        <div className="page-meta"><Badge tone="info">Internal</Badge><Stars rating={review.rating} size={16} /><span>{formatDateTime(review.createdAt)}</span></div>
      </div>
    </div>
    <Surface label="Review">
      <Section title="Feedback"><p className="review-text" style={{ fontSize: 17 }}>{review.comment}</p></Section>
      <Section title="Service request">
        <InfoList columns={2} items={[['Customer', review.customerId?.name], ['Corporate', review.corporateId?.name], ['Service centre', review.serviceCentreId?.name], ['Device', review.deviceId?.model], ['Ticket', review.ticketId?._id ? <Link className="btn-link mono" to={`/service/tickets/${review.ticketId._id}`}>{review.ticketId.ticketId}</Link> : null]]} />
      </Section>
    </Surface>
  </ServiceShell>;
}
