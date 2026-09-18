import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, ExternalLink, MapPinned, RefreshCcw, ShieldCheck } from 'lucide-react';
import { Shell, PageTitle, Empty } from './components';

const API = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const BASE = API ? `${API.replace(/\/api$/, '')}/api` : '/api';

const request = async (path, options = {}) => {
  const token = localStorage.getItem('iplanet_token');
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || `Request failed (${response.status})`);
  }

  return response.json();
};

export function GoogleBusinessProfile() {
  const [status, setStatus] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [locations, setLocations] = useState([]);
  const [serviceCentres, setServiceCentres] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState('');
  const [selectedServiceCentre, setSelectedServiceCentre] = useState('');
  const [mappingMessage, setMappingMessage] = useState('');
  const [syncResult, setSyncResult] = useState(null);
  const [error, setError] = useState('');

  const connectGoogle = async () => {
    setConnecting(true);
    setError('');
    try {
      const result = await request('/google-business/auth');
      window.open(result.url, '_blank', 'noopener,noreferrer');
      setStatus({ connected: true, mode: 'business-profile' });
    } catch (loadError) {
      setError(loadError.message || 'Unable to start Google Business Profile authorization.');
    } finally {
      setConnecting(false);
    }
  };

  const loadLocations = async () => {
    try {
      const result = await request('/google-business/locations');
      setLocations(result.locations || []);
      if (result.locations?.length) setSelectedLocation(result.locations[0].name);
      setError('');
    } catch (loadError) {
      setError(loadError.message || 'Google Business Profile is not yet connected.');
      setLocations([]);
    }
  };

  const loadServiceCentres = async () => {
    try {
      const result = await request('/iplanet/service-centres');
      setServiceCentres(result || []);
      if (result?.length) setSelectedServiceCentre(String(result[0]._id));
    } catch {
      setServiceCentres([]);
    }
  };

  useEffect(() => {
    request('/google-business/health').then(setStatus).catch(() => setStatus({ connected: false, mode: 'business-profile' }));
    loadServiceCentres();
  }, []);

  useEffect(() => {
    if (status?.connected) loadLocations();
  }, [status]);

  const mapSelectedLocation = async () => {
    if (!selectedLocation || !selectedServiceCentre) {
      setMappingMessage('Select both a Google location and a mapped service centre.');
      return;
    }

    try {
      const selected = locations.find(location => location.name === selectedLocation);
      const result = await request('/google-business/locations/map', {
        method: 'POST',
        body: JSON.stringify({
          locationName: selected.name,
          locationDisplayName: selected.title || selected.locationName || selected.name,
          accountName: selected.accountName || '',
          serviceCentreId: selectedServiceCentre,
        }),
      });
      setMappingMessage(`Mapped ${selected.title || selected.name} to ${result.mapping.serviceCentreName}.`);
    } catch (mapError) {
      setMappingMessage(mapError.message || 'Unable to map the Google Business Profile location.');
    }
  };

  const syncReviews = async () => {
    try {
      const result = await request('/google-business/reviews/sync');
      setSyncResult(result);
      setError('');
    } catch (syncError) {
      setError(syncError.message || 'Unable to sync Google reviews.');
    }
  };

  const reviewSummary = useMemo(() => {
    if (!syncResult?.results) return 0;
    return syncResult.results.reduce((sum, item) => sum + (Number(item.reviewCount) || 0), 0);
  }, [syncResult]);

  return <Shell title="Google Business Profile" eyebrow="Review source integration"><div className="panel"><PageTitle title="Google Reviews" description="Connect a single Google Business Profile account, map the discovered locations to iPlanet service centres, and sync reviews from Google into the existing review workflow." action={<button className="button primary" onClick={connectGoogle} disabled={connecting}>{connecting ? 'Connecting…' : 'Connect Google Account'}</button>} /><div className="dashboard-grid two-column">
      <div className="panel-row stat-box"><Building2 size={18} /><div><small>Connection status</small><strong>{status?.connected ? 'Connected' : 'Not connected'}</strong></div></div>
      <div className="panel-row stat-box"><ShieldCheck size={18} /><div><small>Mode</small><strong>Business Profile API</strong></div></div>
    </div>
    {error && <div className="form-error">{error}</div>}
    {status?.connected && <div className="panel stacked"><div className="row-controls"><label>Mapped Google location<select value={selectedLocation} onChange={event => setSelectedLocation(event.target.value)}>{locations.length ? locations.map(location => <option key={location.name} value={location.name}>{location.title || location.name}</option>) : <option value="">No locations found</option>}</select></label><label>Service centre<select value={selectedServiceCentre} onChange={event => setSelectedServiceCentre(event.target.value)}>{serviceCentres.length ? serviceCentres.map(centre => <option key={centre._id} value={centre._id}>{centre.name}</option>) : <option value="">No service centres found</option>}</select></label><button className="button primary" onClick={mapSelectedLocation}>Map location</button></div>{mappingMessage && <p className="muted">{mappingMessage}</p>}<button className="button secondary" onClick={syncReviews}><RefreshCcw size={16} /> Sync Google reviews</button>{reviewSummary > 0 && <p className="muted">{reviewSummary} Google review(s) synced in the last run.</p>}</div>}
    {status?.connected ? <div className="panel"><h3>Google locations</h3>{locations.length ? <div className="table-wrap"><table><thead><tr><th>Location</th><th>Account</th><th>Action</th></tr></thead><tbody>{locations.map(location => <tr key={location.name}><td>{location.title || location.name}</td><td>{location.accountDisplayName || location.accountName || 'Google Business Profile'}</td><td><button className="button tiny" onClick={() => setSelectedLocation(location.name)}>Select</button></td></tr>)}</tbody></table></div> : <Empty message="No Google locations are available yet. Complete the OAuth flow and refresh the account." />} </div> : <div className="empty"><MapPinned size={18} /><p>Connect a Google Business Profile account to begin discovering locations and reviews.</p></div>}
    <div className="panel"><h3>Google review sync</h3>{syncResult?.results?.length ? <div className="table-wrap"><table><thead><tr><th>Service centre</th><th>Location</th><th>Reviews</th></tr></thead><tbody>{syncResult.results.map(result => <tr key={result.locationName}><td>{result.serviceCentreId ? serviceCentres.find(item => String(item._id) === String(result.serviceCentreId))?.name || 'Mapped centre' : 'Unmapped'}</td><td>{result.locationName}</td><td>{result.reviewCount}</td></tr>)}</tbody></table></div> : <p className="muted">No sync run yet. Use the sync action above to pull Google reviews.</p>}</div>
    <div className="footnote"><ExternalLink size={14} /> Google Business Profile API is used as the external review source, while the internal review model remains unchanged for portal notifications and service workflows.</div>
  </div></Shell>;
}
