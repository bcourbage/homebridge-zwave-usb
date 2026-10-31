import type { NodeParametersPayload, ParameterValue } from './NodeParametersPayload';

/** One value a refresh asked about, and what it said before the asking. */
export interface RefreshBaseline {
  endpoint: number;
  parameter: number;
  bitMask: number | null;
  /** What `getValueTimestamp` said at dispatch, or null where it said nothing. */
  reportedAt: number | null;
}

export interface RefreshToken {
  nodeId: number;
  /** The hardware it was dispatched for, so it cannot outlive a device swap on the same number. */
  fingerprint: string | null;
  requestedAt: number;
  /** True until the attempt settles. Settling says the attempt finished, never that a value came. */
  dispatching: boolean;
  baselines: RefreshBaseline[];
}

export type RefreshState = 'idle' | 'dispatching' | 'incomplete' | 'complete';

export interface RefreshStatus {
  state: RefreshState;
  requestedAt: number | null;
  /** How many of the values it asked about have not answered yet. */
  pending: number;
  /** How many it asked about at all. */
  asked: number;
  /** False where the device has nothing a refresh could confirm. */
  canRequest: boolean;
}

const keyOf = (endpoint: number, parameter: number, bitMask: number | null) =>
  `${endpoint}:${parameter}:${bitMask ?? ''}`;

/**
 * The values a refresh can confirm.
 *
 * Only a readable value can ever answer: zwave-js's Configuration refresh skips write-only
 * parameters outright, so waiting on one would wait forever. The payload has already left a
 * whole-parameter value beside fields out of the group, so nothing here can ask about one.
 */
export function refreshableValues(
  payload: NodeParametersPayload,
): { endpoint: number; parameter: number; value: ParameterValue }[] {
  return payload.groups.flatMap((group) =>
    group.values
      .filter((value) => value.readable)
      .map((value) => ({ endpoint: group.endpoint, parameter: group.parameter, value })),
  );
}

export function canRefresh(payload: NodeParametersPayload): boolean {
  return payload.state === 'parameters' && refreshableValues(payload).length > 0;
}

/**
 * What each refreshable value said at the moment of asking.
 *
 * Taken at dispatch rather than read back later, because the question a refresh answers is whether
 * a value has moved since it was asked for, and nothing else establishes that.
 */
export function baselinesFor(payload: NodeParametersPayload): RefreshBaseline[] {
  return refreshableValues(payload).map(({ endpoint, parameter, value }) => ({
    endpoint,
    parameter,
    bitMask: value.bitMask,
    reportedAt: value.reportedAt,
  }));
}

/**
 * Which of a token's values have still not answered.
 *
 * A value has answered when its timestamp becomes known having been unknown, or moves past the one
 * it carried at dispatch. A value that has since disappeared, or that has turned unreadable, is
 * dropped rather than held open: neither will ever answer, and a pending set that cannot empty
 * would leave the section waiting for ever.
 *
 * A value that appeared after the dispatch is not here at all, because the refresh never asked
 * about it.
 */
export function pendingOf(token: RefreshToken, payload: NodeParametersPayload): RefreshBaseline[] {
  const current = new Map<string, ParameterValue>();

  for (const group of payload.groups) {
    for (const value of group.values) {
      current.set(keyOf(group.endpoint, group.parameter, value.bitMask), value);
    }
  }

  return token.baselines.filter((baseline) => {
    const value = current.get(keyOf(baseline.endpoint, baseline.parameter, baseline.bitMask));

    if (!value || !value.readable) {
      return false;
    }
    if (value.reportedAt === null) {
      return true;
    }
    if (baseline.reportedAt === null) {
      return false;
    }

    return value.reportedAt <= baseline.reportedAt;
  });
}

/**
 * What the section says about the refresh.
 *
 * `dispatching` and `incomplete` are different things. While the attempt runs there is reason to
 * keep looking; once it has settled with values still unanswered there is not, and the reader is
 * offered another attempt instead of a wait that will not end.
 */
export function refreshStatus(
  token: RefreshToken | null,
  payload: NodeParametersPayload,
): RefreshStatus {
  const available = canRefresh(payload);

  if (!token) {
    return { state: 'idle', requestedAt: null, pending: 0, asked: 0, canRequest: available };
  }

  const pending = pendingOf(token, payload);
  const state: RefreshState = token.dispatching
    ? 'dispatching'
    : pending.length > 0
      ? 'incomplete'
      : 'complete';

  return {
    state,
    requestedAt: token.requestedAt,
    pending: pending.length,
    asked: token.baselines.length,
    canRequest: available,
  };
}

/**
 * Whether a request should dispatch, or be answered with the attempt already running.
 *
 * Replacing a running token's baselines would make one that can never complete: a refresh already
 * past parameter 1 has left its timestamp advanced, and a baseline taken from that advanced
 * timestamp waits for a move the refresh will not make again. So a request arriving while one is
 * running is the same request, and only a settled attempt can be retried.
 */
export function shouldDispatch(token: RefreshToken | null, fingerprint: string | null): boolean {
  if (!token) {
    return true;
  }
  if (token.fingerprint !== fingerprint) {
    return true;
  }

  return !token.dispatching;
}
