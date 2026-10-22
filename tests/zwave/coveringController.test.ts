import {
  CoveringConfig,
  CoveringState,
  Effect,
  Event,
  PROBE_WINDOW_MS,
  RECONCILE_CEILING_MS,
  RECONCILE_MAX_MS,
  STALL_WINDOW_MS,
  initialState,
  liveIntent,
  project,
  reduce,
} from '../../src/zwave/coveringController';

const NO_DEBOUNCE: CoveringConfig = { debounceMs: 0 };
const DEBOUNCE: CoveringConfig = { debounceMs: 300 };
const GAP: CoveringConfig = { debounceMs: 300, minGapMs: 1500 };

/** Replays events, deep-freezing every state first so a transition that mutates its input throws. */
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as object).forEach(freeze);
  }

  return value;
}

class Harness {
  state: CoveringState = initialState();
  effects: Effect[] = [];
  now = 1_000;
  private requests = 100;

  constructor(readonly config: CoveringConfig) {}

  send(event: Event): Effect[] {
    freeze(this.state);
    const step = reduce(this.config, this.state, event);
    this.state = step.state;
    this.effects = step.effects;

    return step.effects;
  }

  at(deltaMs: number): this {
    this.now += deltaMs;

    return this;
  }

  init(seed?: { position: number; from: 'hap-cache' | 'driver-cache' }): this {
    this.send({ t: 'Init', seed, now: this.now });

    return this;
  }

  /** Makes a verified position, as a device report would. */
  verified(position: number): this {
    this.send({ t: 'ValueReport', property: 'currentValue', value: position, now: this.now });

    return this;
  }

  move(target: number): number {
    const requestId = ++this.requests;
    this.send({ t: 'HomeKitMove', requestId, target, now: this.now });

    return requestId;
  }

  stop(): number {
    const requestId = ++this.requests;
    this.send({ t: 'HomeKitStop', requestId, now: this.now });

    return requestId;
  }

  /** Settles whatever write is outstanding. */
  settleWrite(confirmation: 'supervised' | 'working' | 'unsupervised' | 'refused'): Effect[] {
    const intent = this.state.inFlight;
    if (!intent) {
      throw new Error('no write is in flight');
    }

    return this.send({
      t: 'WriteSettled',
      intentId: intent.id,
      result:
        confirmation === 'refused'
          ? { kind: 'refused', message: 'Fail' }
          : { kind: 'accepted', confirmation },
      now: this.now,
    });
  }

  answerPoll(token: number, position: number): Effect[] {
    return this.send({ t: 'PollSettled', token, outcome: 'answered', position, now: this.now });
  }

  tick(token: number): Effect[] {
    return this.send({ t: 'ReconcileTick', token, now: this.now });
  }
}

const kinds = (effects: Effect[]) => effects.map((effect) => effect.t);
const settlements = (effects: Effect[]) => effects.filter((effect) => effect.t === 'SettleRequest');

describe('startup', () => {
  it('starts uninitialized and unknown, and projects nothing', () => {
    const state = initialState();

    expect(state.lifecycle).toBe('uninitialized');
    expect(state.reported).toEqual({ kind: 'unknown' });
    expect(project(state)).toBeUndefined();
  });

  it('ignores every event but Init and Teardown until it is initialized', () => {
    const h = new Harness(NO_DEBOUNCE);
    const before = h.state;

    h.move(50);
    h.verified(30);

    expect(h.state).toBe(before);
    expect(h.effects).toEqual([]);
  });

  it('seeds a provisional position and starts a probe', () => {
    const h = new Harness(NO_DEBOUNCE);

    h.init({ position: 40, from: 'hap-cache' });
    const effects = h.effects;

    expect(h.state.lifecycle).toBe('running');
    expect(h.state.reported).toEqual({ kind: 'provisional', position: 40, from: 'hap-cache' });
    expect(h.state.probe).toEqual({ token: 1, deadline: 1_000 + PROBE_WINDOW_MS });
    expect(effects).toEqual([{ t: 'Poll', token: 1 }]);
    expect(project(h.state)).toEqual({ current: 40, target: 40, motion: 'stopped' });
  });

  it('stays unknown with no seed, and still probes', () => {
    const h = new Harness(NO_DEBOUNCE);

    h.init();
    const effects = h.effects;

    expect(h.state.reported).toEqual({ kind: 'unknown' });
    expect(effects).toEqual([{ t: 'Poll', token: 1 }]);
    expect(project(h.state)).toBeUndefined();
  });

  it('ignores a repeated Init rather than downgrading a verified position', () => {
    const h = new Harness(NO_DEBOUNCE).init({ position: 40, from: 'driver-cache' });
    h.verified(70);
    const before = h.state;

    h.init({ position: 10, from: 'hap-cache' });

    expect(h.state).toBe(before);
    expect(h.state.reported).toMatchObject({ kind: 'verified', position: 70 });
  });

  it('promotes the seed only when a probe poll answers, and then drops the probe', () => {
    const h = new Harness(NO_DEBOUNCE).init({ position: 40, from: 'driver-cache' });

    h.at(500).answerPoll(1, 55);

    expect(h.state.reported).toEqual({
      kind: 'verified',
      position: 55,
      observedAt: 1_500,
      via: 'poll',
    });
    expect(h.state.probe).toBeUndefined();
  });

  it('retries an unanswered probe until its window closes, then keeps the seed', () => {
    const h = new Harness(NO_DEBOUNCE).init({ position: 40, from: 'hap-cache' });

    expect(h.send({ t: 'PollSettled', token: 1, outcome: 'unanswered', now: h.now })).toEqual([
      { t: 'ArmReconcileTimer', token: 1, delayMs: 5000 },
    ]);
    expect(h.at(5_000).tick(1)).toEqual([{ t: 'Poll', token: 1 }]);

    h.at(PROBE_WINDOW_MS);
    const closing = h.tick(1);

    expect(h.state.probe).toBeUndefined();
    expect(h.state.reported).toMatchObject({ kind: 'provisional', position: 40 });
    expect(closing.map((effect) => effect.t)).toEqual(['Log']);
  });

  it('lets a device report verify the seed and cancel the probe', () => {
    const h = new Harness(NO_DEBOUNCE).init({ position: 40, from: 'driver-cache' });

    h.verified(62);

    expect(h.state.reported).toMatchObject({ kind: 'verified', position: 62, via: 'device' });
    expect(h.state.probe).toBeUndefined();

    // The probe's own poll, arriving late, is stale and cannot overwrite the newer position.
    const before = h.state;
    h.answerPoll(1, 12);
    expect(h.state).toBe(before);
  });
});

describe('projection', () => {
  it('shows a move as traveling towards its target', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(20);

    h.move(80);

    expect(project(h.state)).toEqual({ current: 20, target: 80, motion: 'increasing' });
  });

  it.each([
    [47, 50, 'increasing'],
    [48, 50, 'stopped'],
    [49, 50, 'stopped'],
    [51, 50, 'stopped'],
    [52, 50, 'stopped'],
    [53, 50, 'decreasing'],
    [99, 100, 'increasing'],
    [1, 0, 'decreasing'],
  ])('shows a covering at %i traveling to %i as %s', (current, target, motion) => {
    const h = new Harness(NO_DEBOUNCE).init().verified(current);
    h.move(target);

    expect(project(h.state)?.motion).toBe(motion);
  });

  it('shows a stop as stopped at the reported position, never as a direction', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(45);
    h.move(90);
    h.settleWrite('working');

    h.stop();

    expect(project(h.state)).toEqual({ current: 45, target: 45, motion: 'stopped' });
  });

  it('does not fabricate a position for a move that arrives while nothing is known', () => {
    const h = new Harness(NO_DEBOUNCE).init();

    h.move(70);

    expect(project(h.state)).toBeUndefined();
    expect(h.state.inFlight).toMatchObject({ kind: 'move', target: 70 });
    expect(kinds(h.effects)).toEqual(['Write']);
  });

  it('treats a covering within two percent of a middle target as stopped, but not at the ends', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(49);
    h.move(50);
    expect(project(h.state)?.motion).toBe('stopped');

    h.verified(98);
    h.move(100);
    expect(project(h.state)?.motion).toBe('increasing');
  });

  it('reveals the previous accepted command when a newer write is refused', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(10);
    h.move(80);
    h.settleWrite('working');
    h.move(30);
    expect(project(h.state)?.target).toBe(30);

    h.settleWrite('refused');

    expect(project(h.state)).toEqual({ current: 10, target: 80, motion: 'increasing' });
  });
});

describe('commands without a debounce window', () => {
  it('writes at once when the transport is free', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(0);

    h.move(60);
    const effects = h.effects;

    expect(effects).toEqual([
      { t: 'Write', intent: expect.objectContaining({ kind: 'move', target: 60 }) },
    ]);
    expect(h.state.inFlight).toBeDefined();
    expect(h.state.pending).toBeUndefined();
  });

  it('holds a newer move behind a busy transport and settles the one it displaces', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(0);
    h.move(60);
    const second = h.move(70);

    h.move(80);
    const third = h.effects;

    expect(h.state.pending).toMatchObject({ intent: { target: 80 }, dispatch: { kind: 'ready' } });
    expect(third).toEqual([{ t: 'SettleRequest', requestId: second, outcome: 'superseded' }]);
  });

  it('drains the held move the moment the write settles', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(0);
    h.move(60);
    h.move(80);

    const effects = h.settleWrite('working');

    expect(kinds(effects)).toEqual(['SettleRequest', 'ArmReconcileTimer', 'Write']);
    expect(h.state.inFlight).toMatchObject({ target: 80 });
    expect(h.state.pending).toBeUndefined();
  });
});

describe('debounce', () => {
  it('holds a move and arms a dispatch timer instead of writing', () => {
    const h = new Harness(DEBOUNCE).init().verified(0);

    h.move(60);
    const effects = h.effects;

    expect(h.state.inFlight).toBeUndefined();
    expect(h.state.pending).toMatchObject({ dispatch: { kind: 'waiting' } });
    expect(effects).toEqual([
      { t: 'ArmDispatchTimer', dispatchToken: expect.any(Number), delayMs: 300 },
    ]);
  });

  it('turns a burst into one command: a newer move strands the older timer', () => {
    const h = new Harness(DEBOUNCE).init().verified(0);
    h.move(20);
    const firstToken = (h.state.pending as { dispatch: { token: number } }).dispatch.token;
    const second = h.move(60);
    const before = h.state;

    expect(settlements(h.effects)).toHaveLength(1);
    h.send({ t: 'DispatchTick', dispatchToken: firstToken, now: h.now });

    expect(h.state).toBe(before);
    expect(second).toBeGreaterThan(0);
  });

  it('queues a stop behind a busy transport and strands the held move timer', () => {
    const h = new Harness(DEBOUNCE).init().verified(0);
    h.stop();
    h.move(70);
    const token = (h.state.pending as { dispatch: { token: number } }).dispatch.token;
    h.stop();
    expect(h.state.pending).toMatchObject({
      intent: { kind: 'stop' },
      dispatch: { kind: 'ready' },
    });

    const before = h.state;
    h.send({ t: 'DispatchTick', dispatchToken: token, now: h.now });
    expect(h.state).toBe(before);
  });

  it('marks a waiting move ready on its tick even while the transport is busy', () => {
    const h = new Harness(DEBOUNCE).init().verified(0);
    h.stop();
    h.move(70);
    const token = (h.state.pending as { dispatch: { token: number } }).dispatch.token;

    h.send({ t: 'DispatchTick', dispatchToken: token, now: h.now });

    expect(h.state.pending).toMatchObject({ dispatch: { kind: 'ready' } });
    expect(h.state.inFlight).toMatchObject({ kind: 'stop' });

    const effects = h.settleWrite('working');
    expect(effects.some((effect) => effect.t === 'Write')).toBe(true);
    expect(h.state.inFlight).toMatchObject({ kind: 'move', target: 70 });
  });

  it('lets a stop bypass the debounce and discard the held move', () => {
    const h = new Harness(DEBOUNCE).init().verified(0);
    const held = h.move(70);

    h.stop();
    const effects = h.effects;

    expect(effects).toEqual([
      { t: 'SettleRequest', requestId: held, outcome: 'superseded' },
      { t: 'Write', intent: expect.objectContaining({ kind: 'stop' }) },
    ]);
    expect(h.state.pending).toBeUndefined();
  });
});

describe('minimum gap between moves', () => {
  /** A write that was issued at the harness's current time and settles after settleMs. */
  function writeThatSettles(h: Harness, target: number, settleMs = 100) {
    h.move(target);
    const token = (h.state.pending as { dispatch: { token: number } }).dispatch.token;
    h.at(300).send({ t: 'DispatchTick', dispatchToken: token, now: h.now });
    h.at(settleMs).settleWrite('working');
  }

  it('holds a move that follows a write too closely, for the rest of the gap', () => {
    const h = new Harness(GAP).init().verified(0);
    writeThatSettles(h, 40); // settles at t, so the gap runs to t + 1500

    h.at(200).move(70);

    expect(h.effects).toEqual([
      { t: 'ArmDispatchTimer', dispatchToken: expect.any(Number), delayMs: 1300 },
    ]);
    expect(h.state.inFlight).toBeUndefined();
  });

  it('measures the gap from when the last write settled, not from when it started', () => {
    const h = new Harness(GAP).init().verified(0);
    writeThatSettles(h, 40, 900);

    h.at(100).move(70);

    expect(h.effects).toEqual([
      { t: 'ArmDispatchTimer', dispatchToken: expect.any(Number), delayMs: 1400 },
    ]);
  });

  it('applies only the debounce once the gap has passed', () => {
    const h = new Harness(GAP).init().verified(0);
    writeThatSettles(h, 40);

    h.at(1_500).move(70);

    expect(h.effects).toEqual([
      { t: 'ArmDispatchTimer', dispatchToken: expect.any(Number), delayMs: 300 },
    ]);
  });

  it('lets the newest move win while the gap is held', () => {
    const h = new Harness(GAP).init().verified(0);
    writeThatSettles(h, 40);
    const first = h.at(200).move(70);

    const second = h.at(100).move(20);

    expect(h.effects).toEqual([
      { t: 'SettleRequest', requestId: first, outcome: 'superseded' },
      { t: 'ArmDispatchTimer', dispatchToken: expect.any(Number), delayMs: 1200 },
    ]);
    expect(h.state.pending).toMatchObject({ intent: { requestId: second, target: 20 } });
  });

  it('never holds a stop', () => {
    const h = new Harness(GAP).init().verified(0);
    writeThatSettles(h, 40);

    h.at(100).stop();

    expect(kinds(h.effects)).toEqual(['Write']);
    expect(h.state.inFlight).toMatchObject({ kind: 'stop' });
  });

  it('never holds a stop that was queued behind a busy write', () => {
    const h = new Harness(GAP).init().verified(0);
    h.move(40);
    const token = (h.state.pending as { dispatch: { token: number } }).dispatch.token;
    h.at(300).send({ t: 'DispatchTick', dispatchToken: token, now: h.now });
    h.at(100).stop();
    expect(h.state.pending).toMatchObject({
      intent: { kind: 'stop' },
      dispatch: { kind: 'ready' },
    });

    h.at(100).settleWrite('working');

    expect(h.state.inFlight).toMatchObject({ kind: 'stop' });
  });

  it('holds a move again if the write it was waiting behind finished late', () => {
    const h = new Harness(GAP).init().verified(0);
    h.move(40);
    const first = (h.state.pending as { dispatch: { token: number } }).dispatch.token;
    h.at(300).send({ t: 'DispatchTick', dispatchToken: first, now: h.now });
    h.at(100).move(70);
    const second = (h.state.pending as { dispatch: { token: number } }).dispatch.token;
    h.at(300).send({ t: 'DispatchTick', dispatchToken: second, now: h.now });
    expect(h.state.pending).toMatchObject({ dispatch: { kind: 'ready' } });

    // The first write takes a second to settle; the move that waited behind it must still wait.
    h.at(600).settleWrite('working');

    expect(h.state.inFlight).toBeUndefined();
    expect(h.state.pending).toMatchObject({ dispatch: { kind: 'waiting' } });
    expect(h.effects.filter((effect) => effect.t === 'ArmDispatchTimer')).toEqual([
      { t: 'ArmDispatchTimer', dispatchToken: expect.any(Number), delayMs: 1500 },
    ]);
  });

  it('sends the held move when its timer fires', () => {
    const h = new Harness(GAP).init().verified(0);
    writeThatSettles(h, 40);
    h.at(200).move(70);
    const token = (h.state.pending as { dispatch: { token: number } }).dispatch.token;

    h.at(1_300).send({ t: 'DispatchTick', dispatchToken: token, now: h.now });

    expect(h.state.inFlight).toMatchObject({ kind: 'move', target: 70 });
  });

  it('does nothing without a configured gap', () => {
    const h = new Harness(DEBOUNCE).init().verified(0);
    writeThatSettles(h, 40);

    h.at(10).move(70);

    expect(h.effects).toEqual([
      { t: 'ArmDispatchTimer', dispatchToken: expect.any(Number), delayMs: 300 },
    ]);
  });
});

describe('write results', () => {
  it('ignores a result for a write that is not the one in flight', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(0);
    h.move(60);
    const before = h.state;

    h.send({
      t: 'WriteSettled',
      intentId: 999,
      result: { kind: 'refused', message: 'x' },
      now: h.now,
    });

    expect(h.state).toBe(before);
    expect(h.effects).toEqual([]);
  });

  it('follows an accepted move that has not been confirmed', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(0);
    const request = h.move(60);

    const effects = h.at(100).settleWrite('unsupervised');

    expect(h.state.active).toMatchObject({ kind: 'move', target: 60, supervised: false });
    expect(effects).toEqual([
      { t: 'SettleRequest', requestId: request, outcome: 'accepted' },
      { t: 'ArmReconcileTimer', token: h.state.active?.token, delayMs: 2000 },
    ]);
  });

  it('treats a supervised move as done: the target becomes verified and nothing is followed', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(0);
    h.move(60);

    h.at(100).settleWrite('supervised');

    expect(h.state.reported).toMatchObject({ kind: 'verified', position: 60, via: 'supervision' });
    expect(h.state.active).toBeUndefined();
    expect(h.state.lastOutcome).toBe('achieved');
    expect(project(h.state)).toEqual({ current: 60, target: 60, motion: 'stopped' });
  });

  it('still polls after a supervised stop, which confirms the stop and not where it ended', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(40);
    h.stop();

    const effects = h.settleWrite('supervised');

    expect(h.state.active).toMatchObject({ kind: 'stop', supervised: true });
    expect(effects.map((effect) => effect.t)).toEqual(['SettleRequest', 'Poll']);
    expect(h.state.reported).toMatchObject({ via: 'device' });
  });

  it('rejects the request of a refused write and leaves the active command and its token alone', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(10);
    h.move(80);
    h.settleWrite('working');
    const active = h.state.active;
    h.move(30);

    const effects = h.settleWrite('refused');

    expect(effects).toEqual([
      { t: 'SettleRequest', requestId: expect.any(Number), outcome: { refused: 'Fail' } },
    ]);
    expect(h.state.active).toBe(active);
    expect(h.tick(active!.token)).toEqual([{ t: 'Poll', token: active!.token }]);
  });
});

describe('command ownership', () => {
  it('retires the previous command reconcile by token when a newer write is accepted', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(0);
    h.move(40);
    h.settleWrite('working');
    const oldToken = h.state.active!.token;
    h.move(90);
    h.settleWrite('working');
    const before = h.state;

    h.tick(oldToken);

    expect(h.state).toBe(before);
    expect(h.state.active!.token).not.toBe(oldToken);
  });

  it('drops the stop target when a later move arrives (the stale stop-target defect)', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(45);
    h.stop();
    h.settleWrite('unsupervised');
    expect(project(h.state)).toMatchObject({ target: 45, motion: 'stopped' });

    h.move(95);

    expect(project(h.state)).toEqual({ current: 45, target: 95, motion: 'increasing' });
  });

  it('keeps a poll answer for the probe from completing the active command', () => {
    const h = new Harness(NO_DEBOUNCE).init({ position: 5, from: 'driver-cache' });
    const probeToken = h.state.probe!.token;
    h.verified(5);
    h.move(60);
    h.settleWrite('working');
    const activeToken = h.state.active!.token;
    expect(activeToken).not.toBe(probeToken);

    h.answerPoll(probeToken, 60);

    expect(h.state.active).toBeDefined();
    expect(h.state.lastOutcome).toBeUndefined();
  });
});

describe('observations', () => {
  it('rejects driver-sourced reports outright', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(10);
    const before = h.state;

    h.send({ t: 'ValueReport', property: 'currentValue', value: 77, source: 'driver', now: h.now });

    expect(h.state).toBe(before);
  });

  it('records an untagged currentValue equal to the in-flight target as ambiguous only', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(10);
    h.move(60);

    h.at(5).verified(60);

    expect(h.state.reported).toMatchObject({ position: 10 });
    expect(h.state.ambiguous).toEqual({ position: 60, observedAt: 1_005 });
  });

  it('records an untagged echo of an accepted, still-followed move as ambiguous only', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(10);
    h.move(60);
    h.settleWrite('working');
    expect(h.state.inFlight).toBeUndefined();
    expect(h.state.active).toMatchObject({ kind: 'move', target: 60 });

    h.at(5).verified(60);

    expect(h.state.reported).toMatchObject({ kind: 'verified', position: 10 });
    expect(h.state.ambiguous).toEqual({ position: 60, observedAt: 1_005 });
    expect(h.state.active).toBeDefined();
  });

  it.each(['inFlight', 'active'] as const)(
    'accepts a node-sourced report at the target of a command that is %s',
    (stage) => {
      const h = new Harness(NO_DEBOUNCE).init().verified(10);
      h.move(60);
      if (stage === 'active') {
        h.settleWrite('working');
      }

      h.send({ t: 'ValueReport', property: 'currentValue', value: 60, source: 'node', now: h.now });

      expect(h.state.reported).toMatchObject({ kind: 'verified', position: 60, via: 'device' });
      expect(h.state.ambiguous).toBeUndefined();
    },
  );

  it('gives a move that replaces a held one its own id and request', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(0);
    h.move(60);
    h.move(70);
    const held = h.state.pending!.intent;
    h.move(80);
    const replacement = h.state.pending!.intent;

    expect(replacement.id).not.toBe(held.id);
    expect(replacement.id).not.toBe(h.state.inFlight!.id);
    expect(replacement.requestId).not.toBe(held.requestId);
  });

  it.each([
    [99, 100],
    [100, 99],
    [100, 100],
    [99, 99],
  ])('records an untagged %i%% report as an echo of a command for %i%%', (target, reported) => {
    const h = new Harness(NO_DEBOUNCE).init().verified(10);
    h.move(target);

    h.at(5).verified(reported);

    expect(h.state.reported).toMatchObject({ position: 10 });
    expect(h.state.ambiguous).toEqual({ position: reported, observedAt: 1_005 });
  });

  it('still takes a report one level away from the target as evidence', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(10);
    h.move(98);

    h.verified(99);

    expect(h.state.reported).toMatchObject({ kind: 'verified', position: 99, via: 'device' });
  });

  it('treats other untagged reports during a command as evidence of movement', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(10);
    h.move(60);

    h.verified(33);

    expect(h.state.reported).toMatchObject({ kind: 'verified', position: 33, via: 'device' });
  });

  it('never lets the cached targetValue decide anything', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(10);
    const before = h.state;

    h.send({ t: 'ValueReport', property: 'targetValue', value: 90, now: h.now });

    expect(h.state).toBe(before);
  });

  it('ignores a report that is not a plausible percentage', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(10);
    const before = h.state;

    h.verified(255);
    h.send({ t: 'ValueReport', property: 'currentValue', now: h.now });

    expect(h.state).toBe(before);
  });
});

describe('completion', () => {
  function followMove(target: number, start = 0) {
    const h = new Harness(NO_DEBOUNCE).init().verified(start);
    h.move(target);
    h.settleWrite('working');

    return h;
  }

  it('achieves a move as soon as a poll is within tolerance of the target', () => {
    const h = followMove(60);
    const token = h.state.active!.token;

    h.at(2_000).answerPoll(token, 59);

    expect(h.state.active).toBeUndefined();
    expect(h.state.lastOutcome).toBe('achieved');
    expect(project(h.state)).toEqual({ current: 59, target: 59, motion: 'stopped' });
  });

  it('does not call a covering still traveling a failure on its first intermediate reading', () => {
    const h = followMove(90);
    const token = h.state.active!.token;

    const effects = h.at(2_000).answerPoll(token, 40);

    expect(h.state.active).toBeDefined();
    expect(h.state.lastOutcome).toBeUndefined();
    expect(effects.map((effect) => effect.t)).toEqual(['ArmReconcileTimer']);
  });

  /** Polls every two seconds with the covering standing still, for the given time. */
  function standStill(h: Harness, token: number, position: number, forMs: number) {
    for (let waited = 0; waited < forMs; waited += 2_000) {
      h.at(Math.min(2_000, forMs - waited)).answerPoll(token, position);
    }
  }

  it('reports a move not achieved once the covering has stood still for the whole stall window', () => {
    const h = followMove(90);
    const token = h.state.active!.token;

    h.at(2_000).answerPoll(token, 40);
    h.at(STALL_WINDOW_MS - 1).answerPoll(token, 40);
    expect(h.state.active).toBeDefined();

    h.at(1).answerPoll(token, 40);

    expect(h.state.active).toBeUndefined();
    expect(h.state.lastOutcome).toBe('not-achieved');
    expect(h.effects).toEqual([
      { t: 'Log', level: 'warn', message: expect.stringContaining('40%') },
    ]);
  });

  it('does not fail a move whose covering pauses for a few seconds and then carries on', () => {
    // An RSZ1 held for about three seconds after a command arrived mid-travel, then resumed.
    const h = followMove(90);
    const token = h.state.active!.token;

    h.at(2_000).answerPoll(token, 11);
    h.at(2_000).answerPoll(token, 11);
    h.at(2_000).answerPoll(token, 11);
    expect(h.state.active).toBeDefined();
    h.at(2_000).answerPoll(token, 25);
    standStill(h, token, 25, STALL_WINDOW_MS - 2_000);

    expect(h.state.active).toBeDefined();
    expect(h.state.lastOutcome).toBeUndefined();
  });

  describe('a movement report disturbs the stall clock', () => {
    it('does not let a covering that moved in between count as having stood still (move)', () => {
      const h = followMove(90);
      const token = h.state.active!.token;

      h.at(2_000).answerPoll(token, 40);
      h.at(5_000).verified(50);
      h.at(5_000).answerPoll(token, 40);

      expect(h.state.active).toBeDefined();
      expect(h.state.lastOutcome).toBeUndefined();
    });

    it('does not let a covering that moved in between count as having stood still (stop)', () => {
      const h = new Harness(NO_DEBOUNCE).init().verified(40);
      h.stop();
      h.settleWrite('unsupervised');
      const token = h.state.active!.token;

      h.at(2_000).answerPoll(token, 40);
      h.at(5_000).verified(50);
      h.at(5_000).answerPoll(token, 40);

      expect(h.state.active).toBeDefined();
      expect(h.state.lastOutcome).toBeUndefined();
    });

    it('restarts the clock where a trusted report says the covering now is', () => {
      const h = followMove(90);
      const token = h.state.active!.token;

      h.at(2_000).answerPoll(token, 40);
      h.at(5_000).verified(50);

      expect(h.state.active!.settling).toEqual({ position: 50, since: h.now });
      standStill(h, token, 50, STALL_WINDOW_MS);
      expect(h.state.lastOutcome).toBe('not-achieved');
    });

    it('stops the clock for an echo that disagrees with where the covering was seen', () => {
      const h = followMove(90);
      const token = h.state.active!.token;

      h.at(2_000).answerPoll(token, 40);
      h.at(5_000).verified(90); // an untagged echo of the command

      expect(h.state.reported).toMatchObject({ position: 40 });
      expect(h.state.active!.settling).toEqual({});
      h.at(5_000).answerPoll(token, 40);
      expect(h.state.active).toBeDefined();
    });

    it('leaves the clock alone for a report of the place the covering is already seen', () => {
      const h = followMove(90);
      const token = h.state.active!.token;

      h.at(2_000).answerPoll(token, 40);
      const since = h.state.active!.settling.since;
      h.at(5_000).verified(40);

      expect(h.state.active!.settling).toEqual({ position: 40, since });
    });

    it('treats a report one percent away as movement, because the stability tolerance is zero', () => {
      const h = followMove(90);
      const token = h.state.active!.token;

      h.at(2_000).answerPoll(token, 40);
      h.at(1_000).verified(41);

      expect(h.state.active!.settling).toEqual({ position: 41, since: h.now });
    });

    it('does nothing when no position has been seen yet', () => {
      const h = followMove(90);

      h.at(1_000).verified(30);

      expect(h.state.active!.settling).toEqual({});
    });
  });

  it('starts the stall window again whenever the position changes', () => {
    const h = followMove(90);
    const token = h.state.active!.token;

    h.at(2_000).answerPoll(token, 40);
    h.at(STALL_WINDOW_MS - 2_000).answerPoll(token, 41);
    expect(h.state.active!.settling).toEqual({ position: 41, since: h.now });
    h.at(STALL_WINDOW_MS - 2_000).answerPoll(token, 41);

    expect(h.state.active).toBeDefined();
  });

  it('achieves a stop once the covering has stood still for the stall window, and pins the target', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(40);
    h.stop();
    h.settleWrite('unsupervised');
    const token = h.state.active!.token;

    h.at(2_000).answerPoll(token, 52);
    standStill(h, token, 52, STALL_WINDOW_MS - 2_000);
    expect(h.state.active).toBeDefined();
    h.at(2_000).answerPoll(token, 52);

    expect(h.state.lastOutcome).toBe('achieved');
    expect(project(h.state)).toEqual({ current: 52, target: 52, motion: 'stopped' });
  });

  it('keeps following a stop while the position is still changing, then settles where it rests', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(40);
    h.stop();
    h.settleWrite('unsupervised');
    const token = h.state.active!.token;

    h.at(2_000).answerPoll(token, 52);
    h.at(2_000).answerPoll(token, 60);
    standStill(h, token, 60, STALL_WINDOW_MS);

    expect(h.state.lastOutcome).toBe('achieved');
    expect(h.state.reported).toMatchObject({ position: 60 });
  });

  it.each([
    [1, 'a stop is not confirmed by readings a percent apart'],
    [2, 'a stop is not confirmed by readings two percent apart'],
  ])('a covering still creeping %i%% per quiet interval is not called stopped (%s)', (step) => {
    const h = new Harness(NO_DEBOUNCE).init().verified(40);
    h.stop();
    h.settleWrite('unsupervised');
    const token = h.state.active!.token;

    h.at(2_000).answerPoll(token, 52);
    h.at(2_000).answerPoll(token, 52 + step);

    expect(h.state.active).toBeDefined();
    expect(h.state.lastOutcome).toBeUndefined();
  });

  it.each([1, 2])('does not fail a move on readings %i%% apart', (step) => {
    const h = followMove(90);
    const token = h.state.active!.token;

    h.at(2_000).answerPoll(token, 40);
    h.at(2_000).answerPoll(token, 40 + step);

    expect(h.state.active).toBeDefined();
    expect(h.state.lastOutcome).toBeUndefined();
  });

  it('achieves a move exactly one percent from the target, but not two', () => {
    const near = followMove(60);
    near.at(2_000).answerPoll(near.state.active!.token, 59);
    expect(near.state.lastOutcome).toBe('achieved');

    const far = followMove(60);
    far.at(2_000).answerPoll(far.state.active!.token, 58);
    expect(far.state.lastOutcome).toBeUndefined();
  });

  describe('how long a command is followed', () => {
    /** Answers polls every two seconds with whatever the position is at that moment. */
    function followFor(
      h: Harness,
      token: number,
      ms: number,
      positionAt: (elapsed: number) => number,
    ) {
      const start = h.now;
      for (let waited = 0; waited < ms && h.state.active; waited += 2_000) {
        h.at(2_000).answerPoll(token, positionAt(h.now - start));
      }
    }

    it('follows a move past the usual limit while it keeps getting closer', () => {
      const h = followMove(100, 0);
      const token = h.state.active!.token;

      // One percent every two seconds: 70 seconds in, well past RECONCILE_MAX_MS, and still on its way.
      followFor(h, token, 70_000, (elapsed) => Math.floor(elapsed / 2_000) + 1);
      expect(h.state.active).toBeDefined();
      expect(h.state.lastOutcome).toBeUndefined();

      followFor(h, token, 200_000, (elapsed) => Math.min(100, Math.floor(elapsed / 2_000) + 36));
      expect(h.state.lastOutcome).toBe('achieved');
    });

    it('gives up on a move that stops getting closer, even if its position keeps changing', () => {
      const h = followMove(100, 0);
      const token = h.state.active!.token;
      const start = h.now;

      followFor(h, token, 120_000, (elapsed) => (Math.floor(elapsed / 2_000) % 2 === 0 ? 10 : 12));

      expect(h.state.lastOutcome).toBe('unconfirmed');
      expect(h.now - start).toBeLessThan(RECONCILE_MAX_MS + 10_000);
    });

    it('never follows a command past the ceiling, however much progress it makes', () => {
      const h = followMove(100, 0);
      const token = h.state.active!.token;
      const accepted = h.state.active!.acceptedAt;

      // One percent every eight seconds: always moving, and it would take 800 seconds to arrive.
      followFor(h, token, RECONCILE_CEILING_MS + 60_000, (elapsed) => Math.floor(elapsed / 8_000));

      expect(h.state.lastOutcome).toBe('unconfirmed');
      expect(h.now - accepted).toBeLessThanOrEqual(RECONCILE_CEILING_MS + 2_000);
    });

    it('gives a stop no extension for a position that is still changing', () => {
      const h = new Harness(NO_DEBOUNCE).init().verified(50);
      h.stop();
      h.settleWrite('unsupervised');
      const token = h.state.active!.token;
      const accepted = h.state.active!.acceptedAt;

      followFor(h, token, 120_000, (elapsed) => 50 - Math.floor(elapsed / 2_000));

      expect(h.state.lastOutcome).toBe('unconfirmed');
      expect(h.now - accepted).toBeLessThanOrEqual(RECONCILE_MAX_MS + 2_000);
    });

    it('moves the deadline out when a trusted report is closer, and not for an echo or a retreat', () => {
      const h = followMove(100, 0);
      const first = h.state.active!.deadline;

      h.at(30_000).verified(30);
      const extended = h.state.active!.deadline;
      expect(extended).toBe(h.now + RECONCILE_MAX_MS);
      expect(extended).toBeGreaterThan(first);

      h.at(1_000).verified(20); // further away than 30
      expect(h.state.active!.deadline).toBe(extended);

      h.at(1_000).verified(100); // an echo of the target
      expect(h.state.active!.deadline).toBe(extended);
    });

    it('gives no extension to a move that goes away from its target (80 to 100, first reading 70)', () => {
      const h = new Harness(NO_DEBOUNCE).init().verified(80);
      h.move(100);
      h.settleWrite('working');
      const token = h.state.active!.token;
      const first = h.state.active!.deadline;

      h.at(30_000).answerPoll(token, 70);

      expect(h.state.active!.deadline).toBe(first);
    });

    it('gives no extension for returning towards where the move started', () => {
      const h = new Harness(NO_DEBOUNCE).init().verified(80);
      h.move(100);
      h.settleWrite('working');
      const token = h.state.active!.token;
      const first = h.state.active!.deadline;

      h.at(20_000).answerPoll(token, 70);
      h.at(2_000).answerPoll(token, 75);
      h.at(2_000).answerPoll(token, 79);

      expect(h.state.active!.deadline).toBe(first);
    });

    it('extends once the move gets closer than where it started', () => {
      const h = new Harness(NO_DEBOUNCE).init().verified(80);
      h.move(100);
      h.settleWrite('working');
      const token = h.state.active!.token;

      h.at(30_000).answerPoll(token, 85);

      expect(h.state.active!.deadline).toBe(h.now + RECONCILE_MAX_MS);
    });

    it('counts the first observation as progress when no position was verified at the start', () => {
      const h = new Harness(NO_DEBOUNCE).init({ position: 80, from: 'hap-cache' });
      h.move(100);
      h.settleWrite('working');
      const token = h.state.active!.token;
      expect(h.state.active!.closest).toBeUndefined();

      h.at(30_000).answerPoll(token, 70);

      expect(h.state.active!.deadline).toBe(h.now + RECONCILE_MAX_MS);
    });

    it('counts a poll that arrives after the old deadline but shows progress', () => {
      const h = followMove(100, 0);
      const token = h.state.active!.token;

      h.at(RECONCILE_MAX_MS + 1_000).answerPoll(token, 50);

      expect(h.state.active).toBeDefined();
      expect(h.state.lastOutcome).toBeUndefined();
      expect(h.state.active!.deadline).toBe(h.now + RECONCILE_MAX_MS);
    });

    it('says how long it followed a command that ended unconfirmed', () => {
      const h = followMove(100, 0);
      const token = h.state.active!.token;

      h.at(RECONCILE_MAX_MS);
      h.tick(token);

      expect(h.effects).toEqual([
        { t: 'Log', level: 'warn', message: expect.stringContaining('unconfirmed 60s after 100%') },
      ]);
    });
  });

  it('ends unconfirmed at the deadline rather than inventing an outcome', () => {
    const h = followMove(60);
    const token = h.state.active!.token;

    h.at(RECONCILE_MAX_MS);
    h.tick(token);

    expect(h.state.active).toBeUndefined();
    expect(h.state.lastOutcome).toBe('unconfirmed');
  });

  it('keeps polling, and never settles early, while the device cannot be asked', () => {
    const h = followMove(60);
    const token = h.state.active!.token;

    expect(h.send({ t: 'PollSettled', token, outcome: 'unavailable', now: h.now })).toEqual([
      { t: 'ArmReconcileTimer', token, delayMs: 2000 },
    ]);
    expect(h.state.active).toBeDefined();
    expect(h.state.reported).toMatchObject({ position: 0 });
  });

  it('never concludes achieved or not-achieved from a provisional position', () => {
    const h = new Harness(NO_DEBOUNCE).init({ position: 60, from: 'hap-cache' });
    h.move(60);
    h.settleWrite('working');

    expect(h.state.active).toBeDefined();
    expect(h.state.lastOutcome).toBeUndefined();
    expect(h.state.reported.kind).toBe('provisional');
  });
});

describe('teardown', () => {
  it('settles every outstanding request as superseded and then stays silent', () => {
    const h = new Harness(NO_DEBOUNCE).init().verified(0);
    const inFlight = h.move(60);
    const pending = h.move(80);

    const effects = h.send({ t: 'Teardown' });

    expect(effects).toEqual(
      expect.arrayContaining([
        { t: 'SettleRequest', requestId: inFlight, outcome: 'superseded' },
        { t: 'SettleRequest', requestId: pending, outcome: 'superseded' },
      ]),
    );
    expect(h.state.lifecycle).toBe('stopped');

    h.move(10);
    expect(h.effects).toEqual([]);
    h.verified(20);
    expect(h.effects).toEqual([]);
  });
});

/**
 * Generated sequences. The reducer is replayed over every short sequence of abstract events and
 * a large set of long random ones, and every invariant of the design is checked after every
 * step. Abstract events are resolved against the current state, so the sequences include the
 * stale results a correct adapter can produce: retired tokens and results for writes that are no
 * longer in flight. A poll result or tick is only ever sent for a Poll or timer the reducer asked
 * for; a fabricated result carrying a current token is the adapter's contract, not covered here.
 */
const ABSTRACT = [
  'move30',
  'move70',
  'move100',
  'stop',
  'tickDispatch',
  'staleDispatch',
  'writeWorking',
  'writeUnsupervised',
  'writeSupervised',
  'writeRefused',
  'staleWrite',
  'reportDevice',
  'reportEcho',
  'reportDriver',
  'reportTarget',
  'pollNear',
  'pollFar',
  'pollProbe',
  'pollUnanswered',
  'pollUnavailable',
  'stalePoll',
  'tickActive',
  'tickProbe',
  'staleTick',
  'late',
  'init',
  'teardown',
] as const;

type Abstract = (typeof ABSTRACT)[number] | 'cycle' | 'pollSame' | 'reportOther';

interface Model {
  requests: number;
  now: number;
  /** Requests handed to the reducer while running and not yet settled. */
  outstanding: Set<number>;
  settled: Set<number>;
  armed: Set<number>;
  /** Tokens with a Poll effect issued and not yet settled. */
  polls: Set<number>;
  /** What every id and token ever held was bound to, across the whole run. */
  bound: Map<number, string>;
  /** The oracle's own record of the last position seen and when it last differed. */
  lastObserved?: number;
  lastDifferentAt?: number;
  /** The oracle's own best distance to the target of the command being followed. */
  best?: number;
  everSeenTokens: Set<number>;
  lastIntent: number;
  tornDown: boolean;
  farToggle: number;
  initCount: number;
}

function newModel(): Model {
  return {
    requests: 0,
    now: 1_000,
    outstanding: new Set(),
    settled: new Set(),
    armed: new Set(),
    polls: new Set(),
    bound: new Map(),
    everSeenTokens: new Set(),
    lastIntent: 0,
    tornDown: false,
    farToggle: 0,
    initCount: 0,
  };
}

function tokensHeld(state: CoveringState): number[] {
  const held: number[] = [];
  if (state.active) {
    held.push(state.active.token);
  }
  if (state.probe) {
    held.push(state.probe.token);
  }
  if (state.pending?.dispatch.kind === 'waiting') {
    held.push(state.pending.dispatch.token);
  }

  return held;
}

function staleToken(model: Model, state: CoveringState): number {
  const held = new Set(tokensHeld(state));
  const candidates = [...model.everSeenTokens].filter((token) => !held.has(token));

  return candidates.length > 0 ? candidates[candidates.length - 1] : 9_999_999;
}

function outstandingPoll(model: Model, state: CoveringState): number | undefined {
  return [state.active?.token, state.probe?.token].find(
    (token): token is number => token !== undefined && model.polls.has(token),
  );
}

function armedToken(model: Model, token: number | undefined): number | undefined {
  return token !== undefined && model.armed.has(token) ? token : undefined;
}

function resolve(kind: Abstract, state: CoveringState, model: Model): Event | undefined {
  const now = model.now;
  const echoTarget = [state.inFlight, state.active].find((c) => c?.kind === 'move');
  const requestId = ++model.requests;

  switch (kind) {
    case 'move30':
      return { t: 'HomeKitMove', requestId, target: 30, now };
    case 'move70':
      return { t: 'HomeKitMove', requestId, target: 70, now };
    case 'move100':
      return { t: 'HomeKitMove', requestId, target: 100, now };
    case 'stop':
      return { t: 'HomeKitStop', requestId, now };
    case 'tickDispatch':
      return {
        t: 'DispatchTick',
        dispatchToken:
          state.pending?.dispatch.kind === 'waiting'
            ? state.pending.dispatch.token
            : staleToken(model, state),
        now,
      };
    case 'staleDispatch':
      return { t: 'DispatchTick', dispatchToken: staleToken(model, state), now };
    case 'writeWorking':
    case 'writeUnsupervised':
    case 'writeSupervised':
    case 'writeRefused': {
      const intentId = state.inFlight?.id ?? model.lastIntent;
      const confirmation =
        kind === 'writeWorking'
          ? 'working'
          : kind === 'writeUnsupervised'
            ? 'unsupervised'
            : 'supervised';

      return {
        t: 'WriteSettled',
        intentId,
        result:
          kind === 'writeRefused'
            ? { kind: 'refused', message: 'Fail' }
            : { kind: 'accepted', confirmation },
        now,
      };
    }
    case 'staleWrite':
      return {
        t: 'WriteSettled',
        intentId: 9_999_998,
        result: { kind: 'accepted', confirmation: 'working' },
        now,
      };
    case 'reportDevice':
      return { t: 'ValueReport', property: 'currentValue', value: 45, now };
    case 'reportEcho':
      return {
        t: 'ValueReport',
        property: 'currentValue',
        value: echoTarget?.kind === 'move' ? echoTarget.target : 60,
        now,
      };
    case 'reportDriver':
      return { t: 'ValueReport', property: 'currentValue', value: 45, source: 'driver', now };
    case 'reportTarget':
      return { t: 'ValueReport', property: 'targetValue', value: 50, now };
    case 'pollNear':
    case 'pollFar': {
      const token = outstandingPoll(model, state) ?? staleToken(model, state);
      const target = state.active?.kind === 'move' ? state.active.target : 50;
      const far = model.farToggle++ % 2 === 0 ? 10 : 90;

      return {
        t: 'PollSettled',
        token,
        outcome: 'answered',
        position: kind === 'pollNear' ? target : far,
        now,
      };
    }
    case 'pollSame': {
      const token = outstandingPoll(model, state) ?? staleToken(model, state);

      return { t: 'PollSettled', token, outcome: 'answered', position: 40, now };
    }
    case 'reportOther':
      return { t: 'ValueReport', property: 'currentValue', value: 50, now };
    case 'cycle':
      return undefined;
    case 'pollProbe':
      return {
        t: 'PollSettled',
        token:
          state.probe && model.polls.has(state.probe.token)
            ? state.probe.token
            : staleToken(model, state),
        outcome: 'answered',
        position: 25,
        now,
      };
    case 'pollUnanswered':
    case 'pollUnavailable':
      return {
        t: 'PollSettled',
        token: outstandingPoll(model, state) ?? staleToken(model, state),
        outcome: kind === 'pollUnanswered' ? 'unanswered' : 'unavailable',
        now,
      };
    case 'stalePoll':
      return {
        t: 'PollSettled',
        token: staleToken(model, state),
        outcome: 'answered',
        position: 77,
        now,
      };
    case 'tickActive':
      return {
        t: 'ReconcileTick',
        token: armedToken(model, state.active?.token) ?? staleToken(model, state),
        now,
      };
    case 'tickProbe':
      return {
        t: 'ReconcileTick',
        token: armedToken(model, state.probe?.token) ?? staleToken(model, state),
        now,
      };
    case 'staleTick':
      return { t: 'ReconcileTick', token: staleToken(model, state), now };
    case 'late':
      model.now += RECONCILE_MAX_MS + 1;
      return undefined;
    case 'init':
      model.initCount += 1;
      return model.initCount % 2 === 0
        ? { t: 'Init', now }
        : { t: 'Init', seed: { position: 35, from: 'driver-cache' }, now };
    case 'teardown':
      return { t: 'Teardown' };
  }
}

function isStaleByDesign(event: Event, state: CoveringState): boolean {
  switch (event.t) {
    case 'DispatchTick':
      return !(
        state.pending?.dispatch.kind === 'waiting' &&
        state.pending.dispatch.token === event.dispatchToken
      );
    case 'PollSettled':
    case 'ReconcileTick':
      return !(state.active?.token === event.token || state.probe?.token === event.token);
    case 'WriteSettled':
      return state.inFlight?.id !== event.intentId;
    default:
      return false;
  }
}

/** An untagged report equal to the target of a move that is in flight or being followed. */
/** The level as the device sees it: HomeKit's 100% is Z-Wave's 99. */
function onWire(percent: number): number {
  return percent === 100 ? 99 : percent;
}

function isEcho(
  state: CoveringState,
  value: number | undefined,
  source: 'driver' | 'node' | undefined,
): boolean {
  return (
    source === undefined &&
    [state.inFlight, state.active].some(
      (command) =>
        command?.kind === 'move' && value !== undefined && onWire(command.target) === onWire(value),
    )
  );
}

/** The projection written out from the design's rules, without using liveIntent or direction. */
function expectedProjection(state: CoveringState) {
  if (state.reported.kind === 'unknown') {
    return undefined;
  }
  const position = state.reported.position;
  const live = state.pending
    ? state.pending.intent
    : state.inFlight
      ? state.inFlight
      : state.active;
  if (!live || live.kind === 'stop') {
    return { current: position, target: position, motion: 'stopped' };
  }
  const gap = live.target - position;
  const slack = live.target === 0 || live.target === 100 ? 0 : 2;
  const motion = Math.abs(gap) <= slack ? 'stopped' : gap > 0 ? 'increasing' : 'decreasing';

  return { current: position, target: live.target, motion };
}

function expectInvariants(
  config: CoveringConfig,
  before: CoveringState,
  event: Event,
  step: { state: CoveringState; effects: Effect[] },
  model: Model,
  context: string,
): void {
  const { state, effects } = step;
  const fail = (message: string): never => {
    throw new Error(`${message}\n  after: ${context}\n  state: ${JSON.stringify(state)}`);
  };

  // 8. After Teardown no effect is ever emitted.
  if (model.tornDown && event.t !== 'Teardown') {
    if (effects.length > 0 || state !== before) {
      fail('an event after Teardown changed state or emitted an effect');
    }
  }

  // Requests: handed over only by an accepted command while running.
  const wasRunning = before.lifecycle === 'running';
  if ((event.t === 'HomeKitMove' || event.t === 'HomeKitStop') && wasRunning) {
    model.outstanding.add(event.requestId);
  }
  for (const effect of effects) {
    if (effect.t !== 'SettleRequest') {
      continue;
    }
    // 1. Every requestId is settled exactly once.
    if (!model.outstanding.has(effect.requestId)) {
      fail(`request ${effect.requestId} settled when it was not outstanding`);
    }
    model.outstanding.delete(effect.requestId);
    model.settled.add(effect.requestId);
  }
  const owed = new Set(
    [state.pending?.intent.requestId, state.inFlight?.requestId].filter(
      (id): id is number => id !== undefined,
    ),
  );
  if (owed.size !== model.outstanding.size || [...owed].some((id) => !model.outstanding.has(id))) {
    fail(`outstanding requests ${[...model.outstanding]} differ from those held ${[...owed]}`);
  }

  // 3. A result whose token is not current changes nothing and emits nothing.
  if (wasRunning && isStaleByDesign(event, before)) {
    if (state !== before || effects.length > 0) {
      fail('a stale result changed state or emitted an effect');
    }
  }

  // 6. A driver-sourced report never changes state.
  if (event.t === 'ValueReport' && event.source === 'driver' && state !== before) {
    fail('a driver-sourced report changed state');
  }

  // 4 and 17. reported only improves, and only from the permitted sources.
  const reportedChanged = state.reported !== before.reported;
  if (reportedChanged) {
    if (state.reported.kind === 'verified') {
      const viaSupervision =
        event.t === 'WriteSettled' &&
        state.reported.via === 'supervision' &&
        effects.some((e) => e.t === 'SettleRequest' && e.outcome === 'accepted');
      const viaDevice =
        event.t === 'ValueReport' &&
        event.property === 'currentValue' &&
        event.source !== 'driver' &&
        state.reported.via === 'device' &&
        !isEcho(before, event.value, event.source);
      const viaPoll =
        event.t === 'PollSettled' &&
        event.outcome === 'answered' &&
        state.reported.via === 'poll' &&
        (before.active?.token === event.token || before.probe?.token === event.token);
      if (!viaSupervision && !viaDevice && !viaPoll) {
        fail('a verified position came from a source that is not allowed');
      }
    } else if (state.reported.kind === 'provisional') {
      if (event.t !== 'Init' || before.reported.kind !== 'unknown') {
        fail('a provisional position was set outside Init');
      }
    } else {
      fail('reported moved back to unknown');
    }
    if (before.reported.kind === 'verified' && state.reported.kind !== 'verified') {
      fail('reported was downgraded from verified');
    }
  }

  // 16. An unanswered or unavailable poll never changes reported.
  if (
    event.t === 'PollSettled' &&
    event.outcome !== 'answered' &&
    state.reported !== before.reported
  ) {
    fail('an unanswered poll changed reported');
  }

  // 2. An untagged report equal to a command's target is an echo: ambiguous, never reported.
  if (
    event.t === 'ValueReport' &&
    event.property === 'currentValue' &&
    event.source !== 'driver' &&
    wasRunning &&
    isEcho(before, event.value, event.source)
  ) {
    if (state.reported !== before.reported) {
      fail('an echo of a command target changed reported');
    }
    if (state.ambiguous?.position !== event.value) {
      fail('an echo was not recorded as ambiguous');
    }
  }

  // 19. A covering is judged stuck (a move not achieved) or at rest (a stop achieved) only after
  // every position seen since the command was accepted, from a poll or a report, has been the
  // same for the whole stall window. Tracked separately from the reducer's own record.
  if (state.active && state.active.id !== before.active?.id) {
    model.lastObserved = undefined;
    model.lastDifferentAt = undefined;
  }
  const observed =
    event.t === 'PollSettled' && event.outcome === 'answered'
      ? event.position
      : event.t === 'ValueReport' &&
          event.property === 'currentValue' &&
          event.source !== 'driver' &&
          typeof event.value === 'number'
        ? event.value
        : undefined;
  if (observed !== undefined && before.active && observed !== model.lastObserved) {
    model.lastObserved = observed;
    model.lastDifferentAt = event.now;
  }
  const judged =
    event.t === 'PollSettled' &&
    state.lastOutcome !== before.lastOutcome &&
    before.active !== undefined &&
    ((before.active.kind === 'move' && state.lastOutcome === 'not-achieved') ||
      (before.active.kind === 'stop' && state.lastOutcome === 'achieved'));
  if (judged) {
    if (
      model.lastDifferentAt === undefined ||
      ('now' in event && event.now - model.lastDifferentAt < STALL_WINDOW_MS)
    ) {
      fail('a covering was judged to have stopped before it stood still for the stall window');
    }
  }

  // 10. lastOutcome is only set in a transition that also clears active, and only for a command
  // that was being followed (or a supervised move, which is accepted and concluded together).
  if (state.lastOutcome !== before.lastOutcome) {
    if (state.active !== undefined) {
      fail('lastOutcome changed while a command is still active');
    }
    const supervisedMove =
      event.t === 'WriteSettled' &&
      event.result.kind === 'accepted' &&
      event.result.confirmation === 'supervised' &&
      before.inFlight?.id === event.intentId &&
      before.inFlight.kind === 'move';
    if (state.lastOutcome !== undefined && !before.active && !supervisedMove) {
      fail('an outcome was invented while no command was being followed');
    }
  }
  // 14. A provisional position never decides achieved or not-achieved.
  if (
    state.lastOutcome !== before.lastOutcome &&
    state.lastOutcome !== 'unconfirmed' &&
    state.lastOutcome !== undefined &&
    state.reported.kind !== 'verified'
  ) {
    fail('an outcome was decided without a verified position');
  }

  // 20a. The deadline of a move moves out only for an observation (a poll answer or a report that is
  // not an echo) closer to the target than the starting position and every earlier observation,
  // tracked here independently of the reducer.
  if (state.active && state.active.id !== before.active?.id) {
    model.best =
      state.active.kind === 'move' && before.reported.kind === 'verified'
        ? Math.abs(before.reported.position - state.active.target)
        : undefined;
  }
  if (before.active && state.active && state.active.id === before.active.id) {
    const isEchoReport = event.t === 'ValueReport' && isEcho(before, event.value, event.source);
    // A poll counts only if it answers the command's own poll, not the startup probe's.
    const foreignPoll = event.t === 'PollSettled' && event.token !== before.active.token;
    const counted =
      observed !== undefined && before.active.kind === 'move' && !isEchoReport && !foreignPoll
        ? Math.abs(observed - before.active.target)
        : undefined;
    const better = counted !== undefined && (model.best === undefined || counted < model.best);
    if (state.active.deadline > before.active.deadline && !better) {
      fail('a deadline moved out for an observation that was not closer than any before');
    }
    if (better) {
      model.best = counted;
    }
  }

  // 20. A followed command's deadline never moves earlier or past the ceiling, and a stop's never moves.
  if (before.active && state.active && state.active.id === before.active.id) {
    if (
      state.active.deadline < before.active.deadline ||
      state.active.deadline > state.active.acceptedAt + RECONCILE_CEILING_MS ||
      (state.active.kind === 'stop' && state.active.deadline !== before.active.deadline)
    ) {
      fail('a deadline moved the wrong way, past the ceiling, or for a stop');
    }
  }

  // 11. A refused write never clears or re-tokenizes an existing active command.
  if (
    event.t === 'WriteSettled' &&
    event.result.kind === 'refused' &&
    before.inFlight?.id === event.intentId &&
    state.active !== before.active
  ) {
    fail('a refused write changed the active command');
  }

  // 12. A ready pending intent never waits while the transport is free.
  if (state.pending?.dispatch.kind === 'ready' && !state.inFlight) {
    fail('a ready pending intent is waiting while inFlight is free');
  }

  if (event.t === 'PollSettled') {
    model.polls.delete(event.token);
  }
  for (const effect of effects) {
    if (effect.t === 'Poll') {
      model.polls.add(effect.token);
    }
  }

  // 13. At most one reconcile timer is outstanding per token.
  if (event.t === 'ReconcileTick') {
    model.armed.delete(event.token);
  }
  for (const effect of effects) {
    if (effect.t === 'ArmReconcileTimer') {
      if (model.armed.has(effect.token)) {
        fail(`a second reconcile timer was armed for token ${effect.token}`);
      }
      model.armed.add(effect.token);
    }
  }

  // 15. A probe never coexists with a verified position.
  if (state.probe && state.reported.kind === 'verified') {
    fail('a probe is present with a verified position');
  }

  // 5 and 14. The projection is unavailable exactly while nothing is known, and a stop is stopped.
  const projection = project(state);
  if ((projection === undefined) !== (state.reported.kind === 'unknown')) {
    fail('the projection availability does not match the reported position');
  }
  if (liveIntent(state)?.kind === 'stop' && projection && projection.motion !== 'stopped') {
    fail('a stop projected as moving');
  }
  if (JSON.stringify(projection) !== JSON.stringify(expectedProjection(state))) {
    fail(`projection ${JSON.stringify(projection)} differs from the rules`);
  }
  // 7 and 9. The projection is a pure function of state and ignores diagnostics.
  const frozenForProjection = JSON.stringify(state);
  const reproject = project({ ...JSON.parse(JSON.stringify(state)), ambiguous: undefined });
  if (JSON.stringify(reproject) !== JSON.stringify(projection)) {
    fail('the projection depends on something other than the command and reported state');
  }
  if (JSON.stringify(state) !== frozenForProjection) {
    fail('projecting changed the state');
  }

  // 18. Every id and token held at once is distinct. Each value is bound for good to one thing: an
  // intent id to its request, a token to its owning concern. A value that is bound to something
  // new was allocated in this step, and every allocation advances nextId by exactly one.
  const bindings = (s: CoveringState): [number, string][] => {
    const out: [number, string][] = [];
    for (const c of [s.pending?.intent, s.inFlight, s.active]) {
      if (c) {
        out.push([c.id, `intent:${c.requestId}:${c.kind}`]);
      }
    }
    if (s.active) {
      out.push([s.active.token, `reconcile:${s.active.id}`]);
    }
    if (s.probe) {
      out.push([s.probe.token, 'probe']);
    }
    if (s.pending?.dispatch.kind === 'waiting') {
      out.push([s.pending.dispatch.token, `dispatch:${s.pending.intent.id}`]);
    }

    return out;
  };
  const now = bindings(state);
  if (now.length !== new Set(now.map(([id]) => id)).size) {
    fail(`an id or token is shared between owners: ${now.map(([id]) => id)}`);
  }
  let fresh = 0;
  for (const [id, binding] of now) {
    const known = model.bound.get(id);
    if (known === undefined) {
      model.bound.set(id, binding);
      fresh += 1;
      if (id < before.nextId || id >= state.nextId) {
        fail(`value ${id} was not allocated from nextId in this step`);
      }
    } else if (known !== binding) {
      fail(`value ${id} was bound to ${known} and is now ${binding}`);
    }
  }
  if (state.nextId - before.nextId !== fresh) {
    fail(`nextId advanced by ${state.nextId - before.nextId} for ${fresh} new values`);
  }
  const commands = [state.pending?.intent, state.inFlight, state.active].filter(
    (c): c is NonNullable<typeof c> => c !== undefined,
  );
  tokensHeld(state).forEach((token) => model.everSeenTokens.add(token));
  commands.forEach((c) => (model.lastIntent = Math.max(model.lastIntent, c.id)));
  void config;
}

function replay(config: CoveringConfig, sequence: Abstract[], start: Abstract[]): void {
  const model = newModel();
  let state = initialState();
  const trail: string[] = [];

  const expanded = [...start, ...sequence].flatMap((kind): Abstract[] =>
    kind === 'cycle' ? ['tickActive', 'pollSame'] : [kind],
  );
  for (const kind of expanded) {
    freeze(state);
    const event = resolve(kind, state, model);
    trail.push(kind);
    if (!event) {
      continue;
    }
    const before = state;
    const step = reduce(config, state, event);
    if (event.t === 'Teardown') {
      model.tornDown = true;
    }
    expectInvariants(config, before, event, step, model, trail.join(' > '));
    state = step.state;
    model.now += 2_100;
  }
}

/** A tiny deterministic generator, so a failing sequence is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.each([
  ['without a debounce window', NO_DEBOUNCE],
  ['with a debounce window', DEBOUNCE],
  ['with a debounce window and a minimum gap', { debounceMs: 300, minGapMs: 5000 }],
])('generated sequences %s', (_name, config) => {
  const core: Abstract[] = [
    'move30',
    'move70',
    'stop',
    'tickDispatch',
    'writeWorking',
    'writeSupervised',
    'writeRefused',
    'reportDevice',
    'reportEcho',
    'pollNear',
    'pollFar',
    'tickActive',
    'late',
    'init',
    'teardown',
  ];

  it('keeps every invariant over all sequences of up to three events', () => {
    const run = (prefix: Abstract[]) => {
      replay(config, [], prefix);
      if (prefix.length >= 3) {
        return;
      }
      for (const kind of ABSTRACT) {
        run([...prefix, kind]);
      }
    };
    // Starting both uninitialized and already running with a seed.
    for (const start of [[], ['init'] as Abstract[]]) {
      const visit = (prefix: Abstract[]) => {
        replay(config, prefix, start);
        if (prefix.length >= 3) {
          return;
        }
        for (const kind of ABSTRACT) {
          visit([...prefix, kind]);
        }
      };
      visit([]);
    }
    expect(run).toBeDefined();
  });

  it('keeps every invariant over all sequences of up to four core events', () => {
    for (const start of [[], ['init'] as Abstract[]]) {
      const visit = (prefix: Abstract[]) => {
        replay(config, prefix, start);
        if (prefix.length >= 4) {
          return;
        }
        for (const kind of core) {
          visit([...prefix, kind]);
        }
      };
      visit([]);
    }
  });

  it('keeps every invariant over long random sequences', () => {
    for (let seed = 1; seed <= 600; seed += 1) {
      const next = mulberry32(seed);
      const length = 20 + Math.floor(next() * 60);
      const sequence: Abstract[] = [];
      for (let i = 0; i < length; i += 1) {
        sequence.push(ABSTRACT[Math.floor(next() * ABSTRACT.length)]);
      }
      try {
        replay(config, sequence, ['init']);
      } catch (error) {
        throw new Error(`seed ${seed}: ${(error as Error).message}`);
      }
    }
  });
});

/**
 * Every interleaving of poll cycles that find the covering in the same place with reports that say
 * it is somewhere else, after a move and after a stop. The broad generator almost never strings
 * together the five matching polls a verdict needs, so this is where the stall window is held to
 * its definition: nothing is judged unless every position seen stayed the same for the window.
 */
describe.each([
  ['a move', ['init', 'move70', 'writeWorking'] as Abstract[]],
  ['a stop', ['init', 'stop', 'writeWorking'] as Abstract[]],
])('stall window interleavings after %s', (_name, start) => {
  it('judges only a covering that stood still for the whole window', () => {
    const alphabet: Abstract[] = ['cycle', 'reportOther', 'reportEcho'];
    const visit = (prefix: Abstract[]) => {
      replay(NO_DEBOUNCE, prefix, start);
      if (prefix.length >= 8) {
        return;
      }
      for (const kind of alphabet) {
        visit([...prefix, kind]);
      }
    };
    visit([]);
  });
});
