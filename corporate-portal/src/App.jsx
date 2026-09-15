import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { LockKeyhole, Mail, ArrowRight, ShieldCheck, Sparkles } from 'lucide-react';
import { Dashboard, Devices, DeviceDetail, Request, Tickets, TicketDetail, Coverage, Profile } from './pages';
import { UnassignedDevices, Notifications } from './corporateExtras';
import { RequestEnhanced } from './RequestEnhanced';
import { TicketDetailEnhanced } from './TicketDetailEnhanced';
import { CoverageEnhanced } from './CoverageEnhanced';
import { getDevice, getTicket, login } from './api';
import { AICustomerSupportPanel } from './AICustomerSupportPanel';
import './App.css';

const localPortalUrls = { corporate: 'http://localhost:5173', iplanet: 'http://localhost:5174' };
const forwardedPortalUrls = { corporate: 'https://shiny-rabbits-hear.loca.lt', iplanet: 'https://slow-coins-accept.loca.lt' };

const resolvePortalUrl = portal => {
  const configured = portal === 'corporate' ? import.meta.env.VITE_CORPORATE_URL : import.meta.env.VITE_IPLANET_URL;
  if (configured) return configured.replace(/\/$/, '');

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
  const [email, setEmail] = useState('admin@corporate.local');
  const [password, setPassword] = useState('Demo@123');
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const activePortal = window.location.origin === localPortalUrls.iplanet || window.location.origin === forwardedPortalUrls.iplanet ? 'iplanet' : 'corporate';

  const switchPortal = portal => {
    const targetUrl = resolvePortalUrl(portal);
    if (targetUrl && targetUrl !== window.location.origin) window.location.assign(targetUrl);
  };

  const submit = async event => {
    event.preventDefault();
    try {
      const result = await login(email, password);
      localStorage.setItem('iplanet_token', result.token);
      localStorage.setItem('iplanet_user', JSON.stringify(result.user));
      navigate('/dashboard');
    } catch (err) {
      setError(err.message);
    }
  };

  return <main className="login-page"><div className="login-art"><div className="art-brand"><div className="brand-mark">i</div><strong>iPlanet</strong></div><div className="art-copy"><span className="kicker">Corporate device care</span><h1>Keep your Apple estate in rhythm.</h1><p>A clear, connected workspace for every device, service request, and coverage decision.</p></div><div className="art-footer"><ShieldCheck size={16} />Corporate Admin portal · Local demo</div></div><div className="login-panel"><div className="login-inner"><span className="kicker">Corporate Admin</span><h2>Sign in to your workspace</h2><p className="muted">Manage devices, coverage, and service requests.</p><form onSubmit={submit}><label>Email address<div className="input-icon"><Mail size={17} /><input type="email" value={email} onChange={event => setEmail(event.target.value)} required /></div></label><label>Password<div className="input-icon"><LockKeyhole size={17} /><input type="password" value={password} onChange={event => setPassword(event.target.value)} required /></div></label><div className="login-options"><label className="checkbox"><input type="checkbox" defaultChecked />Remember me</label><button type="button" className="link-button">Forgot password?</button></div>{error && <p className="form-error">{error}</p>}<button className="button primary login-button">Sign in <ArrowRight size={17} /></button></form><div className="portal-picker" aria-label="Portal switcher"><button type="button" className={activePortal === 'corporate' ? 'portal-option active' : 'portal-option'} onClick={() => switchPortal('corporate')}>Corporate Portal</button><button type="button" className={activePortal === 'iplanet' ? 'portal-option active' : 'portal-option'} onClick={() => switchPortal('iplanet')}>iPlanet Service Portal</button></div><div className="demo-note"><strong>Demo credentials</strong><span>admin@corporate.local</span><span>Demo@123</span></div></div></div></main>;
}
function Protected({ children }) { const user = JSON.parse(localStorage.getItem('iplanet_user') || 'null'); return localStorage.getItem('iplanet_token') && user?.role === 'corporate_admin' ? children : <Navigate to="/" replace />; }

function GlobalAISupportDock() {
  const location = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const [ticket, setTicket] = useState(null);
  const [device, setDevice] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem('iplanet_token');
    const ticketMatch = location.pathname.match(/^\/tickets\/([^/]+)$/);
    const deviceMatch = location.pathname.match(/^\/devices\/([^/]+)$/);
    if (!token || (!ticketMatch && !deviceMatch)) {
      setTicket(null);
      setDevice(null);
      return;
    }

    let ignore = false;
    const load = ticketMatch ? getTicket(ticketMatch[1]).then(result => ({ ticket: result?.ticket || null, device: result?.ticket?.deviceId || null })) : getDevice(deviceMatch[1]).then(result => ({ ticket: null, device: result }));
    load.then(result => { if (!ignore) { setTicket(result.ticket); setDevice(result.device); } }).catch(() => { if (!ignore) { setTicket(null); setDevice(null); } });

    return () => {
      ignore = true;
    };
  }, [location.pathname]);

  const isAuthenticated = Boolean(localStorage.getItem('iplanet_token')) && location.pathname !== '/';
  if (!isAuthenticated) return null;

  return <>
    {!isOpen && <button type="button" className="floating-ai-button" title="AI Support" aria-label="Open AI Support" onClick={() => setIsOpen(true)}><Sparkles size={18} /></button>}
    <AICustomerSupportPanel ticket={ticket} device={device} open={isOpen} onClose={() => setIsOpen(false)} />
  </>;
}

export default function App() {
  return <BrowserRouter>
    <GlobalAISupportDock />
    <Routes>
      <Route path="/" element={<Login />} />
      <Route path="/dashboard" element={<Protected><Dashboard /></Protected>} />
      <Route path="/devices" element={<Protected><Devices /></Protected>} />
      <Route path="/devices/:id" element={<Protected><DeviceDetail /></Protected>} />
      <Route path="/unassigned-devices" element={<Protected><UnassignedDevices /></Protected>} />
      <Route path="/request" element={<Protected><RequestEnhanced /></Protected>} />
      <Route path="/tickets" element={<Protected><Tickets /></Protected>} />
      <Route path="/tickets/:id" element={<Protected><TicketDetailEnhanced /></Protected>} />
      <Route path="/coverage" element={<Protected><CoverageEnhanced /></Protected>} />
      <Route path="/notifications" element={<Protected><Notifications /></Protected>} />
      <Route path="/profile" element={<Protected><Profile /></Protected>} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  </BrowserRouter>;
}

