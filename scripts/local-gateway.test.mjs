import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
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

test('setup refuses empty, inconsistent and non-file runtime inputs without replacing them', () => {
  for (const invalid of ['empty-env', 'wrong-key', 'config-directory']) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'omc-local-test-'));
    fixtures.push(root);
    setupState(root);
    const key = readFileSync(path.join(root, '.local/management-key'), 'utf8');
    if (invalid === 'empty-env') writeFileSync(path.join(root, '.local/omc.env'), '');
    if (invalid === 'wrong-key') writeFileSync(path.join(root, '.local/cpa.env'), 'MANAGEMENT_PASSWORD=wrong\n');
    if (invalid === 'config-directory') {
      rmSync(path.join(root, '.local/cpa/config.yaml'));
      mkdirSync(path.join(root, '.local/cpa/config.yaml'));
    }
    assert.throws(() => setupState(root), /incomplete or invalid/);
    assert.equal(readFileSync(path.join(root, '.local/management-key'), 'utf8'), key);
  }
});

test('setup records an observed panel database and refuses its later loss', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omc-local-test-'));
  fixtures.push(root);
  setupState(root);
  assert.equal(setupState(root).created, false);
  const database = path.join(root, '.local/omc/oh-my-cpa.db');
  writeFileSync(database, 'SQLite format 3\0fixture');
  setupState(root);
  assert.equal(JSON.parse(readFileSync(path.join(root, '.local/initialized'), 'utf8')).panelInitialized, true);
  rmSync(database);
  assert.throws(() => setupState(root), /Previously initialized or attempted panel database/);
  assert.equal(existsSync(database), false);
});

test('legacy setup adopts an existing database and refuses ambiguous missing data', () => {
  for (const hasDatabase of [true, false]) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'omc-local-test-'));
    fixtures.push(root);
    setupState(root);
    writeFileSync(path.join(root, '.local/initialized'), 'Local gateway state initialized.\n');
    if (hasDatabase) {
      writeFileSync(path.join(root, '.local/omc/oh-my-cpa.db'), 'SQLite format 3\0fixture');
      setupState(root);
      assert.equal(JSON.parse(readFileSync(path.join(root, '.local/initialized'), 'utf8')).panelInitialized, true);
    } else assert.throws(() => setupState(root), /Legacy local state has no panel database/);
  }
});

test('setup rejects incomplete or malformed CPA YAML and a mismatched client key', () => {
  for (const invalid of ['version-only', 'malformed', 'wrong-client']) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'omc-local-test-'));
    fixtures.push(root);
    setupState(root);
    const config = path.join(root, '.local/cpa/config.yaml');
    const original = readFileSync(config, 'utf8');
    const client = readFileSync(path.join(root, '.local/client-key'), 'utf8').trim();
    writeFileSync(config, invalid === 'version-only' ? 'config-version: 8\n' : invalid === 'malformed' ? `${original}\nbroken: [\n` : original.replace(client, 'wrong-client'));
    assert.throws(() => setupState(root), /incomplete or invalid/);
    assert.equal(readFileSync(path.join(root, '.local/client-key'), 'utf8').trim(), client);
  }
});

function dockerFixture(options) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omc-docker-test-'));
  fixtures.push(root);
  setupState(root);
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, 'bin'));
  mkdirSync(path.join(root, 'node_modules'));
  symlinkSync(path.dirname(path.dirname(fileURLToPath(import.meta.resolve('yaml')))), path.join(root, 'node_modules/yaml'), 'dir');
  copyFileSync(new URL('./local-gateway.mjs', import.meta.url), path.join(root, 'scripts/local-gateway.mjs'));
  writeFileSync(path.join(root, 'fixture.json'), JSON.stringify({ root, ...options }));
  writeFileSync(path.join(root, 'bin/docker'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixture.json'), 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(fixture.root, 'commands.jsonl'), JSON.stringify(args) + '\\n');
if (fixture.failure) process.exit(1);
const project = 'ct-ai-gateway-local';
const names = ['cpa', 'oh-my-cpa'].map(service => project + '-' + service + '-1');
if (args[0] === 'ps') {
  const filter = args[args.indexOf('--filter') + 1];
  console.log(fixture.absent ? '' : filter.startsWith('name=') ? names.filter(name => filter === 'name=^/' + name + '$').join('\\n') : names.join('\\n'));
} else if (args[0] === 'inspect') {
  const service = args.at(-1) === names[0] ? 'cpa' : 'oh-my-cpa';
  const owner = fixture.foreign ? '/another/checkout' : fixture.root;
  const mountRoot = fixture.foreignMounts ? '/another/checkout' : owner;
  const binds = service === 'cpa' ? [['cpa/config.yaml', '/CLIProxyAPI/config.yaml'], ['cpa/auth', '/root/.cli-proxy-api'], ['cpa/logs', '/CLIProxyAPI/logs'], ['cpa/plugins', '/CLIProxyAPI/plugins']] : [['omc', '/data']];
  const mounts = binds.map(([source,destination])=>({Type:'bind',Source:path.join(mountRoot,'.local',source),Destination:destination}));
  if (fixture.overlap && service === 'oh-my-cpa') mounts.push({Type:'bind',Source:'/another/checkout/omc.db',Destination:'/data/oh-my-cpa.db'});
  console.log(JSON.stringify({project, service, running:true, working_dir:path.join(owner,'deploy/local'), config_files:path.join(owner,'deploy/local/compose.yml'), mounts}));
} else if (args[0] === 'compose') {
  if (fixture.createDatabase) fs.writeFileSync(path.join(fixture.root,'.local/omc/oh-my-cpa.db'),'SQLite format 3\\0fixture');
  process.exit(fixture.composeExit ?? 99);
}
else process.exit(98);
`, { mode: 0o700 });
  return {
    root,
    run: (command) => spawnSync(process.execPath, [path.join(root, 'scripts/local-gateway.mjs'), command, '--json'], { encoding: 'utf8', env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}` } }),
    commands: () => readFileSync(path.join(root, 'commands.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
  };
}

test('start, stop, status and check refuse a different checkout before any compose command', () => {
  for (const command of ['start', 'stop', 'status', 'check']) {
    for (const options of [{ foreign: true }, { foreignMounts: true }, { overlap: true }]) {
      const fixture = dockerFixture(options);
      const result = fixture.run(command);
      assert.equal(result.status, 1, command);
      assert.match(JSON.parse(result.stderr).error, /another checkout|foreign state mounts|unexpected state mounts/);
      assert.equal(fixture.commands().some((args) => args[0] === 'compose'), false);
    }
  }
});

test('status distinguishes absent containers from Docker daemon or permission errors', () => {
  const absent = dockerFixture({ absent: true }).run('status');
  assert.equal(absent.status, 0);
  assert.deepEqual(JSON.parse(absent.stdout).containers, { cpa: null, 'oh-my-cpa': null });
  const unavailable = dockerFixture({ failure: true }).run('status');
  assert.equal(unavailable.status, 1);
  assert.equal(JSON.parse(unavailable.stderr).ok, false);
  assert.match(JSON.parse(unavailable.stderr).error, /Docker command failed/);
});

test('a failed startup records its data-creation attempt before Compose and refuses lost data on retry', () => {
  const fixture = dockerFixture({ createDatabase: true });
  const first = fixture.run('start');
  assert.equal(first.status, 1);
  assert.match(JSON.parse(first.stderr).error, /Docker command failed/);
  assert.equal(JSON.parse(readFileSync(path.join(fixture.root, '.local/initialized'), 'utf8')).startAttempted, true);
  const database = path.join(fixture.root, '.local/omc/oh-my-cpa.db');
  assert.equal(existsSync(database), true);
  rmSync(database);
  const second = fixture.run('start');
  assert.equal(second.status, 1);
  assert.match(JSON.parse(second.stderr).error, /Previously initialized or attempted panel database/);
  assert.equal(fixture.commands().filter((args) => args[0] === 'compose').length, 1);
  assert.equal(existsSync(database), false);
});

test('stop reaches Compose for an owned stack after losing its initialized database', () => {
  const fixture = dockerFixture({ composeExit: 0 });
  const database = path.join(fixture.root, '.local/omc/oh-my-cpa.db');
  writeFileSync(database, 'SQLite format 3\0fixture');
  setupState(fixture.root);
  rmSync(database);
  const result = fixture.run('stop');
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).stopped, true);
  assert.equal(fixture.commands().filter((args) => args[0] === 'compose' && args.at(-1) === 'stop').length, 1);
  assert.equal(existsSync(database), false);
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
    send(response, 200, { choices: [{ message: { role: 'assistant', content: '42' } }] });
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

test('model check rejects a contradictory final answer containing the correct number', async () => {
  let calls = 0;
  const fixture = await server(async (request, response) => {
    for await (const chunk of request) void chunk;
    calls += 1;
    const message = calls === 1
      ? { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'add_numbers', arguments: '{"a":17,"b":25}' } }] }
      : { role: 'assistant', content: '42 is incorrect; the result is 43.' };
    send(response, 200, { choices: [{ message }] });
  });
  try {
    await assert.rejects(modelCheck({ api: fixture.url, client: 'client-fixture', model: 'model-fixture' }), /exactly the computed result/);
    assert.equal(calls, 2);
  } finally { await fixture.close(); }
});

test('live model check requires the explicit opt-in flag', () => {
  const result = spawnSync(process.execPath, [new URL('./local-gateway.mjs', import.meta.url).pathname, 'model-check', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stderr).error, /--live/);
});
