import { RebuildRoutesStatus } from 'zwave-js';

export interface RebuildRoutesSummary {
  total: number;
  pending: number;
  done: number;
  failed: number;
  skipped: number;
  /** done + failed + skipped. */
  completed: number;
}

export function summarizeRebuildRoutes(
  progress: ReadonlyMap<number, RebuildRoutesStatus> | undefined,
): RebuildRoutesSummary {
  const summary: RebuildRoutesSummary = {
    total: 0,
    pending: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    completed: 0,
  };

  if (!progress) {
    return summary;
  }

  for (const status of progress.values()) {
    summary.total += 1;

    switch (status) {
      case 'done':
        summary.done += 1;
        break;
      case 'failed':
        summary.failed += 1;
        break;
      case 'skipped':
        summary.skipped += 1;
        break;
      default:
        summary.pending += 1;
        break;
    }
  }

  /**
   * Derived rather than counted alongside, so there is only one definition of which statuses
   * are terminal and the counts cannot drift apart.
   */
  summary.completed = summary.done + summary.failed + summary.skipped;

  return summary;
}

export function formatRebuildRoutesSummary(summary: RebuildRoutesSummary): string {
  return (
    `${summary.completed}/${summary.total} nodes finished ` +
    `(done ${summary.done}, failed ${summary.failed}, skipped ${summary.skipped}, ` +
    `pending ${summary.pending})`
  );
}
