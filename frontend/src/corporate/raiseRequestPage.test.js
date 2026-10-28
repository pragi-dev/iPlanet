// Renders the real Raise Request route (through Vite's SSR loader) for a signed-in corporate
// admin and checks the wizard opens on Request details with the device lookup on it. Effects
// don't run when rendering to HTML, so no API is called; step changes are covered by
// requestFlow.test.js.
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
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  localStorage.setItem('iplanet_token', `${encode({ alg: 'none' })}.${encode({ id: 'admin-1', role: 'corporate_admin' })}.signature`);
  localStorage.setItem('iplanet_user', JSON.stringify({ id: 'admin-1', name: 'Corporate Admin', role: 'corporate_admin', company: 'Demo Corporation' }));
  vite = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  const [{ createElement }, { prerender }, { MemoryRouter }, { AppRoutes }] = await Promise.all([
    import('react'), import('react-dom/static'), import('react-router-dom'), vite.ssrLoadModule('/src/UnifiedApp.jsx'),
  ]);
  render = async url => {
    const { prelude } = await prerender(createElement(MemoryRouter, { initialEntries: [url] }, createElement(AppRoutes)));
    return new Response(prelude).text();
  };
});

after(async () => { await vite?.close(); });

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('the wizard opens on Request details, with device identification on the same step', async () => {
  const html = await render('/corporate/raise-request');
  const steps = [...html.matchAll(/class="stepper-label">([^<]*)</g)].map(([, label]) => label);
  assert.deepEqual(steps, ['Request details', 'Evidence', 'Review', 'Submit']);
  assert.match(html, /stepper-current[^]*?Request details/);
  const page = text(html);
  assert.match(page, /What do you need\?/);
  assert.match(page, /Request type/);
  for (const category of ['Service', 'Health Camp', 'Buyback / E-Waste']) assert.ok(page.includes(category), category);
  // Devices load in an effect, which doesn't run here, so the lookup shows its loading state.
  assert.ok(page.indexOf('Buyback / E-Waste') < page.indexOf('Issue type'));
  assert.match(page, /Cancel/);
});
