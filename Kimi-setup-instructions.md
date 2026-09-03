# Kimi (Moonshot) — setting up the AI Coach with an API key

Kimi is the third Coach provider. Unlike Claude and Codex it is not a CLI: the api container
makes one HTTPS request per job to Kimi's OpenAI-compatible endpoint (`api.moonshot.ai`), in
JSON mode, and hands the answer to the same validation and approval flow as the other providers.

## 1. Get a key that actually works

1. Sign in at <https://platform.kimi.ai>, open **API Keys**, create one and copy it.
2. **Top up the account** (minimum $1). `kimi-k3` is only unlocked after a successful top-up;
   an un-funded account gets `404 model not found` even with a valid key.
3. Use an **Open Platform** key. Keys from Kimi Code or a Kimi Membership are a different product
   and answer `401` or `404` here.

## 2. Connect it

Settings → **Admin dashboard → AI Coach** → pick the **Kimi** chip → **Use an API key** → paste →
**Save key**. The card runs **Test the Coach** immediately; green means a real round-trip worked.

The key is encrypted at rest (AES-256-GCM, key derived from `./data/secret`) in `./data/coach.json`
and is only ever sent as the `Authorization` header of the Coach's own request to `api.moonshot.ai`.
It never reaches your users, the logs or the browser. Switching to another provider chip clears it.

## 3. Choose a model (optional)

The **Model** field takes one of Kimi's live identifiers, with an optional reasoning-effort suffix:

| Value | What you get |
| --- | --- |
| *(empty)* or `kimi-k3` | flagship model, reasoning effort `low` (the default here — Kimi's own default is `max`) |
| `kimi-k3:high` / `kimi-k3:max` | deeper reasoning, slower, more output tokens billed |
| `kimi-k2.6` | cheaper general model (thinking on by default; no effort knob) |
| `kimi-k2.7-code`, `kimi-k2.7-code-highspeed` | coding models; work, but not the point here |

Retired identifiers (`kimi-k2.5`, `moonshot-v1-*`, `kimi-k2-*`) return `404`.

## 4. What it costs, honestly

`kimi-k3` bills $3 per million input tokens and **$15 per million output tokens — reasoning
included**, and it always reasons, even at effort `low`. A plan or review sends roughly 30k input
tokens and gets back a few thousand tokens of JSON, so expect **at least $0.18 per job before
reasoning**; the reasoning volume at `low` is not documented by Kimi. Read the real number in
the Kimi console after your first job, then set the caps:

- **Per user / day** and **Whole instance / day** in the Coach card (`0` means unlimited — set them).
- A project budget and the balance alert in the Kimi console.

## 5. Rate limits and the silent case

Account tiers depend on cumulative top-up: **Tier 0 ($1)** allows **1 concurrent request and
3 requests per minute**; **Tier 1 ($10)** allows 15 concurrent and 100 per minute. openGym runs
up to two jobs at once, and every profile's weekly review defaults to the same slot (Sunday
18:00), so on Tier 0 two profiles can collide with a `429 rate limited`.

A **manual** run shows that error right away and you simply retry. A **scheduled** review that
fails is silent by design (only a ready proposal sends a notification): the only place it
shows is the admin card's **Last failure**. Check it now and then, or stagger the review day
between profiles, or top up to Tier 1.

## 6. Reading the admin card's "Last failure"

| Label | Meaning | Do |
| --- | --- | --- |
| `Kimi API 401 unauthorized …` / `403 …` | wrong or revoked key | paste a new key |
| `Kimi API 404 …: model not found or account not topped up` | retired model id, or account never funded | fix the Model field, or top up |
| `Kimi API 429 insufficient balance` | balance exhausted | top up |
| `Kimi API 429 rate limited` | tier limit hit | retry, stagger, or top up |
| `Kimi API 429 overloaded, retry later` | Kimi side | retry later |
| `Kimi: output truncated (length limit reached) …` | reasoning + answer exceeded 32 768 tokens | use `:low`, or shorten the plan |
| `Kimi API 5xx …`, `network error`, `timed out` | transport / Kimi side | retry |

## 7. Rotating or revoking the key

Revoke it in the Kimi console, create a new one and paste it in the card (it overwrites the old
one), or press **Disconnect** to stop the Coach. Encrypted copies of the old key may remain in
your server backups; once revoked at Kimi they are inert.

## 8. What leaves your server

Exactly what the consent screen lists — the same allow-list `api/coach/payload.js` sends to any
provider: plan, recent workouts, body weight, questionnaire answers and free-text notes. It goes
to Moonshot AI Pte. Ltd. (Singapore). Read their terms before inviting other people: as of
September 2026 they allow using customer content to improve their services unless agreed
otherwise in writing.
