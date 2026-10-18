import { IZWaveNode } from '../zwave/interfaces';

/**
 * Some devices cannot be classified from their Command Classes alone, either because they
 * implement a generic CC for a specialised purpose or because they report status information
 * that does not match reality. Overrides are keyed on the Manufacturer Specific fingerprint so
 * the exception stays confined to the exact hardware it was verified against.
 */
export interface DeviceOverride {
  /** Manufacturer Specific manufacturer ID. */
  readonly manufacturerId: number;
  /** Manufacturer Specific product type. */
  readonly productType: number;
  /** Manufacturer Specific product ID. */
  readonly productId: number;
  /** Names the device in the log when an override changes what it publishes. */
  readonly label: string;
  /**
   * The device drives a window covering through Multilevel Switch CC because it does not
   * implement Window Covering CC.
   */
  readonly multilevelSwitchDrivesCovering?: true;
}

export const DEVICE_OVERRIDES: readonly DeviceOverride[] = [
  {
    manufacturerId: 0x026e,
    productType: 0x5253,
    productId: 0x5a31,
    label: 'Springs Window Fashions RSZ1 (Somfy Motorized Shade)',
    multilevelSwitchDrivesCovering: true,
  },
];

export function findDeviceOverride(node: IZWaveNode): DeviceOverride | undefined {
  const { manufacturerId, productType, productId } = node;
  if (manufacturerId === undefined || productType === undefined || productId === undefined) {
    return undefined;
  }

  return DEVICE_OVERRIDES.find(
    (override) =>
      override.manufacturerId === manufacturerId &&
      override.productType === productType &&
      override.productId === productId,
  );
}

/**
 * Decides whether a device's Multilevel Switch CC controls a covering instead of a light.
 *
 * Only a verified fingerprint qualifies. Reclassifying an accessory replaces its HomeKit service,
 * which breaks the automations built on the old one, so a guess drawn from the Specific Device
 * Class is not worth the damage it would do to the devices it got wrong.
 */
export function multilevelSwitchDrivesCovering(node: IZWaveNode): boolean {
  return Boolean(findDeviceOverride(node)?.multilevelSwitchDrivesCovering);
}
