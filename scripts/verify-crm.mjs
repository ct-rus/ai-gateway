import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CheckError, check, json, options, readPrivate, request, reserveReceipt } from './verify-provider.mjs';

const uuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export async function verifyCrm({ base, email, password, role, route, live, timeout = 30000, report }) {
  check(live === true, 'live_required');
  check(typeof email === 'string' && email.length > 2 && email.length <= 320 && typeof password === 'string' && password.length > 0 && password.length <= 1024 && typeof role === 'string' && /^[a-z_]{1,50}$/.test(role) && typeof route === 'string' && /^[A-Za-z0-9._:/@-]{1,200}$/.test(route), 'input');
  let cookie, failure;
  const call = (endpoint, opts = {}) => request(base, `/api/v1${endpoint}`, { ...opts, timeout, headers: { ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base }), ...(cookie ? { Cookie: cookie } : {}), ...opts.headers } });
  try {
    check((await call('/auth/me')).status === 401, 'anonymous');
    check((await call('/auth/me', { headers: { 'X-Auth-User': 'forged', 'X-Auth-Email': 'forged@example.invalid', 'X-Forwarded-User': 'forged', Authorization: 'Bearer forged' } })).status === 401, 'forged');
    const login = await call('/auth/login', { method: 'POST', body: { email, password } });
    const setCookie = login.headers.get('set-cookie') ?? '';
    const matched = setCookie.match(/(?:^|,\s*)(crm_session=[^;,\s]+)/i);
    if (matched) cookie = matched[1];
    check(login.status === 200, 'login');
    const logged = json(login);
    check(logged.mustChangePassword === false, 'login');
    check(cookie && /(?:^|;)\s*secure(?:;|,|$)/i.test(setCookie) && /(?:^|;)\s*httponly(?:;|,|$)/i.test(setCookie), 'cookie');
    check(logged.user?.roleId === role && uuid(logged.user?.id), 'role');
    const me = await call('/auth/me');
    check(me.status === 200, 'session');
    const identity = json(me);
    check(identity.user?.id === logged.user.id && identity.user?.roleId === role, 'session');
    const status = await call('/copilot/status');
    check(status.status === 200, 'status');
    const settings = json(status);
    check(settings.enabled === true && (settings.route === undefined || Array.isArray(settings.route) && settings.route[0] === route), 'status');
    report.route = settings.route === undefined ? 'not_exposed' : 'matched';
    const requestId = randomUUID(); report.requestId = requestId;
    const ask = await call('/copilot/ask', { method: 'POST', body: { requestId, question: 'How many leads are in my pipeline?', context: { page: 'pipeline' } } });
    check(ask.status === 200, 'ask');
    const answer = json(ask);
    check(answer.requestId === requestId && uuid(answer.chatId) && typeof answer.answer === 'string' && answer.answer.trim().length > 0 && answer.answer.length <= 4000 && Array.isArray(answer.destinations) && answer.destinations.length <= 5, 'schema');
    const history = await call(`/copilot/chats/${answer.chatId}/messages?limit=10`);
    check(history.status === 200, 'history');
    const messages = json(history);
    check(Array.isArray(messages.items) && messages.items.some((item) => item.requestId === requestId && item.role === 'assistant' && item.status === 'completed' && item.text === answer.answer), 'history');
    report.httpWorkflow = 'passed';
  } catch (e) { failure = e instanceof CheckError ? e.code : 'internal'; }
  finally {
    if (cookie) {
      try {
        const logout = await call('/auth/logout', { method: 'POST' });
        check(logout.status === 204, 'logout');
        check((await call('/auth/me')).status === 401, 'logout');
        report.logout = 'passed';
      } catch { report.logout = 'failed'; failure = failure ?? 'logout'; }
    } else report.logout = 'no_session_observed';
  }
  if (failure) throw new CheckError(failure);
}
async function main() {
  const opts = options(process.argv.slice(2));
  const input = readPrivate(opts.input);
  check(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).sort().join(',') === 'email,password,role,route', 'input');
  const receipt = reserveReceipt(opts.receipt);
  const report = { version: 1, operation: 'crm-dev', operationId: randomUUID(), startedAt: new Date().toISOString(), status: 'failed', httpWorkflow: 'incomplete', traceNotVerified: true, toolCycleAcceptance: 'incomplete' };
  try { await verifyCrm({ base: 'https://crm-dev.ctcrm.net', ...input, live: true, report }); report.status = 'incomplete'; }
  catch (e) { report.failure = e instanceof CheckError ? e.code : 'internal'; }
  report.finishedAt = new Date().toISOString(); receipt.write(report); console.log(JSON.stringify({ status: report.status, httpWorkflow: report.httpWorkflow, traceNotVerified: true, failure: report.failure })); process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(JSON.stringify({ status: 'failed', failure: e instanceof CheckError ? e.code : 'internal' })); process.exitCode = 1; });
