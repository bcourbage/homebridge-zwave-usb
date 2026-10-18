import { ZWaveController } from '../../src/zwave/ZWaveController';
import { Logger } from 'homebridge';
import { Driver } from 'zwave-js';
import { EventEmitter } from 'events';
import { TaskScheduler, TaskPriority, waitFor } from '@zwave-js/waddle';

jest.mock('zwave-js');

/**
 * zwave-js guards a duplicate start with this predicate, which matches the parent task only.
 * `isRebuildingRoutes` uses the wider one below.
 */
const libraryStartGuard = (t: { tag?: { id?: string } }) => t.tag?.id === 'rebuild-routes';
const isRebuildRoutesTask = (t: { tag?: { id?: string } }) =>
  t.tag?.id === 'rebuild-routes' || t.tag?.id === 'rebuild-node-routes';

/**
 * A stand-in for the rebuild half of `Controller`, driven by the real @zwave-js/waddle
 * scheduler so the task bookkeeping the plugin's guards rely on is the library's own, not a
 * mock's idea of it. The task shapes mirror `rebuildRoutesTask` and `rebuildNodeRoutesTask`.
 */
class SchedulerBackedRebuild {
  public readonly scheduler = new TaskScheduler();
  public readonly progress = new Map<number, string>();
  private releases = new Map<number, () => void>();

  constructor(
    private readonly emitter: EventEmitter,
    private readonly nodeIds: number[],
  ) {
    this.scheduler.start();
  }

  public get isRebuildingRoutes(): boolean {
    return !!this.scheduler.findTask(isRebuildRoutesTask);
  }

  /** What zwave-js's own duplicate guard would decide right now. */
  public get libraryGuardWouldAllowStart(): boolean {
    return !this.scheduler.findTask(libraryStartGuard);
  }

  /** Lets the node currently being rebuilt finish. */
  public finishNode(id: number): void {
    this.releases.get(id)?.();
  }

  public beginRebuildingRoutes = (): boolean => {
    if (!this.libraryGuardWouldAllowStart) {
      return false;
    }
    this.progress.clear();
    for (const id of this.nodeIds) {
      this.progress.set(id, 'pending');
    }
    void this.scheduler.queueTask(this.parentTask()).catch(() => undefined);
    return true;
  };

  public stopRebuildingRoutes = (): boolean => {
    if (!this.scheduler.findTask(isRebuildRoutesTask)) {
      return false;
    }
    void this.scheduler.removeTasks(isRebuildRoutesTask);
    this.progress.clear();
    return true;
  };

  private nodeTask(id: number) {
    return {
      priority: TaskPriority.Lower,
      tag: { id: 'rebuild-node-routes', nodeId: id },
      task: async function* (this: SchedulerBackedRebuild) {
        yield* waitFor(
          new Promise<void>((resolve) => {
            this.releases.set(id, resolve);
          }),
        );
        return true;
      }.bind(this),
    };
  }

  private parentTask() {
    const self = this;
    return {
      priority: TaskPriority.Lower,
      tag: { id: 'rebuild-routes' },
      task: async function* () {
        for (const id of self.nodeIds) {
          let ok: boolean;
          try {
            ok = (yield* waitFor(self.nodeTask(id))) as boolean;
          } catch {
            // zwave-js records a removed sub-task as a failed node and carries on.
            ok = false;
          }
          self.progress.set(id, ok ? 'done' : 'failed');
          self.emitter.emit('rebuild routes progress', new Map(self.progress));
        }
        self.emitter.emit('rebuild routes done', new Map(self.progress));
        self.progress.clear();
      },
    };
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('Heal lifecycle against the real task scheduler', () => {
  let controller: ZWaveController;
  let log: jest.Mocked<Logger>;
  let engine: SchedulerBackedRebuild;
  let mockDriver: any;

  beforeEach(() => {
    log = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } as any;

    mockDriver = new EventEmitter();
    mockDriver.start = jest.fn().mockImplementation(async () => {
      setTimeout(() => mockDriver.emit('driver ready'), 0);
    });
    mockDriver.destroy = jest.fn().mockResolvedValue(undefined);
    mockDriver.controller = new EventEmitter();
    mockDriver.controller.nodes = new Map();
    mockDriver.controller.homeId = 1;

    engine = new SchedulerBackedRebuild(mockDriver.controller, [1, 2, 3]);
    mockDriver.controller.beginRebuildingRoutes = engine.beginRebuildingRoutes;
    mockDriver.controller.stopRebuildingRoutes = engine.stopRebuildingRoutes;
    Object.defineProperty(mockDriver.controller, 'isRebuildingRoutes', {
      get: () => engine.isRebuildingRoutes,
      configurable: true,
    });

    (Driver as jest.MockedClass<typeof Driver>).mockImplementation(() => mockDriver);
  });

  afterEach(async () => {
    await controller?.stop();
    await engine.scheduler.stop();
  });

  it('refuses a second start in the window where the library would allow one', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    expect(await controller.startHealing()).toBe('started');
    await flush();

    // The scheduler has swapped the parent out for the per-node sub-task.
    expect(engine.libraryGuardWouldAllowStart).toBe(true);
    expect(engine.isRebuildingRoutes).toBe(true);

    // This plugin's own lifecycle state refuses first.
    expect(await controller.startHealing()).toBe('started');

    (controller as any).healState = 'idle'; // as if the plugin had lost track of it
    expect(await controller.startHealing()).toBe('busy');
  });

  it('does not report completion until the engine reports it', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    const done = jest.fn();
    const progress = jest.fn();
    controller.on('heal network done', done);
    controller.on('heal network progress', progress);

    await controller.startHealing();
    await flush();

    engine.finishNode(1);
    await flush();
    engine.finishNode(2);
    await flush();

    expect(progress).toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();

    engine.finishNode(3);
    await flush();

    expect(done).toHaveBeenCalledTimes(1);
    expect(controller.isHealing()).toBe(false);
  });

  it('keeps refusing while a stopped rebuild is still running', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    await controller.startHealing();
    await flush();

    expect(await controller.stopHealing()).toBe(true);
    await flush();

    // The scheduler re-queued the parent, so the rebuild is still going.
    expect(engine.isRebuildingRoutes).toBe(true);
    expect(controller.isHealing()).toBe(false);
    expect(await controller.startHealing()).toBe('busy');
  });
});
