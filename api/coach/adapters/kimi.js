/* Kimi (Moonshot) adapter — one HTTPS call to the OpenAI-compatible Chat Completions API.
 *
 * In-process on purpose: there is no CLI to sandbox, only a request to send and a JSON answer
 * to hand back. The key arrives through `env` (config.jobEnv builds it from the encrypted
 * credential) and is used for the Authorization header only — never logged, never echoed.
 *
 *   check(cfg)                                      → { ok, version }
 *   invoke({ cfg, prompt, env, model, timeoutMs })  → { code, text, stderr, timedOut, spawnError }
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
      const { model: modelId, reasoningEffort } = resolveModel(model || cfg?.model);
      const body = {
        model: modelId,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        max_completion_tokens: MAX_COMPLETION_TOKENS
      };
      if (reasoningEffort) body.reasoning_effort = reasoningEffort;

      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const raw = await res.text();
      if (!res.ok) return failure(`Kimi API ${res.status}`);
      const content = JSON.parse(raw)?.choices?.[0]?.message?.content;
      return { code: 0, text: String(content ?? '').trim(), stderr: '', timedOut: false, spawnError: false };
    }
  };
}

export default createKimiAdapter();
