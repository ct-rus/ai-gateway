import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { verifyCrm } from './verify-crm.mjs';
const user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roleId: 'sales_manager' };
const chatId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const credentials = { email: 'fixture@example.invalid', password: 'synthetic-password-canary', role: 'sales_manager', route: 'openai:gpt-6.1-sol', live: true };
async function fixture(change = {}) {
  let signedIn = false, askId; const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    calls.push({ path: req.url, method: req.method, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/auth/login') {
      if (change.loginFail) { res.writeHead(401); res.end('{}'); return; }
      if (change.passwordChange) { res.end(JSON.stringify({ user, mustChangePassword: true })); return; }
      signedIn = true; res.setHeader('Set-Cookie', `crm_session=synthetic-session; Path=/; HttpOnly${change.insecure ? '' : '; Secure'}`);
      res.end(JSON.stringify({ user, mustChangePassword: false })); return;
    }
    if (req.url === '/api/v1/auth/me') {
      if (signedIn && req.headers.cookie) res.end(JSON.stringify({ user })); else { res.writeHead(401); res.end('{}'); } return;
    }
    if (req.url === '/api/v1/auth/logout') {
      if (change.logoutFail) { res.writeHead(503); res.end('{}'); return; }
      signedIn = false; res.writeHead(204); res.end(); return;
    }
    if (req.url === '/api/v1/copilot/status') { res.end(JSON.stringify({ enabled: !change.disabled, route: [credentials.route], timeoutMs: 1000, screenContextVersion: 1 })); return; }
    if (req.url === '/api/v1/copilot/ask') {
      askId = body.requestId;
      if (change.askHang) return;
      if (change.askFail) { res.writeHead(503); res.end(credentials.password); return; }
      res.end(JSON.stringify({ answer: 'Synthetic answer', destinations: [], chatId, requestId: change.badId ? chatId : askId })); return;
    }
    if (req.url === `/api/v1/copilot/chats/${chatId}/messages?limit=10`) {
      res.end(JSON.stringify({ items: [{ id: chatId, requestId: askId, role: 'assistant', status: 'completed', text: change.badHistory ? 'different' : 'Synthetic answer', context: null, destinations: [], createdAt: '2026-01-01T00:00:00.000Z' }], nextCursor: null })); return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}
async function run(change = {}, expected) {
  const f = await fixture(change), report = { httpWorkflow: 'incomplete', traceNotVerified: true, toolCycleAcceptance: 'incomplete' };
  try {
    const operation = verifyCrm({ base: f.base, ...credentials, timeout: 50, report });
    if (expected) await assert.rejects(operation, { code: expected }); else await operation;
    return { calls: f.calls, report };
  } finally { await f.close(); }
}
test('CRM anonymous and forged denial, login, ask, history and logout complete while trace remains unverified', async () => {
  const { calls, report } = await run();
  assert.deepEqual(calls.map((c) => c.path), ['/api/v1/auth/me', '/api/v1/auth/me', '/api/v1/auth/login', '/api/v1/auth/me', '/api/v1/copilot/status', '/api/v1/copilot/ask', `/api/v1/copilot/chats/${chatId}/messages?limit=10`, '/api/v1/auth/logout', '/api/v1/auth/me']);
  assert.equal(report.httpWorkflow, 'passed'); assert.equal(report.logout, 'passed'); assert.equal(report.traceNotVerified, true); assert.equal(report.toolCycleAcceptance, 'incomplete');
  assert.equal(calls[5].body.requestId, report.requestId);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-password-canary|fixture@example|Synthetic answer/);
});
test('CRM rejects failed login, password rotation, insecure cookie and disabled status', async () => {
  for (const [change, code] of [[{ loginFail: true }, 'login'], [{ passwordChange: true }, 'login'], [{ insecure: true }, 'cookie'], [{ disabled: true }, 'status']]) {
    const { calls } = await run(change, code);
    assert.equal(calls.some((c) => c.path === '/api/v1/copilot/ask'), false);
    if (change.insecure || change.disabled) assert.equal(calls.filter((c) => c.path === '/api/v1/auth/logout').length, 1);
  }
});
test('CRM rejects mismatched answer/history and logs out even after failure', async () => {
  for (const [change, code] of [[{ badId: true }, 'schema'], [{ badHistory: true }, 'history'], [{ askFail: true }, 'ask'], [{ askHang: true }, 'transport']]) {
    const { calls, report } = await run(change, code);
    assert.equal(calls.filter((c) => c.path === '/api/v1/copilot/ask').length, 1);
    assert.equal(calls.filter((c) => c.path === '/api/v1/auth/logout').length, 1);
    assert.equal(report.logout, 'passed');
  }
});
test('CRM logout failure invalidates the result and live opt-in precedes all requests', async () => {
  const { report } = await run({ logoutFail: true }, 'logout'); assert.equal(report.logout, 'failed');
  const f = await fixture();
  try { await assert.rejects(verifyCrm({ base: f.base, ...credentials, live: false, report: {} }), { code: 'live_required' }); assert.equal(f.calls.length, 0); } finally { await f.close(); }
});
