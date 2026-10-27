import { randomUUID } from 'crypto';
import { Logger } from 'homebridge';
import { AccessoryFactory, PlanOptions, PrimaryKind } from '../accessories/AccessoryFactory';
import { findDeviceOverride } from '../devices/deviceOverrides';
import { IZWaveNode } from '../zwave/interfaces';
import {
  DeviceFingerprint,
  TypeOverride,
  TypeOverrideData,
  TypeOverrideStore,
  describeError,
  fingerprintKey,
} from './TypeOverrideStore';

/** Where a node's published primary type comes from. */
export type TypeSource = 'registry' | 'detected' | 'override';

/** What a node publishes when no override is in effect, and what decided it. */
export interface NodeDefaultType {
  kind?: PrimaryKind;
  source: 'registry' | 'detected';
  /** The registry's name for this hardware, or nothing when the registry did not decide the type. */
  registryLabel: string | null;
}

/** Supplies the two values a write needs that are not derived from the network. */
export interface ResolverClock {
  now(): string;
  newId(): string;
}

const systemClock: ResolverClock = {
  now: () => new Date().toISOString(),
  newId: () => randomUUID(),
};

/**
 * Reads the saved type overrides against what the network currently reports.
 *
 * The store holds decisions about hardware; this turns them into an answer about a node. The two
 * are kept apart because a decision outlives the device it was made for: a node can be replaced
 * with different hardware, a firmware update can take a capability away, and a plugin update can
 * change what a type needs. Each of those leaves the file as it was and changes only what this
 * resolves, so a decision is never quietly rewritten by the network.
 */
export class TypeOverrideResolver {
  /** The three identifiers, once the device has reported all of them. */
  public static fingerprintOf(node: IZWaveNode): DeviceFingerprint | undefined {
    const { manufacturerId, productType, productId } = node;
    if (manufacturerId === undefined || productType === undefined || productId === undefined) {
      return undefined;
    }

    return { manufacturerId, productType, productId };
  }

  /**
   * Whether this node can carry an override at all.
   *
   * A device with several endpoints has a primary per endpoint, so one type for the node would
   * be choosing which endpoint the node is. A device that has not reported all three identifiers
   * cannot be told apart from another model, and a decision made for it would reach whatever
   * else arrived without them.
   */
  public static isOverridable(node: IZWaveNode): boolean {
    return (
      TypeOverrideResolver.fingerprintOf(node) !== undefined &&
      node.getAllEndpoints().length === 1
    );
  }

  /**
   * What this node publishes with no override.
   *
   * Two nodes of the same model can differ here, because the plan is read from what each one
   * reports, so reverting returns each node to its own answer rather than to a shared one.
   */
  public static defaultTypeFor(node: IZWaveNode): NodeDefaultType {
    const kind = AccessoryFactory.planFeatures(node)[0]?.primaryKind;
    const entry = findDeviceOverride(node);
    /**
     * The registry decides a type only where it redirects Multilevel Switch to a covering. Its
     * other fields are command timing, which does not change what the device is published as.
     */
    const registryLabel =
      entry?.multilevelSwitchDrivesCovering && kind === 'window-covering' ? entry.label : null;

    return { kind, source: registryLabel === null ? 'detected' : 'registry', registryLabel };
  }

  /** Nodes whose write failure has been reported, so a failing disk is not reported every event. */
  private readonly reported = new Set<number>();

  constructor(
    public readonly store: TypeOverrideStore,
    private readonly listNodes: () => readonly IZWaveNode[],
    private readonly log: Logger,
    private readonly clock: ResolverClock = systemClock,
  ) {}

  /** The override saved for this node's hardware, whether or not this node can take it. */
  public savedOverrideFor(node: IZWaveNode): TypeOverride | undefined {
    const fingerprint = TypeOverrideResolver.fingerprintOf(node);
    if (!fingerprint || !TypeOverrideResolver.isOverridable(node)) {
      return undefined;
    }

    return this.store.overrideFor(fingerprint);
  }

  /**
   * The override in effect for this node, which is none when the node cannot be published as the
   * saved type. A node included after the decision was made, one running different firmware and
   * one read by a plugin version that asks more of the type all reach this.
   */
  public appliedOverrideFor(node: IZWaveNode): TypeOverride | undefined {
    const saved = this.savedOverrideFor(node);
    if (!saved) {
      return undefined;
    }

    return AccessoryFactory.compatiblePrimaryKinds(node).includes(saved.primaryKind)
      ? saved
      : undefined;
  }

  /** The saved override this node cannot be published as, when there is one. */
  public invalidOverrideFor(node: IZWaveNode): TypeOverride | undefined {
    const saved = this.savedOverrideFor(node);

    return saved && !this.appliedOverrideFor(node) ? saved : undefined;
  }

  /**
   * What the planner is given for this node. An override that this node cannot take is never
   * passed in, so the node is published as planned rather than as a type its services cannot
   * drive.
   */
  public planOptionsFor(node: IZWaveNode): PlanOptions {
    const applied = this.appliedOverrideFor(node);

    return applied ? { primaryOverride: applied.primaryKind } : {};
  }

  /** Where this node's published primary type comes from. */
  public sourceFor(node: IZWaveNode): TypeSource {
    return this.appliedOverrideFor(node)
      ? 'override'
      : TypeOverrideResolver.defaultTypeFor(node).source;
  }

  /**
   * Every node a decision about this hardware reaches: interviewed, single-endpoint and reporting
   * this fingerprint. A node that cannot take the current override stays in the cohort, because a
   * later write is validated against all of them and may well suit it.
   */
  public cohortFor(fingerprint: DeviceFingerprint): IZWaveNode[] {
    const key = fingerprintKey(fingerprint);

    return this.listNodes().filter((node) => {
      const theirs = TypeOverrideResolver.fingerprintOf(node);

      return (
        node.ready &&
        theirs !== undefined &&
        fingerprintKey(theirs) === key &&
        node.getAllEndpoints().length === 1
      );
    });
  }

  /**
   * The types the cohort can be offered, which is what every one of its nodes could be published
   * as. A type one node cannot drive is not offered for the hardware, because the decision is
   * saved for the hardware and would reach that node too.
   */
  public optionsFor(fingerprint: DeviceFingerprint): PrimaryKind[] {
    const cohort = this.cohortFor(fingerprint);
    if (cohort.length === 0) {
      return [];
    }

    return cohort
      .map((node) => AccessoryFactory.compatiblePrimaryKinds(node))
      .reduce((shared, kinds) => shared.filter((kind) => kinds.includes(kind)));
  }

  /**
   * Brings the record of where the override has been applied up to date with what this node now
   * reports, and writes only when that record changes, because this runs on every node event.
   *
   * A store that refused its file knows of no override and no earlier record, so it finds nothing
   * to change and never reaches the write it would refuse.
   */
  public async observe(node: IZWaveNode): Promise<void> {
    const change = this.observationChange(node);
    if (!change) {
      return;
    }

    try {
      await this.store.update(change);
      this.reported.delete(node.nodeId);
    } catch (error) {
      if (this.reported.has(node.nodeId)) {
        return;
      }
      this.reported.add(node.nodeId);
      this.log.warn(
        `Could not record where the type override for Node ${node.nodeId} is applied. ` +
          `${describeError(error)} The type it publishes is unaffected.`,
      );
    }
  }

  /**
   * What this node's report changes about the record, or nothing when it changes none of it.
   *
   * The returned change decides from the data it is handed rather than from what was read here,
   * because writes are serialized: another node's write can land in between, and a second pass
   * for this node can be queued behind the first. Only the values a write cannot derive, the
   * time and the identifier, are taken now.
   */
  private observationChange(node: IZWaveNode): ((data: TypeOverrideData) => void) | undefined {
    // An interview that has not finished reports no fingerprint to compare, so it records nothing.
    if (!node.ready) {
      return undefined;
    }

    const fingerprint = TypeOverrideResolver.fingerprintOf(node);
    if (!fingerprint) {
      return undefined;
    }

    const key = fingerprintKey(fingerprint);
    const { nodeId } = node;
    const applied = this.appliedOverrideFor(node) !== undefined;
    const { observations } = this.store.snapshot();
    const mine = observations.find(
      (observation) => observation.nodeId === nodeId && fingerprintKey(observation.fingerprint) === key,
    );
    const orphaned = observations.some(
      (observation) =>
        observation.nodeId === nodeId &&
        observation.orphanedAt === null &&
        fingerprintKey(observation.fingerprint) !== key,
    );

    const records = applied && mine === undefined;
    const returns = applied && mine?.orphanedAt != null;
    if (!orphaned && !records && !returns) {
      return undefined;
    }

    const at = this.clock.now();
    const id = this.clock.newId();

    return (data) => {
      data.observations.forEach((observation) => {
        if (observation.nodeId !== nodeId) {
          return;
        }
        if (fingerprintKey(observation.fingerprint) !== key) {
          // The node number now reports other hardware, so what was recorded for it is orphaned.
          observation.orphanedAt ??= at;
          return;
        }
        if (applied) {
          // The hardware came back, so the record it left is revived rather than replaced.
          observation.orphanedAt = null;
        }
      });

      const recorded = data.observations.some(
        (observation) =>
          observation.nodeId === nodeId && fingerprintKey(observation.fingerprint) === key,
      );
      if (applied && !recorded) {
        data.observations.push({ id, nodeId, fingerprint, appliedAt: at, orphanedAt: null });
      }
    };
  }
}
