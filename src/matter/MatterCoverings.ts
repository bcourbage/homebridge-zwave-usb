import { Characteristic, PlatformAccessory, Service } from 'homebridge';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { ZWaveAccessory } from '../accessories/ZWaveAccessory';
import {
  homeKitBatteryToMatterPercent,
  homeKitPositionToMatterLift,
  matterLiftToHomeKitPosition,
} from './coveringPosition';
import { matterLabel, matterSerialNumber } from './matterText';

/**
 * The parts of Homebridge's Matter API this plugin uses. It is declared here rather than
 * imported because `api.matter` only exists on Homebridge 2 and the plugin still supports
 * Homebridge 1, where the property is simply absent.
 */
/** The status errors a cluster handler throws to report a failure to the controller. */
interface MatterStatusErrors {
  Failure: new (message?: string) => Error;
  NotFound: new (message?: string) => Error;
}

interface MatterApi {
  deviceTypes: Record<string, unknown>;
  status: MatterStatusErrors;
  registerPlatformAccessories(
    pluginIdentifier: string,
    platformName: string,
    accessories: MatterAccessoryDescriptor[],
  ): Promise<unknown>;
  updateAccessoryState(
    uuid: string,
    cluster: string,
    attributes: Record<string, unknown>,
  ): Promise<unknown>;
  unregisterPlatformAccessories(
    pluginIdentifier: string,
    platformName: string,
    accessories: MatterAccessoryDescriptor[],
  ): Promise<unknown>;
}

interface MatterAccessoryDescriptor {
  UUID: string;
  displayName: string;
  deviceType: unknown;
  serialNumber: string;
  manufacturer: string;
  model: string;
  firmwareRevision?: string;
  context: Record<string, unknown>;
  clusters: Record<string, Record<string, unknown>>;
  handlers: Record<string, Record<string, (request?: never) => Promise<void> | void>>;
}

/** Matter's WindowCovering command payload for an absolute lift position. */
interface GoToLiftPercentageRequest {
  liftPercent100thsValue: number;
}

const WINDOW_COVERING_CLUSTER = 'windowCovering';
const POWER_SOURCE_CLUSTER = 'powerSource';

/** PowerSource.BatChargeLevel */
const BAT_CHARGE_OK = 0;
const BAT_CHARGE_WARNING = 1;

/**
 * How long to wait after an accessory becomes ready before publishing. Nodes finish their
 * interviews within moments of each other at startup, and Matter accessories are registered in
 * one batch rather than one call per node.
 */
const PUBLISH_DEBOUNCE_MS = 3000;

/**
 * Publishes covering accessories over Matter so controllers that cannot speak HomeKit, such as
 * Alexa, can operate them.
 *
 * Commands are routed through the same HomeKit characteristic the Home app writes to, so a Matter
 * request goes through the same command coalescing, encoding and position reconciliation as a
 * HomeKit one. Nothing here talks to Z-Wave directly.
 */
export class MatterCoverings {
  private readonly published = new Set<string>();
  /** Descriptors of what was registered, so an accessory can be unregistered again. */
  private readonly descriptors = new Map<string, MatterAccessoryDescriptor>();
  /** UUIDs Homebridge restored from its own Matter cache, which have to be reconciled. */
  private readonly cached = new Map<string, MatterAccessoryDescriptor>();
  /** Per-accessory detach callbacks for the HomeKit listeners that mirror state into Matter. */
  private readonly trackers = new Map<string, Array<() => void>>();
  /** The accessory instance each published UUID is currently mirroring. */
  private readonly tracked = new Map<string, ZWaveAccessory>();
  private readonly pending = new Map<string, ZWaveAccessory>();
  private publishTimer?: NodeJS.Timeout;

  constructor(private readonly platform: ZWaveUsbPlatform) {}

  private get matter(): MatterApi | undefined {
    return (this.platform.api as unknown as { matter?: MatterApi }).matter;
  }

  public stop(): void {
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = undefined;
    }
    this.pending.clear();
    [...this.trackers.keys()].forEach((uuid) => this.untrack(uuid));
  }

  /**
   * Records a Matter accessory Homebridge restored from its own cache. Anything still recorded
   * once the network has been discovered belongs to a node that is gone, so it is removed rather
   * than left in the controller as a device that no longer answers.
   */
  public configureCachedAccessory(descriptor: { UUID: string; displayName: string }): void {
    this.cached.set(descriptor.UUID, descriptor as MatterAccessoryDescriptor);
  }

  /** Removes an accessory from Matter, so an excluded node does not linger in the controller. */
  public async remove(uuid: string): Promise<void> {
    this.pending.delete(uuid);
    this.untrack(uuid);
    this.published.delete(uuid);

    const descriptor = this.descriptors.get(uuid) ?? this.cached.get(uuid);
    this.descriptors.delete(uuid);
    this.cached.delete(uuid);

    if (!descriptor || !this.matter) {
      return;
    }

    try {
      await this.matter.unregisterPlatformAccessories('homebridge-zwave-usb', 'ZWaveUSB', [
        descriptor,
      ]);
    } catch (err) {
      this.platform.log.warn(
        `Could not remove ${descriptor.displayName} from Matter: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Queues an accessory for publication. Safe to call repeatedly: an accessory is only ever
   * published once, and a node that is not a covering is ignored.
   */
  public add(accessory: ZWaveAccessory): void {
    if (!this.matter) {
      return;
    }

    const uuid = accessory.platformAccessory.UUID;
    if (!this.findCoveringService(accessory.platformAccessory)) {
      return;
    }

    if (this.published.has(uuid)) {
      if (this.tracked.get(uuid) === accessory) {
        return;
      }

      /**
       * The accessory object was rebuilt, so the registered handlers close over a stopped one.
       * Dropping the registration lets it be published again against the live accessory.
       */
      this.untrack(uuid);
      this.published.delete(uuid);
    }

    this.pending.set(uuid, accessory);

    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
    }
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      void this.publishPending();
    }, PUBLISH_DEBOUNCE_MS);
    this.publishTimer.unref();
  }

  private findCoveringService(platformAccessory: PlatformAccessory): Service | undefined {
    const coveringType = this.platform.Service.WindowCovering as unknown as { UUID?: string };
    if (!coveringType?.UUID) {
      return undefined;
    }

    return platformAccessory.services.find((service) => service.UUID === coveringType.UUID);
  }

  private async publishPending(): Promise<void> {
    const matter = this.matter;
    if (!matter || this.pending.size === 0) {
      return;
    }

    const queued = [...this.pending.values()];
    this.pending.clear();

    const descriptors: MatterAccessoryDescriptor[] = [];
    const registered: ZWaveAccessory[] = [];

    for (const accessory of queued) {
      const descriptor = this.describe(accessory, matter);
      if (descriptor) {
        descriptors.push(descriptor);
        registered.push(accessory);
        this.descriptors.set(descriptor.UUID, descriptor);
      }
    }

    if (descriptors.length === 0) {
      return;
    }

    try {
      await matter.registerPlatformAccessories('homebridge-zwave-usb', 'ZWaveUSB', descriptors);
    } catch (err) {
      /**
       * Matter is optional. A bridge without it, or a registration the server rejects, must not
       * disturb the HomeKit accessories that are already working.
       */
      this.platform.log.warn(
        `Could not publish ${descriptors.length} covering(s) over Matter: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    for (const accessory of registered) {
      const uuid = accessory.platformAccessory.UUID;
      this.published.add(uuid);
      this.cached.delete(uuid);
      this.tracked.set(uuid, accessory);
      this.trackPosition(accessory);
      this.trackBattery(accessory);
    }

    /**
     * The Matter server accepts the accessories asynchronously and reports its own failures, so
     * this records what was handed over rather than claiming the devices are live.
     */
    this.platform.log.info(
      `Handed ${descriptors.length} covering(s) to Matter: ` +
        registered.map((accessory) => accessory.platformAccessory.displayName).join(', '),
    );
  }

  private describe(
    accessory: ZWaveAccessory,
    matter: MatterApi,
  ): MatterAccessoryDescriptor | undefined {
    const platformAccessory = accessory.platformAccessory;
    const service = this.findCoveringService(platformAccessory);
    const deviceType = matter.deviceTypes?.WindowCovering;

    if (!service || !deviceType) {
      return undefined;
    }

    const information = this.readAccessoryInformation(platformAccessory);
    const position = this.readPosition(service) ?? 0;
    const lift = homeKitPositionToMatterLift(position);
    const targetLift = homeKitPositionToMatterLift(this.readTargetPosition(service) ?? position);
    const battery = this.describeBattery(platformAccessory);

    return {
      UUID: platformAccessory.UUID,
      displayName: matterLabel(platformAccessory.displayName),
      deviceType,
      serialNumber: matterSerialNumber(information.serialNumber),
      manufacturer: matterLabel(information.manufacturer),
      model: matterLabel(information.model),
      firmwareRevision: information.firmwareRevision,
      context: { nodeId: accessory.node.nodeId },
      clusters: {
        [WINDOW_COVERING_CLUSTER]: {
          type: 0, // Rollershade
          endProductType: 0,
          configStatus: { operational: true, online: true, liftPositionAware: true },
          currentPositionLiftPercent100ths: lift,
          targetPositionLiftPercent100ths: targetLift,
        },
        ...(battery ? { [POWER_SOURCE_CLUSTER]: battery } : {}),
      },
      handlers: {
        [WINDOW_COVERING_CLUSTER]: {
          goToLiftPercentage: (request?: never) => {
            const { liftPercent100thsValue } = (request ??
              {}) as unknown as GoToLiftPercentageRequest;
            return this.requestPosition(
              accessory,
              matterLiftToHomeKitPosition(liftPercent100thsValue),
            );
          },
          upOrOpen: () => this.requestPosition(accessory, 100),
          downOrClose: () => this.requestPosition(accessory, 0),
          stopMotion: () => this.requestStop(accessory),
        },
      },
    };
  }

  private findBatteryService(platformAccessory: PlatformAccessory): Service | undefined {
    const batteryType = this.platform.Service.Battery as unknown as { UUID?: string };
    if (!batteryType?.UUID) {
      return undefined;
    }

    return platformAccessory.services.find((service) => service.UUID === batteryType.UUID);
  }

  /**
   * Describes the covering's battery for Matter.
   *
   * The static facts are always declared, even when no reading has arrived yet. Homebridge
   * decides whether to compose the Battery feature from the attributes present at registration,
   * so a power source declared without them would reject the device's first real reading for the
   * rest of the process. A missing level is reported as unknown rather than invented.
   */
  private describeBattery(
    platformAccessory: PlatformAccessory,
  ): Record<string, unknown> | undefined {
    const service = this.findBatteryService(platformAccessory);
    if (!service) {
      return undefined;
    }

    const level = this.readBatteryLevel(service);

    return {
      status: 1, // Active
      order: 0,
      description: 'Battery',
      batPresent: true,
      batReplaceability: 2, // User replaceable
      batChargeLevel: this.readBatteryChargeLevel(service),
      batPercentRemaining: level === undefined ? null : homeKitBatteryToMatterPercent(level),
    };
  }

  private readBatteryLevel(service: Service): number | undefined {
    const value = service.getCharacteristic(this.platform.Characteristic.BatteryLevel)?.value;
    return typeof value === 'number' ? value : undefined;
  }

  private readBatteryChargeLevel(service: Service): number {
    const low = service.getCharacteristic(this.platform.Characteristic.StatusLowBattery)?.value;

    return low === this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      ? BAT_CHARGE_WARNING
      : BAT_CHARGE_OK;
  }

  /**
   * Stops the covering through HomeKit's HoldPosition, which is the same route the Home app's
   * stop control takes.
   */
  private async requestStop(accessory: ZWaveAccessory): Promise<void> {
    const service = this.findCoveringService(accessory.platformAccessory);
    if (!service) {
      return;
    }

    this.platform.log.debug(`Matter requested stop for ${accessory.platformAccessory.displayName}`);

    await this.writeCharacteristic(
      service,
      this.platform.Characteristic.HoldPosition,
      true,
      accessory,
      'stop request',
    );
  }

  private readAccessoryInformation(platformAccessory: PlatformAccessory): {
    serialNumber: string;
    manufacturer: string;
    model: string;
    firmwareRevision?: string;
  } {
    const info = platformAccessory.getService(this.platform.Service.AccessoryInformation);
    const read = (characteristic: typeof Characteristic.SerialNumber, fallback: string) => {
      const value = info?.getCharacteristic(characteristic)?.value;
      return typeof value === 'string' && value.length > 0 ? value : fallback;
    };

    return {
      serialNumber: read(this.platform.Characteristic.SerialNumber, platformAccessory.UUID),
      manufacturer: read(this.platform.Characteristic.Manufacturer, 'Z-Wave'),
      model: read(this.platform.Characteristic.Model, 'Window Covering'),
      firmwareRevision: read(this.platform.Characteristic.FirmwareRevision, '1.0.0'),
    };
  }

  private readPosition(service: Service): number | undefined {
    const value = service.getCharacteristic(this.platform.Characteristic.CurrentPosition)?.value;
    return typeof value === 'number' ? value : undefined;
  }

  private readTargetPosition(service: Service): number | undefined {
    const value = service.getCharacteristic(this.platform.Characteristic.TargetPosition)?.value;
    return typeof value === 'number' ? value : undefined;
  }

  /**
   * Drives the covering through the HomeKit characteristic rather than through Z-Wave, so a
   * Matter command takes exactly the same path as one from the Home app.
   */
  private async requestPosition(accessory: ZWaveAccessory, position: number): Promise<void> {
    const service = this.findCoveringService(accessory.platformAccessory);
    if (!service) {
      return;
    }

    this.platform.log.debug(
      `Matter requested ${position}% for ${accessory.platformAccessory.displayName}`,
    );

    await this.writeCharacteristic(
      service,
      this.platform.Characteristic.TargetPosition,
      position,
      accessory,
      `${position}% position request`,
    );
  }

  /**
   * Invokes a HomeKit characteristic's write handler. A failure is reported and swallowed: Matter
   * has its own error signalling and an exception escaping here would be reported against the
   * cluster command rather than the device.
   */
  private async writeCharacteristic(
    service: Service,
    characteristicType: typeof Characteristic.TargetPosition,
    value: unknown,
    accessory: ZWaveAccessory,
    description: string,
  ): Promise<void> {
    const handleSetRequest = (
      service.getCharacteristic(characteristicType) as unknown as
        | { handleSetRequest?: (value: unknown) => Promise<unknown> }
        | undefined
    )?.handleSetRequest;

    const status = this.matter?.status;

    if (typeof handleSetRequest !== 'function') {
      this.platform.log.error(
        `Matter ${description} cannot be delivered for ` +
          `${accessory.platformAccessory.displayName}: the HomeKit characteristic has no setter.`,
      );
      throw status
        ? new status.NotFound(`${description} is not available`)
        : new Error(description);
    }

    try {
      await handleSetRequest.call(service.getCharacteristic(characteristicType), value);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.platform.log.error(
        `Matter ${description} failed for ${accessory.platformAccessory.displayName}: ${message}`,
      );

      /**
       * The command did not reach the device, so the controller has to be told. Resolving here
       * would have Matter report success for a move that never happened, while the same command
       * from HomeKit correctly reports a communication failure.
       */
      throw status ? new status.Failure(`${description} failed`) : err;
    }
  }

  /**
   * Mirrors the covering's HomeKit position into Matter whenever it changes, so a controller that
   * is watching over Matter sees the same position the Home app does.
   */
  private trackPosition(accessory: ZWaveAccessory): void {
    const service = this.findCoveringService(accessory.platformAccessory);
    if (!service) {
      return;
    }

    /**
     * Current and target are reported separately. Pushing the travelling position into both
     * would erase the target the controller asked for, and a controller that infers completion
     * from target === current would call the move finished on the first intermediate report.
     */
    this.onCharacteristicChange(
      accessory.platformAccessory.UUID,
      service,
      this.platform.Characteristic.CurrentPosition,
      (newValue) => {
        if (typeof newValue !== 'number') {
          return;
        }

        this.pushState(accessory, WINDOW_COVERING_CLUSTER, {
          currentPositionLiftPercent100ths: homeKitPositionToMatterLift(newValue),
        });
      },
    );

    this.onCharacteristicChange(
      accessory.platformAccessory.UUID,
      service,
      this.platform.Characteristic.TargetPosition,
      (newValue) => {
        if (typeof newValue !== 'number') {
          return;
        }

        this.pushState(accessory, WINDOW_COVERING_CLUSTER, {
          targetPositionLiftPercent100ths: homeKitPositionToMatterLift(newValue),
        });
      },
    );
  }

  /** Mirrors battery readings the same way, so a Matter controller can show the charge level. */
  private trackBattery(accessory: ZWaveAccessory): void {
    const service = this.findBatteryService(accessory.platformAccessory);
    if (!service) {
      return;
    }

    this.onCharacteristicChange(
      accessory.platformAccessory.UUID,
      service,
      this.platform.Characteristic.BatteryLevel,
      (newValue) => {
        if (typeof newValue !== 'number') {
          return;
        }

        this.pushState(accessory, POWER_SOURCE_CLUSTER, {
          batPercentRemaining: homeKitBatteryToMatterPercent(newValue),
        });
      },
    );

    this.onCharacteristicChange(
      accessory.platformAccessory.UUID,
      service,
      this.platform.Characteristic.StatusLowBattery,
      () => {
        this.pushState(accessory, POWER_SOURCE_CLUSTER, {
          batChargeLevel: this.readBatteryChargeLevel(service),
        });
      },
    );
  }

  private onCharacteristicChange(
    uuid: string,
    service: Service,
    characteristicType: typeof Characteristic.CurrentPosition,
    listener: (newValue: unknown) => void,
  ): void {
    const characteristic = service.getCharacteristic(characteristicType) as unknown as
      | {
          on?: (event: string, handler: (change: { newValue: unknown }) => void) => void;
          removeListener?: (event: string, handler: (...args: never[]) => void) => void;
        }
      | undefined;

    if (typeof characteristic?.on !== 'function') {
      return;
    }

    const handler = ({ newValue }: { newValue: unknown }) => listener(newValue);
    characteristic.on('change', handler);

    const detach = () => characteristic.removeListener?.('change', handler as never);
    const existing = this.trackers.get(uuid) ?? [];
    existing.push(detach);
    this.trackers.set(uuid, existing);
  }

  /** Stops mirroring HomeKit state for an accessory that is being rebuilt or removed. */
  private untrack(uuid: string): void {
    this.trackers.get(uuid)?.forEach((detach) => detach());
    this.trackers.delete(uuid);
    this.tracked.delete(uuid);
  }

  private pushState(
    accessory: ZWaveAccessory,
    cluster: string,
    attributes: Record<string, unknown>,
  ): void {
    void this.matter
      ?.updateAccessoryState(accessory.platformAccessory.UUID, cluster, attributes)
      .catch((err) => {
        this.platform.log.debug(
          `Could not mirror ${cluster} to Matter: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }
}
