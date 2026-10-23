import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { setTimeout as wait } from 'node:timers/promises';

// The compiled build: `pnpm test` runs tsc first. Plain .mjs keeps the n8n lint rules (which
// forbid node: imports in shipped code) away from the tests.
const require = createRequire(import.meta.url);
const { newestLoad } = require('../dist/nodes/Leapter/newest-load.js');

// A load that answers `value` after `ms`, or as soon as it is superseded
function load(value, ms, seen = {}) {
  return async (superseded) => {
    for (let waited = 0; waited < ms; waited += 5) {
      if (superseded()) {
        seen.superseded = true;
        return `${value} (stopped)`;
      }
      await wait(5);
    }
    return value;
  };
}

test('a single load answers with its own result', async () => {
  assert.equal(await newestLoad('single', load('A', 10)), 'A');
});

test('an older load stops waiting and answers with the newer result', async () => {
  const seen = {};
  const older = newestLoad('switch', load('A', 1_000, seen));
  await wait(20);
  const newer = newestLoad('switch', load('B', 30));
  assert.deepEqual(await Promise.all([older, newer]), ['B', 'B']);
  assert.deepEqual(seen, { superseded: true });
});

test('an older load that ends after the newer one still answers with the newer result', async () => {
  const older = newestLoad('late', async () => {
    await wait(80);
    return 'A';
  });
  await wait(10);
  const newer = newestLoad('late', load('B', 10));
  assert.equal(await newer, 'B');
  assert.equal(await older, 'B');
});

test('an older load waits for a newer load that is still running', async () => {
  const started = Date.now();
  const older = newestLoad('running', async () => 'A');
  const newer = newestLoad('running', load('B', 60));
  assert.equal(await older, 'B');
  assert.ok(Date.now() - started >= 50, 'the older load answered before the newer one ended');
  assert.equal(await newer, 'B');
});

test("the newer load's error is every overlapping load's error", async () => {
  const older = newestLoad('error', load('A', 1_000));
  await wait(10);
  const newer = newestLoad('error', async () => {
    await wait(10);
    throw new Error('refused');
  });
  await assert.rejects(newer, /refused/);
  await assert.rejects(older, /refused/);
});

test('loads of different callers do not share results', async () => {
  const first = newestLoad('caller-1', load('A', 30));
  const second = newestLoad('caller-2', load('B', 10));
  assert.deepEqual(await Promise.all([first, second]), ['A', 'B']);
});

test('without a caller every load answers for itself', async () => {
  const first = newestLoad(undefined, load('A', 30));
  const second = newestLoad(undefined, load('B', 10));
  assert.deepEqual(await Promise.all([first, second]), ['A', 'B']);
});
