// The only place this app talks to anything outside the browser. The page calls
// loadRegistration() and submitRegistration(); which adapter answers is decided here.
//
// demo (default): simulated in the browser. No network request, nothing stored, no email.
// api: the documented public B2C endpoints (docs/b2c-customer-registration.md), used only
//      when the page was opened from a registration link and the mode is set explicitly.

const MODE = import.meta.env.VITE_REGISTRATION_MODE === 'api' ? 'api' : 'demo';
const API_BASE = (import.meta.env.VITE_REGISTRATION_API_BASE || '').replace(/\/+$/, '');
const TOKEN_PATH = /^\/b2c\/customer-registration\/([A-Za-z0-9_-]{43})\/?$/;

export class RegistrationError extends Error {
  constructor(message, { status = 0, code = 'error', fields } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

// Illustrative values for demo mode only; the real list comes from the device records.
const DEMO_REGIONS = ['Bengaluru', 'Chennai', 'Coimbatore', 'Madurai'];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const demoAdapter = {
  async load() {
    await wait(250);
    return { mode: 'demo', companyName: 'iPlanet', reference: null, expiresAt: null, regions: DEMO_REGIONS };
  },
  async submit() {
    await wait(900);
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    return { mode: 'demo', reference: `DEMO-${suffix}` };
  },
};

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new RegistrationError('The registration service could not be reached.', { code: 'network' });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = body.code || (response.status === 422 ? 'validation' : response.status === 429 ? 'rate_limited' : response.status === 404 ? 'invalid' : 'error');
    throw new RegistrationError(body.message || 'The request failed.', { status: response.status, code, fields: body.fields });
  }
  return body;
}

function apiAdapter(token) {
  const path = `/api/b2c/public/registration/${encodeURIComponent(token)}`;
  return {
    async load() {
      const data = await request(path);
      return { mode: 'api', companyName: data.companyName, reference: data.reference, expiresAt: data.expiresAt, regions: data.regions || [] };
    },
    async submit(payload) {
      const data = await request(path, { method: 'POST', body: JSON.stringify(payload) });
      return { mode: 'api', reference: data.reference };
    },
  };
}

function adapter() {
  if (MODE === 'demo') return demoAdapter;
  const token = window.location.pathname.match(TOKEN_PATH)?.[1];
  if (!token) return { load: () => Promise.reject(new RegistrationError('A registration link is required.', { code: 'link_required' })) };
  return apiAdapter(token);
}

export const registrationMode = MODE;
export const loadRegistration = () => adapter().load();
export const submitRegistration = payload => adapter().submit(payload);
