import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

function buildReviewApp() {
  const app = express();
  app.get('/api/google-reviews/analytics', (_, res) => {
    res.json({ ok: true, source: 'analytics' });
  });
  app.get('/api/google-reviews/summary', (_, res) => {
    res.json({ ok: true, source: 'summary' });
  });
  app.get('/api/google-reviews/:id', (_, res) => {
    res.json({ ok: true, source: 'review-by-id' });
  });
  return app;
}

async function requestJson(app, path) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('analytics endpoint should win over the dynamic review-id route', async () => {
  const app = buildReviewApp();
  const response = await requestJson(app, '/api/google-reviews/analytics');
  assert.equal(response.status, 200);
  assert.equal(response.body.source, 'analytics');
});

test('summary endpoint should win before the dynamic review-id route', async () => {
  const app = buildReviewApp();
  const response = await requestJson(app, '/api/google-reviews/summary');
  assert.equal(response.status, 200);
  assert.equal(response.body.source, 'summary');
});
