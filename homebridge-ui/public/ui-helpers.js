(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ZWaveUsbUiHelpers = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SECURITY_KEY_FIELDS = [
    'S0_Legacy',
    'S2_Unauthenticated',
    'S2_Authenticated',
    'S2_AccessControl',
    'S2_Authenticated_LR',
    'S2_AccessControl_LR',
  ];

  function normalizeSecurityKey(value) {
    return String(value || '').trim().toUpperCase();
  }

  function normalizeSecurityKeys(keys) {
    const normalized = {};
    for (const field of SECURITY_KEY_FIELDS) {
      normalized[field] = normalizeSecurityKey(keys[field]);
    }
    return normalized;
  }

  function getInvalidSecurityKeyFields(keys) {
    return SECURITY_KEY_FIELDS.filter((field) => {
      const value = normalizeSecurityKey(keys[field]);
      return value !== '' && !/^[0-9A-F]{32}$/.test(value);
    });
  }

  const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  /**
   * Escapes a value for interpolation into HTML, as element text or inside a quoted attribute.
   * Single quotes are escaped as well as double, because attributes in this page are written
   * with either. A browser decodes the entities again when the attribute is read back, so a
   * value that goes through JSON.parse still parses.
   */
  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value).replace(
      /[&<>"']/g,
      (character) => HTML_ESCAPES[character],
    );
  }

  /**
   * Text for an RSSI the plugin reports: a number is a dBm measurement, a string is the words for
   * an RSSI error state, and anything else is nothing worth showing. Unescaped; the caller
   * escapes it where it is written into markup.
   */
  function formatRssi(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return `${value} dBm`;
    }

    return typeof value === 'string' ? value : '';
  }

  /** A figure that arrives as JSON: anything that is not a finite number is shown as 0, never as markup. */
  function countOf(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  /** One observed route as escaped markup. */
  function describeRoute(route) {
    if (!route) {
      return 'not recorded';
    }
    const path = route.direct
      ? 'direct (no repeaters)'
      : `via ${(route.repeaters || []).map((repeater) => escapeHtml(repeater)).join(' &rarr; ')}`;
    const ackRssi = formatRssi(route.ackRSSI);
    const rssi = ackRssi ? `, ACK RSSI ${escapeHtml(ackRssi)}` : '';
    const rate =
      typeof route.protocolDataRate === 'number'
        ? `, protocol/speed code ${route.protocolDataRate}`
        : '';
    const failed =
      Array.isArray(route.routeFailedBetween) && route.routeFailedBetween.length === 2
        ? `, a transmission recently failed between nodes ${escapeHtml(
            route.routeFailedBetween[0],
          )} and ${escapeHtml(route.routeFailedBetween[1])}`
        : '';

    return `${path}${rssi}${rate}${failed}`;
  }

  /**
   * The node diagnostics dialog. The title is plain text for textContent; the body is markup in
   * which every value that came from the plugin is escaped or reduced to a number.
   *
   * A route's ACK RSSI and the node-level average show the signal strength of ACK frames received
   * by the controller, so for a routed transmission they describe the first hop (usually the
   * nearest repeater), not the destination device. The background figures are a separate
   * measurement: the controller's own network-wide reading of ambient radio noise, which says
   * nothing about the selected node.
   */
  function renderDiagnostics(report) {
    const d = report || {};
    const averageAck = formatRssi(d.averageAckRSSI);
    const neighbors =
      Array.isArray(d.neighbors) && d.neighbors.length
        ? escapeHtml(d.neighbors.join(', '))
        : 'not available';
    const background = d.backgroundRSSI
      ? escapeHtml(
          Object.entries(d.backgroundRSSI)
            .map(([channel, value]) => `${channel.replace('rssiChannel', 'ch')} ${formatRssi(value) || 'not recorded'}`)
            .join(', '),
        )
      : 'not available';

    return {
      title: `Node ${d.nodeId} (${d.name}) radio and routes`,
      html: `
        <p class="text-muted mb-2">
          Routes are chosen per transmission. These values describe the last observed
          and last working routes, not a fixed connection.
        </p>
        <p class="text-muted mb-2">
          A route's ACK RSSI and the average ACK RSSI show the signal strength of acknowledgment
          frames received by the controller. For a routed transmission they describe the first hop,
          usually the nearest repeater, not the device itself. Controller background RSSI is a
          separate, network-wide measurement of ambient radio noise.
        </p>
        <ul class="pl-3 mb-0">
          <li>Neighbor nodes: ${neighbors}</li>
          <li>Last working route: ${describeRoute(d.lastWorkingRoute)}</li>
          <li>Next-to-last working route: ${describeRoute(d.nextToLastWorkingRoute)}</li>
          <li>Average ACK RSSI at the controller (first hop): ${averageAck ? escapeHtml(averageAck) : 'not recorded'}</li>
          <li>Average round trip: ${typeof d.roundTripTimeMs === 'number' ? `${Math.round(d.roundTripTimeMs)} ms` : 'not recorded'}</li>
          <li>Commands sent / received: ${countOf(d.commandsTX)} / ${countOf(d.commandsRX)}</li>
          <li>Commands dropped sending / receiving: ${countOf(d.commandsDroppedTX)} / ${countOf(d.commandsDroppedRX)}</li>
          <li>Last seen: ${d.lastSeen ? escapeHtml(d.lastSeen) : 'not recorded'}</li>
          <li>Controller background RSSI (network-wide, not this node): ${background}</li>
        </ul>
      `,
    };
  }

  /** A position the covering reported, or wording for one it never did. */
  function positionText(value) {
    return typeof value === 'number' ? `${value}%` : 'an unknown position';
  }

  /**
   * What a position test proved. The plugin cannot say a command was accepted: a write can
   * resolve without reaching the device, so the wording reports what settled and nothing more.
   * A covering already at the commanded position ends there whether it moved or not, so that
   * case is reported as proving nothing rather than as a pass.
   */
  function describeCoveringTestResult(result) {
    const asked = `Commanded ${result.requested}%`;
    const from = `from ${positionText(result.before)}`;
    const now = `now ${positionText(result.after)}`;

    if (result.startedAtTarget) {
      return `${asked} ${from}, ${now}. The covering was already there, so this proves nothing. Try a different position.`;
    }

    if (result.timedOut) {
      return `${asked} ${from}, ${now}. The covering was still reporting movement when the test gave up, so nothing was established.`;
    }

    if (result.reached) {
      return `${asked} ${from}, ${now}. The covering moved there.`;
    }

    return `${asked} ${from}, ${now}. The covering did not reach that position.`;
  }

  /**
   * What a stop proved. A covering that ignores the stop carries on to its target and comes to
   * rest there, which is indistinguishable from a successful stop unless the target is part of
   * the answer.
   */
  function describeCoveringStopResult(result) {
    const ended = `Ended at ${positionText(result.after)}`;
    const sent = `It was at ${positionText(result.before)} when the stop was sent`;

    if (result.timedOut) {
      return `${ended}. ${sent}, and the covering was still reporting movement when the test gave up, so the stop cannot be credited.`;
    }

    if (result.shortOfTarget) {
      return `${ended}, short of its target of ${positionText(result.target)}. ${sent}, and it came to rest after the stop, consistent with the stop taking effect.`;
    }

    if (!result.moved) {
      return `${ended}. ${sent}, and the covering never reported moving afterward, so nothing was established. Start a move first, then stop it part way.`;
    }

    if (typeof result.target !== 'number') {
      return `${ended}. ${sent}, but no target was recorded, so there is nothing to compare against.`;
    }

    return `${ended}, which is its target of ${positionText(result.target)}. ${sent}. The covering may have finished traveling on its own, so the stop proved nothing.`;
  }

  /**
   * What the Rebuild Routes button should say and do for each outcome the controller reports.
   *
   * `busy` means the driver is rebuilding from a request this plugin no longer tracks. There is
   * something to wait for, but `isHealing` cannot see it, so the wait has to watch the driver's
   * own view instead.
   */
  function describeHealStart(result) {
    if (result === 'started') {
      return {
        status: 'Rebuilding routes. Watch the Homebridge log for progress.',
        watch: true,
      };
    }

    if (result === 'busy') {
      return {
        status: 'A route rebuild started elsewhere is already running. Waiting for it to finish.',
        watch: true,
      };
    }

    return { status: 'The controller did not start a route rebuild.', watch: false };
  }

  /** Whether a rebuild is still running, by either the plugin's reckoning or the driver's. */
  function healIsRunning(state) {
    return Boolean(state && (state.healing || state.rebuilding));
  }

  /**
   * Path data for the icons the node table draws, each the contents of an
   * `<svg class="ico" viewBox="0 0 16 16">`. Inline rather than an icon font: a second CDN
   * would leave the table unreadable on a Homebridge host with no internet access.
   */
  const NODE_ICONS = {
    open: '<path d="M6 3l5 5-5 5"/>',
    rename: '<path d="M11 2.5l2.5 2.5L6 12.5H3.5V10z"/><path d="M9.5 4l2.5 2.5"/>',
    refresh: '<path d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1"/><path d="M13.5 2v3h-3"/>',
    diagnostics: '<path d="M3 13V10M6.3 13V7.5M9.7 13V5M13 13V2.5"/>',
    update: '<path d="M8 2v8M5 7l3 3 3-3"/><path d="M2.5 11v2.5h11V11"/>',
    battery: '<rect x="1" y="4" width="12" height="8" rx="1.6"/><path d="M14.3 6.6v2.8"/>',
    remove: '<path d="M2.5 4h11M6 4V2.5h4V4"/><path d="M4 4l.7 9.5h6.6L12 4"/>',
    info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.5v3.5M8 5v.1"/>',
    pending: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
    warning: '<path d="M8 2L1.5 13.5h13z"/><path d="M8 6.5v3M8 11.6v.1"/>',
    error: '<circle cx="8" cy="8" r="6"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/>',
  };

  /** A key the caller supplied, looked up only among the map's own entries. */
  function lookup(map, key) {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key)
      ? map[key]
      : undefined;
  }

  /**
   * The one firmware state a node is in, with the version or percentage belonging to it.
   *
   * What the plugin reports outranks what this page remembers: progress means an update is
   * running whatever the page last recorded, so the client record is read only when the plugin
   * reports no progress at all. That is what lets a five-second refresh leave a check or a
   * found update standing while never contradicting an update already under way.
   */
  function firmwareStateOf(node, record) {
    const progress = node && node.firmwareProgress;

    if (progress) {
      const reported = Number(progress.percent);
      const percent = Number.isFinite(reported) ? reported : 0;
      if (progress.outcome === 'success') {
        return { name: 'completed', percent };
      }
      if (progress.outcome === 'failure') {
        return { name: 'failed', percent };
      }
      return { name: 'updating', percent };
    }

    const phase = record && record.phase;
    if (phase === 'checking') {
      return { name: 'checking' };
    }
    if (phase === 'available' || phase === 'starting') {
      return { name: phase, version: record.version };
    }

    return { name: 'idle' };
  }

  const NO_UPDATE_TEXT = 'No updates available for this device.';
  const UPDATE_GONE_TEXT =
    'That firmware update is no longer available. The update was not started.';

  function updateChangedText(version) {
    return (
      `The available firmware update changed to v${version}. ` +
      'The update was not started. Select Update again to continue.'
    );
  }

  /**
   * The half of the firmware state this page keeps for itself, advanced by one event.
   *
   * Returns the record to keep (null means the node is back to idle), the message to show when
   * the wording belongs to this machine rather than to a server error, and whether the caller
   * should now send the update it has just been handed.
   *
   * The update payload is deliberately absent from the record. It is read at the moment it is
   * sent and never kept, so there is no stored payload to send later against a device that has
   * meanwhile been offered a different version.
   */
  function nextFirmwareRecord(record, event) {
    const version = record && record.version;
    const type = event && event.type;
    const updates = (event && event.updates) || [];
    const offered = updates.length > 0 ? updates[0] : null;
    const idle = { record: null, toast: null, start: false };

    // Keeping an "available" record without a version would offer an update called "vundefined".
    const availableAt = (at) =>
      typeof at === 'string' && at !== ''
        ? { record: { phase: 'available', version: at }, toast: null, start: false }
        : idle;

    /**
     * `update-finished` is the end of a transfer the plugin confirmed, so nothing this page
     * remembers about the update is worth keeping. Without it the page would wait for a refresh
     * to notice, and a refresh can fail.
     */
    if (type === 'node-gone' || type === 'check-failed' || type === 'update-finished') {
      return idle;
    }

    if (type === 'check-clicked') {
      return { record: { phase: 'checking' }, toast: null, start: false };
    }

    if (type === 'check-result') {
      return offered
        ? availableAt(offered.version)
        : { record: null, toast: { type: 'info', text: NO_UPDATE_TEXT }, start: false };
    }

    if (type === 'dialog-confirmed') {
      return { record: { phase: 'starting', version }, toast: null, start: false };
    }

    if (type === 'recheck-result') {
      if (!offered) {
        return { record: null, toast: { type: 'info', text: UPDATE_GONE_TEXT }, start: false };
      }
      if (offered.version !== version) {
        const changed = availableAt(offered.version);
        return {
          record: changed.record,
          toast: { type: 'info', text: updateChangedText(offered.version) },
          start: false,
        };
      }
      return { record: { phase: 'starting', version }, toast: null, start: true };
    }

    if (type === 'recheck-failed' || type === 'start-rejected') {
      return availableAt(version);
    }

    // Opening and canceling the dialog leave the record exactly as it was.
    return { record: record || null, toast: null, start: false };
  }

  /**
   * The node list with one node's firmware progress dropped.
   *
   * A snapshot taken while an update was running outlives the update: the plugin keeps its own
   * progress for thirty seconds and the page redraws from the list it last fetched, so a bar
   * that has finished moving would go on being drawn until a refresh replaced it. The list is
   * copied rather than edited, so a caller holding the old one still sees what it fetched.
   */
  function withoutFirmwareProgress(nodes, nodeId) {
    const wanted = String(nodeId);

    return (nodes || []).map((node) => {
      if (String(node && node.nodeId) !== wanted || !(node && node.firmwareProgress)) {
        return node;
      }
      const copy = Object.assign({}, node);
      delete copy.firmwareProgress;
      return copy;
    });
  }

  /**
   * The battery indicator for one node, or nothing for a device that has no battery to report.
   *
   * The icon is filled in fifths so the row reads at a glance, and the figure itself goes in the
   * label, where someone who wants the number can find it. A device can warn that its battery is
   * low without reporting a usable percentage, because Battery CC sends that warning in place of
   * one, so the warning counts on its own as well as when the level has fallen to a fifth.
   */
  function describeBattery(node) {
    const battery = node && node.battery;
    if (!battery) {
      return null;
    }

    const reported = Number(battery.level);
    const level = Number.isFinite(reported)
      ? Math.min(100, Math.max(0, Math.round(reported)))
      : undefined;
    const low = battery.low === true || (level !== undefined && level <= 20);

    return {
      level,
      low,
      // The shell is drawn whatever the charge, so an empty one still reads as a battery and a
      // device without one has no icon at all. Nothing is invented for a battery at zero, or
      // for a warning that arrived without a percentage.
      fifths: level === undefined ? 0 : Math.ceil(level / 20),
      // The warning is said in words as well as shown in red, so it reaches a screen reader and
      // anyone who cannot tell the red icon from the gray one.
      text: low
        ? level === undefined
          ? 'Battery low'
          : `Battery low, ${level}%`
        : `Battery ${level}%`,
    };
  }

  const NODE_BUTTONS = [
    { action: 'rename-node', label: 'Rename', variant: 'outline-secondary', icon: 'rename' },
    {
      action: 'refresh-node-info',
      label: 'Refresh Info',
      variant: 'outline-secondary',
      icon: 'refresh',
    },
    {
      action: 'node-diagnostics',
      label: 'Diagnostics',
      variant: 'outline-secondary',
      icon: 'diagnostics',
    },
    { action: 'check-update', label: 'Check Update', variant: 'outline-primary', icon: 'update' },
    { action: 'remove-node', label: 'Remove', variant: 'outline-danger', icon: 'remove' },
  ];

  /**
   * What the action cell holds for one node: the controller badge, a progress bar, or the
   * group of icon buttons. The page renders this and decides nothing for itself.
   */
  function describeNodeActions(node, firmwareState) {
    const state = firmwareState || { name: 'idle' };

    if (node && node.nodeId === 1) {
      return { kind: 'controller' };
    }

    /**
     * The way into the node sits outside the group of things you do to the node, so it reads
     * as a different kind of action, and it is offered whatever else the node is doing. A node
     * in the middle of a firmware update is one a reader is more likely to want to look at,
     * not less.
     */
    const open = {
      action: 'open-node',
      label: `Open node ${node.nodeId}`,
      variant: 'outline-secondary',
      icon: 'open',
      disabled: false,
      spinner: false,
    };

    if (state.name === 'updating' || state.name === 'completed' || state.name === 'failed') {
      const reported = Math.round(Number(state.percent));
      return {
        kind: 'progress',
        percent: Number.isFinite(reported) ? Math.min(100, Math.max(0, reported)) : 0,
        failed: state.name === 'failed',
        open,
      };
    }

    const buttons = NODE_BUTTONS.map((button) => {
      if (button.action === 'refresh-node-info') {
        return Object.assign({}, button, {
          requiresWakeup: !(node && (node.isListening || node.isFrequentListening)),
          disabled: false,
          spinner: false,
        });
      }

      if (button.action === 'check-update') {
        if (state.name === 'available') {
          return {
            action: 'start-update',
            label: `Update to v${state.version}`,
            variant: 'success',
            icon: 'update',
            disabled: false,
            spinner: false,
          };
        }
        if (state.name === 'checking' || state.name === 'starting') {
          return Object.assign({}, button, { disabled: true, spinner: true });
        }
      }

      return Object.assign({}, button, { disabled: false, spinner: false });
    });

    return { kind: 'buttons', buttons, open };
  }

  /** Most serious first, so a failure is never read after the routine news below it. */
  const SEVERITY_ORDER = ['error', 'warning', 'pending', 'info'];

  const REFRESH_NOTICES = {
    'waiting-wakeup': { severity: 'pending', text: 'Refresh queued until the device wakes' },
    refreshing: { severity: 'info', text: 'Refresh in progress' },
  };

  const HOMEKIT_NOTICES = {
    'cached-pending': {
      severity: 'pending',
      text: 'Cached in HomeKit; waiting for the device to wake so the interview can continue',
    },
    'pending-interview': {
      severity: 'pending',
      text: 'Not yet in HomeKit; waiting for interview metadata',
    },
  };

  const FIRMWARE_NOTICES = {
    updating: { severity: 'info', text: 'Updating firmware' },
    completed: { severity: 'info', text: 'Firmware update completed' },
    failed: { severity: 'error', text: 'Firmware update failed' },
  };

  /** What a node reports about itself, in the order a Z-Wave controller numbers them. */
  const NODE_STATUS = ['Unknown', 'Asleep', 'Awake', 'Dead', 'Alive'];

  /**
   * The badge the list and the node's own page both draw, so the two cannot come to differ
   * about what a node is doing or about which color says so.
   */
  function describeNodeStatus(node) {
    const text = NODE_STATUS[(node || {}).status] || 'Unknown';

    return {
      text,
      tone: text === 'Alive' || text === 'Awake' ? 'success' : 'secondary',
    };
  }

  /**
   * What a node's own page says about it above everything else: who it is, whether it is
   * answering, and whether it can be reached without waiting for it to wake.
   */
  function describeNodeHeader(node) {
    const status = describeNodeStatus(node);

    return {
      name: node.name || node.label || `Node ${node.nodeId}`,
      nodeId: node.nodeId,
      status: status.text,
      statusTone: status.tone,
      firmware: node.firmwareVersion ? `Firmware ${node.firmwareVersion}` : 'Firmware unknown',
      listening: node.isListening
        ? 'Always listening'
        : node.isFrequentListening
          ? 'Listens frequently'
          : 'Sleeps between reports',
    };
  }

  /**
   * The actions a node's own page offers, in the order it draws them. Diagnostics is not among
   * them: it has a section of its own.
   */
  const DETAIL_CONTROLS = ['refresh-node-info', 'check-update', 'start-update', 'remove-node'];

  /**
   * Everything a node's own page draws, decided here rather than in the page.
   *
   * Two passes over the same node produce the same description, which is what lets the page
   * compare one against the last and leave the view alone when nothing has moved. A refresh
   * that rewrote the page every five seconds would take the keyboard with it, and would take a
   * half-made choice with it once a section carries a form.
   */
  function describeNodeDetail(node, firmwareState) {
    const actions = describeNodeActions(node, firmwareState);
    const buttons = actions.kind === 'buttons' ? actions.buttons : [];

    return {
      header: describeNodeHeader(node),
      rename: buttons.find((button) => button.action === 'rename-node') || null,
      controls: buttons.filter((button) => DETAIL_CONTROLS.indexOf(button.action) !== -1),
      progress:
        actions.kind === 'progress' ? { percent: actions.percent, failed: actions.failed } : null,
    };
  }

  /** What the chip beside a published type says about where that type came from. */
  const TYPE_SOURCE_CHIPS = {
    registry: 'Verified default',
    detected: 'Detected default',
    override: 'Your override',
  };

  /** One heading for every way the saved overrides can be unavailable. */
  const STORE_ERROR_HEADING = 'Saved device type overrides are unavailable.';

  const STORE_ERROR_BODIES = {
    'permission-denied':
      'Homebridge does not have permission to read the saved overrides file, so no saved overrides are applied and type changes are disabled. Check the Homebridge log for the file location and details.',
    unreadable:
      'The saved overrides file could not be opened, so no saved overrides are applied and type changes are disabled. Check the Homebridge log for the file location and details.',
    'invalid-json':
      'The saved overrides file is damaged, so no saved overrides are applied and type changes are disabled. Check the Homebridge log for the file location and details.',
    'unsupported-version':
      'The saved overrides file is in a format this plugin does not read, so no saved overrides are applied and type changes are disabled. Check the Homebridge log for the file location and details.',
    'wrong-network':
      'The saved overrides file belongs to a different Z-Wave network, so no saved overrides are applied and type changes are disabled. Check the Homebridge log for the file location and details.',
    'invalid-data':
      'The saved overrides file holds something this plugin cannot use, so no saved overrides are applied and type changes are disabled. Check the Homebridge log for the file location and details.',
  };

  /** Four uppercase hex digits behind 0x, which is how a fingerprint is written throughout. */
  function hexWord(value) {
    return `0x${Number(value).toString(16).toUpperCase().padStart(4, '0')}`;
  }

  /** Only the type names ending in a sibilant take "es", and only the switches do. */
  function pluralTypeName(name) {
    return /(s|x|ch|sh)$/i.test(name) ? `${name}es` : `${name}s`;
  }

  /**
   * What the endpoints of a device publish, in endpoint order. A type published by more than
   * one endpoint is counted rather than written out again, and no endpoint is named or
   * numbered, because nothing a reader can do here is per endpoint.
   */
  function listEndpointTypes(endpointTypes) {
    const order = [];
    const counts = new Map();

    (endpointTypes || []).forEach((endpoint) => {
      const kind = endpoint.primaryKind;
      if (!counts.has(kind)) {
        counts.set(kind, 0);
        order.push(kind);
      }
      counts.set(kind, counts.get(kind) + 1);
    });

    return order
      .map((kind) => {
        const count = counts.get(kind);
        const name = typeName(kind);
        return count === 1 ? name : `${count} ${pluralTypeName(name)}`;
      })
      .join(', ');
  }

  /** The day an override was saved, as the page writes dates. */
  function savedOnText(savedAt) {
    const when = new Date(savedAt);
    if (Number.isNaN(when.getTime())) {
      return null;
    }

    return when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  /**
   * What the Device type section says about a device before anything can be changed: what it is
   * published as, where that came from, and which hardware the answer belongs to.
   *
   * `panels` sit above the rows and describe something that has gone wrong with this node's
   * type. `notices` sit below them and say why nothing here can be edited.
   */
  function describeTypePanel(payload) {
    const data = payload || {};
    const rows = [];
    const panels = [];
    const notices = [];
    const failed = data.rebuildFailure ? true : false;
    const override = data.override || null;

    if (failed) {
      /**
       * The page knows the named type is not what HomeKit publishes, so the row is relabeled
       * rather than left saying "Published as". Neither panel carries the error text: that
       * reached the reader in the toast that reported the failure, and the log keeps it.
       */
      panels.push(
        override
          ? {
              severity: 'warning',
              heading: 'The saved type has not been applied.',
              body: `${typeName(override.primaryKind)} is saved for this hardware, but HomeKit could not update this device. Restart Homebridge to try again. Check the Homebridge log for details.`,
            }
          : {
              severity: 'warning',
              heading: 'The default type has not been restored.',
              body: `${typeName(data.defaultKind)} is the default for this device, but HomeKit could not restore it. Restart Homebridge to try again. Check the Homebridge log for details.`,
            },
      );
    }

    const publishedLabel = failed ? (override ? 'Saved type' : 'Default type') : 'Published as';
    const published = data.multiEndpoint
      ? listEndpointTypes(data.endpointTypes)
      : data.primaryKind
        ? typeName(data.primaryKind)
        : '';

    if (data.fingerprint && published) {
      rows.push({
        label: publishedLabel,
        value: published,
        chip: lookup(TYPE_SOURCE_CHIPS, data.source) || null,
      });

      if (data.source === 'override' && override) {
        const savedOn = savedOnText(override.savedAt);
        rows.push({
          label: 'Source',
          value: savedOn ? `Your override, saved ${savedOn}` : 'Your override',
          detail: data.defaultKind ? `Default for this node: ${typeName(data.defaultKind)}` : null,
        });
      } else if (data.source === 'registry') {
        rows.push({
          label: 'Source',
          value: 'Built-in verified registry',
          detail: data.registryLabel || null,
        });
      } else {
        rows.push({ label: 'Source', value: 'Detected automatically from the device', detail: null });
      }

      if (data.label) {
        rows.push({ label: 'Device label', value: data.label, detail: null });
      }
    }

    rows.push(
      data.fingerprint
        ? {
            label: 'Hardware fingerprint',
            hex: [
              hexWord(data.fingerprint.manufacturerId),
              hexWord(data.fingerprint.productType),
              hexWord(data.fingerprint.productId),
            ],
            caption: 'Manufacturer, product type, product',
          }
        : { label: 'Hardware fingerprint', value: 'Not reported yet', detail: null },
    );

    if (!data.fingerprint) {
      notices.push({
        severity: 'info',
        body: "Available once the device's interview has finished.",
      });
    } else if (data.multiEndpoint) {
      notices.push({
        severity: 'info',
        body: 'This device provides multiple independent functions. Type overrides are not available for this kind of device yet.',
      });
    }

    const storeError = data.store && data.store.error ? data.store.error.code : null;
    if (storeError) {
      /**
       * Drawn amber rather than as information, because the plugin and the device are working
       * while saved configuration is being ignored and editing is turned off. No text from the
       * backend is shown; the code chooses the sentence.
       */
      notices.push({
        severity: 'warning',
        heading: STORE_ERROR_HEADING,
        body:
          lookup(STORE_ERROR_BODIES, storeError) || lookup(STORE_ERROR_BODIES, 'unreadable'),
      });
    }

    return { panels, rows, notices };
  }

  /**
   * The tab an arrow key moves to, or null for a key the strip does not answer, so the page
   * leaves every other key alone. Both ends wrap, which is what a tab strip does.
   */
  function nextSectionTab(names, current, key) {
    const at = names.indexOf(current);
    if (at === -1) {
      return null;
    }

    if (key === 'ArrowRight') {
      return names[(at + 1) % names.length];
    }
    if (key === 'ArrowLeft') {
      return names[(at - 1 + names.length) % names.length];
    }
    if (key === 'Home') {
      return names[0];
    }
    if (key === 'End') {
      return names[names.length - 1];
    }

    return null;
  }

  /**
   * What the Diagnostics section draws for a node.
   *
   * A failure is reported in place of a stale report rather than beside it. The covering
   * controls are offered only for a covering, and they are disabled while an operation is
   * running, which is how one stays running across a change of tab: the section is drawn from
   * this rather than from what is on screen.
   */
  function describeDiagnosticsSection(state) {
    const current = state || {};

    if (current.error) {
      return { kind: 'error', text: current.error };
    }
    if (!current.report) {
      return { kind: 'loading' };
    }

    const covering = current.covering || {};

    return {
      kind: 'report',
      report: current.report,
      controls: current.report.isWindowCovering
        ? {
            disabled: covering.running === true,
            text: typeof covering.text === 'string' ? covering.text : '',
          }
        : null,
    };
  }

  /**
   * The node a review link points at, or null for any other link. A notice sends a reader to
   * the node it is about, and parsing the target here keeps the page from treating a link it
   * gains later as one of them.
   */
  function nodeIdFromReviewLink(href) {
    const match = /^#node-(\d+)$/.exec(String(href == null ? '' : href));

    return match ? match[1] : null;
  }

  /** The name of every type a device can be published as. A kind is never shown. */
  const TYPE_NAMES = {
    'binary-switch': 'Binary Switch',
    'multilevel-switch': 'Multilevel Switch',
    'color-switch': 'Color Switch',
    'window-covering': 'Window Covering',
    'garage-door': 'Garage Door',
    lock: 'Lock',
    thermostat: 'Thermostat',
    'motion-sensor': 'Motion Sensor',
    'contact-sensor': 'Contact Sensor',
    'leak-sensor': 'Leak Sensor',
    'smoke-sensor': 'Smoke Sensor',
    'carbon-monoxide-sensor': 'Carbon Monoxide Sensor',
    'multilevel-sensor': 'Multilevel Sensor',
    'central-scene': 'Central Scene',
    siren: 'Siren',
  };

  /**
   * A type's name. A kind the table does not know is title-cased rather than shown as it is
   * written, so a type added to the plugin before this table reads as a name either way.
   */
  function typeName(kind) {
    const known = lookup(TYPE_NAMES, kind);
    if (known) {
      return known;
    }

    return String(kind || '')
      .split('-')
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /** "8", "8 and 11", "8, 11 and 12". */
  function listNodeNumbers(nodeIds) {
    const numbers = (nodeIds || []).map(String);
    if (numbers.length <= 1) {
      return numbers.join('');
    }

    return numbers.slice(0, -1).join(', ') + ' and ' + numbers[numbers.length - 1];
  }

  /**
   * What a node's row says about the type it is published as. Each one is its own sentence,
   * because a node can be behind a decision, carrying one that does not fit, and holding a
   * record of hardware that changed, all at once.
   */
  function describeTypeNotices(node) {
    const notices = [];
    const review = { href: `#node-${node.nodeId}`, text: 'Review' };

    if (node.typeInvalid) {
      notices.push({
        severity: 'warning',
        text: 'Saved type override cannot be applied to this device',
        link: review,
      });
    }

    if (node.typeOrphans === 1) {
      notices.push({
        severity: 'warning',
        text: 'A saved type override no longer matches this node',
        link: review,
      });
    } else if (node.typeOrphans > 1) {
      notices.push({
        severity: 'warning',
        text: `${node.typeOrphans} saved type overrides no longer match this node`,
        link: review,
      });
    }

    /**
     * The warning names the type this node should be publishing. With an override applied to
     * it that is the override's type. Without one the node belongs on its default, whether
     * because the override was reverted or because this node cannot take it, and the default
     * needs no naming here: the node's own page names it.
     */
    if (node.typeRebuildFailed) {
      notices.push(
        node.typeOverride
          ? {
              severity: 'warning',
              text: `${typeName(node.typeOverride.primaryKind)} is saved for this hardware but is not published here`,
              link: review,
            }
          : {
              severity: 'warning',
              text: 'The default device type could not be restored',
              link: review,
            },
      );
    }

    if (node.typeOverride) {
      const shared = node.typeOverride.sharedWith || [];
      const also =
        shared.length === 0
          ? ''
          : ` (also applies to ${shared.length === 1 ? 'Node' : 'Nodes'} ${listNodeNumbers(shared)})`;
      notices.push({
        severity: 'info',
        text: `${typeName(node.typeOverride.primaryKind)}, overridden for this hardware${also}`,
        link: null,
      });
    }

    return notices;
  }

  /**
   * The sentences shown under a node row, in the order they are to be read. Checking and
   * starting say nothing, because the spinner in the action cell already says it. The text is
   * unescaped; the caller escapes it where it is written into markup.
   */
  function describeNodeNotices(node, firmwareState) {
    const state = firmwareState || { name: 'idle' };
    const notices = [];
    const add = (notice) => {
      if (notice) {
        notices.push({
          severity: notice.severity,
          text: notice.text,
          link: notice.link || null,
        });
      }
    };

    add(lookup(REFRESH_NOTICES, node && node.refreshState));
    add(lookup(HOMEKIT_NOTICES, node && node.homekitState));

    if (state.name === 'available') {
      add({ severity: 'info', text: `Firmware update available: v${state.version}` });
    } else {
      add(lookup(FIRMWARE_NOTICES, state.name));
    }

    describeTypeNotices(node || {}).forEach(add);

    return notices.sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
    );
  }

  function buildPluginConfig(currentConfig, formValues) {
    const securityKeys = normalizeSecurityKeys(formValues.securityKeys || {});
    const invalidSecurityKeyFields = getInvalidSecurityKeyFields(securityKeys);
    const anySecurityKeysEntered = Object.values(securityKeys).some(Boolean);

    const newConfig = {
      ...currentConfig,
      name: formValues.name,
      platform: 'ZWaveUSB',
      serialPort: formValues.serialPort,
      inclusionTimeoutSeconds: formValues.inclusionTimeoutSeconds,
      debug: formValues.debug,
      healIncludesSleepingDevices: formValues.healIncludesSleepingDevices,
    };

    if (!anySecurityKeysEntered) {
      delete newConfig.securityKeys;
    } else if (invalidSecurityKeyFields.length === 0) {
      newConfig.securityKeys = securityKeys;
    } else if (currentConfig.securityKeys) {
      newConfig.securityKeys = currentConfig.securityKeys;
    } else {
      delete newConfig.securityKeys;
    }

    return {
      config: newConfig,
      normalizedSecurityKeys: securityKeys,
      invalidSecurityKeyFields,
    };
  }

  return {
    SECURITY_KEY_FIELDS,
    normalizeSecurityKey,
    normalizeSecurityKeys,
    getInvalidSecurityKeyFields,
    describeHealStart,
    healIsRunning,
    escapeHtml,
    formatRssi,
    describeRoute,
    describeCoveringTestResult,
    describeCoveringStopResult,
    renderDiagnostics,
    buildPluginConfig,
    NODE_ICONS,
    firmwareStateOf,
    nextFirmwareRecord,
    describeNodeActions,
    describeNodeNotices,
    withoutFirmwareProgress,
    describeBattery,
    describeNodeStatus,
    describeNodeHeader,
    describeNodeDetail,
    nodeIdFromReviewLink,
    nextSectionTab,
    describeDiagnosticsSection,
    describeTypePanel,
    TYPE_NAMES,
    typeName,
    listNodeNumbers,
  };
});
