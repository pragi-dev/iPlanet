import { useEffect, useMemo, useState } from 'react';
import { Building2, ExternalLink, MapPinned, RefreshCcw, ShieldCheck } from 'lucide-react';
import { ServiceShell } from './servicePages';
import { Empty, PageTitle } from './components';
import { getGoogleAccounts, getGoogleBusinessHealth, getGoogleLocations, getGoogleReviewsSync, getServiceCentres, mapGoogleLocation, startGoogleBusinessAuth } from './api';

export function GoogleBusinessProfile() {
  const [status, setStatus] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [locations, setLocations] = useState([]);
  const [serviceCentres, setServiceCentres] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState('');
  const [selectedServiceCentre, setSelectedServiceCentre] = useState('');
  const [mappingMessage, setMappingMessage] = useState('');
  const [syncResult, setSyncResult] = useState(null);
  const [error, setError] = useState('');

  const loadHealth = async () => {
    try {
      const result = await getGoogleBusinessHealth();
      setStatus(result);
      return result;
    } catch (loadError) {
      setStatus({ connected: false, configured: false, mode: 'business-profile' });
      setError(loadError.message || 'Unable to load Google Business Profile status.');
      return null;
    }
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
      setError(loadError.message || 'Unable to load Google Business Profile accounts or locations.');
    }
  };

  useEffect(() => {
    loadHealth().then(result => {
      if (result?.connected) loadAccountsAndLocations();
    });
    getServiceCentres().then(setServiceCentres).catch(() => setServiceCentres([]));
  }, []);

  const connectGoogle = async () => {
    setConnecting(true);
    setError('');
    try {
      const result = await startGoogleBusinessAuth();
      window.open(result.url, '_blank', 'noopener,noreferrer');
      setStatus(current => ({ ...(current || {}), mode: 'business-profile', connectionPending: true }));
    } catch (loadError) {
      setError(loadError.message || 'Unable to start Google Business Profile authorization.');
    } finally {
      setConnecting(false);
    }
  };

  const mapSelectedLocation = async () => {
    const selected = locations.find(location => location.name === selectedLocation);
    if (!selected || !selectedServiceCentre) {
      setMappingMessage('Select both a Google location and an iPlanet service centre.');
      return;
    }
    try {
      const result = await mapGoogleLocation({
        locationName: selected.name,
        locationDisplayName: selected.title || selected.locationName || selected.name,
        accountName: selected.accountName || '',
        serviceCentreId: selectedServiceCentre,
      });
      setMappingMessage(`Mapped ${selected.title || selected.name} to ${result.mapping.serviceCentreName}.`);
    } catch (mapError) {
      setMappingMessage(mapError.message || 'Unable to map the Google Business Profile location.');
    }
  };

  const syncReviews = async () => {
    try {
      const result = await getGoogleReviewsSync();
      setSyncResult(result);
      setError('');
    } catch (syncError) {
      setError(syncError.message || 'Unable to sync Google reviews.');
    }
  };

  const reviewSummary = useMemo(() => (syncResult?.results || []).reduce((sum, item) => sum + (Number(item.reviewCount) || 0), 0), [syncResult]);
  const connected = status?.connected;

  return <ServiceShell title="Google Reviews"><PageTitle title="Google Business Profile" description="Manage the connected Google account, map Business Profile locations to iPlanet service centres, and retrieve Google reviews." action={<button className="button primary" onClick={connectGoogle} disabled={connecting}>{connecting ? 'Connecting...' : connected ? 'Reconnect Google' : 'Connect Google Business Profile'}</button>} />
    {error && <div className="form-error">{error}</div>}
    <div className="dashboard-grid two-column">
      <div className="panel-row stat-box"><Building2 size={18} /><div><small>Connection status</small><strong>{connected ? 'Connected' : 'Not connected'}</strong></div></div>
      <div className="panel-row stat-box"><ShieldCheck size={18} /><div><small>Accessible locations</small><strong>{connected ? locations.length : 'Not available'}</strong></div></div>
    </div>
    {!connected ? <div className="empty"><MapPinned size={18} /><p>Connect your Google Business Profile to view accounts, locations, and reviews.</p></div> : <>
      <section className="panel"><PageTitle title="Google accounts" description="Accounts accessible to the connected Google user." />{accounts.length ? <div className="table-wrap"><table><thead><tr><th>Account</th><th>Account ID</th><th>Role</th><th>Verification</th></tr></thead><tbody>{accounts.map(account => <tr key={account.accountId || account.accountName}><td>{account.accountDisplayName || account.accountName || 'Unnamed account'}</td><td>{account.accountId || 'Not available'}</td><td>{account.role || 'Not available'}</td><td>{account.verificationState || 'Not available'}</td></tr>)}</tbody></table></div> : <Empty message="No Google Business Profile accounts found." />}</section>
      <section className="panel"><PageTitle title="Google locations" description="Map each Google location to its iPlanet service centre." />{locations.length ? <><div className="row-controls"><label>Google location<select value={selectedLocation} onChange={event => setSelectedLocation(event.target.value)}>{locations.map(location => <option key={location.name} value={location.name}>{location.title || location.name}</option>)}</select></label><label>iPlanet service centre<select value={selectedServiceCentre} onChange={event => setSelectedServiceCentre(event.target.value)}><option value="">Select a service centre</option>{serviceCentres.map(centre => <option key={centre._id} value={centre._id}>{centre.name}</option>)}</select></label><button className="button primary" onClick={mapSelectedLocation}>Map location</button></div>{mappingMessage && <p className="muted">{mappingMessage}</p>}<div className="table-wrap"><table><thead><tr><th>Location</th><th>Account</th><th>Action</th></tr></thead><tbody>{locations.map(location => <tr key={location.name}><td>{location.title || location.name}</td><td>{location.accountDisplayName || location.accountName || 'Google Business Profile'}</td><td><button className="button tiny" onClick={() => setSelectedLocation(location.name)}>Select</button></td></tr>)}</tbody></table></div></> : <Empty message="No Google Business Profile locations found." />}</section>
      <section className="panel"><PageTitle title="Google reviews" description="Reviews retrieved from mapped Google Business Profile locations." action={<button className="button secondary" onClick={syncReviews}><RefreshCcw size={16} />Sync Google reviews</button>} />{reviewSummary > 0 && <p className="muted">{reviewSummary} Google review(s) returned in the last sync.</p>}{syncResult?.results?.length ? <div className="table-wrap"><table><thead><tr><th>Service centre</th><th>Location</th><th>Reviews</th></tr></thead><tbody>{syncResult.results.map(result => <tr key={result.locationName}><td>{serviceCentres.find(item => String(item._id) === String(result.serviceCentreId))?.name || 'Mapped centre'}</td><td>{result.locationName}</td><td>{result.reviewCount}</td></tr>)}</tbody></table></div> : <Empty message="No Google review sync results yet." />}</section>
    </>}
    <div className="footnote"><ExternalLink size={14} /> Google Business Profile is an external review source. Internal iPlanet reviews remain available in the Internal tab.</div>
  </ServiceShell>;
}

