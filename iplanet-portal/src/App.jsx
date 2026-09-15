import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { LockKeyhole, Mail, Wrench, ShieldCheck } from 'lucide-react';
import { ServiceDashboard, ServiceTicketDetail, Engineers, ServiceReports } from './servicePages';
import { DeviceEnrollment } from './enrollment';
import { MyTickets } from './companyQueue';
import { ServiceNotifications, EscalationMatrix } from './serviceExtras';
import { OperationalTicketDetail } from './OperationalTicketDetail';
import { ServiceCoverage } from './coverage';
import { login } from './api';
import './App.css';

const localPortalUrls = { corporate: 'http://localhost:5173', iplanet: 'http://localhost:5174' };
const forwardedPortalUrls = { corporate: 'https://shiny-rabbits-hear.loca.lt', iplanet: 'https://slow-coins-accept.loca.lt' };
const defaultPortalUrl = portal => portal === 'corporate' ? (import.meta.env.VITE_CORPORATE_URL || localPortalUrls.corporate) : (import.meta.env.VITE_IPLANET_URL || localPortalUrls.iplanet);
const resolvePortalUrl = portal => {
  const configuredUrl = defaultPortalUrl(portal);
  if (configuredUrl && configuredUrl !== 'http://localhost:5173' && configuredUrl !== 'http://localhost:5174') return configuredUrl.replace(/\/$/, '');
  const currentOrigin = window.location.origin;
  if (currentOrigin === localPortalUrls.corporate || currentOrigin === forwardedPortalUrls.corporate) {
    return portal === 'corporate' ? currentOrigin : (currentOrigin === localPortalUrls.corporate ? localPortalUrls.iplanet : forwardedPortalUrls.iplanet);
  }
  if (currentOrigin === localPortalUrls.iplanet || currentOrigin === forwardedPortalUrls.iplanet) {
    return portal === 'corporate' ? (currentOrigin === localPortalUrls.iplanet ? localPortalUrls.corporate : forwardedPortalUrls.corporate) : currentOrigin;
  }
  return portal === 'corporate' ? localPortalUrls.corporate : localPortalUrls.iplanet;
};

function Login() {
  const [email, setEmail] = useState('service@iplanet.local');
  const [password, setPassword] = useState('Demo@123');
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const activePortal = window.location.origin === localPortalUrls.iplanet || window.location.origin === forwardedPortalUrls.iplanet ? 'iplanet' : 'corporate';
  const switchPortal = portal => {
    const targetUrl = resolvePortalUrl(portal);
    if (targetUrl !== window.location.origin) window.location.assign(targetUrl);
  };
  const submit = async event => { event.preventDefault(); try { const result = await login(email, password); localStorage.setItem('iplanet_service_token', result.token); localStorage.setItem('iplanet_service_user', JSON.stringify(result.user)); navigate('/'); } catch (err) { setError(err.message); } };
  return <main className="login-page"><div className="login-art"><div className="art-brand"><div className="brand-mark">i</div><strong>iPlanet</strong></div><div className="art-copy"><span className="kicker">Internal service operations</span><h1>Move every repair forward.</h1><p>A focused workspace for incoming requests, device enrollment, engineer assignment, and service completion.</p></div><div className="art-footer"><ShieldCheck size={16} />iPlanet Service portal · Local demo</div></div><div className="login-panel"><div className="login-inner"><span className="kicker">iPlanet Service</span><h2>Sign in to operations</h2><p className="muted">Coordinate service work from one shared workspace.</p><form onSubmit={submit}><label>Email / username<div className="input-icon"><Mail size={17} /><input type="email" value={email} onChange={event => setEmail(event.target.value)} required /></div></label><label>Password<div className="input-icon"><LockKeyhole size={17} /><input type="password" value={password} onChange={event => setPassword(event.target.value)} required /></div></label>{error && <p className="form-error">{error}</p>}<button className="button primary login-button"><Wrench size={17} />Sign in</button></form><div className="portal-picker" aria-label="Portal switcher"><button type="button" className={activePortal === 'corporate' ? 'portal-option active' : 'portal-option'} onClick={() => switchPortal('corporate')}>Corporate Portal</button><button type="button" className={activePortal === 'iplanet' ? 'portal-option active' : 'portal-option'} onClick={() => switchPortal('iplanet')}>iPlanet Service Portal</button></div><div className="demo-note"><strong>Demo credentials</strong><span>service@iplanet.local</span><span>Demo@123</span></div></div></div></main>; }
function Protected({ children }) { return localStorage.getItem('iplanet_service_token') ? children : <Navigate to="/login" replace />; }
export default function App() { return <BrowserRouter><Routes><Route path="/login" element={<Login />} /><Route path="/" element={<Protected><ServiceDashboard /></Protected>} /><Route path="/my-tickets" element={<Protected><MyTickets /></Protected>} /><Route path="/tickets" element={<Navigate to="/my-tickets" replace />} /><Route path="/tickets/:id" element={<Protected><OperationalTicketDetail /></Protected>} /><Route path="/enrollment" element={<Protected><DeviceEnrollment /></Protected>} /><Route path="/engineers" element={<Protected><Engineers /></Protected>} /><Route path="/reports" element={<Protected><ServiceReports /></Protected>} /><Route path="/coverage" element={<Protected><ServiceCoverage /></Protected>} /><Route path="/notifications" element={<Protected><ServiceNotifications /></Protected>} /><Route path="/escalation-matrix" element={<Protected><EscalationMatrix /></Protected>} /><Route path="*" element={<Navigate to="/" replace />} /></Routes></BrowserRouter>; }
