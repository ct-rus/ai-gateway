import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, chmodSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readPrivate, reserveReceipt, verifyProvider } from './verify-provider.mjs';

const secret = 'synthetic-private-canary';
async function fixture(change = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    requests.push({ path: req.url, auth: req.headers.authorization, body });
    if (change.hang) return;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v8/management/config/config-version') { res.writeHead(change.management ?? 404); res.end('{}'); return; }
    if (req.url === '/v1/models') {
      if (req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(401); res.end('{}'); return; }
      res.end(JSON.stringify(change.models ?? { object: 'list', data: [{ id: 'example' }] })); return;
    }
    const n = requests.filter((r) => r.path === '/v1/chat/completions').length;
    if (change.http && n === 1) { res.writeHead(503); res.end(secret); return; }
    const call = { id: 'call-1', type: 'function', function: { name: 'add_numbers', arguments: '{"a":17,"b":25}' } };
    const messages = [ { role: 'assistant', tool_calls: [call] }, { role: 'assistant', content: '42' }, { role: 'assistant', content: '{"ok":true,"result":42}' } ];
    if (change.message && n === change.at) messages[n - 1] = change.message;
    if (change.invalid && n === change.at) { res.end('{'); return; }
    res.end(JSON.stringify({ choices: [{ message: messages[n - 1] }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}
async function run(change, expected) {
  const f = await fixture(change);
  try {
    const action = verifyProvider({ base: f.base, client: secret, model: 'example', live: true, timeout: change.timeout ?? 500 });
    if (expected) await assert.rejects(action, { code: expected }); else await action;
    return f.requests;
  } finally { await f.close(); }
}
test('provider performs auth, boundary, exact tool cycle and separate JSON request', async () => {
  const calls = await run({});
  assert.equal(calls.length, 7);
  assert.equal(calls[0].auth, undefined);
  assert.equal(calls[1].auth, 'Bearer invalid-verification-key');
  const first = calls[4].body, second = calls[5].body, third = calls[6].body;
  assert.deepEqual(second.tools, first.tools);
  assert.equal(second.messages.at(-1).tool_call_id, 'call-1');
  assert.deepEqual(JSON.parse(second.messages.at(-1).content), { result: 42 });
  assert.equal(second.tool_choice, 'none');
  assert.deepEqual(third.response_format, { type: 'json_object' });
});
test('provider rejects invalid tool arguments, calls, contradictory result and JSON', async () => {
  for (const [at, message, code] of [
    [1, { role: 'assistant', tool_calls: [] }, 'tool'],
    [1, { role: 'assistant', tool_calls: [{}, {}] }, 'tool'],
    [1, { role: 'assistant', tool_calls: [{ id: '', type: 'function', function: { name: 'add_numbers', arguments: '{}' } }] }, 'tool'],
    [1, { role: 'assistant', tool_calls: [{ id: 'id', type: 'function', function: { name: 'add_numbers', arguments: '{' } }] }, 'tool'],
    [1, { role: 'assistant', tool_calls: [{ id: 'id', type: 'function', function: { name: 'add_numbers', arguments: '{"a":17,"b":24}' } }] }, 'tool'],
    [2, { role: 'assistant', content: '43' }, 'tool'],
    [2, { role: 'assistant', content: '42', tool_calls: [{}] }, 'tool'],
    [3, { role: 'assistant', content: '{' }, 'schema'],
    [3, { role: 'assistant', content: '{"ok":true,"result":42,"extra":1}' }, 'schema'],
  ]) await run({ at, message }, code);
  await run({ invalid: true, at: 1 }, 'schema');
});
test('provider refuses boundary, model, transport and HTTP failures without retry', async () => {
  await run({ management: 401 }, 'boundary');
  await run({ models: { object: 'list', data: [] } }, 'model');
  const calls = await run({ http: true }, 'model');
  assert.equal(calls.filter((r) => r.path === '/v1/chat/completions').length, 1);
  await run({ hang: true, timeout: 20 }, 'transport');
});
test('live refusal, private input and exclusive receipt protect canaries', async () => {
  const f = await fixture(); const dir = mkdtempSync(path.join(os.tmpdir(), 'provider-test-'));
  try {
    await assert.rejects(verifyProvider({ base: f.base, client: secret, model: 'example', live: false }), { code: 'live_required' });
    assert.equal(f.requests.length, 0);
    const input = path.join(dir, 'input'); writeFileSync(input, JSON.stringify({ client: secret, model: 'example' }), { mode: 0o600 });
    assert.equal(readPrivate(input).client, secret); chmodSync(input, 0o644); assert.throws(() => readPrivate(input), { code: 'private_input' });
    const target = path.join(dir, 'receipt'); reserveReceipt(target).write({ status: 'ok' }); assert.throws(() => reserveReceipt(target), { code: 'receipt' });
    assert.doesNotMatch(readFileSync(target, 'utf8'), /synthetic-private-canary/);
    const cli = spawnSync(process.execPath, ['scripts/verify-provider.mjs', '--input', input, '--receipt', target], { encoding: 'utf8' });
    assert.notEqual(cli.status, 0); assert.doesNotMatch(cli.stdout + cli.stderr, /synthetic-private-canary/);
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});
