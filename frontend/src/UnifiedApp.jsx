import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, LockKeyhole, Mail, ShieldCheck, Sparkles, Wrench } from 'lucide-react';
import { Dashboard, Devices, DeviceDetail, Tickets, Profile } from '../../corporate-portal/src/pages';
import { UnassignedDevices, Notifications as CorporateNotifications } from '../../corporate-portal/src/corporateExtras';
import { RequestEnhanced } from '../../corporate-portal/src/RequestEnhanced';
import { TicketDetailEnhanced } from '../../corporate-portal/src/TicketDetailEnhanced';
import { CoverageEnhanced } from '../../corporate-portal/src/CoverageEnhanced';
import { AICustomerSupportPanel } from '../../corporate-portal/src/AICustomerSupportPanel';
import { getDevice, getTicket, login } from '../../corporate-portal/src/api';
import { ServiceDashboard } from '../../iplanet-portal/src/servicePages';
import { MyTickets } from '../../iplanet-portal/src/companyQueue';
import { DeviceEnrollment } from '../../iplanet-portal/src/enrollment';
import { ServiceNotifications, EscalationMatrix } from '../../iplanet-portal/src/serviceExtras';
import { OperationalTicketDetail } from '../../iplanet-portal/src/OperationalTicketDetail';
import { ServiceCoverage } from '../../iplanet-portal/src/coverage';
import { Engineers, ServiceReports } from '../../iplanet-portal/src/servicePages';
import './App.css';
import '../../corporate-portal/src/App.css';
import '../../iplanet-portal/src/App.css';

const TOKEN_KEY = 'iplanet_token';
const USER_KEY = 'iplanet_user';
const corporateHome = '/corporate/dashboard';
const serviceHome = '/service/dashboard';

function readUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
}

function sessionIsValid() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token || !readUser()) return false;
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return !payload.exp || payload.exp * 1000 > Date.now();
  } catch { return Boolean(token); }
}

function Login() {
  const profiles = {
    corporate: { label: 'Corporate Admin', email: 'admin@corporate.local' },
    service: { label: 'iPlanet Service', email: 'service@iplanet.local' }
  };
  const [profile, setProfile] = useState('corporate');
  const [email, setEmail] = useState('admin@corporate.local');
  const [password, setPassword] = useState('Demo@123');
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const submit = async event => {
    event.preventDefault();
    setError('');
    try {
      const result = await login(email, password);
      localStorage.setItem(TOKEN_KEY, result.token);
      localStorage.setItem(USER_KEY, JSON.stringify(result.user));
      navigate(result.user.role === 'iplanet_service' ? serviceHome : corporateHome, { replace: true });
    } catch (loginError) { setError(loginError.message); }
  };
  const selectProfile = nextProfile => { setProfile(nextProfile); setEmail(profiles[nextProfile].email); setError(''); };
  return <main className="login-page"><div className="login-art"><div className="art-brand"><div className="brand-mark">i</div><strong>iPlanet</strong></div><div className="art-copy"><span className="kicker">Apple device care</span><h1>One workspace for every service journey.</h1><p>Manage devices, coverage, troubleshooting, and service operations from one secure workspace.</p></div><div className="art-footer"><ShieldCheck size={16} />Corporate Admin and iPlanet Service</div></div><div className="login-panel"><div className="login-inner"><span className="kicker">Welcome back</span><h2>Sign in to iPlanet</h2><p className="muted">Choose an account profile, then authenticate through the backend.</p><div className="portal-picker" aria-label="Demo profile selector"><button type="button" className={profile === 'corporate' ? 'portal-option active' : 'portal-option'} onClick={() => selectProfile('corporate')}>Corporate Admin</button><button type="button" className={profile === 'service' ? 'portal-option active' : 'portal-option'} onClick={() => selectProfile('service')}><Wrench size={14} />iPlanet Service</button></div><form onSubmit={submit}><label>Email address<div className="input-icon"><Mail size={17} /><input type="email" value={email} onChange={event => setEmail(event.target.value)} required /></div></label><label>Password<div className="input-icon"><LockKeyhole size={17} /><input type="password" value={password} onChange={event => setPassword(event.target.value)} required /></div></label>{error && <p className="form-error">{error}</p>}<button className="button primary login-button" type="submit"><ArrowRight size={17} />Sign in as {profiles[profile].label}</button></form><div className="demo-note"><strong>Demo password</strong><span>Demo@123</span></div></div></div></main>;
}

function Protected({ role, children }) {
  const user = readUser();
  if (!sessionIsValid()) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={user.role === 'iplanet_service' ? serviceHome : corporateHome} replace />;
  return children;
}

function RoleAlias({ corporate, service }) {
  const user = readUser();
  if (!sessionIsValid()) return <Navigate to="/login" replace />;
  return <Navigate to={user?.role === 'iplanet_service' ? service : corporate} replace />;
}

function RoleDetailAlias({ corporateBase, serviceBase }) {
  const { id } = useParams();
  const user = readUser();
  if (!sessionIsValid()) return <Navigate to="/login" replace />;
  return <Navigate to={`${user?.role === 'iplanet_service' ? serviceBase : corporateBase}/${id}`} replace />;
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem('iplanet_service_token');
  localStorage.removeItem('iplanet_service_user');
}

function GlobalAISupportDock() {
  const location = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const [ticket, setTicket] = useState(null);
  const [device, setDevice] = useState(null);
  useEffect(() => {
    if (!sessionIsValid() || readUser()?.role !== 'corporate_admin') { setTicket(null); setDevice(null); return undefined; }
    const ticketMatch = location.pathname.match(/^\/corporate\/(?:service-requests|tickets)\/([^/]+)$/);
    const deviceMatch = location.pathname.match(/^\/corporate\/devices\/([^/]+)$/);
    if (!ticketMatch && !deviceMatch) { setTicket(null); setDevice(null); return undefined; }
    let ignore = false;
    const load = ticketMatch ? getTicket(ticketMatch[1]).then(result => ({ ticket: result?.ticket || null, device: result?.ticket?.deviceId || null })) : getDevice(deviceMatch[1]).then(result => ({ ticket: null, device: result }));
    load.then(result => { if (!ignore) { setTicket(result.ticket); setDevice(result.device); } }).catch(() => { if (!ignore) { setTicket(null); setDevice(null); } });
    return () => { ignore = true; };
  }, [location.pathname]);
  if (!sessionIsValid() || readUser()?.role !== 'corporate_admin') return null;
  return <>{!isOpen && <button type="button" className="floating-ai-button" title="AI Support" aria-label="Open AI Support" onClick={() => setIsOpen(true)}><Sparkles size={18} /></button>}<AICustomerSupportPanel ticket={ticket} device={device} open={isOpen} onClose={() => setIsOpen(false)} /></>;
}

function CorporateRoutes() {
  return <>
    <Route path="/corporate/dashboard" element={<Protected role="corporate_admin"><Dashboard /></Protected>} />
    <Route path="/corporate/devices" element={<Protected role="corporate_admin"><Devices /></Protected>} />
    <Route path="/corporate/devices/:id" element={<Protected role="corporate_admin"><DeviceDetail /></Protected>} />
    <Route path="/corporate/unassigned-devices" element={<Protected role="corporate_admin"><UnassignedDevices /></Protected>} />
    <Route path="/corporate/service-requests" element={<Protected role="corporate_admin"><Tickets /></Protected>} />
    <Route path="/corporate/service-requests/:id" element={<Protected role="corporate_admin"><TicketDetailEnhanced /></Protected>} />
    <Route path="/corporate/raise-request" element={<Protected role="corporate_admin"><RequestEnhanced /></Protected>} />
    <Route path="/corporate/warranty" element={<Protected role="corporate_admin"><CoverageEnhanced /></Protected>} />
    <Route path="/corporate/notifications" element={<Protected role="corporate_admin"><CorporateNotifications /></Protected>} />
    <Route path="/corporate/profile" element={<Protected role="corporate_admin"><Profile /></Protected>} />
  </>;
}

function ServiceRoutes() {
  return <>
    <Route path="/service/dashboard" element={<Protected role="iplanet_service"><ServiceDashboard /></Protected>} />
    <Route path="/service/tickets" element={<Protected role="iplanet_service"><MyTickets /></Protected>} />
    <Route path="/service/tickets/:id" element={<Protected role="iplanet_service"><OperationalTicketDetail /></Protected>} />
    <Route path="/service/device-enrollment" element={<Protected role="iplanet_service"><DeviceEnrollment /></Protected>} />
    <Route path="/service/engineers" element={<Protected role="iplanet_service"><Engineers /></Protected>} />
    <Route path="/service/reports" element={<Protected role="iplanet_service"><ServiceReports /></Protected>} />
    <Route path="/service/warranty" element={<Protected role="iplanet_service"><ServiceCoverage /></Protected>} />
    <Route path="/service/notifications" element={<Protected role="iplanet_service"><ServiceNotifications /></Protected>} />
    <Route path="/service/escalation" element={<Protected role="iplanet_service"><EscalationMatrix /></Protected>} />
    <Route path="/service/settings" element={<Protected role="iplanet_service"><ServiceDashboard /></Protected>} />
  </>;
}

export default function UnifiedApp() {
  return <BrowserRouter><GlobalAISupportDock /><Routes><Route path="/" element={<Navigate to="/login" replace />} /><Route path="/login" element={sessionIsValid() ? <RoleAlias corporate={corporateHome} service={serviceHome} /> : <Login />} />{CorporateRoutes()}{ServiceRoutes()}<Route path="/dashboard" element={<RoleAlias corporate={corporateHome} service={serviceHome} />} /><Route path="/devices" element={<RoleAlias corporate="/corporate/devices" service={serviceHome} />} /><Route path="/devices/:id" element={<RoleDetailAlias corporateBase="/corporate/devices" serviceBase="/service/tickets" />} /><Route path="/unassigned-devices" element={<RoleAlias corporate="/corporate/unassigned-devices" service={serviceHome} />} /><Route path="/request" element={<RoleAlias corporate="/corporate/raise-request" service={serviceHome} />} /><Route path="/coverage" element={<RoleAlias corporate="/corporate/warranty" service="/service/warranty" />} /><Route path="/notifications" element={<RoleAlias corporate="/corporate/notifications" service="/service/notifications" />} /><Route path="/profile" element={<RoleAlias corporate="/corporate/profile" service={serviceHome} />} /><Route path="/my-tickets" element={<RoleAlias corporate={corporateHome} service="/service/tickets" />} /><Route path="/enrollment" element={<RoleAlias corporate={corporateHome} service="/service/device-enrollment" />} /><Route path="/engineers" element={<RoleAlias corporate={corporateHome} service="/service/engineers" />} /><Route path="/reports" element={<RoleAlias corporate={corporateHome} service="/service/reports" />} /><Route path="/escalation-matrix" element={<RoleAlias corporate={corporateHome} service="/service/escalation" />} /><Route path="/tickets" element={<RoleAlias corporate="/corporate/service-requests" service="/service/tickets" />} /><Route path="/tickets/:id" element={<RoleDetailAlias corporateBase="/corporate/service-requests" serviceBase="/service/tickets" />} /><Route path="*" element={<Navigate to="/login" replace />} /></Routes></BrowserRouter>;
}

export { logout };
