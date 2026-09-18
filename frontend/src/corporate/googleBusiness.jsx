import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Link2, MapPin, RefreshCw, Unlink } from 'lucide-react';
import { Shell, PageTitle, Badge, Empty } from './components';
import { getGoogleBusinessHealth, getGoogleBusinessLocations, getGoogleBusinessServiceCentres, mapGoogleBusinessLocation, syncGoogleBusinessLocations, syncGoogleBusinessReviews } from './api';

export function GoogleBusinessSettings() {
  const [health, setHealth] = useState(null);
  const [locations, setLocations] = useState([]);
  const [centres, setCentres] = useState([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    try {
      setError('');
      const [healthResult, locationRows, centreRows] = await Promise.all([getGoogleBusinessHealth(), getGoogleBusinessLocations(), getGoogleBusinessServiceCentres()]);
      setHealth(healthResult);
      setLocations(locationRows);
      setCentres(centreRows);
    } catch (loadError) { setError(loadError.message); }
  };

  useEffect(() => { void load(); }, []);

  const connect = () => { window.location.assign('/api/google-business/auth'); };
  const syncLocations = async () => { try { setBusy('locations'); setMessage(''); const result = await syncGoogleBusinessLocations(); setMessage(`${result.locationsDiscovered || 0} location(s) discovered.`); await load(); } catch (syncError) { setError(syncError.message); } finally { setBusy(''); } };
  const syncReviews = async () => { try { setBusy('reviews'); setMessage(''); const result = await syncGoogleBusinessReviews(); setMessage(`${result.reviewsFound || 0} review(s) checked, ${result.newReviews || 0} new.`); await load(); } catch (syncError) { setError(syncError.message); } finally { setBusy(''); } };
  const mapLocation = async (locationId, serviceCentreId) => { if (!serviceCentreId) return; try { setBusy(locationId); await mapGoogleBusinessLocation(locationId, serviceCentreId); await load(); } catch (mapError) { setError(mapError.message); } finally { setBusy(''); } };

  return <Shell title="Google Business Profile"><PageTitle title="Google Business Profile" description="Connect one central Google account, discover locations, and confirm their Service Centre mappings." action={<button className="button primary" onClick={connect}><Link2 size={16} />{health?.connection === 'connected' ? 'Reconnect Google' : 'Connect Google'}</button>} />{error && <p className="form-error google-business-error">{error}</p>}{message && <p className="form-success google-business-error">{message}</p>}<section className="panel google-business-overview"><div><span className="kicker">Connection</span><strong className={health?.connection === 'connected' ? 'connection-state connected' : 'connection-state'}>{health?.connection === 'connected' ? 'Connected' : 'Not connected'}</strong><small>Google Business Profile API</small></div><div><span className="kicker">Locations</span><strong>{health?.locationsDiscovered ?? 0}</strong><small>{health?.locationsMapped ?? 0} mapped to Service Centres</small></div><div><span className="kicker">Last review sync</span><strong>{health?.lastReviewSync ? new Date(health.lastReviewSync).toLocaleString() : 'Never'}</strong><small>{health?.lastError || 'No recorded error'}</small></div><div className="google-business-actions"><button className="button secondary" onClick={syncLocations} disabled={busy !== ''}><RefreshCw size={15} />{busy === 'locations' ? 'Syncing...' : 'Sync Locations'}</button><button className="button secondary" onClick={syncReviews} disabled={busy !== '' || health?.connection !== 'connected'}><RefreshCw size={15} />{busy === 'reviews' ? 'Syncing...' : 'Sync Reviews'}</button></div></section><section className="panel table-panel google-location-panel"><div className="panel-heading"><div><span className="kicker">Admin mapping</span><h3>Google Locations</h3></div><MapPin size={20} /></div>{!locations.length ? <Empty message="No Google locations discovered yet. Connect Google and sync locations." /> : <div className="table-wrap"><table><thead><tr><th>Google Business</th><th>Address</th><th>Service Centre</th><th>Status</th><th>Last sync</th></tr></thead><tbody>{locations.map(location => <tr key={location._id}><td><strong>{location.businessName || 'Unnamed business'}</strong></td><td>{location.address || 'Address not provided'}</td><td><select value={location.serviceCentreId?._id || location.serviceCentreId || ''} onChange={event => mapLocation(location._id, event.target.value)} disabled={busy === location._id}><option value="">Select Service Centre</option>{centres.map(centre => <option key={centre._id} value={centre._id}>{centre.name}</option>)}</select></td><td><Badge>{location.mappingStatus}</Badge></td><td>{location.lastSyncedAt ? new Date(location.lastSyncedAt).toLocaleDateString() : 'Not synced'}</td></tr>)}</tbody></table></div>}</section><p className="google-business-note"><Unlink size={14} /> Disconnecting the central account is managed by the backend integration owner.</p><Link className="text-link" to="/corporate/dashboard"><Check size={14} /> Return to dashboard</Link></Shell>;
}
