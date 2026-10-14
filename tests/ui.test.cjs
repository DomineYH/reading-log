/* UI behavior smoke tests with a deliberately small DOM fixture.
 * These test application logic, not layout, native form validation, or browser APIs.
 * Real Chromium QA was attempted but blocked by this environment's socket policy.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../apps-script/Index.html'), 'utf8');
const code = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

function mount({ demo = false, handlers = {} } = {}) {
  const all = [], ids = new Map(), timeouts = [], calls = [], confirmations = [];
  class Node {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.handlers = {}; this.attributes = {}; this.dataset = {}; this.value = ''; this.hidden = false; this.disabled = false; this.className = ''; this._text = ''; all.push(this); }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(_) { throw new Error('Untrusted innerHTML must not be used'); }
    append(...nodes) { this.children.push(...nodes.flatMap(node => node.tagName === '#FRAGMENT' ? node.children : [node])); }
    replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key]; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(event, handler) { (this.handlers[event] ||= []).push(handler); }
    async fire(event) { for (const handler of this.handlers[event] || []) await handler({ preventDefault() {} }); }
    focus() {} scrollIntoView() {} reportValidity() { return true; }
    reset() {
      const fields = this.id === 'loginForm' ? ['studentName','password'] : ['bookTitle','publisher','startDate','finishDate','pages','impressions'];
      fields.forEach(id => { ids.get(id).value = ''; });
    }
  }
  for (const match of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    const attrs = match[2], id = attrs.match(/\bid="([^"]+)"/), filter = attrs.match(/\bdata-filter="([^"]+)"/);
    if (!id && !filter) continue;
    const node = new Node(match[1]);
    if (id) { node.id = id[1]; ids.set(node.id, node); }
    if (filter) node.dataset.filter = filter[1];
    node.className = (attrs.match(/\bclass="([^"]*)"/) || [,''])[1];
    node.hidden = /\bhidden(?:\s|$)/.test(attrs); node.disabled = /\bdisabled(?:\s|$)/.test(attrs);
  }
  const document = {
    getElementById: id => { if (!ids.has(id)) throw new Error('Missing node ' + id); return ids.get(id); },
    createElement: tag => new Node(tag), createDocumentFragment: () => new Node('#fragment'),
    createTextNode: text => { const node = new Node('#text'); node.textContent = text; return node; },
    querySelectorAll(selector) { if (selector === '[data-filter]') return all.filter(node => node.dataset.filter); const classes = selector.split(',').map(s => s.trim().slice(1)); return all.filter(node => classes.some(c => node.className.split(/\s+/).includes(c))); }
  };
  const journal = { records: [], totalPages: 0, completedCount: 0 };
  const defaultHandlers = {
    getLoginChallenge: () => ({ salt: 'ab'.repeat(16), iterations: 600000 }),
    login: () => ({ token: 't'.repeat(72), name: '가상 학생' }),
    getJournal: () => structuredClone(journal),
    logout: () => true
  };
  const run = { withSuccessHandler(success) { return { withFailureHandler(failure) { return new Proxy({}, { get(_, method) { return (...args) => {
    const call = { method, args, success, failure }; calls.push(call);
    const handler = handlers[method] || defaultHandlers[method];
    if (!handler) throw new Error('Unexpected call ' + method);
    queueMicrotask(() => { try { const result = handler(...args); if (result !== mount.PENDING) success(result); } catch (error) { failure(error); } });
  }; } }); } }; } };
  let random = 0;
  const crypto = { getRandomValues: data => data.fill(7), randomUUID: () => '00000000-0000-4000-8000-' + String(++random).padStart(12, '0'), subtle: { importKey: async () => ({}), deriveBits: async () => new Uint8Array(32).buffer } };
  const window = { document, crypto, TextEncoder, location: { search: demo ? '?demo=1' : '', href: '' }, confirm: text => { confirmations.push(text); return true; } };
  if (!demo) window.google = { script: { run } };
  const context = { window, document, google: window.google, crypto, TextEncoder, URLSearchParams, Intl, Date, Uint8Array, console, setTimeout: (fn, delay) => { if (delay === 45000) { const timer = { fn, cleared: false }; timeouts.push(timer); return timer; } return setTimeout(fn, 0); }, clearTimeout: timer => { timer.cleared = true; } };
  vm.runInNewContext(code, context, { filename: 'Index.html' });
  const el = id => ids.get(id);
  async function login() { el('studentName').value = '가상 학생'; el('password').value = 'demo-password'; await el('loginForm').fire('submit'); }
  function input({ title = '테스트 책', startDate = '2026-01-01', finishDate = '', pages = '100', publisher = '', impressions = '' } = {}) {
    Object.entries({ bookTitle: title, startDate, finishDate, pages, publisher, impressions }).forEach(([id,value]) => { el(id).value = value; });
  }
  return { el, all, calls, timeouts, login, input, journal, confirmations, window };
}
mount.PENDING = Symbol('pending');

const sample = () => ({ id: 'r1', title: '가상 책', publisher: '가상 출판사', startDate: '2026-01-01', finishDate: '', pages: 100, impressions: '<img src=x onerror=alert(1)>', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' });

test('login uses derived proof, clears password, and renders server-owned all-record total', async () => {
  const app = mount({ handlers: { getJournal: () => ({ records: [sample()], totalPages: 100, completedCount: 0 }) } });
  await app.login();
  const call = app.calls.find(c => c.method === 'login');
  assert.match(call.args[1], /^[a-f0-9]{64}$/); assert.notEqual(call.args[1], 'demo-password');
  assert.equal(app.el('password').value, ''); assert.equal(app.el('journalView').hidden, false);
  assert.equal(app.el('totalPages').textContent, '100쪽'); assert.equal(app.el('completedCount').textContent, '0권');
  assert.ok(app.el('recordsList').textContent.includes('<img src=x onerror=alert(1)>'));
});

test('save blocks repeat submits and reuses immutable request on ambiguous failure', async () => {
  let attempts = 0;
  const app = mount({ handlers: { saveRecord: (_token, payload) => { attempts++; if (attempts === 1) throw new Error('NETWORK'); return { records: [{ ...payload, id: 'r2', createdAt: '2026-01-01' }], totalPages: payload.pages, completedCount: 0 }; } } });
  await app.login(); app.input();
  const first = app.el('recordForm').fire('submit'); const repeated = app.el('recordForm').fire('submit'); await Promise.all([first, repeated]);
  assert.equal(attempts, 1); assert.equal(app.el('recordFields').disabled, true); assert.equal(app.el('pendingNotice').hidden, false);
  app.el('bookTitle').value = 'tampered draft'; await app.el('recordForm').fire('submit');
  const saves = app.calls.filter(c => c.method === 'saveRecord');
  assert.equal(saves[0].args[1].requestId, saves[1].args[1].requestId); assert.equal(saves[1].args[1].title, '테스트 책');
  assert.equal(app.el('recordFields').disabled, false); assert.equal(app.el('bookTitle').value, '');
});

test('edit sends record id and original updatedAt, then returns to new-entry mode', async () => {
  const record = sample();
  const app = mount({ handlers: { getJournal: () => ({ records: [record], totalPages: 100, completedCount: 0 }), updateRecord: (_token, id, payload) => ({ records: [{ ...record, ...payload, id, updatedAt: '2026-01-03' }], totalPages: payload.pages, completedCount: 1 }) } });
  await app.login(); await app.all.find(node => node.className === 'edit-button').fire('click');
  app.el('finishDate').value = '2026-01-02'; await app.el('recordForm').fire('submit');
  const edit = app.calls.find(c => c.method === 'updateRecord');
  assert.equal(edit.args[1], 'r1'); assert.equal(edit.args[2].expectedUpdatedAt, record.updatedAt); assert.equal(edit.args[2].finishDate, '2026-01-02');
  assert.equal(app.el('cancelEditButton').hidden, true); assert.equal(app.el('completedCount').textContent, '1권');
});

test('conflicting edit releases uncertain lock but requires cancel and refresh', async () => {
  const app = mount({ handlers: { getJournal: () => ({ records: [sample()], totalPages: 100, completedCount: 0 }), updateRecord: () => { throw new Error('CONFLICT'); } } });
  await app.login(); await app.all.find(node => node.className === 'edit-button').fire('click'); await app.el('recordForm').fire('submit');
  assert.equal(app.el('pendingNotice').hidden, true); assert.equal(app.el('saveButton').disabled, true); assert.equal(app.el('cancelEditButton').disabled, false);
  await app.el('cancelEditButton').fire('click'); assert.equal(app.el('saveButton').disabled, false);
});

test('logout immediately clears data and ignores a late save response', async () => {
  const app = mount({ handlers: { saveRecord: () => mount.PENDING } });
  await app.login(); app.input(); const savePromise = app.el('recordForm').fire('submit'); await pause();
  await app.el('logoutButton').fire('click');
  assert.equal(app.el('recordsList').textContent, ''); assert.equal(app.el('loginView').hidden, false); assert.equal(app.el('accountName').textContent, '');
  app.calls.find(c => c.method === 'saveRecord').success({ records: [sample()], totalPages: 100, completedCount: 0 }); await savePromise;
  assert.equal(app.el('journalView').hidden, true); assert.equal(app.el('recordsList').textContent, '');
});

test('client validation blocks reversed dates and invalid page counts before backend', async () => {
  const app = mount(); await app.login();
  app.input({ startDate: '2026-01-02', finishDate: '2026-01-01' }); await app.el('recordForm').fire('submit');
  assert.match(app.el('saveError').textContent, /빠를 수 없어요/);
  app.input({ pages: '0' }); await app.el('recordForm').fire('submit'); assert.match(app.el('saveError').textContent, /정수/);
  assert.equal(app.calls.filter(c => c.method === 'saveRecord').length, 0);
});

test('synthetic demo has no backend calls, marks fake data, and resets on reload', async () => {
  const app = mount({ demo: true });
  assert.equal(app.el('demoBanner').hidden, false); assert.equal(app.el('loginView').hidden, true); assert.equal(app.el('totalPages').textContent, '296쪽');
  app.input({ title: '체험 추가', pages: '10' }); await app.el('recordForm').fire('submit');
  assert.equal(app.el('totalPages').textContent, '306쪽'); assert.equal(app.calls.length, 0);
  const reload = mount({ demo: true }); assert.equal(reload.el('totalPages').textContent, '296쪽');
});

test('launcher never accepts untrusted destinations and app never persists student data', () => {
  const landing = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(landing.includes('rel="noopener noreferrer"')); assert.ok(landing.includes('apps-script/Index.html?demo=1'));
  assert.equal(/localStorage|sessionStorage|document\.cookie/.test(code), false);
  assert.equal(/\bfetch\s*\(|<iframe\b|<form\b/.test(landing), false);
});

test('ambiguous save then RATE_LIMIT preserves requestId for every retry', async () => {
  let attempts = 0;
  const app = mount({ handlers: { saveRecord: (_token, payload) => { attempts++; if (attempts === 1) throw new Error('TIMEOUT'); if (attempts === 2) throw new Error('RATE_LIMIT: wait'); return { records: [{ ...payload, id: 'once' }], totalPages: payload.pages, completedCount: 0 }; } } });
  await app.login(); app.input();
  await app.el('recordForm').fire('submit'); await app.el('recordForm').fire('submit');
  assert.equal(app.el('pendingNotice').hidden, false); assert.equal(app.el('recordFields').disabled, true);
  await app.el('recordForm').fire('submit');
  const ids = app.calls.filter(c => c.method === 'saveRecord').map(c => c.args[1].requestId);
  assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 1);
});

test('delete asks for confirmation and refreshes counters from response', async () => {
  const app = mount({ handlers: { getJournal: () => ({ records: [sample()], totalPages: 100, completedCount: 0 }), deleteRecord: () => ({ records: [], totalPages: 0, completedCount: 0 }) } });
  await app.login(); await app.all.find(node => node.className === 'delete-button').fire('click');
  assert.equal(app.confirmations.length, 1); assert.match(app.confirmations[0], /가상 책/);
  assert.equal(app.calls.find(c => c.method === 'deleteRecord').args[1], 'r1'); assert.equal(app.el('totalPages').textContent, '0쪽');
});
