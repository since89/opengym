/* Kimi adapter — no network: fetch is injected. The adapter has no dependency on DATA_DIR. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createKimiAdapter, resolveModel } from '../coach/adapters/kimi.js';

const ENV = { MOONSHOT_API_KEY: 'sk-test' };
const BASE = 'https://kimi.test/v1';

/** A fetch double that records each request and answers with one canned Response. */
function fakeFetch(status, body, { statusText = '' } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, statusText, headers: { 'content-type': 'application/json' } });
  };
  impl.calls = calls;
  return impl;
}

/** A Chat Completions success body. `content` may be null, as the API allows. */
const okBody = content => ({
  id: 'chatcmpl-test',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, reasoning_content: 'private chain of thought' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 }
});

const invoke = (adapter, over = {}) =>
  adapter.invoke({ cfg: {}, prompt: 'P', jobDir: '/tmp', env: ENV, model: null, timeoutMs: 5000, ...over });

test('resolveModel: kimi-k3 defaults to low effort, honours a suffix, strips it for other models', () => {
  assert.deepEqual(resolveModel(null), { model: 'kimi-k3', reasoningEffort: 'low' });
  assert.deepEqual(resolveModel(''), { model: 'kimi-k3', reasoningEffort: 'low' });
  assert.deepEqual(resolveModel('kimi-k3:high'), { model: 'kimi-k3', reasoningEffort: 'high' });
  assert.deepEqual(resolveModel('kimi-k3:max'), { model: 'kimi-k3', reasoningEffort: 'max' });
  assert.deepEqual(resolveModel('kimi-k2.6'), { model: 'kimi-k2.6', reasoningEffort: null });
  assert.deepEqual(resolveModel('kimi-k2.6:high'), { model: 'kimi-k2.6', reasoningEffort: null });
  assert.deepEqual(resolveModel(' kimi-k2.7-code '), { model: 'kimi-k2.7-code', reasoningEffort: null });
});

test('a successful call returns the JSON text and never the reasoning', async () => {
  const f = fakeFetch(200, okBody('{"coach_contract":1,"ok":true}'));
  const r = await invoke(createKimiAdapter({ fetchImpl: f, baseUrl: BASE }), { prompt: 'Reply with JSON' });
  assert.deepEqual(r, { code: 0, text: '{"coach_contract":1,"ok":true}', stderr: '', timedOut: false, spawnError: false });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://kimi.test/v1/chat/completions');
});

test('the request is shaped for Kimi: bearer key, JSON mode, completion bound, no temperature', async () => {
  const f = fakeFetch(200, okBody('{}'));
  await invoke(createKimiAdapter({ fetchImpl: f, baseUrl: BASE + '/' }));   // trailing slash tolerated
  const { init, body, url } = f.calls[0];
  assert.equal(url, 'https://kimi.test/v1/chat/completions');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer sk-test');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(body.model, 'kimi-k3');
  assert.equal(body.reasoning_effort, 'low');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.max_completion_tokens, 32768);
  assert.equal('max_tokens' in body, false, 'max_tokens is deprecated at Kimi');
  assert.equal('temperature' in body, false, 'Kimi fixes temperature and rejects any other value');
  assert.equal('thinking' in body, false);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /openGym Coach/);
  assert.deepEqual(body.messages[1], { role: 'user', content: 'P' });
});

test('the model field drives model and effort; non-K3 models get no reasoning knob', async () => {
  const f = fakeFetch(200, okBody('{}'));
  const a = createKimiAdapter({ fetchImpl: f, baseUrl: BASE });
  await invoke(a, { cfg: { model: 'kimi-k3:high' }, model: 'kimi-k3:high' });
  await invoke(a, { cfg: { model: 'kimi-k2.6:max' }, model: 'kimi-k2.6:max' });
  assert.equal(f.calls[0].body.model, 'kimi-k3');
  assert.equal(f.calls[0].body.reasoning_effort, 'high');
  assert.equal(f.calls[1].body.model, 'kimi-k2.6');
  assert.equal('reasoning_effort' in f.calls[1].body, false);
});

test('check() is static and names the effective model', async () => {
  const a = createKimiAdapter({ fetchImpl: fakeFetch(200, okBody('{}')), baseUrl: BASE });
  assert.deepEqual(await a.check({ model: null }, ENV), { ok: true, version: 'Kimi API · kimi-k3' });
  assert.deepEqual(await a.check({ model: 'kimi-k2.6:high' }, ENV), { ok: true, version: 'Kimi API · kimi-k2.6' });
  assert.equal(a.id, 'kimi');
  assert.equal(a.runtime, 'Kimi API (Moonshot)');
});

/* ---------------- failures ----------------
 * jobs.js:279 reads any stderr matching this regex as "the Coach couldn't sign in". */
const AUTHISH = /auth|unauthor|api key|credential|token|401|403|login/;   // copy of api/coach/jobs.js:279 — keep in sync
const authish = stderr => AUTHISH.test(String(stderr).toLowerCase());
const kimiErr = (type, message = 'irrelevant') => ({ error: { type, message } });
const run = (status, body, { model = null, statusText = '' } = {}) =>
  invoke(createKimiAdapter({ fetchImpl: fakeFetch(status, body, { statusText }), baseUrl: BASE }), { model });

test('401/403 are the only HTTP failures classified as auth', async () => {
  for (const [status, type] of [[401, 'invalid_authentication_error'], [403, 'permission_denied_error']]) {
    const r = await run(status, kimiErr(type));
    assert.deepEqual([r.code, r.text, r.timedOut, r.spawnError], [1, '', false, false]);
    assert.equal(r.stderr, `Kimi API ${status} unauthorized (${type})`);
    assert.equal(authish(r.stderr), true);
  }
});

test('a missing key is an auth failure before any request is made', async () => {
  const f = fakeFetch(200, okBody('{}'));
  const r = await invoke(createKimiAdapter({ fetchImpl: f, baseUrl: BASE }), { env: {} });
  assert.equal(r.stderr, 'Kimi API key missing');
  assert.equal(r.code, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(authish(r.stderr), true);
});

test('429 is split by error.type and never reads as an auth problem', async () => {
  const cases = [
    ['exceeded_current_quota_error', 'Kimi API 429 insufficient balance'],
    ['rate_limit_reached_error', 'Kimi API 429 rate limited'],
    ['engine_overloaded_error', 'Kimi API 429 overloaded, retry later'],
    ['token_quota_surprise', 'Kimi API 429 (*_quota_surprise)']          // unknown type: quoted, scrubbed
  ];
  for (const [type, expected] of cases) {
    const r = await run(429, kimiErr(type, 'Token quota is insufficient'));
    assert.equal(r.stderr, expected);
    assert.equal(r.code, 1);
    assert.equal(authish(r.stderr), false, expected);
  }
});

test('404 points at the two real causes: wrong model id, or an account not topped up', async () => {
  const r = await run(404, kimiErr('resource_not_found_error'), { model: 'kimi-k2.5' });
  assert.equal(r.stderr, 'Kimi API 404 (resource_not_found_error): model not found or account not topped up (>= $1)');
  assert.equal(authish(r.stderr), false);
});

test('400 distinguishes the content filter from a bad request', async () => {
  assert.equal((await run(400, kimiErr('content_filter'))).stderr, 'Kimi API 400 content filtered');
  const r = await run(400, kimiErr('invalid_request_error', 'prompt tokens + max_tokens exceeds the model specification'));
  assert.equal(r.stderr, 'Kimi API 400 (invalid_request_error): invalid request (input too long or bad parameter)');
  assert.equal(authish(r.stderr), false);
});

test('5xx and an HTML gateway page are provider failures with a readable label', async () => {
  assert.equal((await run(500, kimiErr('server_error'))).stderr, 'Kimi API 500 server error (server_error)');
  const r = await run(504, '<html><body>Gateway Time-out</body></html>', { statusText: 'Gateway Time-out' });
  assert.equal(r.stderr, 'Kimi API 504 server error (Gateway Time-out)');
  assert.equal(authish(r.stderr), false);
});

test('a non-JSON 2xx body, an empty answer and a truncated answer fail without a repair-worthy text', async () => {
  assert.equal((await run(200, 'not json at all')).stderr, 'Kimi API returned a non-JSON body');
  assert.equal((await run(200, okBody(null))).stderr, 'Kimi API returned an empty answer');
  assert.equal((await run(200, okBody('   '))).stderr, 'Kimi API returned an empty answer');
  const truncated = okBody('{"partial":');
  truncated.choices[0].finish_reason = 'length';
  const r = await run(200, truncated);
  assert.equal(r.stderr, 'Kimi: output truncated (length limit reached) — lower the reasoning effort (model suffix :low) or raise the bound');
  assert.deepEqual([r.code, r.text], [1, '']);
  assert.equal(authish(r.stderr), false);
});

test('a network exception is a provider failure, not a missing runtime', async () => {
  const boom = async () => { throw new TypeError('fetch failed'); };
  const r = await invoke(createKimiAdapter({ fetchImpl: boom, baseUrl: BASE }));
  assert.deepEqual(r, { code: 1, text: '', stderr: 'Kimi API network error (TypeError)', timedOut: false, spawnError: false });
});

test('the timeout aborts the request and reports timedOut', async () => {
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
  });
  const r = await invoke(createKimiAdapter({ fetchImpl: hang, baseUrl: BASE }), { timeoutMs: 20 });
  assert.deepEqual(r, { code: -1, text: '', stderr: 'Kimi API timed out', timedOut: true, spawnError: false });
});

test('contract: every stderr this adapter can produce is classified the way jobs.js expects', async () => {
  const expectAuth = [
    (await run(401, kimiErr('invalid_authentication_error'))).stderr,
    (await run(403, kimiErr('permission_denied_error'))).stderr,
    'Kimi API key missing'
  ];
  const expectProvider = [
    (await run(404, kimiErr('resource_not_found_error'))).stderr,
    (await run(429, kimiErr('exceeded_current_quota_error'))).stderr,
    (await run(429, kimiErr('rate_limit_reached_error'))).stderr,
    (await run(429, kimiErr('engine_overloaded_error'))).stderr,
    (await run(429, kimiErr('authentication_token_login_credential'))).stderr,   // hostile type: must be scrubbed
    (await run(429, kimiErr('quota_401_error'))).stderr,                        // hostile type: must be scrubbed
    (await run(500, kimiErr('quota_401_error'))).stderr,
    (await run(429, kimiErr('forbidden_403_case'))).stderr,
    (await run(500, kimiErr('forbidden_403_case'))).stderr,
    (await run(429, kimiErr('bad api key format'))).stderr,
    (await run(500, kimiErr('bad api key format'))).stderr,
    (await run(400, kimiErr('content_filter'))).stderr,
    (await run(400, kimiErr('invalid_request_error'))).stderr,
    (await run(500, kimiErr('server_error'))).stderr,
    (await run(504, '<html>', { statusText: 'Gateway Time-out' })).stderr,
    (await run(200, 'nope')).stderr,
    (await run(200, okBody(''))).stderr,
    'Kimi API network error (TypeError)',
    'Kimi API timed out'
  ];
  for (const s of expectAuth) assert.equal(authish(s), true, `should read as auth: ${s}`);
  for (const s of expectProvider) assert.equal(authish(s), false, `must not read as auth: ${s}`);
});
