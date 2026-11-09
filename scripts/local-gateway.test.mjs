import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { checkHTTP, modelCheck, setupState } from './local-gateway.mjs';

const fixtures = [];
after(() => { for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true }); });

test('setup preserves existing keys and panel-edited CPA configuration on repeat', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omc-local-test-'));
  fixtures.push(root);
  assert.equal(setupState(root).created, true);
  const read = (name) => readFileSync(path.join(root, '.local', name), 'utf8');
  const management = read('management-key');
  const client = read('client-key');
  const env = read('omc.env');
  assert.match(management, /^[a-f0-9]{64}\n$/);
  assert.match(client, /^[a-f0-9]{64}\n$/);
  assert.notEqual(management, client);
  for (const name of ['', 'management-key', 'client-key', 'compose.env', 'cpa.env', 'omc.env', 'cpa/config.yaml']) {
    assert.equal(statSync(path.join(root, '.local', name)).mode & 0o077, 0);
  }
  const config = `${read('cpa/config.yaml')}# saved provider fixture\n`;
  writeFileSync(path.join(root, '.local/cpa/config.yaml'), config);
  assert.equal(setupState(root).created, false);
  assert.equal(read('management-key'), management);
  assert.equal(read('client-key'), client);
  assert.equal(read('omc.env'), env);
  assert.equal(read('cpa/config.yaml'), config);
});

test('setup refuses incomplete state without replacing it', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omc-local-test-'));
  fixtures.push(root);
  setupState(root);
  rmSync(path.join(root, '.local/omc.env'));
  assert.throws(() => setupState(root), /incomplete/);
});

test('setup refuses a missing runtime directory without recreating it', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omc-local-test-'));
  fixtures.push(root);
  setupState(root);
  rmSync(path.join(root, '.local/cpa/auth'), { recursive: true });
  assert.throws(() => setupState(root), /incomplete/);
  assert.equal(existsSync(path.join(root, '.local/cpa/auth')), false);
});

async function server(handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${instance.address().port}`, close: () => new Promise((resolve) => instance.close(resolve)) };
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function fakeStack({ degraded = false, clientManagementAccess = false } = {}) {
  return async (request, response) => {
    const route = request.url;
    const authorization = request.headers.authorization;
    if (route === '/healthz') return send(response, 200, {});
    if (route === '/') return send(response, 200, '<script src="/app.js"></script>', { 'content-type': 'text/html' });
    if (route === '/app.js') return send(response, 200, 'void 0;', { 'content-type': 'application/javascript' });
    if (route === '/api/healthz') return send(response, 200, { status: degraded ? 'degraded' : 'ok', database_status: 'ok', cpa_connected: !degraded, cpa_management_api: 'v8', version: 'fixture' });
    if (route === '/v1/models') return send(response, authorization === 'Bearer client-fixture' ? 200 : 401, { object: 'list', data: [] });
    if (route === '/v8/management/config/config-version') return send(response, clientManagementAccess ? 200 : 401, {});
    if (route === '/api/auth/session') return send(response, 200, { authenticated: request.headers.cookie === 'session=fixture' });
    if (route === '/api/auth/login') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const valid = request.method === 'POST' && request.headers.origin === `http://${request.headers.host}` && JSON.parse(body).password === 'management-fixture';
      return valid
        ? send(response, 200, { authenticated: true }, { 'set-cookie': 'session=fixture; HttpOnly; SameSite=Strict' })
        : send(response, 401, { authenticated: false });
    }
    if (route === '/api/v1/management/overview') return send(response, request.headers.cookie === 'session=fixture' ? 200 : 401, { status: 'connected', cpa_connected: true });
    if (route === '/api/v1/usage/ingest-status') return send(response, 200, { enabled: true, healthy: true, collector: { running: true, mode: 'subscribe' } });
    send(response, 404, {});
  };
}

test('check exercises credentials, session and connected status over HTTP', async () => {
  const fixture = await server(fakeStack());
  try {
    const result = await checkHTTP({ api: fixture.url, panel: fixture.url, keys: { client: 'client-fixture', management: 'management-fixture' } });
    assert.equal(result.passed.length, 14);
    assert.equal(result.model_count, 0);
  } finally { await fixture.close(); }
});

test('check fails on degraded connection and on client access to management', async () => {
  for (const options of [{ degraded: true }, { clientManagementAccess: true }]) {
    const fixture = await server(fakeStack(options));
    try {
      await assert.rejects(checkHTTP({ api: fixture.url, panel: fixture.url, keys: { client: 'client-fixture', management: 'management-fixture' } }), /connection|management/);
    } finally { await fixture.close(); }
  }
});

test('check fails when the management key cannot create a panel session', async () => {
  const fixture = await server(fakeStack());
  try {
    await assert.rejects(checkHTTP({ api: fixture.url, panel: fixture.url, keys: { client: 'client-fixture', management: 'wrong-management-key' } }), /Management key creates/);
  } finally { await fixture.close(); }
});

test('model check sends the same tools twice and validates a separate structured JSON answer', async () => {
  const calls = [];
  let structuredContent = '{"ok":true,"result":42}';
  const fixture = await server(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push(JSON.parse(body));
    if (calls.length === 1) return send(response, 200, { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'add_numbers', arguments: '{"a":17,"b":25}' } }] } }] });
    if (calls.length === 3) return send(response, 200, { choices: [{ message: { role: 'assistant', content: structuredContent } }] });
    send(response, 200, { choices: [{ message: { role: 'assistant', content: 'The result is 42.' } }] });
  });
  try {
    const result = await modelCheck({ api: fixture.url, client: 'client-fixture', model: 'model-fixture' });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].tools, calls[1].tools);
    assert.equal(calls[0].tool_choice, 'auto');
    assert.equal(calls[1].tool_choice, 'none');
    assert.deepEqual(calls[1].messages[2], { role: 'tool', tool_call_id: 'call-1', content: '{"result":42}' });
    assert.deepEqual(result.arguments, { a: 17, b: 25 });
    assert.equal(result.tool_result, 42);
    assert.deepEqual(calls[2].response_format, { type: 'json_object' });
    assert.equal(result.structured_json_validated, true);
    for (const invalid of ['{"ok":true,"result":0}', 'not JSON']) {
      structuredContent = invalid;
      calls.length = 0;
      await assert.rejects(modelCheck({ api: fixture.url, client: 'client-fixture', model: 'model-fixture' }), /structured JSON/);
    }
  } finally { await fixture.close(); }
});

test('model check rejects unexpected model tool arguments before any second request', async () => {
  let calls = 0;
  const fixture = await server((request, response) => {
    calls += 1;
    send(response, 200, { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'add_numbers', arguments: '{"a":17,"b":99}' } }] } }] });
  });
  try {
    await assert.rejects(modelCheck({ api: fixture.url, client: 'client-fixture', model: 'model-fixture' }), /unexpected tool arguments/);
    assert.equal(calls, 1);
  } finally { await fixture.close(); }
});

test('live model check requires the explicit opt-in flag', () => {
  const result = spawnSync(process.execPath, [new URL('./local-gateway.mjs', import.meta.url).pathname, 'model-check', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stderr).error, /--live/);
});
