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
          A route's ACK RSSI and the average ACK RSSI show the signal strength of acknowledgement
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
    escapeHtml,
    formatRssi,
    describeRoute,
    renderDiagnostics,
    buildPluginConfig,
  };
});
