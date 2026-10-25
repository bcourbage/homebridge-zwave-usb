import { ServiceMapping } from './serviceMappings';

interface BehaviorType {
  with(...features: string[]): unknown;
}
interface DeviceType {
  requirements?: Record<string, BehaviorType>;
  behaviors?: Record<string, unknown>;
  with(...behaviors: unknown[]): DeviceType;
}

/** Compose only public host-provided servers; no dependency on a second Matter.js runtime. */
export function composeDeviceType(
  mapping: ServiceMapping,
  types: Record<string, unknown>,
): unknown {
  let type = types[mapping.deviceType] as DeviceType;
  if (!mapping.composition || Object.keys(mapping.composition).length === 0) return type;
  const requirements = (types.AirQualitySensor as DeviceType | undefined)?.requirements;
  const servers = Object.entries(mapping.composition).map(([name, features]) => {
    const server = requirements?.[name];
    if (!server) throw new Error(`Homebridge Matter does not provide ${name}`);
    return server.with(...features);
  });
  type = type.with(...servers);
  return type;
}

/**
 * Homebridge 2.4 restores base device types from names. Its re-registration shape check
 * compares root server names, but not child server composition or feature flags. Explicitly
 * compose the root's required bridged-info server whenever any service has optional servers.
 * The public shape check then rebuilds the restored graph with the requested composition,
 * preserving accessory UUID and child IDs instead of attaching to incomplete cached parts.
 */
export function composeBridgedRoot(
  type: unknown,
  mappings: ServiceMapping[],
  types: Record<string, unknown>,
): unknown {
  if (
    !mappings.some((mapping) => mapping.composition && Object.keys(mapping.composition).length > 0)
  )
    return type;
  const info = (types.BridgedNode as DeviceType | undefined)?.behaviors
    ?.bridgedDeviceBasicInformation;
  if (!info) throw new Error('Homebridge Matter does not provide the bridged information server');
  return (type as DeviceType).with(info);
}
