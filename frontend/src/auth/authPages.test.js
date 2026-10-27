// Renders the real portal routes (through Vite's SSR loader, so JSX and lazy pages work)
// at /login and /signup and checks the Sign in <-> Sign up links, the shared login theme
// and the workspace selection. Effects don't run when rendering to HTML, so no API is called.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));
let vite;
let render;

before(async () => {
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key), clear: () => store.clear() };
  vite = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  // Dependencies are external in SSR, so the app and this test share one copy of React.
  const [{ createElement }, { prerender }, { MemoryRouter }, { AppRoutes }] = await Promise.all([
    import('react'), import('react-dom/static'), import('react-router-dom'), vite.ssrLoadModule('/src/UnifiedApp.jsx'),
  ]);
  // prerender waits for lazy-loaded pages, so the HTML is the page itself, not the loading bar.
  render = async url => {
    const { prelude } = await prerender(createElement(MemoryRouter, { initialEntries: [url] }, createElement(AppRoutes)));
    return new Response(prelude).text();
  };
});

after(async () => { await vite?.close(); });

const hrefs = html => [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)</g)].map(([, href, text]) => ({ href: href.replace(/&amp;/g, '&'), text }));
const pressed = html => /<button[^>]*aria-pressed="true"[^>]*>([^<]*)</.exec(html)?.[1];

test('Sign in shows a Sign up link that keeps the selected workspace', async () => {
  const corporate = await render('/login');
  assert.match(corporate, /Don’t have an account\?/);
  assert.ok(hrefs(corporate).some(link => link.href === '/signup' && link.text === 'Sign up'));
  assert.equal(pressed(corporate), 'Corporate Self-Care');
  assert.match(corporate, /type="submit"[^>]*>Sign in/, 'the existing Sign in form is still there');

  const service = await render('/login?workspace=service');
  assert.ok(hrefs(service).some(link => link.href === '/signup?workspace=service'));
  assert.equal(pressed(service), 'iPlanet Service');
  assert.match(service, /value="service@iplanet\.local"/, 'the service profile is preselected as before');
});

test('Sign in offers B2C Escalations as its own workspace, without Sign up', async () => {
  const b2c = await render('/login?workspace=b2c');
  assert.equal(pressed(b2c), 'B2C Escalations');
  assert.ok(!/b2c\.admin@iplanet\.local|Demo@123/.test(b2c), 'no demo account is offered: production has none');
  assert.ok(!hrefs(b2c).some(link => link.href.startsWith('/signup')), 'B2C accounts are created by an administrator');

  const signup = await render('/signup?workspace=b2c');
  assert.ok(!/B2C Escalations<\/button>/.test(signup), 'Sign up keeps its two workspaces');
});

test('the Sign up route renders the registration form in the login theme', async () => {
  const html = await render('/signup');
  for (const className of ['login', 'login-top', 'login-brand', 'login-intro', 'login-card', 'login-segmented', 'login-fields', 'login-float', 'login-submit', 'login-foot']) {
    assert.match(html, new RegExp(`class="${className}"`), `uses .${className} from the sign-in page`);
  }
  assert.match(html, /<h2 id="signup-title">Create account<\/h2>/);
  for (const [id, label] of [['signup-name', 'Full name'], ['signup-email', 'Work email address'], ['signup-phone', 'Mobile number'], ['signup-organization', 'Organization'], ['signup-gstNumber', 'GSTIN'], ['signup-password', 'Password'], ['signup-confirmPassword', 'Confirm password']]) {
    assert.match(html, new RegExp(`<label class="login-float" for="${id}"><input id="${id}"`), `${label} has an associated label`);
    assert.match(html, new RegExp(`>${label}<`));
  }
  assert.match(html, /type="submit"[^>]*>Create account/);
  assert.match(html, /aria-label="Show password"/);
  assert.ok(hrefs(html).some(link => link.href === '/login' && link.text === 'Sign in'));
  assert.doesNotMatch(html, /Demo@123/, 'demo credentials are not shown on sign-up');
  assert.doesNotMatch(html, /name="role"|Account type|Corporate Admin/i, 'no role picker is offered');
});

test('iPlanet Service sign-up offers the same registration form', async () => {
  const html = await render('/signup?workspace=service');
  assert.equal(pressed(html), 'iPlanet Service');
  assert.match(html, /iPlanet work email/);
  for (const id of ['signup-name', 'signup-email', 'signup-phone', 'signup-organization', 'signup-gstNumber', 'signup-password', 'signup-confirmPassword']) assert.match(html, new RegExp(`id="${id}"`));
  assert.ok(hrefs(html).some(link => link.href === '/login?workspace=service'));
});
