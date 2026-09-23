import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Link2, MapPinned, RefreshCcw } from 'lucide-react';
import { ServiceShell } from './components';
import { GoogleBadge, GoogleReviewCard, ReviewTabs, flattenGoogleReviews, getCachedGoogleSync, setCachedGoogleSync } from './reviewShared';
import { getGoogleAccounts, getGoogleBusinessHealth, getGoogleLocations, getGoogleReviewsSync, getServiceCentres, mapGoogleLocation, startGoogleBusinessAuth } from './api';
import { Badge, Button, Card, EmptyState, Field, InlineAlert, PageHeader, Skeleton, friendlyError } from '../ui';

export function GoogleBusinessProfile() {
  const [status, setStatus] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [locations, setLocations] = useState([]);
  const [serviceCentres, setServiceCentres] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState('');
  const [selectedServiceCentre, setSelectedServiceCentre] = useState('');
  const [mapping, setMapping] = useState(null);
  const [syncResult, setSyncResult] = useState(getCachedGoogleSync);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');

  const loadHealth = async () => {
    try { const result = await getGoogleBusinessHealth(); setStatus(result); return result; }
    catch (loadError) { setStatus({ connected: false, configured: false, mode: 'business-profile' }); setError(friendlyError(loadError, 'Unable to load Google Business Profile status.')); return null; }
  };
  const loadAccountsAndLocations = async () => {
    try {
      const accountResult = await getGoogleAccounts();
      setAccounts(accountResult.accounts || []);
      const locationResult = await getGoogleLocations();
      setLocations(locationResult.locations || []);
      if (locationResult.locations?.length) setSelectedLocation(locationResult.locations[0].name);
      setError('');
    } catch (loadError) {
      setAccounts([]);
      setLocations([]);
      setError(friendlyError(loadError, 'Unable to load Google Business Profile accounts or locations.'));
    }
  };

  useEffect(() => {
    loadHealth().then(result => { if (result?.connected) void loadAccountsAndLocations(); });
    getServiceCentres().then(setServiceCentres).catch(() => setServiceCentres([]));
  }, []);

  const connectGoogle = async () => {
    setConnecting(true);
    setError('');
    try {
      const result = await startGoogleBusinessAuth();
      window.open(result.url, '_blank', 'noopener,noreferrer');
      setStatus(current => ({ ...(current || {}), mode: 'business-profile', connectionPending: true }));
    } catch (loadError) { setError(friendlyError(loadError, 'Unable to start Google Business Profile authorization.')); }
    finally { setConnecting(false); }
  };
  const mapSelectedLocation = async () => {
    const selected = locations.find(location => location.name === selectedLocation);
    if (!selected || !selectedServiceCentre) { setMapping({ tone: 'warning', text: 'Select both a Google location and an iPlanet service centre.' }); return; }
    try {
      const result = await mapGoogleLocation({ locationName: selected.name, locationDisplayName: selected.title || selected.locationName || selected.name, accountName: selected.accountName || '', serviceCentreId: selectedServiceCentre });
      setMapping({ tone: 'success', text: `Mapped ${selected.title || selected.name} to ${result.mapping.serviceCentreName}.` });
    } catch (mapError) { setMapping({ tone: 'critical', text: friendlyError(mapError, 'Unable to map the Google Business Profile location.') }); }
  };
  const syncReviews = async () => {
    setSyncing(true);
    try { const result = await getGoogleReviewsSync(); setCachedGoogleSync(result); setSyncResult(result); setError(''); }
    catch (syncError) { setError(friendlyError(syncError, 'Unable to sync Google reviews.')); }
    finally { setSyncing(false); }
  };

  const centreName = id => serviceCentres.find(item => String(item._id) === String(id))?.name;
  const reviews = useMemo(() => flattenGoogleReviews(syncResult, centreName).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)), [syncResult, serviceCentres]); // eslint-disable-line react-hooks/exhaustive-deps
  const connected = status?.connected;

  return <ServiceShell title="Google Reviews" crumbs={[{ label: 'Reviews', to: '/service/reviews' }, { label: 'Google reviews' }]}>
    <PageHeader title="Reviews" description="Customer feedback from closed service requests and your Google Business Profile." />
    <ReviewTabs current="/service/reviews/google" />
    {error && <InlineAlert title="Google connection issue">{error}</InlineAlert>}

    <Card>
      {!status ? <Skeleton height={40} /> : <div className="row-between">
        <div className="connection-strip">
          <GoogleBadge />
          <span className="connection-status"><span className={`status-light ${connected ? 'on' : ''}`} aria-hidden="true" />{connected ? 'Business Profile connected' : status.connectionPending ? 'Waiting for authorization in the new tab' : 'Not connected'}</span>
          {connected && <span className="text-muted text-small">{accounts.length} account{accounts.length === 1 ? '' : 's'} · {locations.length} location{locations.length === 1 ? '' : 's'}</span>}
        </div>
        <div className="row">
          {status.connectionPending && !connected && <Button icon={RefreshCcw} onClick={() => loadHealth().then(result => { if (result?.connected) void loadAccountsAndLocations(); })}>Check status</Button>}
          <Button variant={connected ? 'secondary' : 'primary'} icon={Link2} onClick={connectGoogle} disabled={connecting}>{connecting ? 'Connecting…' : connected ? 'Reconnect' : 'Connect Google Business Profile'}</Button>
        </div>
      </div>}
    </Card>

    {status && !connected ? <div className="card"><EmptyState icon={MapPinned} title="Google Business Profile is not connected" description="Connect your Business Profile to map locations to iPlanet service centres and retrieve public Google reviews." /></div>
      : connected && <>
        <Card title="Google reviews" description="Public reviews retrieved from mapped Business Profile locations" actions={<Button icon={RefreshCcw} onClick={syncReviews} disabled={syncing}>{syncing ? 'Syncing…' : 'Sync Google reviews'}</Button>}>
          {!syncResult ? <EmptyState compact title="No reviews synced in this session" description="Sync to retrieve the latest reviews from Google." />
            : <div className="stack-16">
              {syncResult.results?.some(result => result.error) && <InlineAlert tone="warning" title="Some locations could not be synced">{syncResult.results.filter(result => result.error).map(result => result.locationName).join(', ')}</InlineAlert>}
              {reviews.length ? <div className="review-cards">{reviews.map((review, index) => <GoogleReviewCard key={review.googleReviewId || index} review={review} />)}</div> : <EmptyState compact title="No Google reviews returned" description={syncResult.results?.length ? 'The mapped locations have no reviews yet.' : 'Map a Google location to a service centre first.'} />}
            </div>}
        </Card>

        <Card title="Location mapping" description="Link each Google location to its iPlanet service centre">
          {locations.length ? <div className="stack-16">
            <div className="form-grid" style={{ alignItems: 'end' }}>
              <Field label="Google location">{props => <select {...props} value={selectedLocation} onChange={event => setSelectedLocation(event.target.value)}>{locations.map(location => <option key={location.name} value={location.name}>{location.title || location.name}</option>)}</select>}</Field>
              <Field label="iPlanet service centre">{props => <select {...props} value={selectedServiceCentre} onChange={event => setSelectedServiceCentre(event.target.value)}><option value="">Select a service centre</option>{serviceCentres.map(centre => <option key={centre._id} value={centre._id}>{centre.name}</option>)}</select>}</Field>
            </div>
            <div className="form-actions" style={{ justifyContent: 'flex-start' }}><Button variant="primary" onClick={mapSelectedLocation}>Map location</Button></div>
            {mapping && <InlineAlert tone={mapping.tone} title={mapping.text} />}
          </div> : <EmptyState compact icon={MapPinned} title="No Business Profile locations found" />}
        </Card>

        <Card flush title="Google accounts" description="Accounts accessible to the connected Google user">
          {accounts.length ? <div className="table-scroll"><table className="table">
            <thead><tr><th>Account</th><th>Account ID</th><th>Role</th><th>Verification</th></tr></thead>
            <tbody>{accounts.map(account => <tr key={account.accountId || account.accountName}><td className="cell-primary">{account.accountDisplayName || account.accountName || 'Unnamed account'}</td><td className="mono">{account.accountId || '—'}</td><td>{account.role || '—'}</td><td>{account.verificationState ? <Badge>{account.verificationState}</Badge> : '—'}</td></tr>)}</tbody>
          </table></div> : <EmptyState compact title="No Google Business Profile accounts found" />}
        </Card>
      </>}
    <p className="text-muted text-small row"><ExternalLink size={13} aria-hidden="true" />Google reviews come from an external public source and are separate from internal iPlanet service reviews.</p>
  </ServiceShell>;
}
