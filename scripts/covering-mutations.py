"""Checks that the tests for the covering controller fail when the code is wrong.

Applies each of a set of deliberate breaks to the controller or the adapter in turn (a stale
token honoured, device reports ignored, an echo taken as a position, a refused write clearing the
command in progress, a stop judged settled on the first reading, ...), runs the full suite, and
restores the file. A break counts as CAUGHT only if the suite fails while the project still
compiles; a compile failure is reported separately and not counted.

An optional second argument limits the run to mutations whose name starts with it (for example A12).

Usage, from the repository root and with nothing else using the CPU (the generated tests are
time-sensitive under load):

    python3 scripts/covering-mutations.py .

Every mutation should be reported as CAUGHT. SKIP means the text to break was not found, which
means the script has fallen out of step with the source and needs updating.

TIMED OUT means the mutated suite did not finish within SUITE_TIMEOUT_S and was killed. That is
NOT a catch: a run that stalls says nothing about whether the tests would have detected the
mutation, so it is reported separately and not counted.
"""
import subprocess, pathlib, os, sys

# A mutated suite that hangs must be killed and reported, not waited on. The unmutated suite
# takes about fifteen seconds here, so this is generous.
SUITE_TIMEOUT_S = 300

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
RC = ROOT / 'src/zwave/coveringController.ts'
AD = ROOT / 'src/features/WindowCoveringFeature.ts'
CT = ROOT / 'src/zwave/coveringTravel.ts'

M = [
 ("A1  stale poll finishing against a newer command", "poll result honoured for a retired token", RC,
  "    if (!active || active.token !== event.token) {\n      return false;\n    }\n\n    if (event.outcome !== 'answered') {",
  "    if (!active) {\n      return false;\n    }\n\n    if (event.outcome !== 'answered') {"),
 ("A2  stale timer acting for a newer command", "reconcile tick honoured for a retired token", RC,
  "    if (!active || active.token !== event.token) {\n      return false;\n    }\n\n    if (event.now >= active.deadline) {",
  "    if (!active) {\n      return false;\n    }\n\n    if (event.now >= active.deadline) {"),
 ("A3  timed-out command reported as settled", "deadline concludes achieved instead of unconfirmed", RC,
  "      this.conclude(active, 'unconfirmed', event.now);", "      this.conclude(active, 'achieved', event.now);"),
 ("A4  device reports no longer move the position", "currentValue report never verifies", RC,
  "    this.verify(value, 'device', event.now);\n    this.disturbStall(value, event.now, true);",
  "    this.disturbStall(value, event.now, true);"),
 ("A5  stop judged settled without observing it stop", "stop achieved on the first reading", RC,
  "  return stalled(active, now) ? 'achieved' : undefined;\n}", "  return 'achieved';\n}"),
 ("A6  hot recovery keeps the old node's state", "updateNode never restarts the controller", AD,
  "    if (replaced) {\n      this.restart(true);", "    if (false) {\n      this.restart(true);"),
 ("A7  refused write must not disturb the live command", "refused write clears the active command", RC,
  "      this.settle(intent.requestId, { refused: result.message });",
  "      this.settle(intent.requestId, { refused: result.message });\n      this.state.active = undefined;"),
 ("A8  a stop must discard a held move", "stop leaves the held move to fire afterwards", RC,
  "    const displaced = this.state.pending;\n    if (displaced) {",
  "    const displaced = intent.kind === 'stop' ? undefined : this.state.pending;\n    if (displaced) {"),
 ("A9  a stop is shown as stopped, not as a direction", "stop projected as moving", RC,
  "  if (live?.kind === 'stop') {\n    return { current: position, target: position, motion: 'stopped' };\n  }",
  "  if (live?.kind === 'stop') {\n    return { current: position, target: position, motion: direction(position, position + 50) };\n  }"),
 ("A10 the driver's echo is not the device answering", "untagged echo taken as a device report", RC,
  "(command) => command?.kind === 'move' && sameLevel(command.target, value),",
  "(command) => command?.kind === 'move' && sameLevel(command.target, value + 1000),"),
 ("A11 keyed Window Covering position wins over Multilevel Switch", "Multilevel Switch read first", CT,
  "  const keyed = findCoveringPositionValueId(node, endpointIndex);\n  if (keyed?.propertyKey !== undefined) {",
  "  const mlsFirst = node.getValue({\n    commandClass: CommandClasses['Multilevel Switch'],\n    property,\n    endpoint: endpointIndex,\n  });\n  if (mlsFirst !== undefined) {\n    return mlsFirst;\n  }\n  const keyed = findCoveringPositionValueId(node, endpointIndex);\n  if (keyed?.propertyKey !== undefined) {"),
 ("A12 a move that keeps getting closer is followed past the usual limit", "progress never extends the deadline", RC,
  "    Math.max(active.deadline, now + RECONCILE_MAX_MS),", "    active.deadline,"),
 ("A13 no command is followed forever", "the ceiling is ignored", RC,
  "    active.acceptedAt + RECONCILE_CEILING_MS,\n    Math.max", "    active.acceptedAt + RECONCILE_CEILING_MS * 100,\n    Math.max"),
 ("A14 a stop gets no extension for a position that is still changing", "a stop extends its deadline", RC,
  "  if (active.kind !== 'move') {\n    return active;\n  }\n  const distance",
  "  if (active.kind !== 'move') {\n    return {\n      ...active,\n      deadline: Math.min(\n        active.acceptedAt + RECONCILE_CEILING_MS,\n        Math.max(active.deadline, now + RECONCILE_MAX_MS),\n      ),\n    };\n  }\n  const distance"),
 ("A15 a move that retreats earns no extension", "the starting position is not the first distance to beat", RC,
  "      intent.kind === 'move' && reported.kind === 'verified'\n        ? Math.abs(reported.position - intent.target)\n        : undefined;",
  "      intent.kind === 'move' && reported.kind === 'verified' ? undefined : undefined;"),
 ("A16 only a verified position seeds that distance", "a provisional position seeds it too", RC,
  "intent.kind === 'move' && reported.kind === 'verified'", "intent.kind === 'move' && reported.kind !== 'unknown'"),
 ("B1  a refused write is a HomeKit failure", "refusal resolves HomeKit's promise", AD,
  "      waiter.reject(new this.platform.api.hap.HapStatusError(HAP_COMMUNICATION_FAILURE));\n    } else {",
  "      waiter.resolve();\n    } else {"),
 ("B2a results from before a node replacement are dropped (poll)", "poll ignores the epoch", AD,
  "      if (epoch === this.epoch) {\n        this.dispatch({ t: 'PollSettled'", "      if (true) {\n        this.dispatch({ t: 'PollSettled'"),
 ("B2b ... (write)", "write ignores the epoch", AD,
  "    if (epoch === this.epoch) {\n      this.dispatch({ t: 'WriteSettled'", "    if (true) {\n      this.dispatch({ t: 'WriteSettled'"),
 ("B3  a superseded request must still be answered", "superseded waiter never resolved", AD,
  "    } else {\n      // A superseded request was replaced by something newer, which is not a failure.\n      waiter.resolve();\n    }",
  "    } else if (outcome === 'accepted') {\n      waiter.resolve();\n    }"),
 ("B4  an answered poll is a device observation", "poll answer does not verify the position", RC,
  "    this.verify(event.position, 'poll', event.now);\n    const settling", "    const settling"),
 ("B5  an empty poll is no reading, not the cached one", "empty poll falls back to the cache", AD,
  "      } else {\n        if (value !== undefined) {",
  "      } else if (value === undefined) {\n        settleOnce({ outcome: 'answered', position: readCoveringPosition(this.node, this.endpoint.index, 'currentValue') ?? 0 });\n      } else {\n        if (value !== undefined) {"),
 ("B6  settle tolerance", "POSITION_TOLERANCE widened", RC,
  "export const POSITION_TOLERANCE = 1;", "export const POSITION_TOLERANCE = 2;"),
 ("B7  stopping the feature drops what is pending", "stop() never tears down the controller", AD,
  "    this.dispatch({ t: 'Teardown' });\n    this.timers.forEach((timer) => clearTimeout(timer));\n    this.timers.clear();\n  }\n\n  update(",
  "    this.timers.forEach((timer) => clearTimeout(timer));\n    this.timers.clear();\n  }\n\n  update("),
]

orig = {p: p.read_text() for p in (RC, AD, CT)}
env = dict(os.environ)
caught = survived = skipped = broke = stalled = 0
ONLY = sys.argv[2] if len(sys.argv) > 2 else ''
for name, intent, path, old, new in M:
    if ONLY and not name.startswith(ONLY):
        continue
    src = orig[path]
    if old not in src:
        print(f"{name}: SKIP (anchor not found)", flush=True); skipped += 1; continue
    path.write_text(src.replace(old, new, 1))
    try:
        tsc = subprocess.run(['npx', 'tsc', '--noEmit', '-p', '.'], cwd=ROOT, env=env, capture_output=True, text=True)
        try:
            r = subprocess.run(['npx', 'jest', '--silent'], cwd=ROOT, env=env,
                               capture_output=True, text=True, timeout=SUITE_TIMEOUT_S)
            timed_out = False
        except subprocess.TimeoutExpired:
            r = None
            timed_out = True
    finally:
        path.write_text(src)
    line = '' if r is None else next(
        (l for l in (r.stderr + r.stdout).splitlines() if l.startswith('Tests:')), '')
    if tsc.returncode != 0:
        status = 'COMPILE ERROR (not counted)'; broke += 1
    elif timed_out:
        # A mutation that makes the suite hang is not a pass and not a catch: a hang tells the
        # reader nothing about the mutation and hides it behind a stalled run.
        status = f'TIMED OUT after {SUITE_TIMEOUT_S}s (not counted)'; stalled += 1
    elif r.returncode != 0:
        status = 'CAUGHT'; caught += 1
    else:
        status = 'SURVIVED'; survived += 1
    print(f"{name}: {status}  [{intent}]  {line}", flush=True)
print(f"\ncaught {caught}, survived {survived}, skipped {skipped}, compile errors {broke}, timed out {stalled}")
sys.exit(1 if (survived or stalled or broke) else 0)
