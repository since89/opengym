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
