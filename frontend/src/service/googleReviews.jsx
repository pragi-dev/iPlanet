import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowUpRight, CheckCheck, Eye, MessageSquareText, RefreshCw, Search, Star, TrendingUp } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ServiceShell } from './servicePages';
import { Badge, Empty, Metric, PageTitle } from './components';
import { acknowledgeGoogleReview, generateGoogleReviewResponse, getGoogleGmailAuthUrl, getGoogleReviewAnalytics, getGoogleReviewHealth, getGoogleReviews, getServiceCentres, resolveGoogleReview, syncGoogleReviews } from './api';

const sentimentColors = { positive: '#2f8f5b', neutral: '#d4a72c', negative: '#bf4a3f' };
const ratingColors = ['#0e7490', '#2f8f5b', '#d4a72c', '#d96f45', '#bf4a3f'];
const filtersDefault = { rating: 'All', sentiment: 'All', status: 'All', priority: 'All', from: '', to: '' };

function formatReviewDate(value) {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}

function starDisplay(rating = 0) {
  return '★'.repeat(Math.max(1, Math.min(5, Number(rating) || 0))) + '☆'.repeat(Math.max(0, 5 - Math.max(1, Math.min(5, Number(rating) || 0))));
}

function buildReviewCharts(items) {
  const sentimentBuckets = ['positive', 'neutral', 'negative'].map(key => ({ name: key, value: items.filter(item => item.sentiment === key).length }));
  const ratingBuckets = [5, 4, 3, 2, 1].map(rating => ({ name: `${rating}★`, value: items.filter(item => Number(item.rating) === rating).length }));
  const byDay = Object.values(items.reduce((acc, item) => {
    const day = item.reviewCreatedAt ? new Date(item.reviewCreatedAt).toISOString().slice(0, 10) : 'unknown';
    acc[day] = acc[day] || { day: formatReviewDate(item.reviewCreatedAt), total: 0 };
    acc[day].total += 1;
    return acc;
  }, {})).sort((a, b) => new Date(a.day).getTime() - new Date(b.day).getTime());
  const ratingTrend = [5, 4, 3, 2, 1].map(rating => ({ name: `${rating}★`, value: items.filter(item => Number(item.rating) === rating).length }));

  return { sentimentBuckets, ratingBuckets, byDay, ratingTrend };
}

export function GoogleReviews({ admin = false } = {}) {
  const location = useLocation();
  const [reviews, setReviews] = useState([]);
  const [analytics, setAnalytics] = useState({ summary: { totalReviews: 0, averageRating: 0, positiveReviews: 0, neutralReviews: 0, negativeReviews: 0, unresolvedNegativeReviews: 0 }, byServiceCentre: [] });
  const [serviceCentres, setServiceCentres] = useState([]);
  const [selectedReview, setSelectedReview] = useState(null);
  const [filters, setFilters] = useState(filtersDefault);
  const [serviceCentreFilter, setServiceCentreFilter] = useState('All');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [health, setHealth] = useState(null);

  const load = async () => {
    try {
      setLoading(true);
      const [reviewRows, analyticsResult, centreRows, healthResult] = await Promise.all([
        getGoogleReviews(admin ? { serviceCentreId: serviceCentreFilter !== 'All' ? serviceCentreFilter : undefined } : {}),
        getGoogleReviewAnalytics(admin ? { serviceCentreId: serviceCentreFilter !== 'All' ? serviceCentreFilter : undefined } : {}),
        getServiceCentres().catch(() => []),
        getGoogleReviewHealth().catch(() => null)
      ]);
      setReviews(reviewRows);
      setAnalytics(analyticsResult || { summary: { totalReviews: 0, averageRating: 0, positiveReviews: 0, neutralReviews: 0, negativeReviews: 0, unresolvedNegativeReviews: 0 }, byServiceCentre: [] });
      setServiceCentres(centreRows);
      setHealth(healthResult);
    } catch (loadError) {
      setError(loadError.message || 'Unable to load Google reviews.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [admin, serviceCentreFilter]);

  useEffect(() => {
    const focusId = new URLSearchParams(location.search).get('focus');
    if (focusId && reviews.length) {
      const match = reviews.find(review => String(review._id) === focusId || String(review.id) === focusId);
      if (match) setSelectedReview(match);
    }
  }, [location.search, reviews]);

  const filteredReviews = useMemo(() => {
    return reviews.filter(review => {
      const matchesRating = filters.rating === 'All' || Number(review.rating) === Number(filters.rating);
      const matchesSentiment = filters.sentiment === 'All' || review.sentiment === filters.sentiment;
      const matchesStatus = filters.status === 'All' || review.status === filters.status;
      const matchesPriority = filters.priority === 'All' || review.priority === filters.priority;
      const matchesFrom = !filters.from || new Date(review.reviewCreatedAt) >= new Date(filters.from);
      const matchesTo = !filters.to || new Date(review.reviewCreatedAt) <= new Date(`${filters.to}T23:59:59`);
      return matchesRating && matchesSentiment && matchesStatus && matchesPriority && matchesFrom && matchesTo;
    });
  }, [reviews, filters]);

  const summaryCards = [
    { label: 'Total Reviews', value: analytics.summary.totalReviews ?? filteredReviews.length, accent: 'teal' },
    { label: 'Average Rating', value: `${Number(analytics.summary.averageRating ?? 0).toFixed(1)} ★`, accent: 'gold' },
    { label: 'Positive Reviews', value: analytics.summary.positiveReviews ?? 0, accent: 'green' },
    { label: 'Neutral Reviews', value: analytics.summary.neutralReviews ?? 0, accent: 'amber' },
    { label: 'Negative Reviews', value: analytics.summary.negativeReviews ?? 0, accent: 'coral' },
    { label: 'Reviews Requiring Attention', value: analytics.summary.unresolvedNegativeReviews ?? 0, accent: 'rose' },
  ];

  const charts = useMemo(() => buildReviewCharts(filteredReviews), [filteredReviews]);

  const openReview = async (review) => {
    const match = review && reviews.find(item => String(item._id) === String(review._id));
    if (!match) return;
    setSelectedReview(match);
  };

  const markAction = async (reviewId, action) => {
    try {
      if (action === 'acknowledge') await acknowledgeGoogleReview(reviewId);
      if (action === 'resolve') await resolveGoogleReview(reviewId);
      if (action === 'generate') {
        const response = await generateGoogleReviewResponse(reviewId);
        setSelectedReview(current => current && current._id === reviewId ? { ...current, suggestedResponse: response.suggestedResponse || current.suggestedResponse } : current);
        return;
      }
      await load();
      const next = reviews.find(item => String(item._id) === String(reviewId));
      if (next) setSelectedReview(next);
    } catch (markError) {
      setError(markError.message || 'Unable to update review status.');
    }
  };

  const handleFilter = (field, value) => setFilters(current => ({ ...current, [field]: value }));

  const syncReviews = async () => {
    try {
      setSyncing(true);
      setSyncMessage('');
      const result = await syncGoogleReviews();
      setSyncMessage(`Sync complete: ${result.newReviews || 0} new, ${result.duplicates || 0} duplicate, ${result.failed || 0} failed.`);
      await load();
    } catch (syncError) {
      setError(syncError.message || 'Unable to sync Google reviews.');
    } finally {
      setSyncing(false);
    }
  };

  const connectGmail = async () => {
    try {
      const result = await getGoogleGmailAuthUrl();
      window.location.assign(result.authorizationUrl);
    } catch (authError) {
      setError(authError.message || 'Unable to start Google authorization.');
    }
  };

  const serviceTitle = admin ? 'Google Reviews' : 'Google Reviews';
  const serviceDescription = admin ? 'Monitor service-centre feedback and operational risk across the network.' : 'Monitor customer feedback for this service centre.';

  return (
    <ServiceShell title={serviceTitle}>
      <PageTitle title={serviceTitle} description={serviceDescription} action={<button type="button" className="button primary" onClick={syncReviews} disabled={syncing}><RefreshCw size={15} className={syncing ? 'spin' : ''} />{syncing ? 'Syncing...' : 'Sync Google Reviews'}</button>} />
      <div className="panel review-connection-status">
        <div><span className="kicker">Google Reviews</span><strong>{health?.gmailConfigured ? 'Connected' : 'Not connected'}</strong><small>{health?.businessName || 'Phoenixx IT'} · {health?.placeId || 'Place ID not configured'}</small></div>
        <div><span className="kicker">Last sync</span><strong>{health?.lastSyncAt ? formatReviewDate(health.lastSyncAt) : 'Never'}</strong><small>{health?.lastSyncStatus || 'never'}</small></div>
        {!health?.gmailConfigured && <button type="button" className="button secondary" onClick={connectGmail}>Connect Gmail</button>}
      </div>
      {syncMessage && <p className="form-success review-error">{syncMessage}</p>}
      <div className="toolbar service-toolbar review-toolbar">
        {admin && (
          <select value={serviceCentreFilter} onChange={event => setServiceCentreFilter(event.target.value)}>
            <option value="All">All service centres</option>
            {serviceCentres.map(centre => (
              <option key={centre._id} value={centre._id}>{centre.name}</option>
            ))}
          </select>
        )}
        <select value={filters.rating} onChange={event => handleFilter('rating', event.target.value)}>
          <option value="All">All ratings</option>
          {[5, 4, 3, 2, 1].map(value => <option key={value} value={value}>{value} star</option>)}
        </select>
        <select value={filters.sentiment} onChange={event => handleFilter('sentiment', event.target.value)}>
          <option value="All">All sentiment</option>
          <option value="positive">Positive</option>
          <option value="neutral">Neutral</option>
          <option value="negative">Negative</option>
        </select>
        <select value={filters.status} onChange={event => handleFilter('status', event.target.value)}>
          <option value="All">All status</option>
          {['Open', 'Acknowledged', 'Resolved'].map(status => <option key={status} value={status}>{status}</option>)}
        </select>
        <select value={filters.priority} onChange={event => handleFilter('priority', event.target.value)}>
          <option value="All">All priority</option>
          {['low', 'medium', 'high'].map(level => <option key={level} value={level}>{level}</option>)}
        </select>
        <input type="date" value={filters.from} onChange={event => handleFilter('from', event.target.value)} />
        <input type="date" value={filters.to} onChange={event => handleFilter('to', event.target.value)} />
      </div>

      {error && <p className="form-error review-error">{error}</p>}

      <div className="metrics service-metrics review-metrics">
        {summaryCards.map(item => (
          <Metric key={item.label} label={item.label} value={item.value} note="Live MongoDB data" accent={item.accent} />
        ))}
      </div>

      <div className="chart-grid review-chart-grid">
        <section className="panel chart-panel">
          <div className="panel-heading"><div><span className="kicker">Trend</span><h3>Rating trend</h3></div></div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={charts.ratingTrend}>
              <CartesianGrid vertical={false} stroke="#e9eeef" />
              <XAxis dataKey="name" tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} />
              <Tooltip />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {charts.ratingTrend.map((entry, index) => <Cell key={`${entry.name}-${index}`} fill={ratingColors[index % ratingColors.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </section>

        <section className="panel chart-panel">
          <div className="panel-heading"><div><span className="kicker">Sentiment</span><h3>Sentiment distribution</h3></div></div>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={charts.sentimentBuckets} dataKey="value" nameKey="name" innerRadius={52} outerRadius={82} paddingAngle={3}>
                {charts.sentimentBuckets.map(bucket => <Cell key={bucket.name} fill={sentimentColors[bucket.name] || '#0e7490'} />)}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
          <div className="legend review-legend">
            {charts.sentimentBuckets.map(item => (
              <span key={item.name}><i style={{ background: sentimentColors[item.name] || '#0e7490' }} />{item.name}<b>{item.value}</b></span>
            ))}
          </div>
        </section>

        <section className="panel chart-panel">
          <div className="panel-heading"><div><span className="kicker">Ratings</span><h3>Rating distribution</h3></div></div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={charts.ratingBuckets}>
              <CartesianGrid vertical={false} stroke="#e9eeef" />
              <XAxis dataKey="name" tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} />
              <Tooltip />
              <Bar dataKey="value" fill="#0e7490" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </section>

        <section className="panel chart-panel">
          <div className="panel-heading"><div><span className="kicker">Volume</span><h3>Review volume over time</h3></div></div>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={charts.byDay}>
              <defs>
                <linearGradient id="reviewArea" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="5%" stopColor="#0e7490" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="#0e7490" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="#e9eeef" />
              <XAxis dataKey="day" tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} />
              <Tooltip />
              <Area dataKey="total" stroke="#0e7490" fill="url(#reviewArea)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </section>
      </div>

      <section className="panel table-panel review-table-panel">
        <div className="panel-heading">
          <div>
            <span className="kicker">Recent reviews</span>
            <h3>Recent Google Reviews</h3>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Rating</th>
                <th>Reviewer</th>
                <th>Review</th>
                <th>Sentiment</th>
                <th>Priority</th>
                <th>Date</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredReviews.map(review => (
                <tr key={review._id} className={review.sentiment === 'negative' ? 'negative-review-row' : ''}>
                  <td><span className="review-stars">{starDisplay(review.rating)}</span></td>
                  <td>{review.reviewerName || 'Google Reviewer'}<small>{review.serviceCentreName || 'Service centre'}</small></td>
                  <td className="review-text-cell">{review.comment || review.aiSummary || 'No review text provided.'}</td>
                  <td><Badge>{review.sentiment === 'positive' ? 'Positive' : review.sentiment === 'negative' ? 'Negative' : 'Neutral'}</Badge></td>
                  <td><Badge>{review.priority || 'low'}</Badge></td>
                  <td>{formatReviewDate(review.reviewCreatedAt)}</td>
                  <td><Badge>{review.status || 'Open'}</Badge></td>
                  <td><button type="button" className="button secondary small-button" onClick={() => openReview(review)}><Eye size={14} />View</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filteredReviews.length && <Empty message="No Google reviews match these filters." />}
        </div>
      </section>

      {selectedReview && (
        <div className="drawer-backdrop" onClick={() => setSelectedReview(null)}>
          <aside className="review-drawer panel" onClick={event => event.stopPropagation()}>
            <div className="panel-heading review-drawer-header">
              <div>
                <span className="kicker">Review details</span>
                <h3>{selectedReview.serviceCentreName || 'Service Centre'}</h3>
              </div>
              <button type="button" className="modal-close" onClick={() => setSelectedReview(null)}><Search size={18} /></button>
            </div>
            <div className="review-drawer-body">
              <div className="review-summary-row">
                <span className="kicker">Rating</span>
                <strong>{starDisplay(selectedReview.rating)}</strong>
              </div>
              <div className="review-detail-grid">
                <div><span>Reviewer</span><strong>{selectedReview.reviewerName || 'Google reviewer'}</strong></div>
                <div><span>Posted date</span><strong>{formatReviewDate(selectedReview.reviewCreatedAt)}</strong></div>
                <div><span>Store</span><strong>{selectedReview.serviceCentreName || 'N/A'}</strong></div>
                <div><span>Sentiment</span><strong>{selectedReview.sentiment || 'neutral'}</strong></div>
                <div><span>Priority</span><strong>{selectedReview.priority || 'low'}</strong></div>
                <div><span>Status</span><strong>{selectedReview.status || 'Open'}</strong></div>
              </div>

              <div className="review-block">
                <span className="kicker">Original Google Review</span>
                <p>{selectedReview.comment || 'No review text provided.'}</p>
                {selectedReview.reviewUrl && <a className="text-link" href={selectedReview.reviewUrl} target="_blank" rel="noreferrer">Open Review <ArrowUpRight size={14} /></a>}
              </div>

              <div className="review-block">
                <span className="kicker">AI Summary</span>
                <p>{selectedReview.aiSummary || 'No AI summary available yet.'}</p>
              </div>

              <div className="review-block">
                <span className="kicker">Detected issue/theme</span>
                <p>{selectedReview.keyIssue || 'No issue theme detected.'}</p>
              </div>

              <div className="review-block">
                <span className="kicker">Recommended action</span>
                <p>{selectedReview.recommendedAction || 'Review the service interaction and contact the customer as appropriate.'}</p>
              </div>

              <div className="review-block">
                <span className="kicker">Suggested response</span>
                <p>{selectedReview.suggestedResponse || 'Thank you for the feedback. We appreciate your input and will follow up appropriately.'}</p>
              </div>

              <div className="review-actions">
                <button type="button" className="button secondary" onClick={() => markAction(selectedReview._id, 'acknowledge')}><CheckCheck size={15} />Mark Acknowledged</button>
                <button type="button" className="button secondary" onClick={() => markAction(selectedReview._id, 'resolve')}><TrendingUp size={15} />Mark Resolved</button>
                <button type="button" className="button primary" onClick={() => markAction(selectedReview._id, 'generate')}><MessageSquareText size={15} />Generate Response</button>
              </div>
            </div>
          </aside>
        </div>
      )}
    </ServiceShell>
  );
}
