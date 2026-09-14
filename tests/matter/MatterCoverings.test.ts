import { MatterCoverings } from '../../src/matter/MatterCoverings';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { ZWaveAccessory } from '../../src/accessories/ZWaveAccessory';

const WINDOW_COVERING_UUID = '0000008C-0000-1000-8000-0026BB765291';
const INFORMATION_UUID = '0000003E-0000-1000-8000-0026BB765291';
const BATTERY_UUID = '00000096-0000-1000-8000-0026BB765291';

describe('MatterCoverings', () => {
  let platform: any;
  let matter: any;
  let handleSetRequest: jest.Mock;
  let changeListeners: Array<(change: { newValue: unknown }) => void>;
  let batteryListeners: Array<(change: { newValue: unknown }) => void>;
  let currentPosition: number;
  let batteryLevel: number | null;
  let lowBattery: number;
  let holdSetRequest: jest.Mock;

  const createCoveringAccessory = (uuid = 'covering-uuid', displayName = "Nico's Shade") => {
    changeListeners = [];
    batteryListeners = [];
    currentPosition = 80;

    const C = platform.Characteristic;
    const entries: Array<[unknown, any]> = Object.entries({
      CurrentPosition: {
        get value() {
          return currentPosition;
        },
        on: (event: string, listener: (change: { newValue: unknown }) => void) => {
          if (event === 'change') {
            changeListeners.push(listener);
          }
        },
      },
      TargetPosition: { handleSetRequest },
      HoldPosition: { handleSetRequest: holdSetRequest },
      BatteryLevel: {
        get value() {
          return batteryLevel;
        },
        on: (event: string, listener: (change: { newValue: unknown }) => void) => {
          if (event === 'change') {
            batteryListeners.push(listener);
          }
        },
      },
      StatusLowBattery: {
        get value() {
          return lowBattery;
        },
        on: jest.fn(),
      },
      SerialNumber: { value: 'zwave-0x026E:0x5253:0x5A31-node-5' },
      Manufacturer: { value: 'Springs Window Fashions' },
      Model: { value: 'Somfy Motorized Shade' },
      FirmwareRevision: { value: '11.2' },
    }).map(([name, char]) => [(C as any)[name], char]);
    const characteristics = new Map<unknown, any>(entries);

    const covering = {
      UUID: WINDOW_COVERING_UUID,
      getCharacteristic: jest.fn((type: unknown) => characteristics.get(type)),
    };
    const information = {
      UUID: INFORMATION_UUID,
      getCharacteristic: jest.fn((type: unknown) => characteristics.get(type)),
    };
    const battery = {
      UUID: BATTERY_UUID,
      getCharacteristic: jest.fn((type: unknown) => characteristics.get(type)),
    };

    return {
      node: { nodeId: 5 },
      platformAccessory: {
        UUID: uuid,
        displayName,
        services: [information, covering, battery],
        getService: jest.fn(() => information),
      },
    } as unknown as ZWaveAccessory;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    handleSetRequest = jest.fn().mockResolvedValue(undefined);
    holdSetRequest = jest.fn().mockResolvedValue(undefined);
    batteryLevel = 84;
    lowBattery = 0;

    class MatterFailure extends Error {}
    class MatterNotFound extends Error {}

    matter = {
      deviceTypes: { WindowCovering: { name: 'WindowCoveringDevice' } },
      status: { Failure: MatterFailure, NotFound: MatterNotFound },
      unregisterPlatformAccessories: jest.fn().mockResolvedValue(undefined),
      registerPlatformAccessories: jest.fn().mockResolvedValue(undefined),
      updateAccessoryState: jest.fn().mockResolvedValue(undefined),
    };

    platform = {
      log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      api: { matter },
      Service: {
        WindowCovering: { UUID: WINDOW_COVERING_UUID },
        AccessoryInformation: { UUID: INFORMATION_UUID },
        Battery: { UUID: BATTERY_UUID },
      },
      Characteristic: {
        CurrentPosition: 'CurrentPosition',
        TargetPosition: 'TargetPosition',
        SerialNumber: 'SerialNumber',
        Manufacturer: 'Manufacturer',
        Model: 'Model',
        FirmwareRevision: 'FirmwareRevision',
        HoldPosition: 'HoldPosition',
        BatteryLevel: 'BatteryLevel',
        StatusLowBattery: { BATTERY_LEVEL_NORMAL: 0, BATTERY_LEVEL_LOW: 1 },
      },
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const publish = async (coverings: MatterCoverings, accessory: ZWaveAccessory) => {
    coverings.add(accessory);
    await jest.advanceTimersByTimeAsync(4000);
  };

  it('publishes a covering as a Matter WindowCovering device', async () => {
    const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);

    await publish(coverings, createCoveringAccessory());

    expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    const [pluginId, platformName, descriptors] = matter.registerPlatformAccessories.mock.calls[0];
    expect(pluginId).toBe('homebridge-zwave-usb');
    expect(platformName).toBe('ZWaveUSB');
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      UUID: 'covering-uuid',
      displayName: "Nico's Shade",
      deviceType: matter.deviceTypes.WindowCovering,
      manufacturer: 'Springs Window Fashions',
      model: 'Somfy Motorized Shade',
      firmwareRevision: '11.2',
    });
  });

  it('reports the current position with Matter polarity', async () => {
    const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);

    await publish(coverings, createCoveringAccessory());

    // HomeKit 80% open is Matter 20.00% closed.
    const cluster = matter.registerPlatformAccessories.mock.calls[0][2][0].clusters.windowCovering;
    expect(cluster.currentPositionLiftPercent100ths).toBe(2000);
    expect(cluster.configStatus.liftPositionAware).toBe(true);
  });

  it('batches several coverings into one registration', async () => {
    const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);

    coverings.add(createCoveringAccessory('nico', "Nico's Shade"));
    coverings.add(createCoveringAccessory('lia', "Lia's Shade"));
    await jest.advanceTimersByTimeAsync(4000);

    expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    expect(matter.registerPlatformAccessories.mock.calls[0][2]).toHaveLength(2);
  });

  it('shortens an over-long serial number to what Matter accepts', async () => {
    const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);

    await publish(coverings, createCoveringAccessory());

    const descriptor = matter.registerPlatformAccessories.mock.calls[0][2][0];
    expect(descriptor.serialNumber.length).toBeLessThanOrEqual(32);
    // The node ID is what distinguishes two shades of the same model, so it must survive.
    expect(descriptor.serialNumber.endsWith('node-5')).toBe(true);
  });

  it('keeps the Matter target distinct from the position while the covering travels', async () => {
    const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);
    await publish(coverings, createCoveringAccessory());

    matter.updateAccessoryState.mockClear();
    // An intermediate travel report must not be mistaken for the commanded target.
    changeListeners.forEach((listener) => listener({ newValue: 62 }));

    const pushed = matter.updateAccessoryState.mock.calls.map(
      ([, , attributes]: [unknown, unknown, Record<string, unknown>]) => attributes,
    );
    expect(pushed).toContainEqual({ currentPositionLiftPercent100ths: 3800 });
    expect(
      pushed.some((a: Record<string, unknown>) => 'targetPositionLiftPercent100ths' in a),
    ).toBe(false);
  });

  it('removes an accessory from Matter when its node leaves the network', async () => {
    const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);
    const accessory = createCoveringAccessory();
    await publish(coverings, accessory);

    await coverings.remove('covering-uuid');

    expect(matter.unregisterPlatformAccessories).toHaveBeenCalledWith(
      'homebridge-zwave-usb',
      'ZWaveUSB',
      [expect.objectContaining({ UUID: 'covering-uuid' })],
    );

    // The UUID is free again, so a node re-included with the same id can be published.
    await publish(coverings, createCoveringAccessory());
    expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(2);
  });

  it('never publishes the same accessory twice', async () => {
    const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);
    const accessory = createCoveringAccessory();

    await publish(coverings, accessory);
    await publish(coverings, accessory);

    expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
  });

  it('ignores accessories that are not coverings', async () => {
    const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);
    const light = {
      node: { nodeId: 7 },
      platformAccessory: {
        UUID: 'light',
        displayName: 'A Dimmer',
        services: [{ UUID: '00000043-0000-1000-8000-0026BB765291' }],
        getService: jest.fn(),
      },
    } as unknown as ZWaveAccessory;

    await publish(coverings, light);

    expect(matter.registerPlatformAccessories).not.toHaveBeenCalled();
  });

  it('does nothing when the bridge has no Matter support', async () => {
    platform.api = {};
    const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);

    await publish(coverings, createCoveringAccessory());

    expect(matter.registerPlatformAccessories).not.toHaveBeenCalled();
  });

  it('keeps HomeKit working when Matter registration fails', async () => {
    matter.registerPlatformAccessories.mockRejectedValue(new Error('matter is not ready'));
    const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);

    await expect(publish(coverings, createCoveringAccessory())).resolves.toBeUndefined();
    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not publish 1 covering(s) over Matter'),
    );
  });

  describe('commands', () => {
    const handlers = () =>
      matter.registerPlatformAccessories.mock.calls[0][2][0].handlers.windowCovering;

    it('routes an absolute Matter position through the HomeKit characteristic', async () => {
      const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      // Matter 75.00% closed is HomeKit 25% open.
      await handlers().goToLiftPercentage({ liftPercent100thsValue: 7500 });

      expect(handleSetRequest).toHaveBeenCalledWith(25);
    });

    it('opens fully on UpOrOpen and closes fully on DownOrClose', async () => {
      const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      await handlers().upOrOpen();
      expect(handleSetRequest).toHaveBeenCalledWith(100);

      await handlers().downOrClose();
      expect(handleSetRequest).toHaveBeenCalledWith(0);
    });

    it('routes stopMotion through HomeKit HoldPosition', async () => {
      const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      await handlers().stopMotion();

      expect(holdSetRequest).toHaveBeenCalledWith(true);
      // A stop must not also be sent as a position.
      expect(handleSetRequest).not.toHaveBeenCalled();
    });

    it('reports a failed stop to the Matter controller as a failure', async () => {
      holdSetRequest.mockRejectedValue(new Error('device did not respond'));
      const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      await expect(handlers().stopMotion()).rejects.toBeInstanceOf(matter.status.Failure);
      expect(platform.log.error).toHaveBeenCalledWith(
        expect.stringContaining('Matter stop request failed'),
      );
    });

    it('reports a failed write to the Matter controller as a failure', async () => {
      handleSetRequest.mockRejectedValue(new Error('device did not respond'));
      const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      /**
       * Resolving here would have the controller confirm a move that never happened, while the
       * same command from HomeKit correctly reports a communication failure.
       */
      await expect(handlers().upOrOpen()).rejects.toBeInstanceOf(matter.status.Failure);
      expect(platform.log.error).toHaveBeenCalledWith(
        expect.stringContaining('position request failed'),
      );
    });
  });

  describe('battery', () => {
    const powerSource = () =>
      matter.registerPlatformAccessories.mock.calls[0][2][0].clusters.powerSource;

    it('publishes the battery as a Matter power source in half-percent units', async () => {
      const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      // Matter reports battery charge in half-percent units, so 84% is 168.
      expect(powerSource()).toMatchObject({
        batPresent: true,
        batPercentRemaining: 168,
        batChargeLevel: 0,
      });
    });

    it('declares the static battery facts even with no reading yet', async () => {
      // Homebridge composes the Battery feature from the attributes present at registration, so
      // a shade whose battery pack is out must still register as battery powered.
      batteryLevel = null;
      const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      expect(powerSource()).toMatchObject({ batPresent: true, batReplaceability: 2 });
      // Unknown is reported as unknown rather than as an invented percentage.
      expect(powerSource().batPercentRemaining).toBeNull();
    });

    it('reports a low battery as a charge warning', async () => {
      lowBattery = 1;
      const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      expect(powerSource().batChargeLevel).toBe(1);
    });

    it('omits the power source for an accessory with no battery service', async () => {
      const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);
      const accessory = createCoveringAccessory();
      (accessory.platformAccessory as any).services = (
        accessory.platformAccessory as any
      ).services.filter((s: any) => s.UUID !== BATTERY_UUID);

      await publish(coverings, accessory);

      expect(powerSource()).toBeUndefined();
    });

    it('mirrors later battery readings back to Matter', async () => {
      const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      expect(batteryListeners).toHaveLength(1);
      batteryListeners[0]({ newValue: 50 });

      expect(matter.updateAccessoryState).toHaveBeenCalledWith('covering-uuid', 'powerSource', {
        batPercentRemaining: 100,
      });
    });
  });

  it('mirrors later position changes back to Matter', async () => {
    const coverings = new MatterCoverings(platform as ZWaveUsbPlatform);
    await publish(coverings, createCoveringAccessory());

    expect(changeListeners).toHaveLength(1);
    changeListeners[0]({ newValue: 25 });

    expect(matter.updateAccessoryState).toHaveBeenCalledWith(
      'covering-uuid',
      'windowCovering',
      expect.objectContaining({ currentPositionLiftPercent100ths: 7500 }),
    );
  });
});
