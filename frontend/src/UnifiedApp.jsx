import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, Building2, Check, Eye, EyeOff, Laptop, LockKeyhole, ShieldCheck, Sparkles, Wrench } from 'lucide-react';
import { AICustomerSupportPanel } from './corporate/AICustomerSupportPanel';
import { getDevice, getTicket, login } from './corporate/api';
import { AIAssistantContext, InlineAlert } from './ui';

// Pages load per route so each portal only downloads what it uses (charts,
// enrollment and review tooling stay out of the initial bundle).
const page = (loader, name) => lazy(() => loader().then(module => ({ default: module[name] })));
const corporatePages = () => import('./corporate/pages');
const corporateExtras = () => import('./corporate/corporateExtras');
const reviewPages = () => import('./corporate/ReviewPage');
const servicePages = () => import('./service/servicePages');
const serviceExtras = () => import('./service/serviceExtras');
const internalReviews = () => import('./service/InternalReviews');
const Dashboard = page(corporatePages, 'Dashboard');
const Devices = page(corporatePages, 'Devices');
const DeviceDetail = page(corporatePages, 'DeviceDetail');
const Tickets = page(corporatePages, 'Tickets');
const Profile = page(corporatePages, 'Profile');
const UnassignedDevices = page(corporateExtras, 'UnassignedDevices');
const CorporateNotifications = page(corporateExtras, 'Notifications');
const RequestEnhanced = page(() => import('./corporate/RequestEnhanced'), 'RequestEnhanced');
const TicketDetailEnhanced = page(() => import('./corporate/TicketDetailEnhanced'), 'TicketDetailEnhanced');
const CoverageEnhanced = page(() => import('./corporate/CoverageEnhanced'), 'CoverageEnhanced');
const ReviewPage = page(reviewPages, 'ReviewPage');
const CorporateReviews = page(reviewPages, 'CorporateReviews');
const ServiceDashboard = page(servicePages, 'ServiceDashboard');
const Engineers = page(servicePages, 'Engineers');
const ServiceReports = page(() => import('./service/ServiceReports'), 'ServiceReports');
const ServiceSettings = page(servicePages, 'ServiceSettings');
const MyTickets = page(() => import('./service/companyQueue'), 'MyTickets');
const DeviceEnrollment = page(() => import('./service/enrollment'), 'DeviceEnrollment');
const ServiceNotifications = page(serviceExtras, 'ServiceNotifications');
const EscalationMatrix = page(serviceExtras, 'EscalationMatrix');
const OperationalTicketDetail = page(() => import('./service/OperationalTicketDetail'), 'OperationalTicketDetail');
const ServiceCoverage = page(() => import('./service/coverage'), 'ServiceCoverage');
const InternalReviews = page(internalReviews, 'InternalReviews');
const InternalReviewDetail = page(internalReviews, 'InternalReviewDetail');
const GoogleBusinessProfile = page(() => import('./service/GoogleBusinessProfile'), 'GoogleBusinessProfile');

function RouteLoading() {
  return <div className="route-loading" role="status" aria-live="polite"><span className="sr-only">Loading page…</span><span className="route-loading-bar" aria-hidden="true" /></div>;
}

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
  } catch { return false; }
}

function Login() {
  const profiles = {
    corporate: { label: 'Corporate Admin', email: 'karthik.raj@democorporation.in' },
    service: { label: 'iPlanet Service', email: 'service@iplanet.local' },
  };
  const [profile, setProfile] = useState('corporate');
  const [email, setEmail] = useState('karthik.raj@democorporation.in');
  const [password, setPassword] = useState('Demo@123');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  useEffect(() => { document.title = 'Sign in · iPlanet Self-care Portal'; }, []);
  const submit = async event => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await login(email, password);
      localStorage.setItem(TOKEN_KEY, result.token);
      localStorage.setItem(USER_KEY, JSON.stringify(result.user));
      navigate(result.user.role === 'iplanet_service' ? serviceHome : corporateHome, { replace: true });
    } catch (loginError) {
      setError(loginError.message || 'Unable to sign in. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  const selectProfile = nextProfile => { setProfile(nextProfile); setEmail(profiles[nextProfile].email); setError(''); };
  const [showPassword, setShowPassword] = useState(false);
  const highlights = [
    { icon: Wrench, title: 'Raise & track service', text: 'Log a repair in seconds and follow it to resolution.' },
    { icon: ShieldCheck, title: 'Manage coverage', text: 'See warranty and coverage status across every device.' },
    { icon: Laptop, title: 'Run operations', text: 'Queues, engineers and reports for the service team.' },
  ];
  return <main className="login">
    <header className="login-nav">
      <div className="login-nav-inner">
        <div className="login-nav-brand"><span className="brand-mark" aria-hidden="true">i</span><span>iPlanet</span></div>
        <span className="login-nav-meta">Self-Care &amp; Service Operations</span>
      </div>
    </header>
    <div className="login-backdrop" aria-hidden="true"><i /><i /><i /></div>
    <div className="login-main">
      <section className="login-intro">
        <div className="login-hero">
          <p className="login-eyebrow"><Sparkles size={14} aria-hidden="true" />iPlanet Self-care Portal</p>
          <h1>Device care,<br /><span className="login-gradient">handled.</span></h1>
          <p className="login-lede">Raise and track service, manage coverage, and run service operations — all from one place.</p>
        </div>
        <ul className="login-highlights">
          {highlights.map(({ icon: Icon, title, text }) => <li key={title}>
            <span className="login-highlight-icon" aria-hidden="true"><Icon size={20} /></span>
            <span className="login-highlight-text"><strong>{title}</strong><span>{text}</span></span>
          </li>)}
        </ul>
        <p className="login-trust">
          <span><LockKeyhole size={14} aria-hidden="true" />Encrypted sign-in</span>
          <span><ShieldCheck size={14} aria-hidden="true" />Role-based access</span>
          <span><Building2 size={14} aria-hidden="true" />Built for teams</span>
        </p>
      </section>
      <div className="login-stage">
      <div className="login-halo" aria-hidden="true" />
      <div className="login-chip login-chip-top" aria-hidden="true"><span className="login-chip-icon login-chip-success"><Check size={14} strokeWidth={3} /></span><span><strong>Repair completed</strong><small>Ready for pickup</small></span></div>
      <div className="login-chip login-chip-bottom" aria-hidden="true"><span className="login-chip-icon login-chip-info"><Wrench size={14} /></span><span><strong>Engineer assigned</strong><small>Work starts today</small></span></div>
      <form className="login-card" onSubmit={submit} noValidate>
        <div className="login-card-head">
          <h2>Sign in</h2>
          <p>{profile === 'corporate' ? 'Access your organisation’s devices and service requests.' : 'Access the iPlanet service operations console.'}</p>
        </div>
        <div className="login-segmented" role="group" aria-label="Workspace" data-active={profile}>
          <span className="login-segmented-thumb" aria-hidden="true" />
          <button type="button" aria-pressed={profile === 'corporate'} onClick={() => selectProfile('corporate')}><Building2 size={15} aria-hidden="true" />Corporate Self-Care</button>
          <button type="button" aria-pressed={profile === 'service'} onClick={() => selectProfile('service')}><Wrench size={15} aria-hidden="true" />iPlanet Service</button>
        </div>
        <div className="login-fields">
          <label className="login-float">
            <input type="email" autoComplete="username" placeholder=" " value={email} onChange={event => setEmail(event.target.value)} required />
            <span>Email address</span>
          </label>
          <label className="login-float">
            <input type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder=" " value={password} onChange={event => setPassword(event.target.value)} required />
            <span>Password</span>
            <button type="button" className="login-reveal" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}>{showPassword ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}</button>
          </label>
        </div>
        {error && <InlineAlert title="Sign-in failed">{error}</InlineAlert>}
        <button className="login-submit" type="submit" disabled={busy || !email || !password}>{busy ? <><span className="login-spinner" aria-hidden="true" />Signing in…</> : <>Continue<ArrowRight size={17} aria-hidden="true" /></>}</button>
        <div className="login-note"><LockKeyhole size={13} aria-hidden="true" /><span>Demo password <strong>Demo@123</strong></span></div>
      </form>
      </div>
    </div>
    <footer className="login-foot">
      <div className="login-foot-inner">
        <span>Copyright © {new Date().getFullYear()} iPlanet. All rights reserved.</span>
        <span>Corporate Self-Care · iPlanet Service</span>
      </div>
    </footer>
  </main>;
}

function Protected({ role, children }) {
  const user = readUser();
  if (!sessionIsValid()) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={user.role === 'iplanet_service' ? serviceHome : corporateHome} replace />;
  return children;
}

function RoleAlias({ corporate, service }) {
  const user = readUser();
  const location = useLocation();
  if (!sessionIsValid()) return <Navigate to="/login" replace />;
  return <Navigate to={`${user?.role === 'iplanet_service' ? service : corporate}${location.search}`} replace />;
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

// Provides the corporate AI Support drawer to the header, sidebar and the
// floating button, and loads device/ticket context from the current route.
function AIAssistantProvider({ children }) {
  const location = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const [ticket, setTicket] = useState(null);
  const [device, setDevice] = useState(null);
  const corporate = sessionIsValid() && readUser()?.role === 'corporate_admin' && location.pathname.startsWith('/corporate/');
  useEffect(() => {
    if (!corporate) { setTicket(null); setDevice(null); setIsOpen(false); return undefined; }
    const ticketMatch = location.pathname.match(/^\/corporate\/(?:service-requests|tickets)\/([^/]+)$/);
    const deviceMatch = location.pathname.match(/^\/corporate\/devices\/([^/]+)$/);
    if (!ticketMatch && !deviceMatch) { setTicket(null); setDevice(null); return undefined; }
    let ignore = false;
    const load = ticketMatch ? getTicket(ticketMatch[1]).then(result => ({ ticket: result?.ticket || null, device: result?.ticket?.deviceId || null })) : getDevice(deviceMatch[1]).then(result => ({ ticket: null, device: result }));
    load.then(result => { if (!ignore) { setTicket(result.ticket); setDevice(result.device); } }).catch(() => { if (!ignore) { setTicket(null); setDevice(null); } });
    return () => { ignore = true; };
  }, [location.pathname, corporate]);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const value = useMemo(() => ({ available: corporate, open }), [corporate, open]);
  return <AIAssistantContext.Provider value={value}>
    {children}
    {corporate && !isOpen && <button type="button" className="ai-fab" aria-label="Open AI Support" onClick={open}><Sparkles size={18} aria-hidden="true" /><span>AI Support</span></button>}
    {corporate && <AICustomerSupportPanel ticket={ticket} device={device} open={isOpen} onClose={close} />}
  </AIAssistantContext.Provider>;
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
    <Route path="/corporate/reviews" element={<Protected role="corporate_admin"><CorporateReviews /></Protected>} />
    <Route path="/corporate/reviews/:ticketId" element={<Protected role="corporate_admin"><ReviewPage /></Protected>} />
  </>;
}

function ServiceRoutes() {
  return <>
    <Route path="/service/dashboard" element={<Protected role="iplanet_service"><ServiceDashboard /></Protected>} />
    <Route path="/service/tickets" element={<Protected role="iplanet_service"><MyTickets /></Protected>} />
    <Route path="/service/tickets/:id" element={<Protected role="iplanet_service"><OperationalTicketDetail /></Protected>} />
    <Route path="/service/reviews" element={<Protected role="iplanet_service"><InternalReviews /></Protected>} />
    <Route path="/service/reviews/google" element={<Protected role="iplanet_service"><GoogleBusinessProfile /></Protected>} />
    <Route path="/service/reviews/:reviewId" element={<Protected role="iplanet_service"><InternalReviewDetail /></Protected>} />
    <Route path="/service/device-enrollment" element={<Protected role="iplanet_service"><DeviceEnrollment /></Protected>} />
    <Route path="/service/engineers" element={<Protected role="iplanet_service"><Engineers /></Protected>} />
    <Route path="/service/reports" element={<Protected role="iplanet_service"><ServiceReports /></Protected>} />
    <Route path="/service/warranty" element={<Protected role="iplanet_service"><ServiceCoverage /></Protected>} />
    <Route path="/service/notifications" element={<Protected role="iplanet_service"><ServiceNotifications /></Protected>} />
    <Route path="/service/escalation" element={<Protected role="iplanet_service"><EscalationMatrix /></Protected>} />
    <Route path="/service/settings" element={<Protected role="iplanet_service"><ServiceSettings /></Protected>} />
  </>;
}

export default function UnifiedApp() {
  return <BrowserRouter>
    <AIAssistantProvider>
      <Suspense fallback={<RouteLoading />}>
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/login" element={sessionIsValid() ? <RoleAlias corporate={corporateHome} service={serviceHome} /> : <Login />} />
        {CorporateRoutes()}
        {ServiceRoutes()}
        <Route path="/dashboard" element={<RoleAlias corporate={corporateHome} service={serviceHome} />} />
        <Route path="/devices" element={<RoleAlias corporate="/corporate/devices" service={serviceHome} />} />
        <Route path="/devices/:id" element={<RoleDetailAlias corporateBase="/corporate/devices" serviceBase="/service/tickets" />} />
        <Route path="/unassigned-devices" element={<RoleAlias corporate="/corporate/unassigned-devices" service={serviceHome} />} />
        <Route path="/request" element={<RoleAlias corporate="/corporate/raise-request" service={serviceHome} />} />
        <Route path="/coverage" element={<RoleAlias corporate="/corporate/warranty" service="/service/warranty" />} />
        <Route path="/notifications" element={<RoleAlias corporate="/corporate/notifications" service="/service/notifications" />} />
        <Route path="/profile" element={<RoleAlias corporate="/corporate/profile" service="/service/settings" />} />
        <Route path="/my-tickets" element={<RoleAlias corporate="/corporate/service-requests" service="/service/tickets" />} />
        <Route path="/enrollment" element={<RoleAlias corporate={corporateHome} service="/service/device-enrollment" />} />
        <Route path="/engineers" element={<RoleAlias corporate={corporateHome} service="/service/engineers" />} />
        <Route path="/reports" element={<RoleAlias corporate={corporateHome} service="/service/reports" />} />
        <Route path="/escalation-matrix" element={<RoleAlias corporate={corporateHome} service="/service/escalation" />} />
        <Route path="/tickets" element={<RoleAlias corporate="/corporate/service-requests" service="/service/tickets" />} />
        <Route path="/tickets/:id" element={<RoleDetailAlias corporateBase="/corporate/service-requests" serviceBase="/service/tickets" />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
      </Suspense>
    </AIAssistantProvider>
  </BrowserRouter>;
}

export { logout };
