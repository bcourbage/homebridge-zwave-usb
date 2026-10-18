import { RebuildRoutesStatus } from 'zwave-js';
import { formatRebuildRoutesSummary, summarizeRebuildRoutes } from '../../src/zwave/rebuildRoutes';

const progressOf = (entries: Array<[number, RebuildRoutesStatus]>) =>
  new Map<number, RebuildRoutesStatus>(entries);

describe('summarizeRebuildRoutes', () => {
  it('counts only terminal statuses as completed', () => {
    const summary = summarizeRebuildRoutes(
      progressOf([
        [4, 'done'],
        [5, 'done'],
        [6, 'skipped'],
        [8, 'failed'],
        [9, 'pending'],
      ]),
    );

    expect(summary).toEqual({
      total: 5,
      pending: 1,
      done: 2,
      failed: 1,
      skipped: 1,
      completed: 4,
    });
  });

  it('reports nothing as completed when every node is still pending', () => {
    const summary = summarizeRebuildRoutes(
      progressOf([
        [4, 'pending'],
        [5, 'pending'],
        [6, 'pending'],
        [8, 'pending'],
        [9, 'pending'],
      ]),
    );

    expect(summary.completed).toBe(0);
    expect(summary.pending).toBe(5);
    expect(summary.total).toBe(5);
  });

  it('treats sleeping and offline nodes that were skipped as finished', () => {
    const summary = summarizeRebuildRoutes(
      progressOf([
        [4, 'done'],
        [5, 'done'],
        [6, 'skipped'],
        [8, 'skipped'],
        [9, 'skipped'],
      ]),
    );

    expect(summary.completed).toBe(5);
    expect(summary.skipped).toBe(3);
    expect(summary.failed).toBe(0);
  });

  it('returns an empty summary when no progress is available', () => {
    expect(summarizeRebuildRoutes(undefined)).toEqual({
      total: 0,
      pending: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      completed: 0,
    });
  });

  it('describes each status separately', () => {
    const summary = summarizeRebuildRoutes(
      progressOf([
        [4, 'done'],
        [5, 'failed'],
        [6, 'skipped'],
        [8, 'pending'],
      ]),
    );

    expect(formatRebuildRoutesSummary(summary)).toBe(
      '3/4 nodes finished (done 1, failed 1, skipped 1, pending 1)',
    );
  });

  it('counts a status it does not recognise as still pending', () => {
    /**
     * A future zwave-js release could add a status. Counting it as finished would overstate
     * progress, which is the defect this summarizer exists to fix, so the fallback understates.
     */
    const summary = summarizeRebuildRoutes(
      new Map([
        [4, 'done'],
        [5, 'something-new'],
      ] as unknown as Array<[number, never]>),
    );

    expect(summary).toMatchObject({ total: 2, done: 1, pending: 1, completed: 1 });
  });
});
