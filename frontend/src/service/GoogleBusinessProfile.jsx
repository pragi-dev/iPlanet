import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BellRing, Link2, MapPinned, MessageSquareText, RefreshCcw, ShieldCheck, Unplug } from 'lucide-react';
import { ServiceShell } from './components';
import { GoogleBadge, GoogleReviewCard, ReviewTabs, flattenGoogleReviews, googleErrorMessage, reviewerName, setCachedGoogleReviews } from './reviewShared';
import {
  checkGoogleConnection, deleteGoogleReviewReply, disconnectGoogleBusiness, getGoogleBusinessStatus, getGoogleLocations, getGoogleMappings, getGoogleNotificationSetting,
  getGoogleReviews, getServiceCentres, mapGoogleLocation, saveGoogleReviewReply, setGoogleNotifications, startGoogleBusinessAuth, syncGoogleLocation, unmapGoogleLocation,
} from './api';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, FilterBar, FilterSelect, InlineAlert, KPI, KPIGrid, Modal, NextAction, PageHeader, SearchInput, Skeleton, Stars, Tabs, formatDateTime, formatRelative } from '../ui';

const MAX_REPLY_BYTES = 4096;
const CALLBACK_REASONS = {
  access_denied: 'Google sign-in was cancelled before access was granted.',
  invalid_state: 'The Google sign-in link expired or was already used. Start the connection again.',
  not_authorized: 'Only iPlanet Service users can connect Google Business Profile.',
  insufficient_scope: 'Google access was granted without Business Profile management permission. Connect again and approve all requested access.',
  invalid_client: 'Google rejected the OAuth client configured on the backend.',
  reconnect_required: 'Google rejected the authorization code. Start the connection again.',
};
const SYNC_TONE = { ok: 'success', error: 'critical', pending: 'warning', never: 'neutral' };
const SYNC_LABEL = { ok: 'Synced', error: 'Sync failed', pending: 'Update pending', never: 'Not synced yet' };

// Describes the connection for the status banner. Every state maps to what
// Google actually reported; nothing is shown as working unless it is.
function connectionView(status) {
  if (!status.configured) return { tone: 'critical', light: 'bad', title: 'Google OAuth is not configured', description: `The backend is missing: ${status.missingConfiguration.join(', ')}.` };
  const connection = status.connection;
  if (!connection || connection.status === 'disconnected' || !status.connected && connection.status !== 'reconnect_required') return { tone: 'info', light: '', title: 'Google Business Profile is not connected', description: 'Connect the iPlanet Service Google account that manages your Business Profile locations.', action: 'connect' };
  if (connection.status === 'reconnect_required') return { tone: 'warning', light: 'warn', title: 'Reconnect Google Business Profile', description: 'Google access was revoked or expired. Reconnect to resume review retrieval.', action: 'reconnect' };
  const { access } = status;
  if (access.state === 'pending') return { tone: 'warning', light: 'warn', title: 'Google Business Profile access pending', description: access.lastErrorMessage, action: 'check' };
  if (access.state === 'error') return { tone: 'critical', light: 'bad', title: 'Google Business Profile needs attention', description: access.lastErrorMessage, action: access.lastErrorCategory === 'insufficient_scope' ? 'reconnect' : 'check' };
  if (access.state === 'unknown') return { tone: 'info', light: 'warn', title: 'Connected — verifying Google access', description: 'Checking which Business Profile accounts this connection can reach.', action: 'check' };
  return { tone: 'success', light: 'on', title: 'Business Profile connected', description: access.lastCheckedAt ? `Access last confirmed ${formatDateTime(access.lastCheckedAt)}.` : 'Access confirmed.' };
}

export function GoogleBusinessProfile() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [tab, setTab] = useState(params.get('tab') || 'reviews');
  const [confirm, setConfirm] = useState(null);
  const [serviceCentres, setServiceCentres] = useState([]);

  const loadStatus = async () => {
    try { const result = await getGoogleBusinessStatus(); setStatus(result); setStatusError(''); return result; }
    catch (error) { setStatusError(googleErrorMessage(error, 'Unable to load Google Business Profile status.')); return null; }
  };
  const check = async ({ quiet = false } = {}) => {
    setBusy('check');
    try { await checkGoogleConnection(); if (!quiet) setNotice({ tone: 'success', text: 'Google access confirmed.' }); }
    catch (error) { if (!quiet && error.google?.category !== 'access_pending') setNotice({ tone: 'critical', text: googleErrorMessage(error) }); }
    finally { setBusy(''); await loadStatus(); }
  };

  useEffect(() => {
    const outcome = params.get('google');
    if (outcome) {
      setNotice(outcome === 'connected' ? { tone: 'success', text: 'Google Business Profile connected.' } : { tone: 'critical', text: CALLBACK_REASONS[params.get('reason')] || 'Google Business Profile could not be connected.' });
      const next = new URLSearchParams(params); next.delete('google'); next.delete('reason'); setParams(next, { replace: true });
    }
    loadStatus().then(result => { if (result?.connected && result.access.state === 'unknown') void check({ quiet: true }); });
    getServiceCentres().then(setServiceCentres).catch(() => setServiceCentres([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async ({ reconnect = false } = {}) => {
    setBusy('connect');
    try { const result = await startGoogleBusinessAuth({ reconnect }); window.location.assign(result.url); }
    catch (error) { setNotice({ tone: 'critical', text: googleErrorMessage(error, 'Unable to start Google authorization.') }); setBusy(''); }
  };
  const disconnect = async () => {
    setBusy('disconnect');
    try {
      const result = await disconnectGoogleBusiness();
      setCachedGoogleReviews(null);
      setNotice({ tone: 'success', text: result.revoked ? 'Disconnected. iPlanet\'s access was revoked at Google.' : 'Disconnected locally. Google did not confirm the revocation; you can also remove access from your Google Account permissions.' });
    } catch (error) { setNotice({ tone: 'critical', text: googleErrorMessage(error) }); }
    finally { setBusy(''); setConfirm(null); await loadStatus(); }
  };

  const view = status ? connectionView(status) : null;
  const usable = status?.connected && status.access.state === 'granted';
  const actions = !view ? [] : [
    view.action === 'connect' && { label: busy === 'connect' ? 'Opening Google…' : 'Connect Google Business Profile', icon: Link2, onClick: () => connect(), disabled: Boolean(busy) },
    view.action === 'reconnect' && { label: busy === 'connect' ? 'Opening Google…' : 'Reconnect', icon: Link2, onClick: () => connect({ reconnect: true }), disabled: Boolean(busy) },
    (view.action === 'check' || view.action === 'reconnect' && status.connected) && { label: busy === 'check' ? 'Checking…' : 'Check connection', icon: RefreshCcw, onClick: () => check(), disabled: Boolean(busy), secondary: view.action === 'reconnect' },
  ].filter(Boolean);

  return <ServiceShell title="Google Reviews" crumbs={[{ label: 'Reviews', to: '/service/reviews' }, { label: 'Google reviews' }]}>
    <PageHeader title="Reviews" description="Customer feedback from closed service requests and your Google Business Profile." />
    <ReviewTabs current="/service/reviews/google" />
    {notice && <InlineAlert tone={notice.tone} title={notice.text} action={<Button size="sm" variant="ghost" onClick={() => setNotice(null)}>Dismiss</Button>} />}
    {statusError ? <div className="card"><ErrorState title="Unable to load Google Business Profile status" message={statusError} onRetry={loadStatus} /></div>
      : !status ? <div className="card"><Skeleton height={64} /></div>
      : <NextAction tone={view.tone} eyebrow={<span className="row"><GoogleBadge /><span className={`status-light ${view.light}`} aria-hidden="true" />Integration status</span>} title={view.title} description={view.description} actions={actions}>
        {status.connected && <p className="text-muted text-small row" style={{ marginTop: 8 }}>
          {status.lastSuccessfulSyncAt ? `Last successful review sync ${formatRelative(status.lastSuccessfulSyncAt)}` : 'No successful review sync yet'} · {status.mappingCount} mapped location{status.mappingCount === 1 ? '' : 's'}
          <Button size="sm" variant="ghost" icon={Unplug} onClick={() => setConfirm('disconnect')}>Disconnect</Button>
        </p>}
      </NextAction>}

    {status?.connected && <>
      <Tabs label="Google Business Profile sections" value={tab} onChange={setTab} tabs={[{ value: 'reviews', label: 'Reviews' }, { value: 'locations', label: 'Locations' }, { value: 'notifications', label: 'Notifications' }]} />
      {tab === 'reviews' && <ReviewsPanel usable={usable} status={status} initialLocation={params.get('location')} onStatusChange={loadStatus} onGoToLocations={() => setTab('locations')} />}
      {tab === 'locations' && <LocationsPanel usable={usable} serviceCentres={serviceCentres} onChanged={loadStatus} />}
      {tab === 'notifications' && <NotificationsPanel usable={usable} status={status} onChanged={loadStatus} />}
    </>}

    {confirm === 'disconnect' && <ConfirmDialog title="Disconnect Google Business Profile?" tone="danger" confirmLabel="Disconnect" busy={busy === 'disconnect'} onClose={() => setConfirm(null)} onConfirm={disconnect}
      description="iPlanet's Google access is revoked and stored tokens are deleted. Pub/Sub review notifications are turned off. Location mappings are kept so you can reconnect later." />}
    <p className="text-muted text-small">Google reviews are read from Google when you view them and are not stored by iPlanet. They are separate from internal iPlanet service reviews.</p>
  </ServiceShell>;
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------
function ReviewsPanel({ usable, status, initialLocation, onStatusChange, onGoToLocations }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyLocation, setBusyLocation] = useState('');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ rating: 'All', location: initialLocation || 'All', reply: 'All', from: '', to: '' });
  const [replyDraft, setReplyDraft] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = async () => {
    setLoading(true);
    try { const result = await getGoogleReviews(); setData(result); setCachedGoogleReviews(result); setError(''); }
    catch (loadError) { setError(googleErrorMessage(loadError, 'Unable to retrieve Google reviews.')); }
    finally { setLoading(false); void onStatusChange(); }
  };
  useEffect(() => { if (usable && status.mappingCount) void load(); }, [usable, status.mappingCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const replaceLocation = (mappingId, update) => setData(current => current && { ...current, locations: current.locations.map(location => location.mappingId === mappingId ? update(location) : location) });
  const loadMore = async location => {
    setBusyLocation(location.mappingId);
    try {
      const result = await getGoogleReviews({ mappingId: location.mappingId, pageToken: location.nextPageToken });
      const page = result.locations[0];
      replaceLocation(location.mappingId, current => ({ ...current, reviews: [...current.reviews, ...page.reviews.filter(review => !current.reviews.some(existing => existing.reviewId === review.reviewId))], nextPageToken: page.nextPageToken }));
    } catch (loadError) { setError(googleErrorMessage(loadError)); }
    finally { setBusyLocation(''); }
  };
  const refresh = async () => {
    const targets = (data?.locations || []).filter(location => filters.location === 'All' || location.mappingId === filters.location);
    if (!targets.length) return load();
    setLoading(true);
    const failures = [];
    for (const target of targets) {
      try { const result = await syncGoogleLocation(target.mappingId); replaceLocation(target.mappingId, () => result.location); }
      catch (syncError) { failures.push(`${target.title || target.serviceCentreName}: ${googleErrorMessage(syncError)}`); }
    }
    setError(failures.join(' '));
    setLoading(false);
    void onStatusChange();
  };
  const updateReview = review => replaceLocation(review.location.mappingId, location => ({ ...location, reviews: location.reviews.map(item => item.reviewId === review.reviewId ? review : item) }));

  const scoped = (data?.locations || []).filter(location => filters.location === 'All' || location.mappingId === filters.location);
  const retrieved = flattenGoogleReviews({ locations: scoped });
  const reviews = (() => {
    const term = search.trim().toLowerCase();
    const from = filters.from ? new Date(`${filters.from}T00:00:00`) : null;
    const to = filters.to ? new Date(`${filters.to}T23:59:59`) : null;
    return retrieved.filter(review => (filters.rating === 'All' || review.rating === Number(filters.rating))
      && (filters.reply === 'All' || (filters.reply === 'replied') === Boolean(review.reply?.comment))
      && (!from || (review.createTime && new Date(review.createTime) >= from))
      && (!to || (review.createTime && new Date(review.createTime) <= to))
      && (!term || `${review.comment || ''} ${reviewerName(review)}`.toLowerCase().includes(term)))
      .sort((a, b) => new Date(b.createTime || 0) - new Date(a.createTime || 0));
  })();

  if (!usable) return <div className="card"><EmptyState icon={ShieldCheck} title="Reviews are unavailable until Google grants access" description="The status above explains what Google reported. Reviews are shown only when they can be retrieved from Google — no placeholder data is used." /></div>;
  if (!status.mappingCount) return <div className="card"><EmptyState icon={MapPinned} title="Map a Google location first" description="Reviews are retrieved for Business Profile locations mapped to iPlanet service centres." action={<Button variant="primary" onClick={onGoToLocations}>Map locations</Button>} /></div>;

  const rated = retrieved.filter(review => review.rating);
  const average = rated.length ? (rated.reduce((sum, review) => sum + review.rating, 0) / rated.length).toFixed(1) : null;
  const googleTotals = scoped.map(location => location.googleReportedTotal).filter(value => typeof value === 'number');
  const moreAvailable = scoped.filter(location => location.nextPageToken);
  const lastFetched = scoped.map(location => location.fetchedAt).filter(Boolean).sort().pop();

  return <div className="stack-16">
    <KPIGrid columns={4}>
      <KPI label="Average rating" value={average ?? '—'} hint={average ? `Of ${rated.length} retrieved rated review${rated.length === 1 ? '' : 's'}` : 'No rated reviews retrieved'} />
      <KPI label="Reviews retrieved" value={data ? retrieved.length : '—'} hint={googleTotals.length ? `Google reports ${googleTotals.reduce((a, b) => a + b, 0)} in total` : 'Retrieved in this view'} />
      <KPI label="Awaiting reply" value={data ? retrieved.filter(review => !review.reply?.comment).length : '—'} hint="Among retrieved reviews" tone={retrieved.some(review => !review.reply?.comment) ? 'warning' : 'neutral'} />
      <KPI label="Last retrieved" value={lastFetched ? formatRelative(lastFetched) : '—'} hint={status.lastSuccessfulSyncAt ? `Last successful sync ${formatDateTime(status.lastSuccessfulSyncAt)}` : 'Not synced yet'} />
    </KPIGrid>
    <p className="gbp-scope-note">{moreAvailable.length
      ? 'Figures cover only the reviews retrieved from Google so far (newest first). More pages are available, so these are not lifetime totals.'
      : 'Figures cover every review Google returned for the selected locations at the time of retrieval.'}</p>

    <div className="card card-flush">
      <FilterBar summary={data ? `${reviews.length} of ${retrieved.length} shown` : null}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search comment or reviewer" label="Search Google reviews" />
        <FilterSelect label="Rating" value={filters.rating} onChange={rating => setFilters(current => ({ ...current, rating }))} allLabel="All ratings" options={[5, 4, 3, 2, 1].map(value => ({ value: String(value), label: `${value} star${value === 1 ? '' : 's'}` }))} />
        <FilterSelect label="Location" value={filters.location} onChange={location => setFilters(current => ({ ...current, location }))} allLabel="All locations" options={(data?.locations || []).map(location => ({ value: location.mappingId, label: location.title || location.serviceCentreName || location.locationName }))} />
        <FilterSelect label="Reply status" value={filters.reply} onChange={reply => setFilters(current => ({ ...current, reply }))} allLabel="Any reply status" options={[{ value: 'awaiting', label: 'Awaiting reply' }, { value: 'replied', label: 'Replied' }]} />
        <span className="gbp-date-range"><label className="sr-only" htmlFor="gbp-from">From date</label><input id="gbp-from" type="date" value={filters.from} max={filters.to || undefined} onChange={event => setFilters(current => ({ ...current, from: event.target.value }))} /><span className="text-muted text-small">to</span><label className="sr-only" htmlFor="gbp-to">To date</label><input id="gbp-to" type="date" value={filters.to} min={filters.from || undefined} onChange={event => setFilters(current => ({ ...current, to: event.target.value }))} /></span>
        <Button size="sm" icon={RefreshCcw} onClick={refresh} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh from Google'}</Button>
      </FilterBar>
    </div>

    {error && <InlineAlert tone="warning" title="Google reviews could not be fully retrieved">{error}</InlineAlert>}
    {scoped.filter(location => location.error).map(location => <InlineAlert key={location.mappingId} tone="warning" title={`${location.title || location.serviceCentreName}: ${location.error.message}`} />)}

    {loading && !data ? <div className="review-cards">{[0, 1, 2].map(index => <div className="review-card" key={index}><Skeleton height={18} /><Skeleton height={48} /><Skeleton height={14} width="40%" /></div>)}</div>
      : !data ? (error ? null : <div className="card"><EmptyState compact title="Reviews not loaded" action={<Button onClick={load}>Retrieve reviews</Button>} /></div>)
      : !reviews.length ? <div className="card"><EmptyState icon={MessageSquareText} title={retrieved.length ? 'No reviews match these filters' : 'Google returned no reviews for these locations'} description={retrieved.length ? 'Clear a filter or load more pages.' : 'Reviews appear here as soon as customers post them on Google.'} /></div>
      : <div className="review-cards">{reviews.map(review => <GoogleReviewCard key={`${review.location.mappingId}-${review.reviewId}`} review={review} onReply={item => setReplyDraft({ review: item, text: item.reply?.comment || '', stage: 'edit' })} onDeleteReply={setDeleteTarget} />)}</div>}

    {moreAvailable.length > 0 && <div className="row">{moreAvailable.map(location => <Button key={location.mappingId} onClick={() => loadMore(location)} disabled={busyLocation === location.mappingId}>{busyLocation === location.mappingId ? 'Loading…' : `Load more${moreAvailable.length > 1 || filters.location === 'All' ? ` · ${location.title || location.serviceCentreName}` : ''}`}</Button>)}</div>}

    {replyDraft && <ReplyComposer draft={replyDraft} setDraft={setReplyDraft} onSaved={review => { if (review) updateReview(review); else void load(); }} />}
    {deleteTarget && <DeleteReplyDialog review={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={review => { setDeleteTarget(null); if (review) updateReview(review); else void load(); }} />}
  </div>;
}

function ReplyComposer({ draft, setDraft, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bytes = new TextEncoder().encode(draft.text.trim()).length;
  const tooLong = bytes > MAX_REPLY_BYTES;
  const close = () => setDraft(null);
  const publish = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await saveGoogleReviewReply(draft.review.location.mappingId, draft.review.reviewId, draft.text.trim());
      onSaved(result.review);
      close();
    } catch (saveError) { setError(googleErrorMessage(saveError, 'Google did not accept the reply.')); setDraft(current => ({ ...current, stage: 'edit' })); }
    finally { setBusy(false); }
  };

  if (draft.stage === 'confirm') {
    return <ConfirmDialog title="Publish this reply on Google?" confirmLabel="Publish reply" busy={busy} onClose={() => setDraft(current => ({ ...current, stage: 'edit' }))} onConfirm={publish}
      description={`The reply is posted publicly on Google under your Business Profile${draft.review.reply?.comment ? ' and replaces the existing reply' : ''}.`}>
      <div className="review-reply">{draft.text.trim()}</div>
    </ConfirmDialog>;
  }
  return <Modal title={draft.review.reply?.comment ? 'Edit reply' : 'Reply to review'} eyebrow={<GoogleBadge />} onClose={close}
    footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" disabled={!draft.text.trim() || tooLong} onClick={() => setDraft(current => ({ ...current, stage: 'confirm' }))}>Review and publish…</Button></>}>
    <div className="stack-16">
      <div><p className="row"><strong>{reviewerName(draft.review)}</strong>{draft.review.rating && <Stars rating={draft.review.rating} />}</p>{draft.review.comment && <p className="review-text text-muted">{draft.review.comment}</p>}</div>
      <Field label="Your reply" hint={`${bytes} / ${MAX_REPLY_BYTES} bytes · Nothing is published until you confirm.`} error={tooLong ? 'This reply is longer than Google allows.' : error || undefined}>
        {props => <textarea {...props} className="gbp-reply-input" value={draft.text} onChange={event => setDraft(current => ({ ...current, text: event.target.value }))} autoFocus />}
      </Field>
    </div>
  </Modal>;
}

function DeleteReplyDialog({ review, onClose, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const remove = async () => {
    setBusy(true);
    try { const result = await deleteGoogleReviewReply(review.location.mappingId, review.reviewId); onDeleted(result.review); }
    catch (deleteError) { setError(googleErrorMessage(deleteError, 'Google did not delete the reply.')); setBusy(false); }
  };
  return <ConfirmDialog title="Delete this reply from Google?" tone="danger" confirmLabel="Delete reply" busy={busy} onClose={onClose} onConfirm={remove} description="The reply is removed from the public review on Google.">
    <div className="review-reply">{review.reply?.comment}</div>
    {error && <InlineAlert tone="critical" title={error} />}
  </ConfirmDialog>;
}

// ---------------------------------------------------------------------------
// Locations and mapping
// ---------------------------------------------------------------------------
function LocationsPanel({ usable, serviceCentres, onChanged }) {
  const [data, setData] = useState(null);
  const [mappings, setMappings] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [choice, setChoice] = useState({});
  const [saving, setSaving] = useState('');
  const [message, setMessage] = useState(null);

  const load = async ({ refresh = false } = {}) => {
    setLoading(true);
    try {
      const [locations, mapped] = await Promise.all([getGoogleLocations({ refresh }), getGoogleMappings()]);
      setData(locations); setMappings(mapped.mappings); setError('');
    } catch (loadError) { setError(googleErrorMessage(loadError, 'Unable to load Google locations.')); getGoogleMappings().then(result => setMappings(result.mappings)).catch(() => {}); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (usable) void load(); else getGoogleMappings().then(result => setMappings(result.mappings)).catch(() => {}); }, [usable]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async location => {
    const serviceCentreId = choice[location.locationName] ?? location.mapping?.serviceCentreId ?? '';
    if (!serviceCentreId) { setMessage({ tone: 'warning', text: 'Choose an iPlanet service centre first.' }); return; }
    setSaving(location.locationName);
    try {
      const result = await mapGoogleLocation({ locationName: location.locationName, serviceCentreId });
      setMessage({ tone: 'success', text: `${location.title || location.locationName} is mapped to ${result.mapping.serviceCentreName}.` });
      await load(); onChanged();
    } catch (saveError) { setMessage({ tone: 'critical', text: googleErrorMessage(saveError, 'Unable to save the mapping.') }); }
    finally { setSaving(''); }
  };
  const remove = async (mappingId, label) => {
    setSaving(mappingId);
    try { await unmapGoogleLocation(mappingId); setMessage({ tone: 'success', text: `${label} is no longer mapped.` }); await load(); onChanged(); }
    catch (removeError) { setMessage({ tone: 'critical', text: googleErrorMessage(removeError) }); }
    finally { setSaving(''); }
  };

  const locations = data?.locations || [];
  const unmapped = locations.filter(location => !location.mapping).length;
  return <div className="stack-16">
    {message && <InlineAlert tone={message.tone} title={message.text} />}
    {!usable && <InlineAlert tone="warning" title="Google locations can be listed once Google grants Business Profile API access." />}
    {error && <InlineAlert tone="warning" title="Google locations unavailable">{error}</InlineAlert>}
    {data?.inaccessibleMappings?.length > 0 && <InlineAlert tone="warning" title="Some mapped locations are no longer accessible to the connected Google account">
      {data.inaccessibleMappings.map(mapping => <span key={mapping.mappingId} className="row">{mapping.locationDisplayName || mapping.locationName} → {mapping.serviceCentreName}<Button size="sm" variant="ghost" onClick={() => remove(mapping.mappingId, mapping.locationDisplayName || mapping.locationName)} disabled={saving === mapping.mappingId}>Remove mapping</Button></span>)}
    </InlineAlert>}

    {usable && <Card flush title="Google locations" description={data ? `${locations.length} accessible location${locations.length === 1 ? '' : 's'} · ${unmapped} unmapped` : 'Locations the connected Google account can manage'} actions={<Button size="sm" icon={RefreshCcw} onClick={() => load({ refresh: true })} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh from Google'}</Button>}>
      {loading && !data ? <div style={{ padding: 24 }}><Skeleton height={80} /></div>
        : !locations.length ? <EmptyState compact icon={MapPinned} title="No Business Profile locations found" description="The connected Google account cannot manage any locations. Check its Business Profile roles." />
        : <div className="table-scroll"><table className="table">
          <thead><tr><th>Google location</th><th>Account</th><th>Status</th><th>iPlanet service centre</th><th><span className="sr-only">Action</span></th></tr></thead>
          <tbody>{locations.map(location => {
            const selected = choice[location.locationName] ?? location.mapping?.serviceCentreId ?? '';
            const changed = selected && selected !== location.mapping?.serviceCentreId;
            return <tr key={location.locationName}>
              <td><span className="cell-primary">{location.title || 'Untitled location'}</span><br /><span className="text-muted text-small">{location.address || location.locationName}</span></td>
              <td>{location.accountDisplayName || location.accountName}</td>
              <td>{location.mapping ? <Badge tone="success">Mapped</Badge> : <Badge tone="warning">Unmapped</Badge>}</td>
              <td><select aria-label={`Service centre for ${location.title || location.locationName}`} value={selected} onChange={event => setChoice(current => ({ ...current, [location.locationName]: event.target.value }))}><option value="">Select a service centre</option>{serviceCentres.map(centre => <option key={centre._id} value={centre._id}>{centre.name}</option>)}</select></td>
              <td className="cell-right"><span className="row">
                {(!location.mapping || changed) && <Button size="sm" variant={location.mapping ? 'secondary' : 'primary'} onClick={() => save(location)} disabled={!selected || saving === location.locationName}>{saving === location.locationName ? 'Saving…' : location.mapping ? 'Change' : 'Map'}</Button>}
                {location.mapping && !changed && <Button size="sm" variant="ghost" onClick={() => remove(location.mapping.mappingId, location.title || location.locationName)} disabled={saving === location.mapping.mappingId}>Unmap</Button>}
              </span></td>
            </tr>;
          })}</tbody>
        </table></div>}
    </Card>}

    {data?.accounts?.length > 0 && <Card flush title="Google accounts" description="Business Profile accounts accessible to the connected Google user">
      <div className="table-scroll"><table className="table">
        <thead><tr><th>Account</th><th>Type</th><th>Role</th><th>Verification</th></tr></thead>
        <tbody>{data.accounts.map(account => <tr key={account.accountName}><td className="cell-primary">{account.accountDisplayName || account.accountName}</td><td>{account.type || '—'}</td><td>{account.role || '—'}</td><td>{account.verificationState ? <Badge>{account.verificationState}</Badge> : '—'}</td></tr>)}</tbody>
      </table></div>
    </Card>}

    <Card flush title="Synchronization" description="Per-location sync state (metadata only — review content is not stored)">
      {!mappings.length ? <EmptyState compact icon={MapPinned} title="No mapped locations yet" />
        : <div className="table-scroll"><table className="table">
          <thead><tr><th>Service centre</th><th>Google location</th><th>Status</th><th>Last successful sync</th><th>Last attempt</th><th>Last Google activity</th></tr></thead>
          <tbody>{mappings.map(mapping => <tr key={mapping.mappingId}>
            <td className="cell-primary">{mapping.serviceCentreName}</td>
            <td>{mapping.locationDisplayName || mapping.locationName}</td>
            <td><Badge tone={SYNC_TONE[mapping.syncStatus] || 'neutral'}>{SYNC_LABEL[mapping.syncStatus] || mapping.syncStatus}</Badge>{mapping.lastErrorCategory && <span className="text-muted text-small"> {mapping.lastErrorCategory.replaceAll('_', ' ')}</span>}</td>
            <td>{mapping.lastSuccessfulSyncAt ? formatDateTime(mapping.lastSuccessfulSyncAt) : '—'}</td>
            <td>{mapping.lastSyncAttemptAt ? formatRelative(mapping.lastSyncAttemptAt) : '—'}</td>
            <td>{mapping.lastNotificationAt ? formatRelative(mapping.lastNotificationAt) : '—'}</td>
          </tr>)}</tbody>
        </table></div>}
    </Card>
  </div>;
}

// ---------------------------------------------------------------------------
// Pub/Sub notifications
// ---------------------------------------------------------------------------
function NotificationsPanel({ usable, status, onChanged }) {
  const [accounts, setAccounts] = useState([]);
  const [accountName, setAccountName] = useState(status.notifications.accountName || '');
  const [setting, setSetting] = useState(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null);
  const { notifications } = status;
  const configured = notifications.pushConfigured && notifications.topicConfigured;

  useEffect(() => { if (usable) getGoogleLocations().then(result => setAccounts(result.accounts || [])).catch(() => setAccounts([])); }, [usable]);
  useEffect(() => {
    if (!usable || !accountName) { setSetting(null); return; }
    setBusy('load');
    getGoogleNotificationSetting(accountName).then(result => { setSetting(result.setting); setMessage(null); }).catch(error => setMessage({ tone: 'warning', text: googleErrorMessage(error) })).finally(() => setBusy(''));
  }, [usable, accountName]);

  const toggle = async enabled => {
    setBusy(enabled ? 'enable' : 'disable');
    try { const result = await setGoogleNotifications(accountName, enabled); setSetting(result.setting); setMessage({ tone: 'success', text: enabled ? 'Google will publish new and updated review events to Pub/Sub.' : 'Pub/Sub review notifications are turned off for this account.' }); onChanged(); }
    catch (error) { setMessage({ tone: 'critical', text: googleErrorMessage(error) }); }
    finally { setBusy(''); }
  };
  const active = setting?.pubsubTopic && setting.notificationTypes?.length;

  return <Card title="Review notifications" description="Optional. Google Cloud Pub/Sub alerts the portal when reviews are added or updated. Manual retrieval works without it." actions={<BellRing size={18} aria-hidden="true" />}>
    <div className="stack-16">
      {!configured && <InlineAlert tone="info" title="Pub/Sub is not configured on the backend">Set GOOGLE_PUBSUB_TOPIC, GOOGLE_PUBSUB_PUSH_AUDIENCE and GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT on Render, and create an authenticated push subscription. See the setup guide in the repository.</InlineAlert>}
      {!usable && <InlineAlert tone="warning" title="Notification settings can be changed once Google grants Business Profile API access." />}
      {message && <InlineAlert tone={message.tone} title={message.text} />}
      {usable && <>
        <Field label="Google account">{props => <select {...props} value={accountName} onChange={event => setAccountName(event.target.value)}><option value="">Select an account</option>{accounts.map(account => <option key={account.accountName} value={account.accountName}>{account.accountDisplayName || account.accountName}</option>)}</select>}</Field>
        {accountName && (busy === 'load' ? <Skeleton height={40} /> : setting && <p className="row text-small">
          <Badge tone={active ? 'success' : 'neutral'}>{active ? 'Enabled' : 'Off'}</Badge>
          {active ? <span className="text-muted">Topic {setting.pubsubTopic} · {setting.notificationTypes.join(', ')}</span> : <span className="text-muted">No Pub/Sub topic is set for this account.</span>}
        </p>)}
        {accountName && <div className="row">
          <Button variant="primary" onClick={() => toggle(true)} disabled={!configured || Boolean(busy)}>{busy === 'enable' ? 'Enabling…' : active ? 'Re-apply notification topic' : 'Enable review notifications'}</Button>
          {active && <Button onClick={() => toggle(false)} disabled={Boolean(busy)}>{busy === 'disable' ? 'Turning off…' : 'Turn off'}</Button>}
        </div>}
      </>}
    </div>
  </Card>;
}
