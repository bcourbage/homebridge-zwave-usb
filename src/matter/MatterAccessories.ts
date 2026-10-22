import { Characteristic, PlatformAccessory, Service } from 'homebridge';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { ZWaveAccessory } from '../accessories/ZWaveAccessory';
import { homeKitBatteryToMatterPercent } from './coveringPosition';
import { matterLabel, matterSerialNumber } from './matterText';
import { serviceMappings, ServiceMapping } from './serviceMappings';

/** The status errors a cluster handler throws to report a failure to the controller. */
interface MatterStatusErrors {
  Failure: new (message?: string) => Error;
  NotFound: new (message?: string) => Error;
}

/** One accessory on its way to Matter, with the descriptor built for it retained locally. */
interface PendingPublication {
  uuid: string;
  accessory: ZWaveAccessory;
  descriptor: MatterAccessoryDescriptor;
}

/**
 * The parts of Homebridge's Matter API this plugin uses. It is declared here rather than
 * imported because `api.matter` only exists on Homebridge 2 and the plugin still supports
 * Homebridge 1, where the property is simply absent.
 */
interface MatterApi {
  deviceTypes: Record<string, unknown>;
  switch?: {
    emitGesture(
      uuid: string,
      gesture: 'singlePress' | 'doublePress' | 'longPress',
      options?: { partId?: string },
    ): Promise<void>;
  };
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
    partId?: string,
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
  parts?: Array<{
    id: string;
    displayName: string;
    deviceType: unknown;
    clusters: Record<string, Record<string, unknown>>;
    handlers: Record<string, Record<string, (request?: never) => Promise<void> | void>>;
  }>;
}

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
 * Publishes supported Z-Wave services over Matter so controllers that cannot speak HomeKit, such as
 * Alexa, can operate them.
 *
 * Commands are routed through the accessory's HomeKit characteristics, so a Matter request goes
 * through the same command coalescing, encoding and position reconciliation as a HomeKit one.
 * Nothing here talks to Z-Wave directly.
 */
export class MatterAccessories {
  private readonly published = new Set<string>();
  /** Descriptors of what was registered, so an accessory can be unregistered again. */
  private readonly descriptors = new Map<string, MatterAccessoryDescriptor>();
  /**
   * UUIDs Homebridge restored from its own Matter cache and that this run has not claimed yet.
   * The distinction is load bearing rather than bookkeeping: a restored endpoint is the only
   * one Homebridge lets a registration attach to in place, so an entry leaving this map is what
   * says the identifier must never be offered for registration again this session.
   */
  private readonly cached = new Map<string, MatterAccessoryDescriptor>();
  /**
   * Accessories whose descriptor construction or publication is in progress. While a UUID is
   * here it is in neither `pending` nor `published`, so without it a second `add()` would queue
   * the same accessory again and register it twice.
   */
  private readonly inFlight = new Set<string>();
  /**
   * A replacement offered while publication was in flight, tagged with the generation current
   * when it was offered. Kept apart from `inFlight` because the two answer different questions:
   * one is whether an operation is running, the other is what to do when it finishes. A removal
   * bumps the generation, which is what makes a replacement offered before it stale, while a
   * genuinely new request made after the removal carries the new generation and still runs.
   */
  private readonly deferred = new Map<string, { accessory: ZWaveAccessory; generation: number }>();
  /** Bumped whenever an accessory is removed, so a registration in flight can be discarded. */
  private readonly generations = new Map<string, number>();
  /** Per-accessory detach callbacks for the HomeKit listeners that mirror state into Matter. */
  private readonly trackers = new Map<string, Array<() => void>>();
  /** The accessory instance each published UUID is currently mirroring. */
  private readonly tracked = new Map<string, ZWaveAccessory>();
  private readonly pending = new Map<string, ZWaveAccessory>();
  private publishTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly platform: ZWaveUsbPlatform) {}

  private get matter(): MatterApi | undefined {
    return (this.platform.api as unknown as { matter?: MatterApi }).matter;
  }

  public stop(): void {
    this.stopped = true;
    for (const uuid of this.inFlight)
      this.generations.set(uuid, (this.generations.get(uuid) ?? 0) + 1);
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = undefined;
    }
    this.pending.clear();
    this.inFlight.clear();
    this.deferred.clear();
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
    // Anything still in flight for this accessory belongs to a generation that is now obsolete.
    this.generations.set(uuid, (this.generations.get(uuid) ?? 0) + 1);

    const descriptor = this.descriptors.get(uuid) ?? this.cached.get(uuid);
    if (!descriptor || !this.matter) {
      this.published.delete(uuid);
      this.descriptors.delete(uuid);
      this.cached.delete(uuid);
      return;
    }

    try {
      await this.matter.unregisterPlatformAccessories('homebridge-zwave-usb', 'ZWaveUSB', [
        descriptor,
      ]);
    } catch (err) {
      /**
       * Only a refusal raised before the removal is dispatched reaches here. Bridged
       * unregistration is dispatched as an event that is not awaited, so a removal the Matter
       * server goes on to refuse returns from this call as though it had worked, and the record
       * is dropped below. Homebridge offers the endpoint back from its cache on the next start,
       * which is where such a removal is noticed and tried again; within this session it is
       * not detectable.
       */
      this.platform.log.warn(
        `Could not remove ${descriptor.displayName} from Matter, so it is still recorded: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      /**
       * No longer published, because the plugin has given up on it as a live accessory, but
       * still recorded as restored so the next reconcile tries the removal again. Dropping it
       * from both would leave a device in the controller that nothing here can ever remove.
       */
      this.published.delete(uuid);
      this.descriptors.set(uuid, descriptor);
      this.cached.set(uuid, descriptor);
      return;
    }

    this.published.delete(uuid);
    this.descriptors.delete(uuid);
    this.cached.delete(uuid);
  }

  /**
   * Removes every Matter accessory Homebridge restored that this run did not match to a live
   * device. Called once the network has been discovered, which is the first moment the absence
   * of a node means the node is gone rather than not interviewed yet.
   */
  public async reconcileCached(liveUuids: ReadonlySet<string>): Promise<void> {
    /**
     * Keyed on what the network has, not on what has been published. Publication is debounced
     * and a covering that is asleep, dead or still interviewing may not have been queued at all
     * yet, so treating unpublished as absent would unregister a shade whose battery is simply
     * out.
     */
    const leftovers = [...this.cached.keys()].filter((uuid) => !liveUuids.has(uuid));
    for (const uuid of leftovers) {
      this.platform.log.info(
        `Removing ${this.cached.get(uuid)?.displayName ?? uuid} from Matter: ` +
          'it was restored from the cache but is not a node on this network.',
      );
      await this.remove(uuid);
    }
  }

  /**
   * Queues an accessory for publication. Safe to call repeatedly: an accessory is only ever
   * published once, and services without a supported mapping are ignored.
   */
  public add(accessory: ZWaveAccessory): void {
    if (!this.matter || this.stopped) {
      return;
    }

    const uuid = accessory.platformAccessory.UUID;
    if (!this.supports(accessory)) {
      return;
    }

    if (this.inFlight.has(uuid)) {
      // Publication is already running for this accessory. Record the newest object so the
      // operation can republish against it when it finishes, rather than starting a second one.
      this.deferred.set(uuid, { accessory, generation: this.generations.get(uuid) ?? 0 });
      return;
    }

    if (this.published.has(uuid)) {
      if (this.tracked.get(uuid) === accessory) {
        return;
      }

      // The accessory object was rebuilt while its Matter endpoint is live.
      this.refreshTracking(uuid, accessory);
      return;
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

  public supports(accessory: ZWaveAccessory): boolean {
    return (
      serviceMappings(this.platform, accessory, {
        read: async () => undefined,
        write: async () => undefined,
      }).length > 0
    );
  }

  private mappings(accessory: ZWaveAccessory): ServiceMapping[] {
    return serviceMappings(this.platform, accessory, {
      read: async (key, type) => {
        const current = this.live(accessory.platformAccessory.UUID, this.matter!);
        const service = this.mappings(current).find((m) => m.key === key)?.service;
        if (!service) throw new this.matter!.status.NotFound('Service is no longer available');
        return service.getCharacteristic(type).handleGetRequest();
      },
      write: async (key, type, value) => {
        const current = this.live(accessory.platformAccessory.UUID, this.matter!);
        const service = this.mappings(current).find((m) => m.key === key)?.service;
        if (!service) throw new this.matter!.status.NotFound('Service is no longer available');
        await this.writeCharacteristic(
          service,
          type,
          value,
          current,
          type === this.platform.Characteristic.HoldPosition
            ? 'stop request'
            : type === this.platform.Characteristic.TargetPosition
              ? `${String(value)}% position request`
              : type.UUID,
        );
      },
    }).filter((mapping) => !!this.matter?.deviceTypes[mapping.deviceType]);
  }

  private async publishPending(): Promise<void> {
    const matter = this.matter;
    if (!matter || this.stopped || this.pending.size === 0) {
      return;
    }

    const queued = [...this.pending.entries()];
    this.pending.clear();

    /**
     * Captured before any await. A removal that happens while a descriptor is being built would
     * otherwise bump the generation before this read, and the publication would see its own
     * stale work as current.
     */
    queued.forEach(([uuid]) => this.inFlight.add(uuid));

    const generations = new Map(
      queued.map(([uuid]) => [uuid, this.generations.get(uuid) ?? 0] as const),
    );

    /**
     * Both groups go through registration, which is the only path that records the plugin and
     * platform an endpoint belongs to. Homebridge accepts it for an identifier it has never seen
     * and for one it restored from its own cache, where it attaches the handlers and the
     * ownership to the endpoint already there; it rejects a second registration of an endpoint
     * that is already live this session. That rejection happens downstream of the call awaited
     * here, so nothing offered in error would be visible: the groups are built from what has not
     * been claimed yet rather than from what a failure would tell us. They stay separate so a
     * failure of one cannot discard the other.
     */
    const fresh: PendingPublication[] = [];
    const restored: PendingPublication[] = [];

    for (const [uuid, accessory] of queued) {
      let descriptor: MatterAccessoryDescriptor | undefined;
      try {
        descriptor = await this.describe(accessory, matter);
      } catch (err) {
        this.platform.log.warn(
          `Could not describe ${accessory.platformAccessory.displayName} for Matter: ${String(err)}`,
        );
        continue;
      }
      if (!descriptor) {
        continue;
      }

      /**
       * Held locally until dispatch. Recording it now would let a removal that arrives
       * mid-flight ask Matter to unregister an accessory that was never offered.
       */
      (this.cached.has(uuid) ? restored : fresh).push({ uuid, accessory, descriptor });
    }

    // Handed over separately, so a failure reported for one group does not discard a group that
    // was already dispatched and would otherwise be offered a second time later.
    try {
      await this.commit(matter, fresh, generations);
      await this.commit(matter, restored, generations);
    } finally {
      for (const [uuid, accessory] of queued) {
        this.inFlight.delete(uuid);
        const replacement = this.deferred.get(uuid);
        this.deferred.delete(uuid);

        if (!replacement) {
          continue;
        }

        if (replacement.generation !== (this.generations.get(uuid) ?? 0)) {
          /**
           * The accessory was removed after this replacement was offered. Publishing it now
           * would put back a device the plugin has already been told to take away.
           */
          continue;
        }

        /**
         * Ordering is established by the generation, not by object identity. The same object
         * offered again after a removal is a new request, because the publication it would
         * have duplicated has been undone, and skipping it on identity alone would lose a
         * re-included node that happens to reuse its wrapper.
         */
        const unchanged =
          replacement.accessory === accessory &&
          replacement.generation === (generations.get(uuid) ?? 0);
        if (unchanged) {
          continue;
        }

        // Rebuilt while this was in flight, so the handlers just published close over a stopped
        // object, or removed and asked for again. Queue it now that the UUID is free.
        this.add(replacement.accessory);
      }
    }
  }

  /**
   * Offers one group to Matter and records what it handed over. An entry whose accessory was
   * removed while this was in flight is undone rather than committed, using the descriptor
   * retained here rather than the shared map, which the removal has already emptied.
   */
  private async commit(
    matter: MatterApi,
    group: PendingPublication[],
    generations: ReadonlyMap<string, number>,
  ): Promise<void> {
    if (group.length === 0) {
      return;
    }

    /**
     * Checked here rather than only after the call, because a removal that arrives while the
     * descriptors are being built would otherwise be dispatched anyway and undone afterwards.
     * The undo is not a reliable answer: bridged unregistration is dispatched as an event of
     * its own, so it can be handled before the registration it is meant to cancel. Not sending
     * the work at all is the only part of this the plugin controls.
     */
    const live = group.filter(
      (entry) => (this.generations.get(entry.uuid) ?? 0) === generations.get(entry.uuid),
    );

    if (live.length === 0) {
      return;
    }

    const descriptors = live.map((entry) => entry.descriptor);
    try {
      await matter.registerPlatformAccessories('homebridge-zwave-usb', 'ZWaveUSB', descriptors);
    } catch (err) {
      /**
       * Matter is optional. A bridge without it, or a registration refused before it is
       * dispatched, must not disturb the HomeKit accessories that are already working.
       */
      this.platform.log.warn(
        `Could not publish ${descriptors.length} accessory(ies) over Matter: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    const undo: MatterAccessoryDescriptor[] = [];
    const committed: PendingPublication[] = [];

    for (const entry of live) {
      if ((this.generations.get(entry.uuid) ?? 0) !== generations.get(entry.uuid)) {
        // Removed while the registration was being dispatched. Compensating for it is
        // best-effort, for the ordering reason above, which is why the window is kept small
        // rather than relied on.
        undo.push(entry.descriptor);
        continue;
      }

      this.descriptors.set(entry.uuid, entry.descriptor);
      this.published.add(entry.uuid);
      // Claimed, so no longer a restored endpoint awaiting reclamation.
      this.cached.delete(entry.uuid);
      this.tracked.set(entry.uuid, entry.accessory);
      this.trackState(entry.accessory);
      this.trackBattery(entry.accessory);
      committed.push(entry);
    }

    if (committed.length > 0) {
      /**
       * A bridged registration is dispatched as an event that is not awaited, so this call
       * returning says the accessories were handed over and nothing about what became of them.
       * The wording follows.
       */
      this.platform.log.info(
        `Handed ${committed.length} accessory(ies) to Matter: ` +
          committed.map((entry) => entry.accessory.platformAccessory.displayName).join(', '),
      );
    }

    if (undo.length === 0) {
      return;
    }

    try {
      await matter.unregisterPlatformAccessories('homebridge-zwave-usb', 'ZWaveUSB', undo);
    } catch (err) {
      /**
       * The registration was dispatched and the plugin no longer wants it. Keeping these as
       * restored leaves something for the next reconcile to remove, rather than an orphan in
       * the controller that nothing knows about.
       */
      this.platform.log.warn(
        `Could not undo a registration for ${undo.length} removed accessory(ies): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      undo.forEach((descriptor) => this.cached.set(descriptor.UUID, descriptor));
    }
  }

  private async mappingState(
    mapping: ServiceMapping,
  ): Promise<Record<string, Record<string, unknown>>> {
    const clusters = Object.fromEntries(
      Object.entries(mapping.clusters).map(([name, state]) => [name, { ...state }]),
    );
    for (const binding of mapping.bindings) {
      if (binding.event) continue;
      let value: unknown;
      try {
        const characteristic = mapping.service.getCharacteristic(binding.characteristic);
        value = await characteristic.handleGetRequest();
      } catch {
        value = undefined;
      }
      Object.assign((clusters[binding.cluster] ??= {}), binding.attributes(value));
    }
    if (
      clusters.windowCovering &&
      clusters.windowCovering.targetPositionLiftPercent100ths == null
    ) {
      clusters.windowCovering.targetPositionLiftPercent100ths =
        clusters.windowCovering.currentPositionLiftPercent100ths;
    }
    return clusters;
  }

  private async describe(
    accessory: ZWaveAccessory,
    matter: MatterApi,
  ): Promise<MatterAccessoryDescriptor | undefined> {
    const mappings = this.mappings(accessory);
    const root = mappings[0];
    if (!root) return undefined;
    const information = this.readAccessoryInformation(accessory.platformAccessory);
    const battery = this.describeBattery(accessory.platformAccessory);
    const descriptor: MatterAccessoryDescriptor = {
      UUID: accessory.platformAccessory.UUID,
      displayName: matterLabel(accessory.platformAccessory.displayName),
      deviceType: matter.deviceTypes[root.deviceType],
      serialNumber: matterSerialNumber(information.serialNumber),
      manufacturer: matterLabel(information.manufacturer),
      model: matterLabel(information.model),
      firmwareRevision: information.firmwareRevision,
      context: { nodeId: accessory.node.nodeId, serviceKey: root.key },
      clusters: {
        ...(await this.mappingState(root)),
        ...(battery ? { powerSource: battery } : {}),
      },
      handlers: this.handlers(root, matter),
    };
    if (mappings.length > 1) {
      descriptor.parts = await Promise.all(
        mappings.slice(1).map(async (mapping) => ({
          id: mapping.key,
          displayName: matterLabel(
            mapping.service.displayName || accessory.platformAccessory.displayName,
          ),
          deviceType: matter.deviceTypes[mapping.deviceType],
          clusters: await this.mappingState(mapping),
          handlers: this.handlers(mapping, matter),
        })),
      );
    }
    return descriptor;
  }

  private handlers(
    mapping: ServiceMapping,
    matter: MatterApi,
  ): MatterAccessoryDescriptor['handlers'] {
    return Object.fromEntries(
      Object.entries(mapping.commands).map(([cluster, commands]) => [
        cluster,
        Object.fromEntries(
          Object.entries(commands).map(([command, handler]) => [
            command,
            async (request?: never) => {
              try {
                await handler(request);
              } catch (err) {
                if (err instanceof matter.status.NotFound) throw err;
                throw new matter.status.Failure(err instanceof Error ? err.message : String(err));
              }
            },
          ]),
        ),
      ]),
    );
  }

  private findBatteryService(platformAccessory: PlatformAccessory): Service | undefined {
    const batteryType = this.platform.Service.Battery as unknown as { UUID?: string };
    if (!batteryType?.UUID) {
      return undefined;
    }

    return platformAccessory.services.find((service) => service.UUID === batteryType.UUID);
  }

  /**
   * Describes the accessory's battery for Matter.
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
      model: read(this.platform.Characteristic.Model, 'Z-Wave Device'),
      firmwareRevision: read(this.platform.Characteristic.FirmwareRevision, '1.0.0'),
    };
  }

  /**
   * Invokes a HomeKit characteristic's write handler. A failure is logged and then raised as a
   * Matter status, so the controller that sent the command is told it failed rather than being
   * left to assume it worked.
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
  /**
   * The accessory an identifier stands for right now. A handler resolves it when a command
   * arrives rather than closing over the object that existed when the handler was built,
   * because a Matter endpoint outlives the Z-Wave wrapper it mirrors: a rebuild replaces the
   * wrapper while the endpoint, and the handlers registered with it, stay as they were.
   */
  private live(uuid: string, matter: MatterApi): ZWaveAccessory {
    const accessory = this.tracked.get(uuid);
    if (!accessory) {
      throw new matter.status.NotFound(`No accessory is registered for ${uuid}.`);
    }

    return accessory;
  }

  /**
   * Points a live endpoint at a rebuilt accessory. Registering the identifier again is not
   * available here: Homebridge attaches a registration in place only for an endpoint it
   * restored from its own cache, and rejects a second registration of one already live, which
   * it reports downstream of the call the plugin awaits. Nothing about the endpoint needs to
   * change in any case, since the handlers resolve the accessory by identifier, so repointing
   * the record and resubscribing is the whole update.
   */
  private refreshTracking(uuid: string, accessory: ZWaveAccessory): void {
    this.untrack(uuid);
    this.tracked.set(uuid, accessory);
    this.trackState(accessory);
    this.trackBattery(accessory);
    void this.pushCurrentState(accessory).catch((err) => {
      this.platform.log.debug(
        `Could not mirror the rebuilt accessory to Matter: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  /**
   * Brings Matter back in step after a rebuild. The listeners that were mirroring state belonged
   * to the characteristics of the object just replaced, so without this the endpoint would hold
   * what was last reported until the new object happens to report a change of its own.
   */
  private async pushCurrentState(accessory: ZWaveAccessory): Promise<void> {
    const descriptor = this.descriptors.get(accessory.platformAccessory.UUID);
    if (!descriptor) return;
    const mappings = this.mappings(accessory);
    for (const mapping of mappings) {
      const partId = this.partId(descriptor, mapping);
      if (partId === null) continue;
      for (const [cluster, attributes] of Object.entries(await this.mappingState(mapping))) {
        this.pushState(accessory, cluster, attributes, partId);
      }
    }
    const battery = this.describeBattery(accessory.platformAccessory);
    if (battery && descriptor.clusters.powerSource)
      this.pushState(accessory, POWER_SOURCE_CLUSTER, battery);
  }

  /** Only mirror services present in the endpoint registered this session. */
  private partId(
    descriptor: MatterAccessoryDescriptor,
    mapping: ServiceMapping,
  ): string | undefined | null {
    if (descriptor.parts?.some((part) => part.id === mapping.key)) return mapping.key;
    const rootKey = (descriptor.context as { serviceKey?: string }).serviceKey;
    return rootKey === mapping.key ? undefined : null;
  }

  private trackState(accessory: ZWaveAccessory): void {
    const descriptor = this.descriptors.get(accessory.platformAccessory.UUID);
    if (!descriptor) return;
    for (const mapping of this.mappings(accessory)) {
      const partId = this.partId(descriptor, mapping);
      if (partId === null) continue;
      for (const binding of mapping.bindings) {
        this.onCharacteristicChange(
          accessory.platformAccessory.UUID,
          mapping.service,
          binding.characteristic,
          (value) => {
            if (binding.event) {
              const gesture =
                value === 0
                  ? 'singlePress'
                  : value === 1
                    ? 'doublePress'
                    : value === 2
                      ? 'longPress'
                      : undefined;
              if (gesture)
                void this.matter?.switch
                  ?.emitGesture(accessory.platformAccessory.UUID, gesture, { partId })
                  .catch((err) =>
                    this.platform.log.warn(`Could not send Matter button event: ${String(err)}`),
                  );
            } else {
              // HAP error updates must not become sensor readings.
              if (value instanceof Error || value === undefined || value === null) return;
              this.pushState(accessory, binding.cluster, binding.attributes(value), partId);
            }
          },
        );
      }
    }
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
    partId?: string,
  ): void {
    void this.matter
      ?.updateAccessoryState(
        accessory.platformAccessory.UUID,
        cluster,
        attributes,
        ...(partId ? [partId] : []),
      )
      .catch((err) => {
        this.platform.log.debug(
          `Could not mirror ${cluster} to Matter: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }
}
