import { test } from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { ITEMS } from './travel/catalog.mjs';
import { PackingWorld } from './travel/physics.mjs';

function element() {
  const listeners = new Map();
  const classes = new Set();
  const attributes = new Map();
  const captured = new Set();
  return {
    style: {}, dataset: {}, children: [],
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      toggle(name, enabled = !classes.has(name)) {
        if (enabled) classes.add(name); else classes.delete(name);
      },
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: name => attributes.get(name),
    append(...children) { this.children.push(...children); },
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
    dispatch(name, event = {}) {
      for (const listener of listeners.get(name) || []) {
        listener({ target: this, preventDefault() {}, ...event });
      }
    },
    setPointerCapture: id => captured.add(id),
    hasPointerCapture: id => captured.has(id),
    releasePointerCapture: id => captured.delete(id),
    remove() {},
  };
}

function harness(t, { width = 1200, height = 540, items = ITEMS, reducedMotion = false, ...handlers } = {}) {
  const dimensions = { width, height, left: 18, top: 24 };
  const container = element();
  container.getBoundingClientRect = () => ({ ...dimensions });
  const globals = ['window', 'document', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const originals = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  globalThis.window = {
    Matter,
    matchMedia: () => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} }),
  };
  globalThis.document = { createElement: element };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};

  // Reproducible initial pile; the simulation itself uses the real Matter solver.
  const originalRandom = Math.random;
  let seed = 43;
  Math.random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let world;
  try { world = new PackingWorld(container, items, handlers); }
  finally { Math.random = originalRandom; }
  t.after(() => {
    world.destroy();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return { world, dimensions };
}

const advance = (world, frames) => {
  for (let frame = 0; frame < frames; frame++) world._step();
};
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const speed = body => Math.hypot(body.velocity.x, body.velocity.y);
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} versus ${expected}`);

function assertContained(world) {
  for (const { body, item } of world.records.values()) {
    assert.ok(Number.isFinite(body.position.x) && Number.isFinite(body.position.y) && Number.isFinite(body.angle), `${item.id} has a finite pose`);
    assert.ok(body.position.x >= 0 && body.position.x <= world.width, `${item.id} stays within horizontal bounds`);
    assert.ok(body.position.y >= 0 && body.position.y <= world.height, `${item.id} stays within vertical bounds`);
  }
}

test('selecting and releasing an item preserve its existing linear and angular momentum', t => {
  const { world } = harness(t, { items: ITEMS.slice(0, 1) });
  const record = world.records.get(ITEMS[0].id);
  Matter.Body.setPosition(record.body, { x: 300, y: 300 });
  Matter.Body.setAngle(record.body, 2.3);
  for (const ids of [[record.item.id], []]) {
    Matter.Body.setVelocity(record.body, { x: 5, y: -4 });
    Matter.Body.setAngularVelocity(record.body, 0.08);
    const before = { ...record.body.velocity, angular: record.body.angularVelocity };
    world.select(ids);
    close(record.body.velocity.x, before.x, 'horizontal momentum survives selection changes');
    close(record.body.velocity.y, before.y, 'vertical momentum survives selection changes');
    close(record.body.angularVelocity, before.angular, 'angular momentum survives selection changes');
  }
});

test('dragging attaches the constraint at the actual clicked point on a rotated item', t => {
  const { world, dimensions } = harness(t, { items: ITEMS.slice(0, 1) });
  const record = world.records.get(ITEMS[0].id);
  Matter.Body.setPosition(record.body, { x: 300, y: 300 });
  Matter.Body.setAngle(record.body, 0.6);
  const point = { x: 312, y: 294 };
  record.element.dispatch('pointerdown', {
    pointerId: 1, pointerType: 'mouse', button: 0,
    clientX: point.x + dimensions.left, clientY: point.y + dimensions.top,
  });
  assert.ok(world.drag, 'pointer down starts a drag');
  const attached = Matter.Constraint.pointBWorld(world.drag.constraint);
  close(attached.x, point.x, 'constraint horizontal anchor matches the clicked point');
  close(attached.y, point.y, 'constraint vertical anchor matches the clicked point');
  record.element.dispatch('pointercancel', { pointerId: 1 });
  assert.equal(world.drag, null, 'cancelling a drag releases its constraint');
});

test('rising items accelerate, follow a curved path, and slow down near their target', t => {
  const { world } = harness(t, { items: ITEMS.slice(0, 1) });
  const record = world.records.get(ITEMS[0].id);
  const origin = { x: 80, y: 460 };
  Matter.Body.setPosition(record.body, origin);
  Matter.Body.setVelocity(record.body, { x: 0, y: 0 });
  Matter.Body.setAngularVelocity(record.body, 0);
  world.select([record.item.id]);
  const target = { ...record.target };
  const length = distance(origin, target);
  const samples = [];
  for (let frame = 0; frame < 360; frame++) {
    world._step();
    samples.push({ position: { ...record.body.position }, speed: speed(record.body), remaining: distance(record.body.position, target) });
  }
  const moving = samples.filter(sample => sample.remaining > length * 0.1);
  const peak = Math.max(...moving.map(sample => sample.speed));
  const beginning = moving.find(sample => sample.speed > 0.05);
  assert.ok(beginning && peak > beginning.speed * 1.5, 'the rise gains speed after starting instead of immediately cruising at a cap');
  const approaching = samples.find(sample => sample.remaining < length * 0.05);
  assert.ok(approaching && approaching.speed < peak * 0.65, 'the item decelerates before reaching its target');
  const deviations = samples.filter(sample => sample.remaining > length * 0.15 && sample.remaining < length * 0.85)
    .map(({ position }) => Math.abs((target.x - origin.x) * (position.y - origin.y) - (target.y - origin.y) * (position.x - origin.x)) / length);
  assert.ok(Math.max(...deviations) > 8, 'the rise bends visibly instead of following a straight diagonal');
  assert.ok(distance(record.body.position, target) < 6, 'the item ultimately settles at its assigned target');
});

test('released items fall into the real pile, collide with other items, and remain contained', t => {
  const { world } = harness(t);
  advance(world, 600);
  const record = world.records.get(ITEMS[0].id);
  world.select([record.item.id]);
  advance(world, 600);
  assert.ok(distance(record.body.position, record.target) < 6, 'selected item settles near its target');
  assert.ok(speed(record.body) < 0.3, 'selected item comes to rest');
  let hitPile = false;
  Matter.Events.on(world.engine, 'collisionStart', ({ pairs }) => {
    for (const pair of pairs) {
      const other = pair.bodyA === record.body ? pair.bodyB : pair.bodyB === record.body ? pair.bodyA : null;
      if (other && !other.isStatic) hitPile = true;
    }
  });
  world.select([]);
  let fastestFall = 0;
  for (let frame = 0; frame < 900; frame++) {
    world._step();
    fastestFall = Math.max(fastestFall, record.body.velocity.y);
    assertContained(world);
  }
  assert.ok(fastestFall > 1, 'gravity builds downward momentum after release');
  assert.ok(hitPile, 'the released item collides with other loose items');
  assert.ok(record.body.position.y > world.height * 0.55, 'the item returns to the pile');
  assert.ok(speed(record.body) < 0.3, 'the pile settles after impact');
});

test('a full travel selection can lift every item out of a sleeping desktop pile', t => {
  const { world } = harness(t, { width: 1280, height: 605 });
  const records = [...world.records.values()];
  for (let frame = 0; frame < 1800 && !records.every(record => record.body.isSleeping); frame++) {
    world._step();
  }
  assert.ok(records.every(record => record.body.isSleeping), 'the entire initial pile is asleep before selection');
  const ids = [
    'id_card', 'bank_card', 'tickets', 'backpack', 't_shirt', 'shorts',
    'underwear', 'pajamas', 'sandals', 'hat', 'toothbrush', 'toothpaste',
    'sunscreen', 'skincare', 'tissues', 'medication', 'phone', 'charger',
    'power_bank', 'sunglasses', 'water_bottle', 'swimsuit', 'swim_goggles', 'beach_towel',
  ];
  world.select(ids);
  advance(world, 360);
  const trapped = ids.map(id => world.records.get(id))
    .filter(record => distance(record.body.position, record.target) >= 8)
    .map(record => `${record.item.id} (${distance(record.body.position, record.target).toFixed(1)} px from target)`);
  assert.deepEqual(trapped, [], 'sleeping neighbors must not pin selected items inside the pile');
  assertContained(world);
});

test('mobile selection caps at 24 unique known items and remains stable after resize', t => {
  const { world, dimensions } = harness(t, { width: 390, height: 620 });
  world.select(['unknown-item', ITEMS[0].id, ...ITEMS.map(item => item.id), ITEMS[0].id]);
  assert.equal(world.selectedIds.length, 24);
  assert.equal(new Set(world.selectedIds).size, 24);
  assert.ok(world.selectedIds.every(id => world.records.has(id)));
  advance(world, 480);
  dimensions.width = 320;
  dimensions.height = 520;
  world._resize();
  for (let frame = 0; frame < 600; frame++) {
    world._step();
    assertContained(world);
  }
  for (const id of world.selectedIds) {
    const record = world.records.get(id);
    assert.ok(distance(record.body.position, record.target) < 12, `${id} reaches its resized target`);
    assert.equal(record.element.getAttribute('aria-pressed'), 'true');
  }
});

test('reduced motion settles a full mobile selection and can safely release it', t => {
  const { world } = harness(t, { width: 390, height: 520, reducedMotion: true });
  world.select(ITEMS.slice(0, 24).map(item => item.id));
  advance(world, 360);
  assertContained(world);
  for (const id of world.selectedIds) {
    const record = world.records.get(id);
    assert.ok(distance(record.body.position, record.target) < 12, `${id} settles in reduced-motion mode`);
    assert.ok(speed(record.body) < 0.5, `${id} avoids ongoing movement in reduced-motion mode`);
  }
  world.reset();
  advance(world, 900);
  assertContained(world);
  assert.equal(world.selectedIds.length, 0);
});

test('keyboard activation remains available and a completed pointer drag does not toggle an item', t => {
  const toggled = [];
  const { world, dimensions } = harness(t, { items: ITEMS.slice(0, 1), onToggle: item => toggled.push(item.id) });
  const record = world.records.get(ITEMS[0].id);
  record.element.dispatch('click', { detail: 0 });
  assert.deepEqual(toggled, [record.item.id]);
  Matter.Body.setPosition(record.body, { x: 300, y: 300 });
  record.element.dispatch('pointerdown', { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 300 + dimensions.left, clientY: 300 + dimensions.top });
  record.element.dispatch('pointermove', { pointerId: 2, clientX: 330 + dimensions.left, clientY: 280 + dimensions.top });
  world._step();
  record.element.dispatch('pointerup', { pointerId: 2 });
  record.element.dispatch('click', { detail: 1 });
  assert.deepEqual(toggled, [record.item.id], 'dragging never activates or toggles the item');
  assert.equal(world.drag, null);
});
