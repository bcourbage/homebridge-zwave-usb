import { ZWaveController } from '../../src/zwave/ZWaveController';
import { Logger } from 'homebridge';
import { Driver } from 'zwave-js';
import { EventEmitter } from 'events';

// Mock dependencies
jest.mock('zwave-js');

describe('ZWaveController (Direct Mode)', () => {
  let controller: ZWaveController;
  let log: jest.Mocked<Logger>;
  let mockDriver: any;

  beforeEach(() => {
    log = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as any;

    // Setup Driver mock using EventEmitter
    mockDriver = new EventEmitter();
    mockDriver.start = jest.fn().mockImplementation(async () => {
      setTimeout(() => mockDriver.emit('driver ready'), 10);
    });
    mockDriver.destroy = jest.fn().mockResolvedValue(undefined);
    mockDriver.controller = new EventEmitter();
    mockDriver.controller.nodes = new Map();
    mockDriver.controller.homeId = 1;
    mockDriver.controller.beginInclusion = jest.fn().mockResolvedValue(true);
    mockDriver.controller.stopInclusion = jest.fn().mockResolvedValue(true);
    mockDriver.controller.beginExclusion = jest.fn().mockResolvedValue(true);
    mockDriver.controller.stopExclusion = jest.fn().mockResolvedValue(true);
    /**
     * These two are synchronous in zwave-js 15 and return a boolean. Mocking them as promises
     * would let the production code depend on an API shape the library does not have.
     */
    mockDriver.controller.beginRebuildingRoutes = jest.fn().mockReturnValue(true);
    mockDriver.controller.stopRebuildingRoutes = jest.fn().mockReturnValue(true);

    const DriverMock = Driver as jest.MockedClass<typeof Driver>;
    DriverMock.mockImplementation(() => mockDriver);
  });

  afterEach(async () => {
    jest.useRealTimers();
    await controller?.stop();
  });

  it('should start the driver and wait for ready', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();
    expect(mockDriver.start).toHaveBeenCalled();
  });

  it('should disable driver debug logging when debug is false', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0', { debug: false });
    await controller.start();

    const DriverMock = Driver as jest.MockedClass<typeof Driver>;
    expect(DriverMock).toHaveBeenCalledWith(
      '/dev/ttyACM0',
      expect.objectContaining({
        logConfig: expect.objectContaining({
          enabled: false,
          level: 'info',
          forceConsole: false,
        }),
      }),
    );
  });

  it('should enable driver debug logging when debug is true', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0', { debug: true });
    await controller.start();

    const DriverMock = Driver as jest.MockedClass<typeof Driver>;
    expect(DriverMock).toHaveBeenCalledWith(
      '/dev/ttyACM0',
      expect.objectContaining({
        logConfig: expect.objectContaining({
          enabled: true,
          level: 'debug',
          forceConsole: true,
        }),
      }),
    );
  });

  it('should handle inclusion', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();
    await controller.startInclusion();
    expect(mockDriver.controller.beginInclusion).toHaveBeenCalled();
  });

  it('should get available firmware updates', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 2;
    mockNode.status = 4; // Alive
    mockNode.getAvailableFirmwareUpdates = jest.fn().mockResolvedValue([{ version: '1.1' }]);
    mockDriver.controller.emit('node added', mockNode);

    const updates = await controller.getAvailableFirmwareUpdates(2);
    expect(mockNode.getAvailableFirmwareUpdates).toHaveBeenCalled();
    expect(updates).toEqual([{ version: '1.1' }]);
  });

  it('should begin firmware update', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 2;
    mockNode.status = 4; // Alive
    mockNode.updateFirmware = jest.fn().mockResolvedValue(undefined);
    mockDriver.controller.emit('node added', mockNode);

    await controller.beginFirmwareUpdate(2, { version: '1.1' });
    expect(mockNode.updateFirmware).toHaveBeenCalledWith([{ version: '1.1' }]);
  });

  it('should abort firmware update', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 2;
    mockNode.status = 4; // Alive
    mockNode.abortFirmwareUpdate = jest.fn().mockResolvedValue(undefined);
    mockDriver.controller.emit('node added', mockNode);

    await controller.abortFirmwareUpdate(2);
    expect(mockNode.abortFirmwareUpdate).toHaveBeenCalled();
  });

  it('should set node name', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 2;
    mockNode.status = 4; // Alive
    mockNode.name = 'Old Name';
    mockDriver.controller.emit('node added', mockNode);

    controller.setNodeName(2, 'New Name');
    expect(mockNode.name).toBe('New Name');
  });

  it('should refresh node info and surface wake-up guidance for sleepy nodes', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 2;
    mockNode.status = 1;
    mockNode.isListening = false;
    mockNode.isFrequentListening = false;
    mockNode.refreshInfo = jest.fn().mockResolvedValue(undefined);
    mockDriver.controller.emit('node added', mockNode);

    await expect(controller.refreshNodeInfo(2)).resolves.toEqual({
      nodeId: 2,
      requiresWakeUp: true,
    });
    expect(mockNode.refreshInfo).toHaveBeenCalled();
  });

  it('should return immediately when a sleepy node refresh is still waiting for wake-up', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    let resolveRefresh: (() => void) | undefined;
    const refreshPromise = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 3;
    mockNode.status = 1;
    mockNode.isListening = false;
    mockNode.isFrequentListening = false;
    mockNode.refreshInfo = jest.fn().mockReturnValue(refreshPromise);
    mockDriver.controller.emit('node added', mockNode);

    await expect(controller.refreshNodeInfo(3)).resolves.toEqual({
      nodeId: 3,
      requiresWakeUp: true,
    });
    expect(mockNode.refreshInfo).toHaveBeenCalled();

    resolveRefresh?.();
    await refreshPromise;
  });

  it('should emit node updated during interview lifecycle changes', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 2;
    mockNode.status = 1;
    mockNode.ready = false;

    const onNodeUpdated = jest.fn();
    controller.on('node updated', onNodeUpdated);

    mockDriver.controller.emit('node added', mockNode);
    mockNode.emit('interview stage completed', mockNode, 'NodeInfo');
    mockNode.emit('interview failed', mockNode, { errorMessage: 'timed out' });
    mockNode.emit('wake up', mockNode);
    mockNode.emit('sleep', mockNode);
    mockNode.emit('dead', mockNode);
    mockNode.emit('alive', mockNode);

    expect(onNodeUpdated).toHaveBeenCalledTimes(6);
  });

  it('should fetch and cache a device-specific serial number when a node becomes ready', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 4;
    mockNode.status = 4;
    mockNode.ready = false;
    mockNode.supportsCC = jest
      .fn()
      .mockImplementation((cc) => cc === 114);
    mockNode.commandClasses = {
      'Manufacturer Specific': {
        deviceSpecificGet: jest.fn().mockResolvedValue('lock-serial-0001'),
      },
    };

    const onNodeUpdated = jest.fn();
    controller.on('node updated', onNodeUpdated);

    mockDriver.controller.emit('node added', mockNode);
    mockNode.emit('ready');

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockNode.commandClasses['Manufacturer Specific'].deviceSpecificGet).toHaveBeenCalledWith(1);
    expect(mockNode.deviceSerialNumber).toBe('lock-serial-0001');
    expect(onNodeUpdated).toHaveBeenCalledWith(mockNode);
  });

  it('should resolve S2 PIN entry from the controller callback path', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0', { storagePath: '/tmp' });
    const onStatusUpdated = jest.fn();
    controller.on('status updated', onStatusUpdated);

    await controller.start();

    const DriverMock = Driver as jest.MockedClass<typeof Driver>;
    const driverOptions = DriverMock.mock.calls.at(-1)![1] as {
      inclusionUserCallbacks: { validateDSKAndEnterPIN: (dsk: string) => Promise<string | false> };
    };

    const pinPromise = driverOptions.inclusionUserCallbacks.validateDSKAndEnterPIN('12345-67890');
    controller.setS2Pin('00123');

    await expect(pinPromise).resolves.toBe('00123');
    expect(onStatusUpdated).toHaveBeenCalledWith('S2 PIN REQUIRED');
  });
  describe('network heal lifecycle', () => {
    const addNode = (nodeId: number, status: number) => {
      const node = new EventEmitter() as any;
      node.nodeId = nodeId;
      node.status = status;
      mockDriver.controller.emit('node added', node);
      return node;
    };

    it('starts exactly one rebuild for repeated start requests', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const results = await Promise.all([
        controller.startHealing(),
        controller.startHealing(),
        controller.startHealing(),
      ]);

      expect(mockDriver.controller.beginRebuildingRoutes).toHaveBeenCalledTimes(1);
      expect(results).toEqual(['started', 'started', 'started']);
    });

    it('reports failure when the controller refuses and nothing is running', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      mockDriver.controller.beginRebuildingRoutes.mockReturnValueOnce(false);
      mockDriver.controller.isRebuildingRoutes = false;

      await expect(controller.startHealing()).resolves.toBe('refused');
      expect(controller.isHealing()).toBe(false);
    });

    it('never fabricates a completion event when every node is finished', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const onDone = jest.fn();
      controller.on('heal network done', onDone);

      jest.useFakeTimers();
      await controller.startHealing();
      mockDriver.controller.emit(
        'rebuild routes progress',
        new Map([
          [4, 'done'],
          [5, 'done'],
        ]),
      );

      jest.advanceTimersByTime(60000);

      expect(onDone).not.toHaveBeenCalled();
      expect(controller.isHealing()).toBe(true);
    });

    it('ignores a completion for a rebuild it no longer owns', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const onDone = jest.fn();
      const onStatus = jest.fn();
      controller.on('heal network done', onDone);

      await controller.startHealing();
      await controller.stopHealing();
      controller.on('status updated', onStatus);

      /**
       * stopRebuildingRoutes clears the driver's progress map and the orphaned task can still
       * finish, so this arrives with only the nodes it managed afterwards. Reporting it would
       * announce a 100% completion for a heal the user cancelled.
       */
      mockDriver.controller.emit('rebuild routes done', new Map([[7, 'done']]));

      expect(onDone).not.toHaveBeenCalled();
      expect(onStatus).not.toHaveBeenCalledWith('Heal Network Done');
      expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('Heal Network Complete'));
    });

    it('does not let a finished heal clear the status of the next one', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      jest.useFakeTimers();
      await controller.startHealing();
      mockDriver.controller.emit('rebuild routes done', new Map([[4, 'done']]));

      // A second heal starts inside the five second window the first one's epilogue owns.
      jest.advanceTimersByTime(1000);
      await controller.startHealing();

      const onStatus = jest.fn();
      controller.on('status updated', onStatus);
      jest.advanceTimersByTime(10000);

      mockDriver.controller.emit('rebuild routes progress', new Map([[4, 'pending']]));

      expect(onStatus).not.toHaveBeenCalledWith('Driver Ready');
      expect(onStatus).toHaveBeenLastCalledWith('Heal: 0/1');
    });

    it('counts pending nodes as unfinished in the progress it reports', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const onStatus = jest.fn();
      controller.on('status updated', onStatus);

      await controller.startHealing();
      mockDriver.controller.emit(
        'rebuild routes progress',
        new Map([
          [4, 'done'],
          [5, 'pending'],
          [6, 'skipped'],
          [8, 'skipped'],
          [9, 'skipped'],
        ]),
      );

      expect(onStatus).toHaveBeenCalledWith('Heal: 4/5');
    });

    it('completes only on the genuine completion event', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const onDone = jest.fn();
      controller.on('heal network done', onDone);

      await controller.startHealing();
      const result = new Map([
        [4, 'done'],
        [5, 'done'],
        [6, 'skipped'],
      ]);
      mockDriver.controller.emit('rebuild routes done', result);

      expect(onDone).toHaveBeenCalledWith(result);
      expect(controller.isHealing()).toBe(false);
    });

    it('allows a new heal once the previous one completed', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      await controller.startHealing();
      mockDriver.controller.emit('rebuild routes done', new Map([[4, 'done']]));
      await controller.startHealing();

      expect(mockDriver.controller.beginRebuildingRoutes).toHaveBeenCalledTimes(2);
    });

    it('reports a timeout without forging a library completion event', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const onDone = jest.fn();
      const onStopped = jest.fn();
      controller.on('heal network done', onDone);
      controller.on('heal network stopped', onStopped);

      jest.useFakeTimers();
      await controller.startHealing();
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      expect(onStopped).toHaveBeenCalledWith('timeout');
      expect(onDone).not.toHaveBeenCalled();
      expect(mockDriver.controller.stopRebuildingRoutes).toHaveBeenCalled();
      expect(controller.isHealing()).toBe(false);
    });

    it('still reports a timeout when stopping the rebuild rejects', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);

      const onStopped = jest.fn();
      const onDone = jest.fn();
      controller.on('heal network stopped', onStopped);
      controller.on('heal network done', onDone);

      mockDriver.controller.stopRebuildingRoutes.mockImplementationOnce(() => {
        throw new Error('controller is busy');
      });

      jest.useFakeTimers();
      await controller.startHealing();
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);
      jest.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));

      process.off('unhandledRejection', unhandled);

      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to stop the timed-out heal: controller is busy'),
      );
      expect(onStopped).toHaveBeenCalledWith('timeout');
      expect(onDone).not.toHaveBeenCalled();
      expect(controller.isHealing()).toBe(false);
      expect(unhandled).not.toHaveBeenCalled();
    });

    it('closes the lifecycle when the heal is cancelled', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const onStopped = jest.fn();
      controller.on('heal network stopped', onStopped);

      await controller.startHealing();
      await controller.stopHealing();

      expect(onStopped).toHaveBeenCalledWith('cancelled');
      expect(controller.isHealing()).toBe(false);
    });

    it('does not start a second rebuild while the driver is still running one', async () => {
      /**
       * stopRebuildingRoutes removes the task asynchronously, and the parent task is not in the
       * scheduler's queue while it waits on a node, so it resumes and keeps going. The driver is
       * therefore the authority on whether a rebuild is running, not this plugin's own state.
       */
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      await controller.startHealing();
      await controller.stopHealing();

      mockDriver.controller.isRebuildingRoutes = true;
      mockDriver.controller.beginRebuildingRoutes.mockClear();

      /**
       * Refused rather than adopted. An adopted rebuild inherits a progress map the driver has
       * already cleared, so every later report would look like 100% - the very defect this
       * change exists to remove.
       */
      await expect(controller.startHealing()).resolves.toBe('busy');

      expect(mockDriver.controller.beginRebuildingRoutes).not.toHaveBeenCalled();
      expect(controller.isHealing()).toBe(false);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('still rebuilding routes'));
    });

    it('does not time out a heal that was asked to include sleeping devices', async () => {
      /**
       * The driver emits nothing while it waits for a device to wake, so an inactivity watchdog
       * would cancel a run that is behaving exactly as configured.
       */
      controller = new ZWaveController(log, '/dev/ttyACM0', {
        healIncludesSleepingDevices: true,
      });
      const onStopped = jest.fn();
      controller.on('heal network stopped', onStopped);

      await controller.start();
      jest.useFakeTimers();
      await controller.startHealing();

      await jest.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(onStopped).not.toHaveBeenCalled();
      expect(controller.isHealing()).toBe(true);
    });

    it('passes the configured sleeping-device policy to the driver', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      await controller.startHealing();
      expect(mockDriver.controller.beginRebuildingRoutes).toHaveBeenCalledWith({
        includeSleeping: false,
      });

      await controller.stop();
      controller = new ZWaveController(log, '/dev/ttyACM0', {
        healIncludesSleepingDevices: true,
      });
      await controller.start();
      await controller.startHealing();
      expect(mockDriver.controller.beginRebuildingRoutes).toHaveBeenLastCalledWith({
        includeSleeping: true,
      });
    });

    it('ignores a progress event that arrives after the heal was cancelled', async () => {
      /**
       * Cancelling leaves the library's task briefly alive and it emits one last progress event
       * on its way out. Treating that as a running rebuild would revive a heal the user had just
       * stopped, and then block the next one until the watchdog expired.
       */
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      await controller.startHealing();
      await controller.stopHealing();

      const onProgress = jest.fn();
      const onStatus = jest.fn();
      controller.on('heal network progress', onProgress);
      controller.on('status updated', onStatus);

      mockDriver.controller.emit('rebuild routes progress', new Map([[4, 'pending']]));

      // The guard has to suppress the side effects, not merely leave the end state tidy.
      expect(controller.isHealing()).toBe(false);
      expect(onProgress).not.toHaveBeenCalled();
      expect(onStatus).not.toHaveBeenCalledWith(expect.stringMatching(/^Heal: /));

      mockDriver.controller.beginRebuildingRoutes.mockClear();
      await controller.startHealing();
      expect(mockDriver.controller.beginRebuildingRoutes).toHaveBeenCalledTimes(1);
    });

    it('reports sleeping and offline nodes as skipped rather than failed', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const onDone = jest.fn();
      controller.on('heal network done', onDone);

      await controller.startHealing();
      // Skipped rather than failed is a consequence of asking the driver to leave them alone.
      expect(mockDriver.controller.beginRebuildingRoutes).toHaveBeenCalledWith({
        includeSleeping: false,
      });
      mockDriver.controller.emit(
        'rebuild routes done',
        new Map([
          [4, 'done'],
          [5, 'done'],
          [6, 'skipped'],
          [8, 'skipped'],
          [9, 'skipped'],
        ]),
      );

      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining('done 2, failed 0, skipped 3, pending 0'),
      );
    });

    it('keeps the watchdog alive while the rebuild is still reporting progress', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      const onStopped = jest.fn();
      controller.on('heal network stopped', onStopped);

      await controller.start();
      jest.useFakeTimers();
      await controller.startHealing();

      /**
       * A large network can take far longer in total than the idle timeout. As long as it keeps
       * reporting, it must not be cancelled.
       */
      for (let minute = 0; minute < 40; minute++) {
        await jest.advanceTimersByTimeAsync(60 * 1000);
        mockDriver.controller.emit('rebuild routes progress', new Map([[4, 'pending']]));
      }

      expect(onStopped).not.toHaveBeenCalled();
      expect(controller.isHealing()).toBe(true);
      expect(mockDriver.controller.stopRebuildingRoutes).not.toHaveBeenCalled();
    });

    it('times out only once the rebuild stops reporting progress', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      const onStopped = jest.fn();
      controller.on('heal network stopped', onStopped);

      await controller.start();
      jest.useFakeTimers();
      await controller.startHealing();

      await jest.advanceTimersByTimeAsync(9 * 60 * 1000);
      mockDriver.controller.emit('rebuild routes progress', new Map([[4, 'pending']]));
      await jest.advanceTimersByTimeAsync(9 * 60 * 1000);
      expect(onStopped).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(onStopped).toHaveBeenCalledWith('timeout');
    });
  });
});
