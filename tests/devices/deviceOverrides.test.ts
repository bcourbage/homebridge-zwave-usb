import {
  DEVICE_OVERRIDES,
  findDeviceOverride,
  multilevelSwitchDrivesCovering,
} from '../../src/devices/deviceOverrides';
import { IZWaveNode } from '../../src/zwave/interfaces';

const RSZ1 = { manufacturerId: 0x026e, productType: 0x5253, productId: 0x5a31 };

const nodeWith = (fingerprint: Partial<typeof RSZ1>) => fingerprint as unknown as IZWaveNode;

describe('deviceOverrides', () => {
  it('matches the RSZ1 fingerprint', () => {
    const override = findDeviceOverride(nodeWith(RSZ1));

    expect(override?.label).toContain('RSZ1');
    expect(override?.multilevelSwitchDrivesCovering).toBe(true);
  });

  it('does not match a device that shares only part of the fingerprint', () => {
    expect(findDeviceOverride(nodeWith({ ...RSZ1, productId: 0x5a32 }))).toBeUndefined();
    expect(findDeviceOverride(nodeWith({ ...RSZ1, productType: 0x5643 }))).toBeUndefined();
    expect(findDeviceOverride(nodeWith({ ...RSZ1, manufacturerId: 0x0086 }))).toBeUndefined();
  });

  it('does not match a node whose fingerprint is not known yet', () => {
    expect(findDeviceOverride(nodeWith({}))).toBeUndefined();
  });

  it('treats the RSZ1 Multilevel Switch as a covering even without device class data', () => {
    expect(multilevelSwitchDrivesCovering(nodeWith(RSZ1))).toBe(true);
  });

  it('treats an ordinary dimmer Multilevel Switch as a light', () => {
    const dimmer = nodeWith({ manufacturerId: 0x0086, productType: 0x0003, productId: 0x0062 });

    expect(multilevelSwitchDrivesCovering(dimmer)).toBe(false);
  });

  it('does not reclassify a device that is not in the table', () => {
    // Reclassifying an accessory replaces the HomeKit service its automations were built on,
    // so only a fingerprint someone has verified qualifies.
    const unknownMotor = nodeWith({
      manufacturerId: 0x1234,
      productType: 0x0001,
      productId: 0x0001,
    });

    expect(multilevelSwitchDrivesCovering(unknownMotor)).toBe(false);
  });

  it('holds one entry per fingerprint', () => {
    // Lookup takes the first match, so a duplicate would silently shadow whatever follows it.
    const fingerprints = DEVICE_OVERRIDES.map(
      (override) => `${override.manufacturerId}:${override.productType}:${override.productId}`,
    );

    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });
});
