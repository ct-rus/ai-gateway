import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export class CheckError extends Error { constructor(code) { super(code); this.code = code; } }
export function check(condition, code) { if (!condition) throw new CheckError(code); }
const privateStat = (s, directory) => s.uid === process.getuid() && (s.mode & 0o077) === 0 && (directory ? s.isDirectory() : s.isFile() && s.nlink === 1);
export function readPrivate(file) {
  check(path.isAbsolute(file), 'private_input');
  let fd;
  try {
    const before = lstatSync(file);
    check(privateStat(before, false) && before.size <= 16384, 'private_input');
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const after = fstatSync(fd);
    check(privateStat(after, false) && before.dev === after.dev && before.ino === after.ino && after.size <= 16384, 'private_input');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch { throw new CheckError('private_input'); } finally { if (fd !== undefined) closeSync(fd); }
}
export function reserveReceipt(file) {
  check(path.isAbsolute(file), 'receipt');
  let parent, fd;
  try {
    const dir = path.dirname(file), before = lstatSync(dir);
    check(privateStat(before, true), 'receipt');
    parent = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const after = fstatSync(parent);
    check(privateStat(after, true) && before.dev === after.dev && before.ino === after.ino, 'receipt');
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    return { write(value) { try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); fsyncSync(parent); } finally { closeSync(fd); closeSync(parent); } } };
  } catch { if (fd !== undefined) closeSync(fd); if (parent !== undefined) closeSync(parent); throw new CheckError('receipt'); }
}
export function options(args) {
  check(args.length === 5 && args[0] === '--live' && args[1] === '--input' && args[3] === '--receipt' && args[2] && args[4], 'usage');
  return { input: args[2], receipt: args[4] };
}
export async function request(base, route, { method = 'GET', headers = {}, body, timeout = 20000, onHeaders } = {}) {
  try {
    const response = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    onHeaders?.(response.headers);
    const reader = response.body?.getReader(); let size = 0; const chunks = [];
    if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 262144) { await reader.cancel(); throw new CheckError('response_size'); } chunks.push(value); }
    return { status: response.status, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') };
  } catch (e) { if (e instanceof CheckError) throw e; throw new CheckError('transport'); }
}
export function json(response) { try { return JSON.parse(response.text); } catch { throw new CheckError('schema'); } }
const tools = [{ type: 'function', function: { name: 'add_numbers', description: 'Add two integers.', parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'], additionalProperties: false } } }];
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === expected;
export async function verifyProvider({ base, client, model, live, timeout = 20000 }) {
  check(live === true, 'live_required');
  check(typeof client === 'string' && /^[\x21-\x7e]{1,512}$/.test(client), 'input');
  check(typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model), 'input');
  const auth = { Authorization: `Bearer ${client}` };
  const get = (headers = {}) => request(base, '/v1/models', { headers, timeout });
  check((await get()).status === 401, 'auth');
  check((await get({ Authorization: 'Bearer invalid-verification-key' })).status === 401, 'auth');
  const management = await request(base, '/v8/management/config/config-version', { headers: auth, timeout });
  check(management.status === 404, 'boundary');
  const listing = await get(auth);
  check(listing.status === 200, listing.status === 401 || listing.status === 403 ? 'auth' : 'model');
  const models = json(listing);
  check(models?.object === 'list' && Array.isArray(models.data) && models.data.length > 0 && models.data.length <= 10000 && models.data.every((item) => typeof item?.id === 'string') && models.data.some((item) => item.id === model), 'model');
  const send = async (payload) => { const r = await request(base, '/v1/chat/completions', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: payload, timeout }); check(r.status === 200, r.status === 401 || r.status === 403 ? 'auth' : 'model'); return json(r); };
  const messages = [{ role: 'user', content: 'Call add_numbers with a=17 and b=25, then reply with only the numeric result, without any other text.' }];
  const first = await send({ model, messages, tools, tool_choice: 'auto' });
  const assistant = first?.choices?.[0]?.message, calls = assistant?.tool_calls;
  check(first?.choices?.[0]?.finish_reason === 'tool_calls' && assistant?.role === 'assistant' && Array.isArray(calls) && calls.length === 1, 'tool');
  const call = calls[0];
  check(call?.type === 'function' && call.function?.name === 'add_numbers' && typeof call.id === 'string' && call.id.length > 0 && call.id.length <= 500 && typeof call.function.arguments === 'string', 'tool');
  let args; try { args = JSON.parse(call.function.arguments); } catch { throw new CheckError('tool'); }
  check(keys(args, 'a,b') && args.a === 17 && args.b === 25, 'tool');
  const result = args.a + args.b;
  const second = await send({ model, messages: [...messages, assistant, { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ result }) }], tools, tool_choice: 'none' });
  const final = second?.choices?.[0]?.message;
  check(second?.choices?.[0]?.finish_reason === 'stop' && final?.role === 'assistant' && typeof final.content === 'string' && final.content.trim() === String(result) && (final.tool_calls === undefined || Array.isArray(final.tool_calls) && final.tool_calls.length === 0), 'tool');
  const structured = await send({ model, messages: [{ role: 'user', content: 'Return exactly this JSON object: {"ok":true,"result":42}' }], response_format: { type: 'json_object' } });
  const message = structured?.choices?.[0]?.message;
  check(structured?.choices?.[0]?.finish_reason === 'stop' && message?.role === 'assistant' && typeof message.content === 'string' && (message.tool_calls === undefined || Array.isArray(message.tool_calls) && message.tool_calls.length === 0), 'schema');
  let value; try { value = JSON.parse(message.content); } catch { throw new CheckError('schema'); }
  check(keys(value, 'ok,result') && value.ok === true && value.result === result, 'schema');
  return { model, modelCount: models.data.length, inferenceBoundary: 'passed', toolCycle: 'passed', structuredJson: 'passed' };
}
async function main() {
  const opts = options(process.argv.slice(2));
  const input = readPrivate(opts.input);
  check(keys(input, 'client,model'), 'input');
  const receipt = reserveReceipt(opts.receipt);
  const report = { version: 1, operation: 'provider', operationId: randomUUID(), startedAt: new Date().toISOString(), status: 'failed' };
  try { Object.assign(report, await verifyProvider({ base: 'http://ct-ai-inference:8317', ...input, live: true }), { status: 'passed' }); }
  catch (e) { report.failure = e instanceof CheckError ? e.code : 'internal'; }
  report.finishedAt = new Date().toISOString(); receipt.write(report); console.log(JSON.stringify({ status: report.status, failure: report.failure })); if (report.status !== 'passed') process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(JSON.stringify({ status: 'failed', failure: e instanceof CheckError ? e.code : 'internal' })); process.exitCode = 1; });
