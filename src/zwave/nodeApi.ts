/**
 * The decoded contents of a Battery CC Report as returned by the zwave-js Battery CC API.
 * The API hands back the parsed report itself, which still carries the level even in the cases
 * where zwave-js decides not to persist it.
 */
export interface BatteryReport {
  level?: number;
  chargingStatus?: number;
  rechargeable?: boolean;
  backup?: boolean;
  overheating?: boolean;
  lowFluid?: boolean;
  rechargeOrReplace?: number;
  disconnected?: boolean;
  lowTemperatureStatus?: boolean;
}

type BatteryApi = { get?: () => Promise<BatteryReport | undefined> };

/**
 * Command Class APIs are not part of the node interface so that node mocks stay small. These
 * accessors resolve them at runtime and return undefined when the source cannot serve the call.
 *
 * Pass the endpoint the caller serves, not the node: a multi-endpoint device can report Battery
 * CC on more than one endpoint, and the node resolves to endpoint 0 whatever the caller asked
 * for.
 */
export function getBatteryApi(
  source: { commandClasses?: Record<string, unknown> } | undefined,
): BatteryApi | undefined {
  const api = source?.commandClasses?.['Battery'] as BatteryApi | undefined;

  return typeof api?.get === 'function' ? api : undefined;
}
