import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createAiSupportRouter } from '../routes/aiSupport.js';

function post(port, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/api/ai/support/chat', method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
      let raw = '';
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(raw) }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

test('AI support router delegates chat requests to the established session workflow', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _, next) => { req.user = { role: 'corporate_admin' }; next(); });
  app.use('/api/ai', createAiSupportRouter());
  app.post('/api/ai/support/chat', (req, res) => res.json({ delegated: true, message: req.body.message }));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const result = await post(server.address().port, { message: 'My battery drains quickly' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { delegated: true, message: 'My battery drains quickly' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
