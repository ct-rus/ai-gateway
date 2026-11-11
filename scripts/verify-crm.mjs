import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CheckError, check, json, options, readPrivate, request, reserveReceipt } from './verify-provider.mjs';

// Wire vocabulary observed in CRM copilot.ts at screen-context version 4.
const uuid = (s) => typeof s === 'string' && /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(s);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const shape = (v, required, optional = []) => object(v) && required.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => [...required, ...optional].includes(k));
const string = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
const settings = {
  'personal-channels': [], appearance: [],
  'crm-configuration': ['business-calendar', 'stage-targets', 'operational-timing', 'sequence', 'waiting-policies', 'offer-workflow', 'commercial-timing', 'commercial-document-profiles', 'commercial-document-payment-terms', 'commercial-document-email-policy'],
  'sales-rules': ['communication-progression', 'lead-assignment', 'pipeline-transitions', 'activity-outcomes', 'deal-types', 'lost-reasons', 'lead-sources'],
  'review-settings': ['approval-policies', 'reviews'], catalog: ['services', 'assets', 'discount-limits', 'events', 'editions'],
  'users-workspace': ['custom-fields', 'users', 'notification-policy'], 'change-history': ['change-history'],
};
const pages = ['my-day', 'inbox', 'calendar', 'pipeline', 'lead', 'companies', 'company', 'contacts', 'contact', 'team', 'analytics', 'reviews', 'settings', 'client-service', 'archive', 'catalog', 'deals', 'deal', 'outside-sends', 'recycle-bin', 'lead-recycle-bin', 'exports', 'unknown'];
function destination(v) {
  if (!object(v) || !string(v.label, 1, 120)) return false;
  const basic = ['pipeline', 'my-day', 'calendar', 'settings', 'archive', 'catalog', 'outside-sends'];
  if (basic.includes(v.kind)) return shape(v, ['kind', 'label']);
  if (v.kind === 'page') return shape(v, ['kind', 'label', 'page']) && ['inbox', 'companies', 'contacts', 'team', 'analytics', 'reviews', 'client-service'].includes(v.page);
  if (['lead', 'company', 'deal'].includes(v.kind)) { const id = `${v.kind}Id`; return shape(v, ['kind', 'label', id]) && uuid(v[id]); }
  if (v.kind === 'settings-section') return shape(v, ['kind', 'label', 'tab'], ['section']) && Object.hasOwn(settings, v.tab) && (v.section === undefined || settings[v.tab].includes(v.section));
  if (v.kind === 'inbox') return shape(v, ['kind', 'label', 'channel', 'view']) && (v.channel === 'email' ? ['mailbox', 'needs_reply'].includes(v.view) : v.channel === 'telegram' && ['chats', 'needs_reply'].includes(v.view));
  if (v.kind === 'analytics') return shape(v, ['kind', 'label', 'section']) && ['now', 'outcomes', 'team', 'events', 'explorer', 'overview', 'pipeline', 'data-export', 'adoption'].includes(v.section);
  return false;
}
const destinations = (v) => Array.isArray(v) && v.length <= 5 && v.every(destination);
function context(v) {
  if (v === null) return true;
  const ids = ['leadId', 'targetUserId', 'companyId', 'contactId', 'dealId', 'outsideSendId'];
  const optional = [...ids, 'viewMode', 'filters', 'settingsTab', 'settingsSection', 'visibleIds', 'selectedIds', 'visibleCount', 'totalCount', 'activeTab', 'subTab', 'recordKind', 'screenContextVersion'];
  if (!shape(v, ['page'], optional) || !pages.includes(v.page) || JSON.stringify(v).length > 8000) return false;
  if (ids.some((id) => v[id] !== undefined && !uuid(v[id]))) return false;
  for (const [id, page] of [['leadId', 'lead'], ['companyId', 'company'], ['contactId', 'contact'], ['dealId', 'deal'], ['outsideSendId', 'outside-sends']]) if (v[id] !== undefined && v.page !== page) return false;
  if (v.viewMode !== undefined && !['self', 'oversight', 'team'].includes(v.viewMode)) return false;
  if (v.settingsTab !== undefined && !Object.hasOwn(settings, v.settingsTab)) return false;
  if ((v.settingsTab !== undefined || v.settingsSection !== undefined) && v.page !== 'settings') return false;
  if (v.settingsSection !== undefined && (v.settingsTab === undefined || !settings[v.settingsTab].includes(v.settingsSection))) return false;
  for (const key of ['visibleIds', 'selectedIds']) if (v[key] !== undefined && (!Array.isArray(v[key]) || v[key].length > 50 || !v[key].every(uuid))) return false;
  for (const key of ['visibleCount', 'totalCount']) if (v[key] !== undefined && !(key === 'totalCount' && v[key] === null) && (!Number.isInteger(v[key]) || v[key] < 0 || v[key] > 1000000)) return false;
  if (v.activeTab !== undefined && !['chat', 'timeline', 'work', 'progress', 'commercial', 'activity', 'notes', 'history', 'tasks'].includes(v.activeTab)) return false;
  if (v.subTab !== undefined && !string(v.subTab, 0, 200)) return false;
  if (v.recordKind !== undefined && !['lead', 'deal', 'outsideSend', 'invoice'].includes(v.recordKind)) return false;
  if (v.screenContextVersion !== undefined && (!Number.isInteger(v.screenContextVersion) || v.screenContextVersion < 1 || v.screenContextVersion > 4)) return false;
  if (v.filters !== undefined) {
    const textKeys = ['query', 'stage', 'priority', 'tag', 'lastContact', 'work', 'sort', 'channel', 'view', 'period', 'population', 'signal', 'preset', 'from', 'to', 'boardGroupBy', 'activeViewId', 'section', 'mode', 'tab', 'threadId'];
    const idKeys = ['ownerId', 'sourceId', 'serviceId', 'actorId', 'sourceSubcategoryId', 'eventSeriesId', 'eventEditionId'];
    const f = v.filters;
    if (!shape(f, [], [...textKeys, ...idKeys, 'chips']) || Object.keys(f).length > 28 || textKeys.some((key) => f[key] !== undefined && !string(f[key], 0, 200)) || idKeys.some((key) => f[key] !== undefined && !uuid(f[key]))) return false;
    if (f.chips !== undefined && (!Array.isArray(f.chips) || f.chips.length > 12 || !f.chips.every((chip) => string(chip, 1, 200)))) return false;
  }
  return true;
}
function message(v) {
  return shape(v, ['id', 'requestId', 'role', 'text', 'status', 'context', 'destinations', 'createdAt']) && uuid(v.id) && uuid(v.requestId) && ['user', 'assistant'].includes(v.role) && string(v.text, 1, 4000) && ['completed', 'failed'].includes(v.status) && context(v.context) && destinations(v.destinations) && typeof v.createdAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v.createdAt) && Number.isFinite(Date.parse(v.createdAt)) && new Date(v.createdAt).toISOString().slice(0, 19) === v.createdAt.slice(0, 19);
}
export async function verifyCrm({ base, email, password, role, route, live, timeout = 30000, deadlineScale = 1, report }) {
  check(live === true, 'live_required');
  check(typeof email === 'string' && email.length > 2 && email.length <= 320 && typeof password === 'string' && password.length > 0 && password.length <= 1024 && typeof role === 'string' && /^[a-z_]{1,50}$/.test(role) && typeof route === 'string' && /^[A-Za-z0-9._:/@-]{1,200}$/.test(route), 'input');
  check(Number.isFinite(deadlineScale) && deadlineScale > 0 && deadlineScale <= 1, 'input');
  let cookie, failure;
  const call = (endpoint, opts = {}) => request(base, `/api/v1${endpoint}`, { timeout, ...opts, headers: { ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base }), ...(cookie ? { Cookie: cookie } : {}), ...opts.headers } });
  try {
    check((await call('/auth/me')).status === 401, 'anonymous');
    check((await call('/auth/me', { headers: { 'X-Auth-User': 'forged', 'X-Auth-Email': 'forged@example.invalid', 'X-Forwarded-User': 'forged', Authorization: 'Bearer forged' } })).status === 401, 'forged');
    let setCookie = '';
    const login = await call('/auth/login', { method: 'POST', body: { email, password }, onHeaders: (headers) => {
      setCookie = headers.get('set-cookie') ?? '';
      const matched = setCookie.match(/(?:^|,\s*)(crm_session=[^;,\s]+)/i);
      if (matched) cookie = matched[1];
    } });
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
    check(shape(settings, ['enabled', 'timeoutMs', 'screenContextVersion'], ['route']) && settings.enabled === true && Number.isInteger(settings.timeoutMs) && settings.timeoutMs >= 1000 && settings.timeoutMs <= 90000 && settings.screenContextVersion === 4 && (settings.route === undefined || Array.isArray(settings.route) && settings.route.length <= 10 && settings.route.every((entry) => string(entry, 1, 200)) && settings.route[0] === route), 'status');
    report.route = settings.route === undefined ? 'not_exposed' : 'matched';
    const requestId = randomUUID(); report.requestId = requestId;
    const ask = await call('/copilot/ask', { method: 'POST', timeout: Math.ceil((settings.timeoutMs + 5000) * deadlineScale), body: { requestId, question: 'How many leads are in my pipeline?', context: { page: 'pipeline' } } });
    check(ask.status === 200, 'ask');
    const answer = json(ask);
    check(shape(answer, ['requestId', 'chatId', 'answer', 'destinations']) && answer.requestId === requestId && uuid(answer.chatId) && typeof answer.answer === 'string' && answer.answer.trim().length > 0 && answer.answer.trim().length <= 4000 && destinations(answer.destinations), 'schema');
    const history = await call(`/copilot/chats/${answer.chatId}/messages?limit=10`);
    check(history.status === 200, 'history');
    const messages = json(history);
    check(shape(messages, ['items', 'nextCursor']) && (messages.nextCursor === null || uuid(messages.nextCursor)) && Array.isArray(messages.items) && messages.items.every(message) && messages.items.some((item) => item.requestId === requestId && item.role === 'assistant' && item.status === 'completed' && item.text === answer.answer), 'history');
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
