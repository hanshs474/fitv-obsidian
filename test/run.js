'use strict';
// node test/run.js          -> mocked unit tests (responses shaped like the live API)
// node test/run.js --live   -> free live calls only: wrong-key credits and wrong-key submit must land on 'auth'
const Module = require('module');
const live = process.argv.includes('--live');
let polls = 0;
let lastBody;
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req !== 'obsidian') return origLoad.call(this, req, ...rest);
  const noop = class {};
  return {
    Plugin: noop, Modal: noop, PluginSettingTab: noop, Setting: noop, TFile: noop, MarkdownView: noop, Notice: noop,
    normalizePath: (p) => p,
    requestUrl: async (o) => {
      if (live) {
        const r = await fetch(o.url, { method: o.method || 'GET', headers: { ...o.headers, 'content-type': o.contentType }, body: o.body });
        let json = {}; try { json = JSON.parse(await r.text()); } catch {}
        return { status: r.status, json };
      }
      const body = JSON.parse(o.body || '{}');
      if (o.url.endsWith('/api/ai/generate')) { lastBody = body; return { status: 200, json: { code: 0, data: { id: 't1', status: 'pending' } } }; }
      if (o.url.endsWith('/api/user/get-user-credits')) return { status: 200, json: { code: 0, data: { remainingCredits: 42 } } };
      return { status: 200, json: { code: 0, data: polls++ ? { id: 't1', status: 'success', videos: ['https://cdn/x.mp4'] } : { id: 't1', status: 'processing' } } };
    },
  };
};
const assert = require('assert');
const { runVideo, credits, explain } = require('../main.js');

(async () => {
  if (live) {
    await assert.rejects(credits('sk-wrongkey000'), (e) => e.kind === 'auth');
    await assert.rejects(runVideo('smoke test', { apiKey: 'sk-wrongkey000' }), (e) => e.kind === 'auth');
    console.log('live: wrong key -> auth on credits and generate');
    return;
  }
  assert.strictEqual(await runVideo('x', { apiKey: 'sk', image: 'https://i/p.jpg', duration: 6, ratio: '9:16', pollEveryMs: 0 }), 'https://cdn/x.mp4');
  assert.deepStrictEqual(lastBody.options, { sound: true, duration: 6, aspect_ratio: '9:16', image_input: ['https://i/p.jpg'] });
  assert.strictEqual(lastBody.scene, 'image-to-video');
  assert.strictEqual(lastBody.model, 'minimax-h3');
  assert.strictEqual(await credits('sk'), 42);
  await assert.rejects(runVideo('x', { apiKey: '' }), (e) => e.kind === 'auth');
  assert.strictEqual(explain(401).kind, 'auth');
  assert.strictEqual(explain(200, { code: -1, message: 'x', data: { reason: 'plan_required' } }).kind, 'plan');
  assert.strictEqual(explain(200, { code: -1, message: 'x', data: { reason: 'insufficient_credits' } }).kind, 'quota');
  assert.strictEqual(explain(200, { code: -1, message: 'x', data: { reason: 'concurrency' } }).kind, 'busy');
  assert.strictEqual(explain(200, { code: -2, message: 'blocked' }).kind, 'rejected');
  console.log('all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
