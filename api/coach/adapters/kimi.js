/* Kimi (Moonshot) adapter — one HTTPS call to the OpenAI-compatible Chat Completions API.
 *
 * In-process on purpose: there is no CLI to sandbox, only a request to send and a JSON answer
 * to hand back. The key arrives through `env` (config.jobEnv builds it from the encrypted
 * credential) and is used for the Authorization header only — never logged, never echoed.
 *
 *   check(cfg)                                      → { ok, version }
 *   invoke({ cfg, prompt, env, model, timeoutMs })  → { code, text, stderr, timedOut, spawnError }
 *
 * Failure labels are deliberate. jobs.js (api/coach/jobs.js:279) reads any stderr matching
 * /auth|unauthor|api key|credential|token|401|403|login/ as an authentication problem and tells
 * the lifter "the Coach couldn't sign in". So 401/403 and a missing key say "unauthorized" /
 * "key missing" on purpose, every other label stays clear of those words, and provider-supplied
 * error types are scrubbed before they are quoted. test/kimi.test.js pins that contract.
 */
const DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';
const DEFAULT_MODEL = 'kimi-k3';
const DEFAULT_EFFORT = 'low';           // Kimi's own default is `max`; every reasoning token is billed as output.
const MAX_COMPLETION_TOKENS = 32768;    // covers reasoning + answer (`max_tokens` is deprecated at Kimi)
const SYSTEM_PROMPT = [
  'You are the openGym Coach.',
  'Answer only the supplied task and return exactly the requested JSON.',
  'You have no tools, filesystem access, external services, or persistent memory.'
].join(' ');
const AUTH_WORDS = /token|auth|login|credential/gi;
const scrub = s => String(s || '').replace(AUTH_WORDS, '*').slice(0, 80);

/** `kimi-k3:high` → effort high; bare `kimi-k3` → low; any other model → suffix dropped, no knob
 *  (the API rejects `reasoning_effort` outside the K3 family). */
export function resolveModel(raw) {
  const value = String(raw || '').trim() || DEFAULT_MODEL;
  const m = value.match(/^(.*?):(low|high|max)$/);
  const model = m ? m[1] : value;
  if (!/^kimi-k3/.test(model)) return { model, reasoningEffort: null };
  return { model, reasoningEffort: m ? m[2] : DEFAULT_EFFORT };
}

const failure = (stderr, { code = 1, timedOut = false } = {}) => ({ code, text: '', stderr, timedOut, spawnError: false });

/** One line for the admin card's "Last failure", built from (status, error.type) — never from error.message. */
function describeError(status, statusText, rawBody) {
  let type = null;
  try { type = JSON.parse(rawBody)?.error?.type || null; } catch { /* HTML gateway page, or an empty body */ }
  const t = type || statusText || 'error';
  if (status === 401 || status === 403) return `Kimi API ${status} unauthorized (${t})`;
  const quoted = scrub(t);
  if (status === 404) return `Kimi API 404 (${quoted}): model not found or account not topped up (>= $1)`;
  if (status === 429) {
    if (type === 'exceeded_current_quota_error') return 'Kimi API 429 insufficient balance';
    if (type === 'rate_limit_reached_error') return 'Kimi API 429 rate limited';
    if (type === 'engine_overloaded_error') return 'Kimi API 429 overloaded, retry later';
    return `Kimi API 429 (${quoted})`;
  }
  if (status === 400) {
    if (type === 'content_filter') return 'Kimi API 400 content filtered';
    return `Kimi API 400 (${quoted}): invalid request (input too long or bad parameter)`;
  }
  if (status >= 500) return `Kimi API ${status} server error (${quoted})`;
  return `Kimi API ${status} (${quoted})`;
}

export function createKimiAdapter({ fetchImpl = globalThis.fetch, baseUrl = process.env.COACH_KIMI_BASE_URL || DEFAULT_BASE_URL } = {}) {
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  return {
    id: 'kimi',
    runtime: 'Kimi API (Moonshot)',

    // Static on purpose (like the Claude adapter): the real round-trip is jobs.testRun().
    async check(cfg) {
      return { ok: true, version: `Kimi API · ${resolveModel(cfg?.model).model}` };
    },

    async invoke({ cfg, prompt, env, model, timeoutMs }) {
      const key = env?.MOONSHOT_API_KEY;
      if (!key) return failure('Kimi API key missing');
      const { model: modelId, reasoningEffort } = resolveModel(model || cfg?.model);
      const body = {
        model: modelId,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        max_completion_tokens: MAX_COMPLETION_TOKENS
      };
      if (reasoningEffort) body.reasoning_effort = reasoningEffort;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res, raw;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        raw = await res.text();
      } catch (e) {
        if (controller.signal.aborted) return failure('Kimi API timed out', { code: -1, timedOut: true });
        return failure(`Kimi API network error (${scrub(e?.name || 'Error')})`);
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) return failure(describeError(res.status, res.statusText, raw));
      let data;
      try { data = JSON.parse(raw); } catch { return failure('Kimi API returned a non-JSON body'); }
      const choice = data?.choices?.[0];
      if (choice?.finish_reason === 'length') {
        return failure('Kimi: output truncated (length limit reached) — lower the reasoning effort (model suffix :low) or raise the bound');
      }
      const content = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '';
      if (!content) return failure('Kimi API returned an empty answer');   // no text ⇒ no paid repair round
      return { code: 0, text: content, stderr: '', timedOut: false, spawnError: false };
    }
  };
}

export default createKimiAdapter();
