'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { threadCount, providerChains, createOnnxSession } = require('./runtime');

test('threadCount is between 1 and 4', () => {
  const n = threadCount();
  assert.ok(n >= 1 && n <= 4);
});

test('providerChains always ends with cpu', () => {
  const chains = providerChains();
  assert.ok(chains.length >= 1);
  assert.deepEqual(chains[chains.length - 1], ['cpu']);
});

test('createOnnxSession tries EPs then succeeds on cpu', async () => {
  const calls = [];
  const fakeOrt = {
    InferenceSession: {
      create: async (path, opts) => {
        calls.push(opts.executionProviders);
        if (opts.executionProviders[0] !== 'cpu') throw new Error('no ep');
        return { ok: true };
      },
    },
  };
  const session = await createOnnxSession(fakeOrt, 'model.onnx', { threads: 2 });
  assert.equal(session.ok, true);
  assert.equal(session.executionProvider, 'cpu');
  assert.ok(calls.some((c) => c[0] === 'cpu'));
});
