import {
  baselinesFor,
  canRefresh,
  pendingOf,
  refreshStatus,
  shouldDispatch,
  type RefreshToken,
} from '../../src/platform/NodeParametersRefresh';
import type { NodeParametersPayload, ParameterValue } from '../../src/platform/NodeParametersPayload';

const value = (over: Partial<ParameterValue> = {}): ParameterValue => ({
  bitMask: null,
  value: 1,
  reportedAt: 1_000,
  label: null,
  description: null,
  unit: null,
  min: null,
  max: null,
  defaultValue: null,
  recommended: null,
  states: null,
  allowed: null,
  format: null,
  valueSize: null,
  advanced: false,
  requiresReInclusion: false,
  destructive: false,
  allowManualEntry: true,
  fromConfig: false,
  readable: true,
  writable: true,
  ...over,
});

const payloadOf = (
  groups: { endpoint?: number; parameter: number; values: ParameterValue[] }[],
  state: NodeParametersPayload['state'] = 'parameters',
): NodeParametersPayload => ({
  nodeId: 10,
  state,
  listening: true,
  groups: groups.map((group) => ({
    endpoint: group.endpoint ?? 0,
    parameter: group.parameter,
    partial: group.values.some((one) => one.bitMask !== null),
    values: group.values,
    raw: null,
  })),
});

const tokenOf = (payload: NodeParametersPayload, over: Partial<RefreshToken> = {}): RefreshToken => ({
  nodeId: 10,
  fingerprint: 'abc',
  requestedAt: 5_000,
  dispatching: true,
  baselines: baselinesFor(payload),
  ...over,
});

describe('asking a device for its current configuration values', () => {
  describe('what a refresh can confirm', () => {
    it('asks about every readable value', () => {
      const payload = payloadOf([
        { parameter: 1, values: [value()] },
        { parameter: 2, values: [value({ bitMask: 0x0f }), value({ bitMask: 0xf0 })] },
      ]);

      expect(baselinesFor(payload)).toHaveLength(3);
    });

    it('never asks about a value the device will not report', () => {
      /**
       * zwave-js's Configuration refresh skips write-only parameters outright, so a baseline for
       * one would wait for a timestamp that is never going to move.
       */
      const payload = payloadOf([
        { parameter: 1, values: [value({ readable: false })] },
        { parameter: 2, values: [value()] },
      ]);

      expect(baselinesFor(payload).map((baseline) => baseline.parameter)).toEqual([2]);
    });

    it('is not offered where nothing could answer', () => {
      expect(canRefresh(payloadOf([{ parameter: 1, values: [value({ readable: false })] }]))).toBe(
        false,
      );
      expect(canRefresh(payloadOf([], 'none'))).toBe(false);
      expect(canRefresh(payloadOf([{ parameter: 1, values: [value()] }]))).toBe(true);
    });
  });

  describe('what has answered', () => {
    it('counts a value whose timestamp has moved past its own baseline', () => {
      const before = payloadOf([{ parameter: 1, values: [value({ reportedAt: 1_000 })] }]);
      const token = tokenOf(before);
      const after = payloadOf([{ parameter: 1, values: [value({ reportedAt: 1_001 })] }]);

      expect(pendingOf(token, before)).toHaveLength(1);
      expect(pendingOf(token, after)).toHaveLength(0);
    });

    it('counts a value that had no timestamp and now has one', () => {
      const before = payloadOf([{ parameter: 1, values: [value({ reportedAt: null })] }]);
      const token = tokenOf(before);
      const after = payloadOf([{ parameter: 1, values: [value({ reportedAt: 7 })] }]);

      expect(pendingOf(token, before)).toHaveLength(1);
      expect(pendingOf(token, after)).toHaveLength(0);
    });

    it('does not count a timestamp that merely equals the baseline', () => {
      // The same reading is not a new one, however recently the cache was read.
      const before = payloadOf([{ parameter: 1, values: [value({ reportedAt: 1_000 })] }]);

      expect(pendingOf(tokenOf(before), before)).toHaveLength(1);
    });

    it('compares each value against its own baseline, not against one instant', () => {
      /**
       * Two values asked for together can carry different baselines. Judging both against a
       * single wall-clock instant would call one of them answered on the strength of a reading
       * that predates the request.
       */
      const before = payloadOf([
        { parameter: 1, values: [value({ reportedAt: 1_000 })] },
        { parameter: 2, values: [value({ reportedAt: 9_000 })] },
      ]);
      const token = tokenOf(before, { requestedAt: 5_000 });
      const after = payloadOf([
        { parameter: 1, values: [value({ reportedAt: 6_000 })] },
        { parameter: 2, values: [value({ reportedAt: 9_000 })] },
      ]);

      expect(pendingOf(token, after).map((baseline) => baseline.parameter)).toEqual([2]);
    });

    it('stops waiting on a value that has gone', () => {
      const before = payloadOf([
        { parameter: 1, values: [value()] },
        { parameter: 2, values: [value()] },
      ]);
      const token = tokenOf(before);
      const after = payloadOf([{ parameter: 1, values: [value()] }]);

      expect(pendingOf(token, after).map((baseline) => baseline.parameter)).toEqual([1]);
    });

    it('stops waiting on a value that has turned unreadable', () => {
      const before = payloadOf([{ parameter: 1, values: [value()] }]);
      const token = tokenOf(before);
      const after = payloadOf([{ parameter: 1, values: [value({ readable: false })] }]);

      expect(pendingOf(token, after)).toHaveLength(0);
    });

    it('never waits on a value that appeared after it asked', () => {
      // The refresh did not ask about it, so it has nothing to say about whether it answered.
      const before = payloadOf([{ parameter: 1, values: [value({ reportedAt: 2_000 })] }]);
      const token = tokenOf(before);
      const after = payloadOf([
        { parameter: 1, values: [value({ reportedAt: 2_000 })] },
        { parameter: 9, values: [value({ reportedAt: null })] },
      ]);

      expect(pendingOf(token, after).map((baseline) => baseline.parameter)).toEqual([1]);
    });

    it('tells a field apart from another field of the same parameter', () => {
      const before = payloadOf([
        { parameter: 1, values: [value({ bitMask: 0x0f, reportedAt: 1 }), value({ bitMask: 0xf0, reportedAt: 1 })] },
      ]);
      const token = tokenOf(before);
      const after = payloadOf([
        { parameter: 1, values: [value({ bitMask: 0x0f, reportedAt: 2 }), value({ bitMask: 0xf0, reportedAt: 1 })] },
      ]);

      expect(pendingOf(token, after).map((baseline) => baseline.bitMask)).toEqual([0xf0]);
    });

    it('tells two endpoints using one parameter number apart', () => {
      const before = payloadOf([
        { endpoint: 0, parameter: 1, values: [value({ reportedAt: 1 })] },
        { endpoint: 2, parameter: 1, values: [value({ reportedAt: 1 })] },
      ]);
      const token = tokenOf(before);
      const after = payloadOf([
        { endpoint: 0, parameter: 1, values: [value({ reportedAt: 5 })] },
        { endpoint: 2, parameter: 1, values: [value({ reportedAt: 1 })] },
      ]);

      expect(pendingOf(token, after).map((baseline) => baseline.endpoint)).toEqual([2]);
    });
  });

  describe('what the section is told', () => {
    const payload = payloadOf([{ parameter: 1, values: [value({ reportedAt: 1_000 })] }]);

    it('says nothing is happening when nothing has been asked', () => {
      expect(refreshStatus(null, payload)).toMatchObject({
        state: 'idle',
        asked: 0,
        pending: 0,
        canRequest: true,
      });
    });

    it('separates an attempt that is running from one that finished short', () => {
      /**
       * While the attempt runs there is reason to keep looking. Once it has settled with values
       * unanswered there is not, and another attempt is offered instead of an endless wait.
       */
      const running = tokenOf(payload);

      expect(refreshStatus(running, payload).state).toBe('dispatching');
      expect(refreshStatus({ ...running, dispatching: false }, payload).state).toBe('incomplete');
    });

    it('reports completion only when every value it asked about has answered', () => {
      const token = tokenOf(payload, { dispatching: false });
      const answered = payloadOf([{ parameter: 1, values: [value({ reportedAt: 2_000 })] }]);

      expect(refreshStatus(token, answered)).toMatchObject({ state: 'complete', pending: 0 });
    });

    it('says a device with nothing readable cannot be asked', () => {
      const unreadable = payloadOf([{ parameter: 1, values: [value({ readable: false })] }]);

      expect(refreshStatus(null, unreadable).canRequest).toBe(false);
    });
  });

  describe('when a request dispatches', () => {
    const payload = payloadOf([{ parameter: 1, values: [value()] }]);

    it('dispatches when nothing is running', () => {
      expect(shouldDispatch(null, 'abc')).toBe(true);
    });

    it('does not dispatch again while an attempt is running', () => {
      /**
       * A second dispatch would take its baselines from timestamps the running refresh has
       * already advanced, and then wait for a move it will never make again.
       */
      expect(shouldDispatch(tokenOf(payload), 'abc')).toBe(false);
    });

    it('dispatches again once the attempt has settled', () => {
      expect(shouldDispatch(tokenOf(payload, { dispatching: false }), 'abc')).toBe(true);
    });

    it('dispatches for different hardware on the same node number', () => {
      // Z-Wave gives a node number away again; a token for the old device answers for nothing.
      expect(shouldDispatch(tokenOf(payload), 'different')).toBe(true);
    });
  });
});
