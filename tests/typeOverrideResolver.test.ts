import fs from 'fs';
import os from 'os';
import path from 'path';
import { Logger } from 'homebridge';
import { AccessoryFactory } from '../src/accessories/AccessoryFactory';
import { TypeOverrideResolver } from '../src/platform/TypeOverrideResolver';
import { DeviceFingerprint, TypeOverrideStore } from '../src/platform/TypeOverrideStore';
import { IZWaveNode } from '../src/zwave/interfaces';
import {
  NodeIdentity,
  REALISTIC_DEVICES,
  binarySensorDevice,
  buildNode,
} from './fixtures/realisticDevices';

describe('TypeOverrideResolver', () => {
  const HOME_ID = 0xe4a1c0f2;
  const FILE = 'homebridge-zwave-usb-overrides-e4a1c0f2.json';
  const NOW = '2026-10-27T12:00:00.000Z';

  const SHADE: DeviceFingerprint = { manufacturerId: 2748, productType: 2, productId: 16 };
  const OTHER: DeviceFingerprint = { manufacturerId: 2748, productType: 3, productId: 32 };
  /** The one hardware the built-in registry reclassifies. */
  const RSZ1: DeviceFingerprint = { manufacturerId: 0x026e, productType: 0x5253, productId: 0x5a31 };
  const RSZ1_LABEL = 'Springs Window Fashions RSZ1 (Somfy Motorized Shade)';

  let directory: string;
  let log: jest.Mocked<Logger>;
  let nodes: IZWaveNode[];
  let issued: number;

  const clock = { now: () => NOW, newId: () => `id-${++issued}` };

  const named = (name: string) => {
    const device = REALISTIC_DEVICES.find((candidate) => candidate.name === name);
    if (!device) {
      throw new Error(`No realistic device named ${name}`);
    }
    return device;
  };

  const node = (name: string, identity: NodeIdentity = {}) =>
    buildNode(named(name), { ...SHADE, ...identity });

  const sensor = (property: string, identity: NodeIdentity = {}) =>
    buildNode(binarySensorDevice(property), { ...SHADE, ...identity });

  const override = (fingerprint: DeviceFingerprint, primaryKind: string) => ({
    fingerprint,
    primaryKind,
    savedAt: '2026-10-12T18:20:00Z',
  });

  const observation = (
    id: string,
    nodeId: number,
    fingerprint: DeviceFingerprint,
    orphanedAt: string | null = null,
  ) => ({ id, nodeId, fingerprint, appliedAt: '2026-09-30T17:02:00Z', orphanedAt });

  const resolver = (overrides: unknown[] = [], observations: unknown[] = []) => {
    fs.writeFileSync(
      path.join(directory, FILE),
      JSON.stringify({ version: 1, homeId: 'e4a1c0f2', overrides, observations }),
    );
    const store = new TypeOverrideStore(directory, HOME_ID, log);
    store.load();
    return new TypeOverrideResolver(store, () => nodes, log, clock);
  };

  const stored = () => JSON.parse(fs.readFileSync(path.join(directory, FILE), 'utf8'));

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zwave-resolver-'));
    log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never;
    nodes = [];
    issued = 0;
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  describe('reading what a node reports', () => {
    it('reads the fingerprint once the device has reported all three identifiers', () => {
      expect(TypeOverrideResolver.fingerprintOf(node('relay'))).toEqual(SHADE);
    });

    it.each([
      ['manufacturer', { manufacturerId: undefined }],
      ['product type', { productType: undefined }],
      ['product ID', { productId: undefined }],
    ])('reports no fingerprint while the %s is missing', (_label, missing) => {
      expect(TypeOverrideResolver.fingerprintOf(node('relay', missing))).toBeUndefined();
    });

    it('accepts a node that reports a fingerprint and one endpoint', () => {
      expect(TypeOverrideResolver.isOverridable(node('relay'))).toBe(true);
    });

    it('refuses a node that has not finished reporting its identifiers', () => {
      expect(TypeOverrideResolver.isOverridable(node('relay', { productId: undefined }))).toBe(false);
    });

    it('refuses a node with several endpoints, which has a primary for each of them', () => {
      expect(TypeOverrideResolver.isOverridable(node('relay', { endpoints: 2 }))).toBe(false);
    });
  });

  describe('a node default', () => {
    it('is what the device reports, when nothing names the hardware', () => {
      expect(TypeOverrideResolver.defaultTypeFor(node('dimmer with battery'))).toEqual({
        kind: 'multilevel-switch',
        source: 'detected',
        registryLabel: null,
      });
    });

    it('credits the registry when the registry is what chose the type', () => {
      expect(
        TypeOverrideResolver.defaultTypeFor(node('covering (Multilevel Switch only)', RSZ1)),
      ).toEqual({ kind: 'window-covering', source: 'registry', registryLabel: RSZ1_LABEL });
    });

    it('credits the device when the registry named the hardware but did not choose the type', () => {
      // The registry entry also carries command timing, which does not decide what is published.
      expect(TypeOverrideResolver.defaultTypeFor(node('relay', RSZ1))).toEqual({
        kind: 'binary-switch',
        source: 'detected',
        registryLabel: null,
      });
    });

    it('differs between two nodes of one model that report different capabilities', () => {
      const plain = TypeOverrideResolver.defaultTypeFor(node('relay'));
      const dimming = TypeOverrideResolver.defaultTypeFor(node('dimmer with battery'));

      expect(plain.kind).toBe('binary-switch');
      expect(dimming.kind).toBe('multilevel-switch');
    });
  });

  describe('applying a saved override', () => {
    it('passes a type the node can be published as into the plan', () => {
      const shade = node('covering (Multilevel Switch only)');

      expect(resolver([override(SHADE, 'window-covering')]).planOptionsFor(shade)).toEqual({
        primaryOverride: 'window-covering',
      });
    });

    it('publishes the overridden type rather than the detected one', () => {
      const shade = node('covering (Multilevel Switch only)');
      const options = resolver([override(SHADE, 'window-covering')]).planOptionsFor(shade);

      expect(AccessoryFactory.planFeatures(shade)[0].effectiveKinds).toEqual(['multilevel-switch']);
      expect(AccessoryFactory.planFeatures(shade, options)[0].effectiveKinds).toEqual([
        'window-covering',
      ]);
    });

    it('takes precedence over the registry for the same hardware', () => {
      const shade = node('covering (Multilevel Switch only)', RSZ1);
      const options = resolver([override(RSZ1, 'multilevel-switch')]).planOptionsFor(shade);

      expect(AccessoryFactory.planFeatures(shade)[0].effectiveKinds).toEqual(['window-covering']);
      expect(AccessoryFactory.planFeatures(shade, options)[0].effectiveKinds).toEqual([
        'multilevel-switch',
      ]);
    });

    it('plans nothing special for a node whose hardware has no saved decision', () => {
      expect(resolver([override(OTHER, 'window-covering')]).planOptionsFor(node('relay'))).toEqual(
        {},
      );
    });

    it('never overrides a node that has not reported its identifiers', () => {
      const unknown = node('covering (Multilevel Switch only)', { productId: undefined });

      expect(resolver([override(SHADE, 'window-covering')]).planOptionsFor(unknown)).toEqual({});
    });

    it('never overrides a node with several endpoints', () => {
      const split = node('covering (Multilevel Switch only)', { endpoints: 2 });

      expect(resolver([override(SHADE, 'window-covering')]).planOptionsFor(split)).toEqual({});
    });

    it('holds no decision at all over a node that cannot carry one', () => {
      // Reported as invalid, this would tell the reader to choose another type. There is no type
      // to choose: the node has a primary for each of its endpoints.
      const split = node('covering (Multilevel Switch only)', { endpoints: 2 });
      const subject = resolver([override(SHADE, 'window-covering')]);

      expect(subject.savedOverrideFor(split)).toBeUndefined();
      expect(subject.invalidOverrideFor(split)).toBeUndefined();
    });
  });

  describe('an override the node cannot take', () => {
    // A Binary Sensor reporting Motion is detected as a contact sensor but can only drive motion.
    const motion = () => sensor('Motion');

    it('is kept out of the plan, so the node is published as it was planned', () => {
      expect(resolver([override(SHADE, 'contact-sensor')]).planOptionsFor(motion())).toEqual({});
    });

    it('is reported against the node, so the reason can be shown', () => {
      const reported = resolver([override(SHADE, 'contact-sensor')]).invalidOverrideFor(motion());

      expect(reported?.primaryKind).toBe('contact-sensor');
    });

    it('is still the decision saved for the hardware', () => {
      const saved = resolver([override(SHADE, 'contact-sensor')]).savedOverrideFor(motion());

      expect(saved?.primaryKind).toBe('contact-sensor');
    });

    it('leaves nothing to report when the node can take it', () => {
      const subject = resolver([override(SHADE, 'motion-sensor')]);

      expect(subject.invalidOverrideFor(motion())).toBeUndefined();
      expect(subject.appliedOverrideFor(motion())?.primaryKind).toBe('motion-sensor');
    });
  });

  describe('where a type comes from', () => {
    it('is the override when one is applied', () => {
      const shade = node('covering (Multilevel Switch only)', RSZ1);

      expect(resolver([override(RSZ1, 'multilevel-switch')]).sourceFor(shade)).toBe('override');
    });

    it('is the registry when the hardware is named there and no override applies', () => {
      expect(resolver().sourceFor(node('covering (Multilevel Switch only)', RSZ1))).toBe('registry');
    });

    it('is the device when nothing else decided', () => {
      expect(resolver().sourceFor(node('relay'))).toBe('detected');
    });

    it('is the registry when the saved override cannot be applied', () => {
      const shade = node('covering (Multilevel Switch only)', RSZ1);

      expect(resolver([override(RSZ1, 'lock')]).sourceFor(shade)).toBe('registry');
    });
  });

  describe('the cohort a decision reaches', () => {
    it('is every interviewed single-endpoint node reporting the fingerprint', () => {
      nodes = [
        node('covering (Multilevel Switch only)', { nodeId: 10 }),
        node('dimmer with battery', { nodeId: 11 }),
        node('relay', { nodeId: 12, ...OTHER }),
      ];

      expect(resolver().cohortFor(SHADE).map((member) => member.nodeId)).toEqual([10, 11]);
    });

    it('leaves out a node whose interview has not finished', () => {
      nodes = [
        node('covering (Multilevel Switch only)', { nodeId: 10 }),
        node('dimmer with battery', { nodeId: 11, ready: false }),
      ];

      expect(resolver().cohortFor(SHADE).map((member) => member.nodeId)).toEqual([10]);
    });

    it('leaves out a node with several endpoints', () => {
      nodes = [
        node('covering (Multilevel Switch only)', { nodeId: 10 }),
        node('dimmer with battery', { nodeId: 11, endpoints: 2 }),
      ];

      expect(resolver().cohortFor(SHADE).map((member) => member.nodeId)).toEqual([10]);
    });

    it('leaves out a node that reports no fingerprint at all', () => {
      nodes = [node('dimmer with battery', { nodeId: 11, manufacturerId: undefined })];

      expect(resolver().cohortFor(SHADE)).toEqual([]);
    });

    it('keeps a node that cannot take the override, because a later decision may suit it', () => {
      nodes = [node('covering (Multilevel Switch only)', { nodeId: 10 }), sensor('Motion', { nodeId: 11 })];

      expect(
        resolver([override(SHADE, 'window-covering')]).cohortFor(SHADE).map((m) => m.nodeId),
      ).toEqual([10, 11]);
    });
  });

  describe('the types a cohort can be offered', () => {
    it('are the types every node in it could be published as', () => {
      nodes = [node('multisensor', { nodeId: 10 }), sensor('Motion', { nodeId: 11 })];

      expect(resolver().optionsFor(SHADE)).toEqual(['motion-sensor']);
    });

    it('are the types of the only node when it is alone', () => {
      nodes = [node('multisensor', { nodeId: 10 })];

      expect(resolver().optionsFor(SHADE)).toEqual(['motion-sensor', 'multilevel-sensor']);
    });

    it('are none when one node in the cohort can drive none of them', () => {
      // A Binary Sensor reporting Tilt has no feature that can read it.
      nodes = [node('multisensor', { nodeId: 10 }), sensor('Tilt', { nodeId: 11 })];

      expect(resolver().optionsFor(SHADE)).toEqual([]);
    });

    it('are none when no node reports the fingerprint', () => {
      nodes = [node('multisensor', { nodeId: 10, ...OTHER })];

      expect(resolver().optionsFor(SHADE)).toEqual([]);
    });
  });

  describe('recording where an override is applied', () => {
    it('records a node the first time the override reaches it', async () => {
      const shade = node('covering (Multilevel Switch only)', { nodeId: 10 });
      await resolver([override(SHADE, 'window-covering')]).observe(shade);

      expect(stored().observations).toEqual([
        { id: 'id-1', nodeId: 10, fingerprint: SHADE, appliedAt: NOW, orphanedAt: null },
      ]);
    });

    it('writes nothing on a later pass over the same node', async () => {
      const shade = node('covering (Multilevel Switch only)', { nodeId: 10 });
      const subject = resolver([override(SHADE, 'window-covering')]);
      await subject.observe(shade);

      const update = jest.spyOn(subject.store, 'update');
      await subject.observe(shade);

      expect(update).not.toHaveBeenCalled();
    });

    it('records nothing for a node that cannot take the override', async () => {
      const subject = resolver([override(SHADE, 'contact-sensor')]);
      const update = jest.spyOn(subject.store, 'update');
      await subject.observe(sensor('Motion', { nodeId: 10 }));

      expect(update).not.toHaveBeenCalled();
    });

    it('records nothing while the interview is unfinished', async () => {
      const subject = resolver([override(SHADE, 'window-covering')]);
      const update = jest.spyOn(subject.store, 'update');
      await subject.observe(node('covering (Multilevel Switch only)', { nodeId: 10, ready: false }));

      expect(update).not.toHaveBeenCalled();
    });

    it('records nothing while the node reports no fingerprint', async () => {
      const subject = resolver([override(SHADE, 'window-covering')]);
      const update = jest.spyOn(subject.store, 'update');
      await subject.observe(
        node('covering (Multilevel Switch only)', { nodeId: 10, productType: undefined }),
      );

      expect(update).not.toHaveBeenCalled();
    });

    it('records one node once, however many passes start together', async () => {
      const shade = node('covering (Multilevel Switch only)', { nodeId: 10 });
      const subject = resolver([override(SHADE, 'window-covering')]);

      await Promise.all([subject.observe(shade), subject.observe(shade)]);

      expect(stored().observations).toHaveLength(1);
    });
  });

  describe('a node number that now reports other hardware', () => {
    it('orphans what was recorded for it', async () => {
      const replacement = node('relay', { nodeId: 10, ...OTHER });
      await resolver([], [observation('a', 10, SHADE)]).observe(replacement);

      expect(stored().observations).toEqual([
        { ...observation('a', 10, SHADE), orphanedAt: NOW },
      ]);
    });

    it('leaves the record of another node alone', async () => {
      const replacement = node('relay', { nodeId: 10, ...OTHER });
      await resolver([], [observation('a', 10, SHADE), observation('b', 11, SHADE)]).observe(
        replacement,
      );

      expect(stored().observations.map((o: { orphanedAt: string | null }) => o.orphanedAt)).toEqual([
        NOW,
        null,
      ]);
    });

    it('keeps the time an already orphaned record was orphaned at', async () => {
      const replacement = node('relay', { nodeId: 10, ...OTHER });
      const earlier = '2026-01-01T00:00:00Z';
      const subject = resolver([], [observation('a', 10, SHADE, earlier)]);
      const update = jest.spyOn(subject.store, 'update');
      await subject.observe(replacement);

      expect(update).not.toHaveBeenCalled();
      expect(stored().observations[0].orphanedAt).toBe(earlier);
    });

    it('revives the record when the hardware comes back', async () => {
      const shade = node('covering (Multilevel Switch only)', { nodeId: 10 });
      const earlier = '2026-01-01T00:00:00Z';
      await resolver(
        [override(SHADE, 'window-covering')],
        [observation('a', 10, SHADE, earlier)],
      ).observe(shade);

      expect(stored().observations).toEqual([observation('a', 10, SHADE)]);
    });

    it('keeps the time an earlier record was orphaned at while recording another', async () => {
      // The node was recorded for other hardware and orphaned long ago. Recording what it reports
      // now must not restate when that first record stopped matching.
      const earlier = '2026-01-01T00:00:00Z';
      await resolver(
        [override(SHADE, 'window-covering')],
        [observation('a', 10, OTHER, earlier)],
      ).observe(node('covering (Multilevel Switch only)', { nodeId: 10 }));

      expect(stored().observations).toEqual([
        observation('a', 10, OTHER, earlier),
        { id: 'id-1', nodeId: 10, fingerprint: SHADE, appliedAt: NOW, orphanedAt: null },
      ]);
    });

    it('leaves a record orphaned when the hardware came back but cannot take the override', async () => {
      // The node reports hardware it was recorded for before, while the record for what it
      // reported in between is still active and has to be orphaned by this same write.
      const earlier = '2026-01-01T00:00:00Z';
      await resolver(
        [override(SHADE, 'contact-sensor')],
        [observation('a', 10, SHADE, earlier), observation('b', 10, OTHER)],
      ).observe(sensor('Motion', { nodeId: 10 }));

      expect(stored().observations).toEqual([
        observation('a', 10, SHADE, earlier),
        observation('b', 10, OTHER, NOW),
      ]);
    });

    it('does not revive a record for a node that cannot take the override', async () => {
      const earlier = '2026-01-01T00:00:00Z';
      const subject = resolver(
        [override(SHADE, 'contact-sensor')],
        [observation('a', 10, SHADE, earlier)],
      );
      const update = jest.spyOn(subject.store, 'update');
      await subject.observe(sensor('Motion', { nodeId: 10 }));

      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('when the record cannot be written', () => {
    const unwritable = () => {
      fs.writeFileSync(path.join(directory, FILE), '{ not json');
      const store = new TypeOverrideStore(directory, HOME_ID, log);
      store.load();
      return new TypeOverrideResolver(store, () => nodes, log, clock);
    };

    it('publishes every node as planned, because it knows of no decision', () => {
      const subject = unwritable();
      const shade = node('covering (Multilevel Switch only)', { nodeId: 10 });

      expect(subject.planOptionsFor(shade)).toEqual({});
      expect(subject.savedOverrideFor(shade)).toBeUndefined();
      expect(subject.invalidOverrideFor(shade)).toBeUndefined();
    });

    it('finds nothing to record, so it never reaches the write the store would refuse', async () => {
      const subject = unwritable();
      const update = jest.spyOn(subject.store, 'update');
      await subject.observe(node('covering (Multilevel Switch only)', { nodeId: 10 }));

      expect(update).not.toHaveBeenCalled();
    });

    it('reports a failing write once for a node rather than on every event', async () => {
      const shade = node('covering (Multilevel Switch only)', { nodeId: 10 });
      const subject = resolver([override(SHADE, 'window-covering')]);
      jest.spyOn(subject.store, 'update').mockRejectedValue(new Error('Disk is full'));

      await subject.observe(shade);
      await subject.observe(shade);

      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        'Could not record where the type override for Node 10 is applied. Disk is full. ' +
          'The type it publishes is unaffected.',
      );
    });

    it('reports again after a write succeeds and later fails', async () => {
      const shade = node('covering (Multilevel Switch only)', { nodeId: 10 });
      const subject = resolver([override(SHADE, 'window-covering')]);
      const update = jest.spyOn(subject.store, 'update');

      update.mockRejectedValueOnce(new Error('Disk is full'));
      await subject.observe(shade);
      update.mockRestore();
      await subject.observe(shade);
      jest.spyOn(subject.store, 'update').mockRejectedValue(new Error('Disk is full'));
      await subject.observe(node('relay', { nodeId: 10, ...OTHER }));

      expect(log.warn).toHaveBeenCalledTimes(2);
    });
  });
});
