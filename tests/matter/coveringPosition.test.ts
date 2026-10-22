import {
  homeKitBatteryToMatterPercent,
  homeKitPositionToMatterLift,
  matterLiftToHomeKitPosition,
} from '../../src/matter/coveringPosition';

describe('Matter covering position conversion', () => {
  it('maps HomeKit fully open onto the Matter fully open value', () => {
    // The Matter spec has UpOrOpen set the lift target to 0.00%.
    expect(homeKitPositionToMatterLift(100)).toBe(0);
  });

  it('maps HomeKit fully closed onto the Matter fully closed value', () => {
    expect(homeKitPositionToMatterLift(0)).toBe(10000);
  });

  it('inverts intermediate positions', () => {
    expect(homeKitPositionToMatterLift(75)).toBe(2500);
    expect(homeKitPositionToMatterLift(25)).toBe(7500);
    expect(homeKitPositionToMatterLift(50)).toBe(5000);
  });

  it('reads Matter lift values back as HomeKit positions', () => {
    expect(matterLiftToHomeKitPosition(0)).toBe(100);
    expect(matterLiftToHomeKitPosition(10000)).toBe(0);
    expect(matterLiftToHomeKitPosition(2500)).toBe(75);
    expect(matterLiftToHomeKitPosition(7500)).toBe(25);
  });

  it('round-trips every whole HomeKit percentage', () => {
    for (let position = 0; position <= 100; position++) {
      expect(matterLiftToHomeKitPosition(homeKitPositionToMatterLift(position))).toBe(position);
    }
  });

  it('clamps values outside the valid range', () => {
    expect(homeKitPositionToMatterLift(140)).toBe(0);
    expect(homeKitPositionToMatterLift(-20)).toBe(10000);
    expect(matterLiftToHomeKitPosition(99999)).toBe(0);
    expect(matterLiftToHomeKitPosition(-5)).toBe(100);
  });

  it('treats a missing value as fully closed rather than throwing', () => {
    expect(homeKitPositionToMatterLift(Number.NaN)).toBe(0);
    expect(matterLiftToHomeKitPosition(Number.NaN)).toBe(0);
  });

  it('reports battery charge in the half-percent units Matter expects', () => {
    expect(homeKitBatteryToMatterPercent(100)).toBe(200);
    expect(homeKitBatteryToMatterPercent(84)).toBe(168);
    expect(homeKitBatteryToMatterPercent(0)).toBe(0);
    expect(homeKitBatteryToMatterPercent(150)).toBe(200);
  });
});
