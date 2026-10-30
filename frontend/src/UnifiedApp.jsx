import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, Eye, EyeOff, Sparkles } from 'lucide-react';
import { AuthLayout, WorkspaceSwitch } from './auth/AuthLayout';
import { signInWorkspaceFrom } from './auth/workspace';
import { AICustomerSupportPanel } from './corporate/AICustomerSupportPanel';
import { getDevice, getTicket, login, warmUpApi } from './corporate/api';
import { clearRequestCache } from './ui/requestCache';
import { AIAssistantContext, InlineAlert, Loader } from './ui';

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
const CorporateNotifications = page(corporateExtras, 'Notifications');
const RequestEnhanced = page(() => import('./corporate/RequestEnhanced'), 'RequestEnhanced');
const AddDevices = page(() => import('./corporate/AddDevices'), 'AddDevices');
const CorporateReports = page(() => import('./corporate/CorporateReports'), 'CorporateReports');
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
const ProactiveService = page(() => import('./service/ProactiveService'), 'ProactiveService');
const EmailRequests = page(() => import('./service/EmailRequests'), 'EmailRequests');
const ServiceRecommendations = page(() => import('./corporate/ServiceRecommendations'), 'ServiceRecommendations');
const B2CDashboard = page(() => import('./b2c/B2CDashboard'), 'B2CDashboard');
const B2CQueue = page(() => import('./b2c/B2CQueue'), 'B2CQueue');
const B2CTicketDetail = page(() => import('./b2c/B2CTicketDetail'), 'B2CTicketDetail');
const B2CReports = page(() => import('./b2c/B2CReports'), 'B2CReports');
const B2CIntegrations = page(() => import('./b2c/B2CIntegrations'), 'B2CIntegrations');
const B2CSettings = page(() => import('./b2c/B2CSettings'), 'B2CSettings');
const B2CNotifications = page(() => import('./b2c/B2CNotifications'), 'B2CNotifications');
const SignUp = page(() => import('./auth/SignUp'), 'SignUp');
const TrackTicket = page(() => import('./track/TrackTicket'), 'TrackTicket');
const B2CRegistrations = page(() => import('./b2c/B2CRegistrations'), 'B2CRegistrations');
// Public: reached from the customer registration email, no sign-in.
const CustomerRegistration = page(() => import('./b2c/CustomerRegistration'), 'CustomerRegistration');

function RouteLoading() {
  return <div className="route-loading"><Loader label="Loading page…" size={44} /></div>;
}

const TOKEN_KEY = 'iplanet_token';
const USER_KEY = 'iplanet_user';
const corporateHome = '/corporate/dashboard';
const serviceHome = '/service/dashboard';
const b2cHome = '/b2c';
// B2C-only staff ('b2c_staff') have no B2B pages; the API refuses their B2B requests too.
const B2C_ONLY_ROLE = 'b2c_staff';
const homeFor = user => (user?.role === 'iplanet_service' ? serviceHome : user?.role === B2C_ONLY_ROLE ? b2cHome : corporateHome);

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
    corporate: { label: 'Corporate Admin', email: 'karthik.raj@democorporation.in', password: 'Demo@123' },
    service: { label: 'iPlanet Service', email: 'service@iplanet.local', password: 'Demo@123' },
    // No demo account: B2C staff are created by an administrator, and production has no B2C demo accounts.
    b2c: { label: 'B2C Escalations', email: '', password: '' },
  };
  const [searchParams] = useSearchParams();
  const [profile, setProfile] = useState(() => signInWorkspaceFrom(searchParams));
  const [email, setEmail] = useState(() => profiles[signInWorkspaceFrom(searchParams)].email);
  const [password, setPassword] = useState(() => profiles[signInWorkspaceFrom(searchParams)].password);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  useEffect(() => { document.title = 'Sign in · iPlanet Self-care Portal'; warmUpApi(); }, []);
  const submit = async event => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await login(email, password);
      clearRequestCache();
      localStorage.setItem(TOKEN_KEY, result.token);
      localStorage.setItem(USER_KEY, JSON.stringify(result.user));
      navigate(homeFor(result.user), { replace: true });
    } catch (loginError) {
      setError(loginError.message || 'Unable to sign in. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  const selectProfile = nextProfile => { setProfile(nextProfile); setEmail(profiles[nextProfile].email); setPassword(profiles[nextProfile].password); setError(''); };
  const [showPassword, setShowPassword] = useState(false);
  return <AuthLayout>
      <form className="login-card" onSubmit={submit} noValidate>
        <div className="login-card-head">
          <h2>Sign in</h2>
          <p>{profile === 'corporate' ? 'Access your organisation’s devices and service requests.' : profile === 'b2c' ? 'Access the B2C customer escalations desk.' : 'Access the iPlanet service operations console.'}</p>
        </div>
        <WorkspaceSwitch value={profile} onChange={selectProfile} includeB2C />
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
        <button className="login-submit" type="submit" disabled={busy || !email || !password}>{busy ? <><span className="login-spinner" aria-hidden="true" />Signing in…</> : <>Sign in<ArrowRight size={17} aria-hidden="true" /></>}</button>
        {profile === 'b2c'
          ? <p className="login-switch">B2C accounts are created by your B2C administrator.</p>
          : <p className="login-switch">Don’t have an account? <Link to={`/signup${profile === 'service' ? '?workspace=service' : ''}`}>Sign up</Link></p>}
        <p className="login-note"><span>Access is managed by your administrator.</span>{profile !== 'b2c' && <span>Demo password <strong>Demo@123</strong></span>}</p>
      </form>
  </AuthLayout>;
}

// Re-checks the session on every visit to /login. Deciding this once when the
// app mounted left a stale "signed in" route after sign-out, which rendered a
// blank page until the browser was refreshed.
function LoginRoute() {
  return sessionIsValid() ? <Navigate to={homeFor(readUser())} replace /> : <Login />;
}

// Signed-in users have no use for sign-up and go to their portal instead.
function SignUpRoute() {
  return sessionIsValid() ? <RoleAlias corporate={corporateHome} service={serviceHome} /> : <SignUp />;
}

// Downloads the signed-in portal's page code in idle time so opening a page
// doesn't wait for its chunk. Runs once per portal per session.
const prefetchedPortals = new Set();
const portalChunks = {
  corporate_admin: [corporatePages, corporateExtras, reviewPages, () => import('./corporate/RequestEnhanced'), () => import('./corporate/TicketDetailEnhanced'), () => import('./corporate/CoverageEnhanced'), () => import('./corporate/ServiceRecommendations')],
  iplanet_service: [servicePages, serviceExtras, internalReviews, () => import('./service/companyQueue'), () => import('./service/OperationalTicketDetail'), () => import('./service/ProactiveService'), () => import('./service/enrollment'), () => import('./service/coverage')],
  [B2C_ONLY_ROLE]: [() => import('./b2c/B2CQueue'), () => import('./b2c/B2CTicketDetail'), () => import('./b2c/B2CReports')],
};
function usePrefetchPortal(role) {
  useEffect(() => {
    if (!role || prefetchedPortals.has(role)) return undefined;
    prefetchedPortals.add(role);
    const run = () => portalChunks[role]?.forEach(load => { load().catch(() => {}); });
    const idle = window.requestIdleCallback ? window.requestIdleCallback(run, { timeout: 3000 }) : window.setTimeout(run, 1500);
    return () => (window.cancelIdleCallback ? window.cancelIdleCallback(idle) : window.clearTimeout(idle));
  }, [role]);
}

function Protected({ role, children }) {
  const user = readUser();
  const valid = sessionIsValid();
  usePrefetchPortal(valid && user?.role === role ? role : null);
  if (!valid) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={homeFor(user)} replace />;
  return children;
}

// B2C pages are open to B2C-only staff and to iPlanet Service accounts. The API
// checks the B2C role on every request, so a Service account without one sees
// the "no access" state rather than a redirect (its role may be granted after sign-in).
function B2CProtected({ children }) {
  const user = readUser();
  const valid = sessionIsValid();
  usePrefetchPortal(valid && user?.role === B2C_ONLY_ROLE ? B2C_ONLY_ROLE : null);
  if (!valid) return <Navigate to="/login" replace />;
  if (![B2C_ONLY_ROLE, 'iplanet_service'].includes(user.role)) return <Navigate to={homeFor(user)} replace />;
  return children;
}

function RoleAlias({ corporate, service }) {
  const user = readUser();
  const location = useLocation();
  if (!sessionIsValid()) return <Navigate to="/login" replace />;
  if (user?.role === B2C_ONLY_ROLE) return <Navigate to={b2cHome} replace />;
  return <Navigate to={`${user?.role === 'iplanet_service' ? service : corporate}${location.search}`} replace />;
}

function RoleDetailAlias({ corporateBase, serviceBase }) {
  const { id } = useParams();
  const user = readUser();
  if (!sessionIsValid()) return <Navigate to="/login" replace />;
  if (user?.role === B2C_ONLY_ROLE) return <Navigate to={b2cHome} replace />;
  if (user?.role === 'iplanet_service') return <Navigate to={serviceBase ? `${serviceBase}/${id}` : serviceHome} replace />;
  return <Navigate to={`${corporateBase}/${id}`} replace />;
}

function logout() {
  clearRequestCache();
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
    <Route path="/corporate/devices/add" element={<Protected role="corporate_admin"><AddDevices /></Protected>} />
    <Route path="/corporate/devices/:id" element={<Protected role="corporate_admin"><DeviceDetail /></Protected>} />
    {/* The Unassigned Devices page was removed; old links open the device list filtered to unassigned devices. */}
    <Route path="/corporate/unassigned-devices" element={<Navigate to="/corporate/devices?allocation=Unassigned" replace />} />
    <Route path="/corporate/service-requests" element={<Protected role="corporate_admin"><Tickets /></Protected>} />
    <Route path="/corporate/service-requests/:id" element={<Protected role="corporate_admin"><TicketDetailEnhanced /></Protected>} />
    <Route path="/corporate/raise-request" element={<Protected role="corporate_admin"><RequestEnhanced /></Protected>} />
    <Route path="/corporate/service-recommendations" element={<Protected role="corporate_admin"><ServiceRecommendations /></Protected>} />
    <Route path="/corporate/warranty" element={<Protected role="corporate_admin"><CoverageEnhanced /></Protected>} />
    <Route path="/corporate/notifications" element={<Protected role="corporate_admin"><CorporateNotifications /></Protected>} />
    <Route path="/corporate/profile" element={<Protected role="corporate_admin"><Profile /></Protected>} />
    <Route path="/corporate/reviews" element={<Protected role="corporate_admin"><CorporateReviews /></Protected>} />
    <Route path="/corporate/reports" element={<Protected role="corporate_admin"><CorporateReports /></Protected>} />
    <Route path="/corporate/reviews/:periodKey" element={<Protected role="corporate_admin"><ReviewPage /></Protected>} />
  </>;
}

function ServiceRoutes() {
  return <>
    <Route path="/service/dashboard" element={<Protected role="iplanet_service"><ServiceDashboard /></Protected>} />
    <Route path="/service/tickets" element={<Protected role="iplanet_service"><MyTickets /></Protected>} />
    <Route path="/service/tickets/:id" element={<Protected role="iplanet_service"><OperationalTicketDetail /></Protected>} />
    <Route path="/service/proactive" element={<Protected role="iplanet_service"><ProactiveService /></Protected>} />
    <Route path="/service/email-requests" element={<Protected role="iplanet_service"><EmailRequests /></Protected>} />
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

function B2CRoutes() {
  return <>
    <Route path="/b2c" element={<B2CProtected><B2CDashboard /></B2CProtected>} />
    <Route path="/b2c/tickets" element={<B2CProtected><B2CQueue /></B2CProtected>} />
    <Route path="/b2c/tickets/:id" element={<B2CProtected><B2CTicketDetail /></B2CProtected>} />
    <Route path="/b2c/registrations" element={<B2CProtected><B2CRegistrations /></B2CProtected>} />
    <Route path="/b2c/reports" element={<B2CProtected><B2CReports /></B2CProtected>} />
    <Route path="/b2c/integrations" element={<B2CProtected><B2CIntegrations /></B2CProtected>} />
    <Route path="/b2c/settings" element={<B2CProtected><B2CSettings /></B2CProtected>} />
    <Route path="/b2c/notifications" element={<B2CProtected><B2CNotifications /></B2CProtected>} />
    {/* Customer-facing and public: the server checks the link's token; no portal navigation. */}
    <Route path="/b2c/customer-registration/:token" element={<CustomerRegistration />} />
  </>;
}

export default function UnifiedApp() {
  return <BrowserRouter><AppRoutes /></BrowserRouter>;
}

// Every portal route, without the router itself (tests render it in a MemoryRouter).
export function AppRoutes() {
  return <AIAssistantProvider>
    <Suspense fallback={<RouteLoading />}>
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<LoginRoute />} />
      <Route path="/signup" element={<SignUpRoute />} />
      <Route path="/track/:token" element={<TrackTicket />} />
      {CorporateRoutes()}
      {ServiceRoutes()}
      {B2CRoutes()}
      <Route path="/dashboard" element={<RoleAlias corporate={corporateHome} service={serviceHome} />} />
      <Route path="/devices" element={<RoleAlias corporate="/corporate/devices" service={serviceHome} />} />
      <Route path="/devices/:id" element={<RoleDetailAlias corporateBase="/corporate/devices" serviceBase={null} />} />
      <Route path="/unassigned-devices" element={<RoleAlias corporate="/corporate/devices?allocation=Unassigned" service={serviceHome} />} />
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
  </AIAssistantProvider>;
}

export { logout };
