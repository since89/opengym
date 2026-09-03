/* Every provider config.js declares must have an adapter, and each adapter must answer to its id.
 * Importing adapters/index.js pulls in the Claude Agent SDK, so this file needs `npm ci` first. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.mjs';

tempData();
const cfg = await import('../coach/config.js');
const { adapterFor, default: ADAPTERS } = await import('../coach/adapters/index.js');

test('every declared provider has an adapter, and each adapter answers to its own id', () => {
  assert.deepEqual(Object.keys(ADAPTERS).sort(), Object.keys(cfg.PROVIDERS).sort());
  for (const id of Object.keys(cfg.PROVIDERS)) assert.equal(adapterFor(id)?.id, id, id);
  assert.equal(adapterFor('gemini'), null, 'retired providers resolve to null');
});
