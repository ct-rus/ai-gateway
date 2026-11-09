#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = 'ct-ai-gateway-local';
const services = {
  cpa: { port: 28317, inner: '8317/tcp', image: 'eceasy/cli-proxy-api:v8.0.62@sha256:c3384886597346937da7d3697150895e0c91ee563172a6053e057d3a1ba9e79c' },
  'oh-my-cpa': { port: 28318, inner: '8080/tcp', image: 'wiziscool/oh-my-cpa:v0.3.26@sha256:dcce7b8cde4204619a26fb9c21f9807c54fb54085e80465f3ecb2d1b7225d27d' },
};
const apiBase = 'http://127.0.0.1:28317';
const panelBase = 'http://127.0.0.1:28318';
const requiredFiles = ['initialized', 'compose.env', 'cpa.env', 'omc.env', 'management-key', 'client-key', 'cpa/config.yaml'];
const requiredDirectories = ['cpa', 'cpa/auth', 'cpa/logs', 'cpa/plugins', 'omc'];

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function validateState(repoRoot) {
  const state = path.join(repoRoot, '.local');
  const incomplete = 'Local state is incomplete or invalid; preserve it and investigate before continuing.';
  const hasFiles = requiredFiles.every((file) => existsSync(path.join(state, file)) && statSync(path.join(state, file)).isFile() && statSync(path.join(state, file)).size > 0);
  const hasDirectories = requiredDirectories.every((directory) => existsSync(path.join(state, directory)) && statSync(path.join(state, directory)).isDirectory());
  expect(hasFiles && hasDirectories, incomplete);
  expect((statSync(state).mode & 0o077) === 0, 'The .local directory must be private (mode 700).');
  const read = (name) => readFileSync(path.join(state, name), 'utf8').trim();
  const keys = { management: read('management-key'), client: read('client-key') };
  expect(/^[a-f0-9]{64}$/.test(keys.management) && /^[a-f0-9]{64}$/.test(keys.client) && keys.management !== keys.client, incomplete);
  const env = (name) => {
    const values = {};
    for (const line of read(name).split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'))) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      expect(match && !Object.hasOwn(values, match[1]), incomplete);
      values[match[1]] = match[2];
    }
    return values;
  };
  const composeEnv = env('compose.env');
  const cpaEnv = env('cpa.env');
  const omcEnv = env('omc.env');
  expect(/^\d+$/.test(composeEnv.LOCAL_UID ?? '') && /^\d+$/.test(composeEnv.LOCAL_GID ?? ''), incomplete);
  expect(cpaEnv.MANAGEMENT_PASSWORD === keys.management && omcEnv.OMCPA_CPA_MANAGEMENT_KEY === keys.management && /^[a-f0-9]{64}$/.test(omcEnv.OMCPA_MASTER_KEY ?? ''), incomplete);
  expect(/^config-version:\s*8\s*$/m.test(read('cpa/config.yaml')), incomplete);
  const db = path.join(state, 'omc/oh-my-cpa.db');
  const hasDatabase = existsSync(db) && statSync(db).isFile() && statSync(db).size > 0;
  const marker = read('initialized');
  let initialized;
  if (marker === 'Local gateway state initialized.') {
    // Legacy installations have no persisted database observation; adopt only existing data.
    expect(hasDatabase, 'Legacy local state has no panel database; preserve it and investigate before continuing.');
    initialized = { version: 1, panelInitialized: true };
  } else {
    try { initialized = JSON.parse(marker); } catch { throw new Error(incomplete); }
    expect(initialized?.version === 1 && typeof initialized.panelInitialized === 'boolean', incomplete);
  }
  expect(!initialized.panelInitialized || hasDatabase, 'Previously initialized panel database is missing or invalid; restore the private state before continuing.');
  return { state, keys, hasDatabase, initialized };
}

export function setupState(repoRoot) {
  const state = path.join(repoRoot, '.local');
  if (existsSync(state)) {
    const validated = validateState(repoRoot);
    if (validated.hasDatabase) {
      writeFileSync(path.join(state, 'initialized'), JSON.stringify({ version: 1, panelInitialized: true }) + '\n', { mode: 0o600 });
    }
    return { created: false, state };
  }
  expect(typeof process.getuid === 'function' && process.getuid() !== 0, 'Run setup as a non-root Unix user.');
  mkdirSync(state, { mode: 0o700 });
  for (const directory of requiredDirectories) {
    mkdirSync(path.join(state, directory), { mode: 0o700 });
  }
  const management = randomBytes(32).toString('hex');
  const client = randomBytes(32).toString('hex');
  const master = randomBytes(32).toString('hex');
  const put = (file, content) => writeFileSync(path.join(state, file), content, { mode: 0o600, flag: 'wx' });
  put('management-key', `${management}\n`);
  put('client-key', `${client}\n`);
  put('compose.env', `LOCAL_UID=${process.getuid()}\nLOCAL_GID=${process.getgid()}\n`);
  put('cpa.env', `MANAGEMENT_PASSWORD=${management}\n`);
  put('omc.env', `OMCPA_CPA_MANAGEMENT_KEY=${management}\nOMCPA_MASTER_KEY=${master}\n`);
  put('cpa/config.yaml', `config-version: 8
server:
  host: ""
  port: 8317
management:
  allow-remote: true
  secret-key: ""
  disable-control-panel: true
access:
  api-keys:
    - ${client}
oauth:
  auth-dir: /root/.cli-proxy-api
observability:
  usage:
    usage-statistics-enabled: true
    redis-usage-queue-retention-seconds: 60
plugins:
  enabled: false
  dir: /CLIProxyAPI/plugins
`);
  put('initialized', JSON.stringify({ version: 1, panelInitialized: false }) + '\n');
  return { created: true, state };
}

function readKeys(repoRoot = root) {
  return validateState(repoRoot).keys;
}

function docker(args) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    env: { ...process.env, LOCAL_UID: String(process.getuid()), LOCAL_GID: String(process.getgid()) },
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Docker command failed (${result.error?.code ?? result.status}); inspect the local Docker service and project state.`);
  }
  return result.stdout.trim();
}

function compose(args) {
  return docker(['compose', '--project-name', project, '--env-file', path.join(root, '.local/compose.env'), '-f', path.join(root, 'deploy/local/compose.yml'), ...args]);
}

function inspect(service) {
  const name = `${project}-${service}-1`;
  const names = docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']).split('\n').filter(Boolean);
  if (!names.includes(name)) return null;
  const template = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"image_id":{{json .Image}},"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}},"restart":{{json .HostConfig.RestartPolicy.Name}},"logging":{{json .HostConfig.LogConfig}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"user":{{json .Config.User}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"working_dir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"config_files":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}}';
  const info = JSON.parse(docker(['inspect', '--format', template, name]));
  expect(info.project === project && info.service === service, `Container name for ${service} is owned by another project.`);
  const repo = realpathSync(root);
  const composeFile = path.join(repo, 'deploy/local/compose.yml');
  expect(info.working_dir === path.dirname(composeFile) && info.config_files === composeFile, `${service} belongs to another checkout; no Docker mutation was performed.`);
  const expectedMounts = service === 'cpa'
    ? [['cpa/config.yaml', '/CLIProxyAPI/config.yaml'], ['cpa/auth', '/root/.cli-proxy-api'], ['cpa/logs', '/CLIProxyAPI/logs'], ['cpa/plugins', '/CLIProxyAPI/plugins']]
    : [['omc', '/data']];
  for (const [source, destination] of expectedMounts) {
    expect(info.mounts?.some((mount) => mount.Type === 'bind' && mount.Source === path.join(repo, '.local', source) && mount.Destination === destination), `${service} has foreign state mounts; no Docker mutation was performed.`);
  }
  return info;
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Port ${port} is occupied; no existing process was stopped.`)));
    server.listen({ host: '0.0.0.0', port, exclusive: true }, () => server.close(resolve));
  });
}

async function start() {
  const initialized = setupState(root);
  const containers = inspectContainers();
  for (const [service, spec] of Object.entries(services)) {
    const info = containers[service];
    if (!info?.running) await assertPortFree(spec.port);
  }
  compose(['up', '-d', '--wait', '--wait-timeout', '180']);
  expect(validateState(root).hasDatabase, 'Panel started without its persistent database; preserve state and investigate.');
  setupState(root);
  return { state_created: initialized.created, containers: inspectContainers() };
}

function inspectContainers() {
  const names = docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}']).split('\n').filter(Boolean);
  expect(names.every((name) => Object.keys(services).some((service) => name === `${project}-${service}-1`)), 'The project contains unknown containers; no Docker mutation was performed.');
  return Object.fromEntries(Object.keys(services).map((service) => [service, inspect(service)]));
}

function validateContainers(containers) {
  const listed = docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}']).split('\n').filter(Boolean).sort();
  const expected = Object.keys(services).map((service) => `${project}-${service}-1`).sort();
  expect(JSON.stringify(listed) === JSON.stringify(expected), 'The local project must contain exactly its two expected containers.');
  for (const [service, spec] of Object.entries(services)) {
    const info = containers[service];
    expect(info?.running && info.health === 'healthy', `${service} is not running and healthy.`);
    expect(info.image === spec.image, `${service} is not using the pinned image.`);
    const exposed = Object.entries(info.ports ?? {}).filter(([, bindings]) => bindings !== null);
    expect(exposed.length === 1 && exposed[0][0] === spec.inner && exposed[0][1].length === 1 && exposed[0][1][0].HostIp === '127.0.0.1' && exposed[0][1][0].HostPort === String(spec.port), `${service} has unexpected published ports.`);
    expect(info.restart === 'unless-stopped', `${service} has an unexpected restart policy.`);
    expect(info.logging?.Type === 'json-file' && info.logging.Config?.['max-size'] === '10m' && info.logging.Config?.['max-file'] === '3', `${service} has unexpected log rotation.`);
    expect(!info.mounts.some((mount) => mount.Source === '/var/run/docker.sock' || mount.Destination === '/var/run/docker.sock'), `${service} has a Docker socket mount.`);
  }
  const uid = containers['oh-my-cpa'].user.split(':')[0];
  expect(containers['oh-my-cpa'].readonly && uid !== '0' && uid !== 'root' && uid !== '', 'Panel must use a non-root user and read-only root filesystem.');
}

async function request(url, options = {}) {
  return fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
}

async function json(response, label) {
  try { return await response.json(); } catch { throw new Error(`${label} returned invalid JSON.`); }
}

export async function checkHTTP({ api = apiBase, panel = panelBase, keys }) {
  const passed = [];
  const mark = (condition, label) => { expect(condition, label); passed.push(label); };
  let response = await request(`${api}/healthz`);
  mark(response.status === 200, 'CPA health endpoint');

  response = await request(`${panel}/`);
  const html = await response.text();
  const script = html.match(/<script[^>]+src="([^"]+)"/);
  mark(response.status === 200 && Boolean(script), 'Panel serves the embedded application');
  response = await request(new URL(script[1], `${panel}/`));
  mark(response.status === 200 && /javascript/i.test(response.headers.get('content-type') ?? ''), 'Panel application asset');

  response = await request(`${panel}/api/healthz`);
  const health = await json(response, 'Panel health');
  mark(response.status === 200 && health.status === 'ok' && health.database_status === 'ok' && health.cpa_connected === true && health.cpa_management_api === 'v8', 'Panel health and CPA v8 connection');

  response = await request(`${api}/v1/models`);
  mark(response.status === 401, 'Missing client key rejected');
  response = await request(`${api}/v1/models`, { headers: { Authorization: 'Bearer invalid-local-verification-key' } });
  mark(response.status === 401, 'Wrong client key rejected');
  response = await request(`${api}/v1/models`, { headers: { Authorization: `Bearer ${keys.client}` } });
  const models = await json(response, 'Models');
  mark(response.status === 200 && models.object === 'list' && Array.isArray(models.data), 'Client key lists models');

  response = await request(`${api}/v8/management/config/config-version`, { headers: { Authorization: `Bearer ${keys.client}` } });
  mark(response.status === 401 || response.status === 403, 'Client key cannot access CPA management');
  response = await request(`${panel}/api/v1/management/overview`, { headers: { Authorization: `Bearer ${keys.client}` } });
  mark(response.status === 401 || response.status === 403, 'Client key cannot access panel management');
  response = await request(`${panel}/api/auth/session`);
  mark(response.status === 200 && (await json(response, 'Session')).authenticated === false, 'Anonymous panel session is unauthenticated');

  response = await request(`${panel}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: panel }, body: JSON.stringify({ password: keys.management }),
  });
  const login = await json(response, 'Panel login');
  const setCookie = response.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  mark(response.status === 200 && login.authenticated === true && cookie.includes('=') && /httponly/i.test(setCookie), 'Management key creates an HttpOnly panel session');
  response = await request(`${panel}/api/auth/session`, { headers: { Cookie: cookie } });
  mark(response.status === 200 && (await json(response, 'Session')).authenticated === true, 'Panel session is authenticated');
  response = await request(`${panel}/api/v1/management/overview`, { headers: { Cookie: cookie } });
  const overview = await json(response, 'Panel overview');
  mark(response.status === 200 && overview.status === 'connected' && overview.cpa_connected === true, 'Authenticated panel overview connects to CPA');
  response = await request(`${panel}/api/v1/usage/ingest-status`, { headers: { Cookie: cookie } });
  const ingest = await json(response, 'Usage collector');
  mark(response.status === 200 && ingest.enabled === true && ingest.healthy === true && ingest.collector?.running === true && ['subscribe', 'resp_pull', 'http_pull'].includes(ingest.collector?.mode), 'Panel usage collector is running and healthy');
  return { passed, model_count: models.data.length, panel_version: health.version, cpa_management_api: health.cpa_management_api, usage_mode: ingest.collector.mode };
}

const tools = [{ type: 'function', function: { name: 'add_numbers', description: 'Add two integers.', parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'], additionalProperties: false } } }];

export async function modelCheck({ api = apiBase, client, model }) {
  expect(typeof model === 'string' && model.trim().length > 0 && model.length <= 200, 'Set MODEL to a configured model name.');
  const messages = [{ role: 'user', content: 'Call add_numbers with a=17 and b=25, then reply with only the numeric result, without any other text.' }];
  const send = async (payload) => {
    const response = await request(`${api}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${client}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    expect(response.status === 200, `Model request failed with HTTP ${response.status}.`);
    return json(response, 'Model response');
  };
  const first = await send({ model, messages, tools, tool_choice: 'auto' });
  const assistant = first.choices?.[0]?.message;
  expect(assistant?.role === 'assistant' && Array.isArray(assistant.tool_calls) && assistant.tool_calls.length === 1, 'Model did not return exactly one tool call.');
  const call = assistant.tool_calls[0];
  expect(call.type === 'function' && call.function?.name === 'add_numbers' && typeof call.id === 'string' && call.id.length > 0 && call.id.length <= 500, 'Model returned an unexpected tool call.');
  let args;
  try { args = JSON.parse(call.function.arguments); } catch { throw new Error('Model returned invalid tool arguments.'); }
  expect(args && !Array.isArray(args) && Object.keys(args).sort().join(',') === 'a,b' && args.a === 17 && args.b === 25, 'Model returned unexpected tool arguments.');
  const result = args.a + args.b;
  const second = await send({ model, messages: [...messages, assistant, { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ result }) }], tools, tool_choice: 'none' });
  const final = second.choices?.[0]?.message;
  expect(final?.role === 'assistant' && typeof final.content === 'string' && final.content.trim().length > 0 && !final.tool_calls?.length, 'Model did not return a final answer.');
  expect(final.content.trim() === String(result), 'Final answer must be exactly the computed result.');
  const structured = await send({ model, messages: [{ role: 'user', content: 'Return exactly this JSON object: {"ok":true,"result":42}' }], response_format: { type: 'json_object' } });
  let structuredValue;
  try { structuredValue = JSON.parse(structured.choices?.[0]?.message?.content); } catch { throw new Error('Model did not return valid structured JSON.'); }
  expect(structuredValue && !Array.isArray(structuredValue) && Object.keys(structuredValue).sort().join(',') === 'ok,result' && structuredValue.ok === true && structuredValue.result === result, 'Model returned unexpected structured JSON.');
  return { model, tool: 'add_numbers', arguments: args, tool_result: result, final_answer_received: true, final_answer_contains_result: true, structured_json_validated: true };
}

async function main(args) {
  const command = args[0];
  const flags = args.slice(1).filter((arg) => arg !== '--json');
  let result;
  if (command === 'setup' && flags.length === 0) result = setupState(root);
  else if (command === 'start' && flags.length === 0) result = await start();
  else if (command === 'stop' && flags.length === 0) { inspectContainers(); setupState(root); compose(['stop']); result = { stopped: true }; }
  else if (command === 'status' && flags.length === 0) result = { containers: inspectContainers() };
  else if (command === 'check' && flags.length === 0) {
    const containers = inspectContainers();
    validateContainers(containers);
    result = { docker_checks: 'passed', ...(await checkHTTP({ keys: readKeys() })) };
  } else if (command === 'model-check' && flags.length === 1 && flags[0] === '--live') {
    inspectContainers();
    result = await modelCheck({ client: readKeys().client, model: process.env.MODEL });
  } else throw new Error('Usage: node scripts/local-gateway.mjs setup|start|stop|status|check [--json], or MODEL=<name> node scripts/local-gateway.mjs model-check --live [--json].');
  console.log(JSON.stringify({ ok: true, command, ...result }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (process.argv.includes('--json')) console.error(JSON.stringify({ ok: false, error: message }));
    else console.error(`Error: ${message}`);
    process.exitCode = 1;
  });
}
