const STEP = 1000 / 60;
const TAU = Math.PI * 2;

/** Matter owns both motion and collisions; the DOM only renders its positions. */
export class PackingWorld {
  constructor(container, items, { onInspect, onToggle } = {}) {
    if (!container || !window.Matter) {
      throw new Error('PackingWorld needs a container and Matter.js.');
    }
    this.container = container;
    this.M = window.Matter;
    this.onInspect = onInspect;
    this.onToggle = onToggle;
    this.records = new Map();
    this.selectedIds = [];
    this.walls = [];
    this.drag = null;
    this.destroyed = false;
    this.frame = 0;
    this.previousTime = 0;
    this.accumulator = 0;
    this.simulationTime = 0;
    this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = this.motionQuery.matches;
    this.engine = this.M.Engine.create({ enableSleeping: true });
    this.engine.gravity.y = 1.65;
    this.engine.positionIterations = 8;
    this.engine.velocityIterations = 8;
    this._measure();
    this._makeWalls();

    const uniqueItems = Array.from(new Map(items.map(item => [item.id, item])).values());
    uniqueItems.forEach((item, index) => this._addItem(item, index));
    this._arrangePile(true);

    this._onMotionChange = event => {
      this.reducedMotion = event.matches;
      for (const record of this.records.values()) {
        record.body.restitution = this.reducedMotion ? 0 : record.bounce;
        record.body.frictionAir = this.reducedMotion ? 0.08 : 0.012;
      }
      if (this.reducedMotion) this._settleImmediately();
    };
    this.motionQuery.addEventListener?.('change', this._onMotionChange);
    this.resizeObserver = new ResizeObserver(() => this._resize());
    this.resizeObserver.observe(container);
    this._tick = this._tick.bind(this);
    this._render();
    this.frame = requestAnimationFrame(this._tick);
  }

  _measure() {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(1, rect.width || this.container.clientWidth || 360);
    this.height = Math.max(1, rect.height || this.container.clientHeight || 390);
    this.size = this.width < 600 ? 44 : 54;
    // The soft pile uses tighter collision shapes than the emoji glyph's box.
    this.radius = this.size * 0.35;
  }

  _makeWalls() {
    const { Bodies, Composite } = this.M;
    for (const wall of this.walls) Composite.remove(this.engine.world, wall);
    const wallOptions = { isStatic: true, friction: 0.7, collisionFilter: { category: 4, mask: 1 | 2 } };
    const inset = this.size / 2 - this.radius;
    this.walls = [
      Bodies.rectangle(this.width / 2, this.height - inset + 25, this.width + 100, 50, wallOptions),
      Bodies.rectangle(inset - 25, this.height / 2, 50, this.height + 100, wallOptions),
      Bodies.rectangle(this.width - inset + 25, this.height / 2, 50, this.height + 100, wallOptions),
      Bodies.rectangle(this.width / 2, inset - 25, this.width + 100, 50, wallOptions),
    ];
    Composite.add(this.engine.world, this.walls);
  }

  _addItem(item, index) {
    const { Bodies, Composite } = this.M;
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'thing';
    element.title = item.name;
    element.setAttribute('aria-label', item.name);
    element.setAttribute('aria-pressed', 'false');
    element.dataset.itemId = item.id;
    Object.assign(element.style, {
      position: 'absolute', left: '0', top: '0', margin: '0',
      width: `${this.size}px`, height: `${this.size}px`,
      touchAction: 'none', userSelect: 'none', willChange: 'transform',
      zIndex: '2',
    });
    const emoji = document.createElement('span');
    emoji.className = 'thing-emoji';
    emoji.textContent = item.emoji;
    emoji.setAttribute('aria-hidden', 'true');
    Object.assign(emoji.style, { display: 'block', fontSize: this.width < 600 ? '35px' : '44px', lineHeight: '1', pointerEvents: 'none' });
    const name = document.createElement('span');
    name.className = 'thing-name';
    name.textContent = item.name;
    name.setAttribute('aria-hidden', 'true');
    Object.assign(name.style, {
      display: 'none', position: 'absolute', left: '50%', top: 'calc(100% - 2px)',
      transform: 'translateX(-50%)', width: '64px', overflow: 'hidden',
      textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '11px', lineHeight: '13px',
      pointerEvents: 'none',
    });
    element.append(emoji, name);
    const variation = ((index * 37 + 11) % 23) / 22;
    const bounce = 0.2 + variation * 0.12;
    const body = Bodies.circle(this.width / 2, this.height / 2, this.radius, {
      label: String(item.id), restitution: this.reducedMotion ? 0 : bounce,
      friction: 0.48, frictionStatic: 0.8, frictionAir: this.reducedMotion ? 0.08 : 0.012,
      density: 0.0015, sleepThreshold: 80,
      collisionFilter: { category: 1, mask: 1 | 2 | 4 },
    });
    const record = {
      item, body, element, emoji, name, index, variation, bounce,
      selected: false, target: null, attractAt: 0,
      previous: { x: body.position.x, y: body.position.y, angle: body.angle },
    };
    this.records.set(item.id, record);
    this.container.append(element);
    Composite.add(this.engine.world, body);

    element.addEventListener('pointerdown', event => this._pointerDown(event, record));
    element.addEventListener('pointermove', event => this._pointerMove(event));
    element.addEventListener('pointerup', event => this._pointerEnd(event, true));
    element.addEventListener('pointercancel', event => this._pointerEnd(event, false));
    element.addEventListener('lostpointercapture', event => this._pointerEnd(event, false));
    element.addEventListener('click', event => {
      // Pointer activation is handled on pointerup so a completed drag never clicks.
      if (event.detail === 0) this._activate(record);
    });
    element.addEventListener('dragstart', event => event.preventDefault());
  }

  _activate(record) {
    if (this.destroyed) return;
    this.onInspect?.(record.item);
    this.onToggle?.(record.item);
  }

  _point(event) {
    const rect = this.container.getBoundingClientRect();
    return {
      x: this._clamp(event.clientX - rect.left, this.size / 2, this.width - this.size / 2),
      y: this._clamp(event.clientY - rect.top, this.size / 2, this.height - this.size / 2),
    };
  }

  _pointerDown(event, record) {
    if (this.drag || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const point = this._point(event);
    this.M.Sleeping.set(record.body, false);
    const constraint = this.M.Constraint.create({
      pointA: point, bodyB: record.body,
      // Matter rotates this world-relative offset with the body from angleB.
      pointB: { x: point.x - record.body.position.x, y: point.y - record.body.position.y },
      length: 0, stiffness: 0.16, damping: 0.12,
    });
    this.drag = {
      pointerId: event.pointerId, record, constraint,
      startX: event.clientX, startY: event.clientY, moved: false,
    };
    this.M.Composite.add(this.engine.world, constraint);
    record.element.classList.add('is-dragging');
    record.element.style.zIndex = '40';
    record.element.setPointerCapture(event.pointerId);
  }

  _pointerMove(event) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 5) drag.moved = true;
    drag.constraint.pointA = this._point(event);
    this.M.Sleeping.set(drag.record.body, false);
  }

  _pointerEnd(event, activate) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.drag = null;
    this.M.Composite.remove(this.engine.world, drag.constraint);
    drag.record.element.classList.remove('is-dragging');
    drag.record.element.style.zIndex = drag.record.selected ? '20' : '2';
    if (drag.record.element.hasPointerCapture(event.pointerId)) {
      drag.record.element.releasePointerCapture(event.pointerId);
    }
    if (activate && !drag.moved) this._activate(drag.record);
  }

  /** Change the selected collection. Unknown/duplicate IDs are ignored; limit 24. */
  select(ids = []) {
    if (this.destroyed) return;
    this.selectedIds = [...new Set(ids)].filter(id => this.records.has(id)).slice(0, 24);
    const selected = new Set(this.selectedIds);
    for (const [id, record] of this.records) {
      const next = selected.has(id);
      if (next !== record.selected) {
        this.M.Sleeping.set(record.body, false);
        // Picking up or releasing changes the force, never the existing momentum.
        if (next) record.attractAt = this.simulationTime + record.variation * 0.075;
      }
      record.selected = next;
      record.body.collisionFilter.category = next ? 2 : 1;
      // Collected items can exchange slots without locking each other in the
      // wrong order, while still nudging loose items on the way out of the pile.
      record.body.collisionFilter.mask = next ? 1 | 4 : 1 | 2 | 4;
      record.element.classList.toggle('is-selected', next);
      record.element.setAttribute('aria-pressed', String(next));
      record.element.style.zIndex = this.drag?.record === record ? '40' : next ? '20' : '2';
      record.name.style.display = next ? 'block' : 'none';
      if (!next) record.target = null;
    }
    this._layoutSelection();
    if (this.reducedMotion) this._settleImmediately();
  }

  _layoutSelection() {
    const count = this.selectedIds.length;
    if (!count) return;
    const selectionWidth = Math.min(680, Math.max(66, this.width - 32));
    const columns = Math.min(count, 10, Math.max(1, Math.floor(selectionWidth / 66)));
    const rows = Math.ceil(count / columns);
    const cellWidth = Math.min(76, selectionWidth / columns);
    const pileColumns = Math.max(1, Math.floor(this.width / (this.radius * 1.85)));
    const pileRows = Math.ceil((this.records.size - count) / pileColumns);
    const pileSpace = Math.max(66, Math.min(135, pileRows * this.radius * 1.65 + this.radius * 2));
    // Leave room for the spring's small overshoot above the resting row.
    const top = 44;
    const availableBottom = Math.max(top, this.height - pileSpace - 34);
    const rowGap = rows === 1 ? 0 : Math.max(46, Math.min(70, (availableBottom - top) / (rows - 1)));
    this.selectedIds.forEach((id, index) => {
      const row = Math.floor(index / columns);
      const rowLength = Math.min(columns, count - row * columns);
      const column = index % columns;
      this.records.get(id).target = {
        x: this.width / 2 + (column - (rowLength - 1) / 2) * cellWidth,
        y: this._clamp(top + row * rowGap, this.size / 2, this.height - this.size / 2 - 16),
      };
    });
  }

  _arrangePile(initial = false) {
    const { Body, Sleeping } = this.M;
    const records = [...this.records.values()].filter(record => !record.selected);
    const columns = Math.max(1, Math.floor(this.width / (this.radius * 2.08)));
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = (column + 0.5) * (this.width / columns) + (Math.random() - 0.5) * 6;
      const y = this.height - this.radius - 3 - row * this.radius * 1.85 - (initial && !this.reducedMotion ? 38 : 0);
      Body.setPosition(record.body, { x: this._clamp(x, this.size / 2, this.width - this.size / 2), y: this._clamp(y, this.size / 2, this.height - this.size / 2) });
      Body.setVelocity(record.body, { x: this.reducedMotion ? 0 : (Math.random() - 0.5) * 1.4, y: 0 });
      Body.setAngle(record.body, (Math.random() - 0.5) * 1.1);
      Body.setAngularVelocity(record.body, 0);
      Sleeping.set(record.body, false);
    }
    if (this.reducedMotion) for (let step = 0; step < 90; step++) this._step();
    this._rememberPositions();
  }

  _rememberPositions() {
    for (const record of this.records.values()) {
      record.previous = { x: record.body.position.x, y: record.body.position.y, angle: record.body.angle };
    }
  }

  _settleImmediately() {
    // Reduced motion changes collections without a flight or falling animation.
    this._arrangePile(false);
    this._rememberPositions();
    this._render();
  }

  _wakeNeighbours(record) {
    // Matter doesn't update the motion estimate used to wake contacts while an
    // external force is applied. Otherwise a resting neighbour can pin a magnet.
    const reach = this.size + Math.min(40, record.body.speed);
    for (const other of this.records.values()) {
      if (other === record || !other.body.isSleeping) continue;
      if (Math.hypot(other.body.position.x - record.body.position.x,
        other.body.position.y - record.body.position.y) < reach) {
        this.M.Sleeping.set(other.body, false);
      }
    }
  }

  /** Clear the selection and put all items back in the suitcase pile. */
  reset() {
    if (this.destroyed) return;
    this._cancelDrag();
    this.select([]);
    this._render();
  }

  /** Give the unselected pile a little toss without changing the selected set. */
  shuffle() {
    if (this.destroyed) return;
    for (const record of this.records.values()) {
      if (record.selected) continue;
      this.M.Sleeping.set(record.body, false);
      this.M.Body.setVelocity(record.body, {
        x: (Math.random() - 0.5) * (this.reducedMotion ? 1 : 8),
        y: this.reducedMotion ? -1 : -4 - Math.random() * 6,
      });
      this.M.Body.setAngularVelocity(record.body, (Math.random() - 0.5) * (this.reducedMotion ? 0.015 : 0.1));
    }
  }

  _step() {
    const { Body, Engine, Sleeping } = this.M;
    this._rememberPositions();
    this.simulationTime += STEP / 1000;
    if (this.drag) this._wakeNeighbours(this.drag.record);
    for (const record of this.records.values()) {
      const { body, target } = record;
      if (!record.selected) continue;
      Sleeping.set(body, false);
      // A magnetic spring cancels weight but keeps contact with the other items.
      body.force.y -= body.mass * this.engine.gravity.y * this.engine.gravity.scale;
      if (this.drag?.record === record || !target) continue;
      if (this.reducedMotion) {
        Body.setPosition(body, target);
        Body.setVelocity(body, { x: 0, y: 0 });
        Body.setAngle(body, 0);
        Body.setAngularVelocity(body, 0);
        continue;
      }
      const dx = target.x - body.position.x;
      const dy = target.y - body.position.y;
      if (Math.hypot(dx, dy) > 1) this._wakeNeighbours(record);
      const age = Math.max(0, this.simulationTime - record.attractAt);
      const ramp = this._clamp(age / 0.16, 0, 1);
      const pull = ramp * ramp * (3 - 2 * ramp);
      const pace = 0.93 + record.variation * 0.14;
      // Lift first, then converge sideways. Different axis response bends the path.
      const wx = 6.8 * pace;
      const wy = 10.2 * pace;
      const vx = body.velocity.x * 60;
      const vy = body.velocity.y * 60;
      Body.applyForce(body, body.position, {
        x: body.mass * (wx * wx * dx * pull - 2 * 0.78 * wx * vx) / 1e6,
        y: body.mass * (wy * wy * dy * pull - 2 * 0.88 * wy * vy) / 1e6,
      });
      // The original tilt unwinds slowly, with a little lean from sideways motion.
      const restingAngle = (record.variation - 0.5) * 0.18;
      const desiredAngle = restingAngle + this._clamp(vx * 0.00045, -0.22, 0.22);
      const angleError = Math.atan2(Math.sin(desiredAngle - body.angle), Math.cos(desiredAngle - body.angle));
      const angularFrequency = 5.2 * pace;
      body.torque += body.inertia * (angularFrequency ** 2 * angleError * pull
        - 2 * 0.62 * angularFrequency * body.angularVelocity * 60) / 1e6;
    }
    Engine.update(this.engine, STEP);
    for (const record of this.records.values()) {
      const body = record.body;
      // The walls resolve normal impacts. Only recover bodies that escaped after
      // a violent drag or a resize; clamping every contact cancels real rebounds.
      const margin = this.size / 2;
      if (body.position.x < -this.size || body.position.x > this.width + this.size
        || body.position.y < -this.size || body.position.y > this.height + this.size) {
        Body.setPosition(body, {
          x: this._clamp(body.position.x, margin, this.width - margin),
          y: this._clamp(body.position.y, margin, this.height - margin),
        });
        Body.setVelocity(body, { x: 0, y: 0 });
      }
    }
  }

  _tick(time) {
    if (this.destroyed) return;
    const elapsed = this.previousTime ? Math.min(50, time - this.previousTime) : STEP;
    this.previousTime = time;
    this.accumulator += elapsed;
    while (this.accumulator >= STEP) {
      this._step();
      this.accumulator -= STEP;
    }
    this._render(this.accumulator / STEP);
    this.frame = requestAnimationFrame(this._tick);
  }

  _render(alpha = 1) {
    for (const { element, body, previous } of this.records.values()) {
      const x = previous.x + (body.position.x - previous.x) * alpha;
      const y = previous.y + (body.position.y - previous.y) * alpha;
      const angle = previous.angle + (body.angle - previous.angle) * alpha;
      element.style.transform = `translate3d(${(x - this.size / 2).toFixed(2)}px, ${(y - this.size / 2).toFixed(2)}px, 0) rotate(${(angle % TAU).toFixed(4)}rad)`;
    }
  }

  _resize() {
    if (this.destroyed) return;
    const oldWidth = this.width;
    const oldHeight = this.height;
    const oldRadius = this.radius;
    this._measure();
    if (oldWidth === this.width && oldHeight === this.height && oldRadius === this.radius) return;
    this._makeWalls();
    for (const record of this.records.values()) {
      if (this.radius !== oldRadius) this.M.Body.scale(record.body, this.radius / oldRadius, this.radius / oldRadius);
      this.M.Body.setPosition(record.body, {
        x: this._clamp(record.body.position.x * this.width / oldWidth, this.size / 2, this.width - this.size / 2),
        y: this._clamp(record.body.position.y + this.height - oldHeight, this.size / 2, this.height - this.size / 2),
      });
      record.element.style.width = `${this.size}px`;
      record.element.style.height = `${this.size}px`;
      record.emoji.style.fontSize = this.width < 600 ? '35px' : '44px';
      this.M.Sleeping.set(record.body, false);
    }
    this._layoutSelection();
    if (this.reducedMotion) this._settleImmediately();
    this._rememberPositions();
    this._render();
  }

  _cancelDrag() {
    if (this.drag) this._pointerEnd({ pointerId: this.drag.pointerId }, false);
  }

  _clamp(value, min, max) {
    return Math.max(min, Math.min(Math.max(min, max), value));
  }

  destroy() {
    if (this.destroyed) return;
    this._cancelDrag();
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.motionQuery.removeEventListener?.('change', this._onMotionChange);
    for (const record of this.records.values()) record.element.remove();
    this.records.clear();
    this.M.Composite.clear(this.engine.world, false);
    this.M.Engine.clear(this.engine);
  }
}
