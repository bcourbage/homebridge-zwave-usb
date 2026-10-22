import { ValueID } from 'zwave-js';
import { CommandClasses } from '@zwave-js/core';
import { IZWaveNode } from './interfaces';

/**
 * Multilevel Switch CC names its start/stop actions after the switch type, so a covering exposes
 * a pair such as Down/Up or Close/Open. Writing false to any of them stops movement.
 */
const MULTILEVEL_SWITCH_ACTIONS = [
  'Off',
  'On',
  'Down',
  'Up',
  'Close',
  'Open',
  'CCW',
  'CW',
  'Left',
  'Right',
  'Reverse',
  'Forward',
  'Pull',
  'Push',
];

/** Window Covering CC names them after the direction instead. */
const WINDOW_COVERING_ACTIONS = ['levelChangeUp', 'levelChangeDown'];

type PositionProperty = 'currentValue' | 'targetValue';

function readCoveringValue(
  node: IZWaveNode,
  endpointIndex: number,
  property: PositionProperty,
): unknown {
  const plainCovering = node.getValue({
    commandClass: CommandClasses['Window Covering'],
    property,
    endpoint: endpointIndex,
  });
  if (plainCovering !== undefined) {
    return plainCovering;
  }

  /**
   * Window Covering CC keys every value by parameter, so the shape above cannot resolve one.
   * The parameter is whichever this covering actually defines, and position, target and
   * duration all share it. This is tried before the Multilevel Switch read because a device
   * implementing both is described by the more specific command class, the same order every
   * other lookup here uses.
   */
  const keyed = findCoveringPositionValueId(node, endpointIndex);
  if (keyed?.propertyKey !== undefined) {
    const keyedValue = node.getValue({
      commandClass: keyed.commandClass,
      property,
      propertyKey: keyed.propertyKey,
      endpoint: endpointIndex,
    });
    if (keyedValue !== undefined) {
      return keyedValue;
    }
  }

  return node.getValue({
    commandClass: CommandClasses['Multilevel Switch'],
    property,
    endpoint: endpointIndex,
  });
}

/** Reads a position as a HomeKit percentage, mapping the Z-Wave maximum of 99 onto 100. */
export function readCoveringPosition(
  node: IZWaveNode,
  endpointIndex: number,
  property: PositionProperty,
): number | undefined {
  const value = readCoveringValue(node, endpointIndex, property);
  if (typeof value !== 'number') {
    return undefined;
  }

  return value === 99 ? 100 : value;
}

/**
 * The ValueID the device actually defines for its current position.
 *
 * Window Covering CC keys every value by parameter, so a bare {commandClass, property} shape
 * cannot be resolved there and the driver rejects a poll built from it. Multilevel Switch CC
 * needs no key, so for that CC the plain shape is correct and this returning undefined is not
 * a problem for the caller.
 */
export function findCoveringPositionValueId(
  node: IZWaveNode,
  endpointIndex: number,
): ValueID | undefined {
  if (typeof node.getDefinedValueIDs !== 'function') {
    return undefined;
  }

  const defined = node
    .getDefinedValueIDs()
    .filter(
      (valueId) => (valueId.endpoint ?? 0) === endpointIndex && valueId.property === 'currentValue',
    );

  // Window Covering CC is the more specific description of a covering, so prefer it.
  return (
    defined.find((valueId) => valueId.commandClass === CommandClasses['Window Covering']) ??
    defined.find((valueId) => valueId.commandClass === CommandClasses['Multilevel Switch'])
  );
}

/**
 * Finds a value the device accepts as "stop moving". Both covering command classes model this as
 * a level-change action that is stopped by writing false, so the value ID is looked up among the
 * ones the device actually reports rather than assumed from the command class.
 */
export function findCoveringStopValueId(
  node: IZWaveNode,
  endpointIndex: number,
): ValueID | undefined {
  if (typeof node.getDefinedValueIDs !== 'function') {
    return undefined;
  }

  const selected = findCoveringPositionValueId(node, endpointIndex);
  const candidates = node.getDefinedValueIDs().filter((valueId) => {
    if ((valueId.endpoint ?? 0) !== endpointIndex || typeof valueId.property !== 'string') {
      return false;
    }

    if (valueId.commandClass === CommandClasses['Window Covering']) {
      return (
        WINDOW_COVERING_ACTIONS.includes(valueId.property) &&
        (selected?.commandClass !== CommandClasses['Window Covering'] ||
          valueId.propertyKey === selected.propertyKey)
      );
    }

    return (
      valueId.commandClass === CommandClasses['Multilevel Switch'] &&
      MULTILEVEL_SWITCH_ACTIONS.includes(valueId.property)
    );
  });

  // Do not stop a different axis through a generic switch when the selected native
  // parameter has no stop action of its own.
  const native = candidates.find(
    (valueId) => valueId.commandClass === CommandClasses['Window Covering'],
  );
  return selected?.commandClass === CommandClasses['Window Covering']
    ? native
    : (native ?? candidates[0]);
}
