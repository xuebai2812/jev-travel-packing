import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { ITEMS } from './travel/catalog.mjs';

const appSource = (await readFile(new URL('./travel/app.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '');
const flush = () => new Promise(resolve => setImmediate(resolve));

function createElement(id = '') {
  const listeners = new Map();
  const classes = new Set();
  const attributes = new Map();
  return {
    id, value: '', textContent: '', innerHTML: '', className: '', hidden: false,
    disabled: false, dataset: {}, style: {},
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle(value, force = !classes.has(value)) {
        if (force) classes.add(value); else classes.delete(value);
        return force;
      },
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: name => attributes.get(name),
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) {
        listener({ target: this, preventDefault() {}, ...event });
      }
    },
    focus() {}, showModal() {}, close() {},
  };
}

async function harness() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, createElement(id));
    return elements.get(id);
  };
  const window = createElement('window');
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  let world;
  class StubPackingWorld {
    constructor(_container, _items, handlers) {
      this.handlers = handlers;
      this.ids = [];
      this.selections = [];
      this.resets = 0;
      this.destroyed = false;
      world = this;
    }
    select(ids) { if (!this.destroyed) { this.ids = Array.from(ids); this.selections.push(this.ids); } }
    reset() { if (!this.destroyed) { this.ids = []; this.resets++; } }
    shuffle() {}
    destroy() { this.destroyed = true; this.ids = []; }
    click(id) {
      assert.equal(this.destroyed, false, 'the playground must remain interactive');
      this.handlers.onToggle(ITEMS.find(item => item.id === id));
    }
  }
  const context = vm.createContext({
    ITEMS, PackingWorld: StubPackingWorld, AbortController,
    document: { getElementById: element, querySelectorAll: () => [] },
    window, navigator: { clipboard: { writeText: async () => {} } },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch(url, options) {
      if (url === '/api/health') return Promise.resolve({ ok: true, json: async () => ({ configured: true }) });
      assert.equal(url, '/api/pack', 'tests must never make external network requests');
      // Deliberately let an aborted request resolve: stale responses must also be ignored.
      return new Promise(resolve => requests.push({ options, resolve }));
    },
  });
  vm.runInContext(appSource, context, { filename: 'travel/app.mjs' });
  await flush();
  return {
    element, world, window, requests,
    async input(trip) { element('tripInput').value = trip; element('tripInput').dispatch('input'); await flush(); },
    async submit() { element('tripForm').dispatch('submit'); await flush(); },
    async respond(index, ids) {
      const request = requests[index];
      assert.ok(request, `packing request ${index} exists`);
      const { trip } = JSON.parse(request.options.body);
      request.resolve({ ok: true, json: async () => ({ trip, selected: ids.map(id => ({ id, probability: .9 })), assumed_month: 9, month_source: 'current' }) });
      await flush();
    },
    async fail(index, message) {
      const request = requests[index];
      assert.ok(request, `packing request ${index} exists`);
      request.resolve({ ok: false, json: async () => ({ error: message }) });
      await flush();
    },
    pack(id) {
      const row = createElement();
      element('packingList').dispatch('change', { target: { dataset: { pack: id }, checked: true, closest: () => row } });
    },
  };
}

test('editing a trip keeps its floating items until the next result replaces them together', async () => {
  const ui = await harness();
  await ui.input('去杭州三天');
  await ui.submit();
  await ui.respond(0, ['passport', 'phone']);
  ui.pack('phone');
  const resets = ui.world.resets;
  const transitions = ui.world.selections.length;

  await ui.input('去杭州三天，改成一周');
  await ui.submit();

  assert.deepEqual(ui.world.ids, ['passport', 'phone']);
  assert.equal(ui.world.resets, resets, 'typing and loading must not release floating bodies');
  assert.equal(ui.world.selections.length, transitions, 'typing must not restart an existing flight');
  assert.equal(ui.element('progressText').textContent, '1 / 2 件已装好');
  assert.equal(ui.element('drawerTrip').textContent, '去杭州三天', 'the retained list still describes its original trip');

  await ui.respond(1, ['phone', 'sunglasses']);

  assert.deepEqual(ui.world.ids, ['phone', 'sunglasses']);
  assert.equal(ui.world.resets, resets, 'replacement must not empty the world before selecting');
  assert.equal(ui.world.selections.length, transitions + 1, 'apply the complete new membership in one transition');
  assert.equal(ui.element('drawerTrip').textContent, '去杭州三天，改成一周');
});

test('clearing a changed trip immediately releases the retained selection and ignores pending results', async () => {
  const ui = await harness();
  await ui.input('去杭州三天');
  await ui.submit();
  await ui.respond(0, ['passport', 'phone']);
  await ui.input('去三亚五天');
  await ui.submit();
  const resets = ui.world.resets;

  await ui.input('');

  assert.deepEqual(ui.world.ids, []);
  assert.equal(ui.world.resets, resets + 1);
  assert.equal(ui.requests[1].options.signal.aborted, true);
  assert.equal(ui.element('progressText').textContent, '0 / 0 件已装好');
  await ui.respond(1, ['sunglasses']);
  assert.deepEqual(ui.world.ids, [], 'a cleared input must stay empty after a late response');
});

test('a failed revised trip retains the previous selection and reports the failure', async () => {
  const ui = await harness();
  await ui.input('去杭州三天');
  await ui.submit();
  await ui.respond(0, ['passport']);
  ui.pack('passport');
  await ui.input('去三亚五天');
  await ui.submit();
  await ui.fail(1, '暂时无法整理，请重试。');

  assert.deepEqual(ui.world.ids, ['passport']);
  assert.equal(ui.element('progressText').textContent, '1 / 1 件已装好');
  assert.match(ui.element('selectionCaption').className, /error/);
  assert.equal(ui.element('statusText').textContent, '暂时无法整理，请重试。');
  assert.equal(ui.element('drawerTrip').textContent, '去杭州三天');
});

test('returning to the displayed trip cancels a revision request without moving its items', async () => {
  const ui = await harness();
  await ui.input('去杭州三天');
  await ui.submit();
  await ui.respond(0, ['passport']);
  ui.pack('passport');
  await ui.input('去三亚五天');
  await ui.submit();

  await ui.input('去杭州三天');
  await ui.respond(1, ['sunglasses']);

  assert.equal(ui.requests[1].options.signal.aborted, true);
  assert.deepEqual(ui.world.ids, ['passport']);
  assert.equal(ui.element('progressText').textContent, '1 / 1 件已装好');
  assert.equal(ui.element('tripForm').getAttribute('aria-busy'), 'false');
  assert.match(ui.element('selectionCaption').className, /success/);
  assert.equal(ui.requests.length, 2, 'returning to the displayed trip requires no extra model request');
});

test('resubmitting the successful unchanged trip preserves manual choices and packed progress', async () => {
  const ui = await harness();
  await ui.input('去杭州三天');
  await ui.submit();
  await ui.respond(0, ['passport']);
  ui.world.click('phone');
  ui.pack('passport');
  assert.equal(ui.element('progressText').textContent, '1 / 2 件已装好');

  await ui.submit();

  assert.deepEqual(ui.world.ids, ['passport', 'phone']);
  assert.equal(ui.element('progressText').textContent, '1 / 2 件已装好');
  assert.equal(ui.requests.length, 1, 'an unchanged successful trip needs no new request');
});

test('manual selection while loading cancels the request and ignores its late result', async () => {
  const ui = await harness();
  await ui.input('去杭州三天');
  await ui.submit();
  assert.equal(ui.element('tripForm').getAttribute('aria-busy'), 'true');

  ui.world.click('phone');
  const aborted = ui.requests[0].options.signal.aborted;
  await ui.respond(0, ['passport']);

  assert.equal(aborted, true, 'manual selection cancels the automatic request');
  assert.deepEqual(ui.world.ids, ['phone'], 'a late model response cannot replace the manual choice');
  assert.equal(ui.element('tripForm').getAttribute('aria-busy'), 'false');
  assert.equal(ui.element('progressText').textContent, '0 / 1 件已装好');
});

test('a persisted pagehide preserves the playground and packing progress after pageshow', async () => {
  const ui = await harness();
  ui.world.click('phone');
  ui.pack('phone');

  ui.window.dispatch('pagehide', { persisted: true });
  ui.window.dispatch('pageshow', { persisted: true });

  assert.equal(ui.world.destroyed, false, 'BFCache restoration must not reuse a destroyed world');
  assert.deepEqual(ui.world.ids, ['phone']);
  assert.equal(ui.element('progressText').textContent, '1 / 1 件已装好');
  ui.world.click('passport');
  assert.deepEqual(ui.world.ids, ['phone', 'passport']);
});

test('restoring a persisted page recovers from an interrupted loading state', async () => {
  const ui = await harness();
  await ui.input('去杭州三天');
  await ui.submit();
  assert.match(ui.element('selectionCaption').className, /loading/);

  ui.window.dispatch('pagehide', { persisted: true });
  ui.window.dispatch('pageshow', { persisted: true });
  await ui.respond(0, ['passport']);

  assert.equal(ui.requests[0].options.signal.aborted, true);
  assert.equal(ui.element('tripForm').getAttribute('aria-busy'), 'false');
  assert.doesNotMatch(ui.element('selectionCaption').className, /loading/, 'cancelled loading must leave a usable status');
  assert.equal(ui.world.destroyed, false);
  assert.deepEqual(ui.world.ids, [], 'the cancelled request stays stale after restoration');
});

test('manual selection never exceeds 24 items and adding works after removing one', async () => {
  const ui = await harness();
  for (const item of ITEMS.slice(0, 25)) ui.world.click(item.id);

  assert.equal(ui.world.ids.length, 24);
  assert.equal(Number(ui.element('navCount').textContent), 24);
  assert.equal(ui.world.ids.includes(ITEMS[24].id), false);
  assert.match(ui.element('toast').textContent, /24/);

  ui.world.click(ITEMS[0].id);
  ui.world.click(ITEMS[24].id);
  assert.equal(ui.world.ids.length, 24);
  assert.equal(ui.world.ids.includes(ITEMS[0].id), false);
  assert.equal(ui.world.ids.includes(ITEMS[24].id), true);
});
