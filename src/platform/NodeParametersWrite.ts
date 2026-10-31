import { ConfigValueFormat, getIntegerLimits } from '@zwave-js/core';
import type {
  AllowedValue,
  NodeParametersPayload,
  ParameterGroup,
  ParameterValue,
} from './NodeParametersPayload';

/**
 * Why a write was refused, in one word the page turns into a sentence.
 *
 * The driver's own wording for a refusal goes to the log. Nothing a device or a config file wrote
 * reaches the page through here, so the page has one sentence per code and no text to escape.
 */
export type WriteRefusal =
  | 'not-writable'
  | 'out-of-range'
  | 'not-permitted'
  | 'manual-entry-forbidden'
  | 'partial-incomplete'
  | 'definition-changed'
  | 'needs-acknowledgment';

/** What a caller asks to be written, as it arrives at the route. */
export interface ParameterWriteRequest {
  endpoint: number;
  parameter: number;
  bitMask: number | null;
  value: number;
  /** What the caller believed the parameter was, which a changed definition will not match. */
  expectedValueSize: number | null;
  expectedFormat: number | null;
  acknowledgeDestructive: boolean;
  acknowledgeRequiresReInclusion: boolean;
}

export type WriteCheck =
  | { ok: true; group: ParameterGroup; value: ParameterValue }
  | { ok: false; code: WriteRefusal };

const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value);

/** The parameter a request names, as the device describes it now rather than as the caller does. */
function liveGroup(
  payload: NodeParametersPayload,
  request: ParameterWriteRequest,
): ParameterGroup | undefined {
  return payload.groups.find(
    (group) => group.endpoint === request.endpoint && group.parameter === request.parameter,
  );
}

function liveValue(group: ParameterGroup, bitMask: number | null): ParameterValue | undefined {
  return group.values.find((value) => value.bitMask === bitMask);
}

/**
 * Whether writing one field of this parameter would leave the others as the device has them.
 *
 * zwave-js composes a partial write from the cached values of the sibling fields, starting from
 * zero: a field it has no value for contributes nothing, and so do the bits no field describes.
 * Writing one field of a parameter that does not compose completely would therefore write zeros
 * into its neighbors. `raw` is non-null only where the fields agree on one width, carry valid
 * masks that do not overlap, and cover every bit, so it answers the structural half of that
 * question; the values and their timestamps answer the rest.
 */
function composesCompletely(group: ParameterGroup): boolean {
  return (
    group.raw !== null &&
    group.values.length > 0 &&
    group.values.every((value) => isInteger(value.value) && typeof value.reportedAt === 'number')
  );
}

/**
 * Whether a number is one of the permitted entries, a range counting by its step.
 *
 * A range with no step, or a step of one, permits every number it covers. Any other step has to
 * be a positive whole number to mean anything, and a range whose step is not is dropped rather
 * than read as permitting everything: metadata that makes no sense must never widen what may be
 * written.
 */
function permitted(value: number, allowed: AllowedValue[]): boolean {
  return allowed.some((entry) => {
    if (entry.kind === 'value') {
      return entry.value === value;
    }
    /**
     * A configuration value is a whole number, so a range between fractions describes nothing a
     * device could be set to, and one that ends before it starts describes nothing at all.
     * Either is metadata that makes no sense, and nothing that makes no sense grants permission.
     */
    if (!isInteger(entry.from) || !isInteger(entry.to) || entry.from > entry.to) {
      return false;
    }
    if (value < entry.from || value > entry.to) {
      return false;
    }
    if (entry.step === null || entry.step === undefined || entry.step === 1) {
      return true;
    }
    if (!isInteger(entry.step) || entry.step < 1) {
      return false;
    }

    return (value - entry.from) % entry.step === 0;
  });
}

/**
 * Whether the number fits where it is going to be written.
 *
 * A whole parameter is bounded by its size and format, read with the driver's own limits so the
 * arithmetic cannot drift from the arithmetic that will encode it. The driver treats a missing
 * format as signed, and so does this.
 *
 * A field is bounded by its mask instead: the driver shifts the value into those bits, and a
 * number too large for them would be written truncated and silently mean something else. Only a
 * field spanning more than one bit can carry a sign, which is the rule the driver uses too.
 */
function fitsTheParameter(value: number, held: ParameterValue): boolean {
  if (held.bitMask !== null) {
    const shift = held.bitMask & -held.bitMask;
    const span = Math.floor(held.bitMask / shift);
    const width = span.toString(2).length;
    const signed = width > 1 && (held.format ?? ConfigValueFormat.SignedInteger) === ConfigValueFormat.SignedInteger;

    return signed
      ? value >= -(2 ** (width - 1)) && value <= 2 ** (width - 1) - 1
      : value >= 0 && value <= span;
  }

  if (!isInteger(held.valueSize) || held.valueSize < 1 || held.valueSize > 4) {
    // Without a size there is nothing to measure against, and the driver will work one out.
    return true;
  }

  const limits = getIntegerLimits(
    held.valueSize as 1 | 2 | 3 | 4,
    (held.format ?? ConfigValueFormat.SignedInteger) === ConfigValueFormat.SignedInteger,
  );

  return limits ? value >= limits.min && value <= limits.max : true;
}

/**
 * Whether the device will take this value for this parameter, judged against what it says now.
 *
 * Every rule here is applied to the live payload rather than to the caller's description of it.
 * A page is read once and acted on later, and a device that has been re-interviewed in between
 * can have changed what it permits; the caller's own account of the parameter is only used to
 * notice that it has moved.
 *
 * The driver checks size and format on its way out and nothing else. Meaning is this plugin's to
 * check, and it is checked before anything reaches the network.
 */
export function checkParameterWrite(
  payload: NodeParametersPayload,
  request: ParameterWriteRequest,
): WriteCheck {
  if (payload.state !== 'parameters') {
    return { ok: false, code: 'definition-changed' };
  }

  const group = liveGroup(payload, request);
  const value = group ? liveValue(group, request.bitMask) : undefined;
  if (!group || !value) {
    return { ok: false, code: 'definition-changed' };
  }

  if (value.valueSize !== request.expectedValueSize || value.format !== request.expectedFormat) {
    return { ok: false, code: 'definition-changed' };
  }

  if (!value.writable) {
    return { ok: false, code: 'not-writable' };
  }

  /**
   * Acknowledged by the boolean itself, not by anything that merely looks true. The body arrives
   * as parsed JSON and the types are gone by then, so a request carrying the string "false", a
   * 1, or an empty object would otherwise acknowledge a risk nobody was shown.
   */
  if (
    (value.destructive && request.acknowledgeDestructive !== true) ||
    (value.requiresReInclusion && request.acknowledgeRequiresReInclusion !== true)
  ) {
    return { ok: false, code: 'needs-acknowledgment' };
  }

  if (request.bitMask !== null && !composesCompletely(group)) {
    return { ok: false, code: 'partial-incomplete' };
  }

  if (!isInteger(request.value)) {
    return { ok: false, code: 'not-permitted' };
  }

  if (
    (isInteger(value.min) && request.value < value.min) ||
    (isInteger(value.max) && request.value > value.max)
  ) {
    return { ok: false, code: 'out-of-range' };
  }

  /**
   * A set the device stated is the whole of what it permits, and a set of none permits none: an
   * entry nobody could read must not leave the parameter open to anything.
   */
  if (value.allowed !== null && !permitted(request.value, value.allowed)) {
    return { ok: false, code: 'not-permitted' };
  }

  /**
   * A parameter that forbids manual entry is a list of named states and nothing else. The names
   * are what the device offered, so a number that is not among them was never on offer.
   */
  if (!value.allowManualEntry) {
    const named = value.states ? Object.keys(value.states) : [];
    if (!named.includes(String(request.value))) {
      return { ok: false, code: 'manual-entry-forbidden' };
    }
  }

  if (!fitsTheParameter(request.value, value)) {
    return { ok: false, code: 'out-of-range' };
  }

  return { ok: true, group, value };
}
