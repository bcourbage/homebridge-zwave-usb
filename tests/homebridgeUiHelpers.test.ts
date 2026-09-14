const {
  escapeHtml,
  formatRssi,
  describeRoute,
  renderDiagnostics,
  normalizeSecurityKey,
  getInvalidSecurityKeyFields,
  buildPluginConfig,
} = require('../homebridge-ui/public/ui-helpers.js');

describe('homebridge-ui security key helpers', () => {
  it('should normalize keys by trimming whitespace and uppercasing hex', () => {
    expect(normalizeSecurityKey(' abcd1234 ')).toBe('ABCD1234');
  });

  it('should flag non-empty keys that are not 32 hex characters', () => {
    const invalid = getInvalidSecurityKeyFields({
      S0_Legacy: '1234',
      S2_Authenticated: 'G'.repeat(32),
      S2_AccessControl: 'A'.repeat(32),
    });

    expect(invalid).toEqual(['S0_Legacy', 'S2_Authenticated']);
  });

  it('should preserve the last valid security keys when current form input is invalid', () => {
    const currentConfig = {
      platform: 'ZWaveUSB',
      name: 'Plugin',
      securityKeys: {
        S0_Legacy: 'A'.repeat(32),
      },
    };

    const result = buildPluginConfig(currentConfig, {
      name: 'Plugin',
      serialPort: '/dev/tty',
      inclusionTimeoutSeconds: 60,
      debug: false,
      securityKeys: {
        S0_Legacy: '1234',
        S2_Authenticated: '',
      },
    });

    expect(result.invalidSecurityKeyFields).toEqual(['S0_Legacy']);
    expect(result.config.securityKeys).toEqual(currentConfig.securityKeys);
  });

  it('should commit normalized valid security keys into the plugin config', () => {
    const result = buildPluginConfig({}, {
      name: 'Plugin',
      serialPort: '/dev/tty',
      inclusionTimeoutSeconds: 60,
      debug: true,
      securityKeys: {
        S2_Authenticated: 'ab'.repeat(16),
        S2_AccessControl_LR: '',
      },
    });

    expect(result.invalidSecurityKeyFields).toEqual([]);
    expect(result.config.securityKeys).toEqual({
      S0_Legacy: '',
      S2_Unauthenticated: '',
      S2_Authenticated: 'AB'.repeat(16),
      S2_AccessControl: '',
      S2_Authenticated_LR: '',
      S2_AccessControl_LR: '',
    });
  });

  it('should carry the sleeping-device heal policy through to the saved config', () => {
    const base = {
      name: 'Plugin',
      serialPort: '/dev/tty',
      inclusionTimeoutSeconds: 60,
      debug: false,
      securityKeys: {},
    };

    expect(
      buildPluginConfig({}, { ...base, healIncludesSleepingDevices: true }).config
        .healIncludesSleepingDevices,
    ).toBe(true);
    expect(
      buildPluginConfig({}, { ...base, healIncludesSleepingDevices: false }).config
        .healIncludesSleepingDevices,
    ).toBe(false);
  });
});

describe('homebridge-ui HTML escaping', () => {
  it('escapes the characters that can end an element or an attribute', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('renders a device name containing markup as text', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes single quotes, which close the single-quoted attributes this page uses', () => {
    expect(escapeHtml("x' onmouseover='evil()")).not.toContain("'");
  });

  it('leaves a JSON payload parseable once the browser decodes the attribute', () => {
    const update = { version: "1.2'3", url: 'https://example.test/f?a=1&b=2' };
    const attribute = escapeHtml(JSON.stringify(update));

    expect(attribute).not.toContain("'");
    // A browser decodes entities when the attribute is read back with getAttribute.
    const decoded = attribute
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    expect(JSON.parse(decoded)).toEqual(update);
  });

  it('renders a missing value as an empty string rather than "undefined"', () => {
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(null)).toBe('');
  });
});

describe('homebridge-ui formatRssi', () => {
  it('shows a measurement in dBm, including zero and the extremes', () => {
    expect(formatRssi(-86)).toBe('-86 dBm');
    expect(formatRssi(0)).toBe('0 dBm');
    expect(formatRssi(-128)).toBe('-128 dBm');
    expect(formatRssi(124)).toBe('124 dBm');
  });

  it.each(['N/A', 'Receiver saturated', 'No signal detected'])(
    'shows the words for an RSSI error state, %s, without a unit',
    (words) => {
      expect(formatRssi(words)).toBe(words);
    },
  );

  it.each([undefined, null, Number.NaN, Infinity, {}, [], true])(
    'shows nothing for a value that is not a measurement or words (%p)',
    (value) => {
      expect(formatRssi(value)).toBe('');
    },
  );

  it('leaves escaping to the caller', () => {
    expect(formatRssi('<b>x</b>')).toBe('<b>x</b>');
    expect(escapeHtml(formatRssi('<b>x</b>'))).toBe('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('homebridge-ui describeRoute', () => {
  it('says so when nothing was recorded', () => {
    expect(describeRoute(undefined)).toBe('not recorded');
  });

  it('describes a direct route with its ACK RSSI and data rate', () => {
    expect(
      describeRoute({ repeaters: [], direct: true, ackRSSI: -78, protocolDataRate: 3 }),
    ).toBe('direct (no repeaters), ACK RSSI -78 dBm, protocol/speed code 3');
  });

  it('lists the repeaters of a routed one in order', () => {
    expect(describeRoute({ repeaters: [4, 7], direct: false })).toBe('via 4 &rarr; 7');
  });

  it.each(['N/A', 'Receiver saturated', 'No signal detected'])(
    'shows the RSSI error state %s as words with no unit',
    (words) => {
      expect(describeRoute({ repeaters: [4], direct: false, ackRSSI: words })).toBe(
        `via 4, ACK RSSI ${words}`,
      );
    },
  );

  it('shows which two nodes the most recent transmission failed between', () => {
    expect(
      describeRoute({ repeaters: [4], direct: false, routeFailedBetween: [4, 5] }),
    ).toBe('via 4, a transmission recently failed between nodes 4 and 5');
  });

  it('ignores a failure pair that is not a pair', () => {
    expect(describeRoute({ repeaters: [], direct: true, routeFailedBetween: [4] })).toBe(
      'direct (no repeaters)',
    );
  });

  it('copes with a routed report that lost its repeaters', () => {
    expect(describeRoute({ direct: false })).toBe('via ');
  });

  it('escapes everything the plugin supplied', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = describeRoute({
      repeaters: [hostile],
      direct: false,
      ackRSSI: hostile,
      routeFailedBetween: [hostile, hostile],
    });

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('homebridge-ui renderDiagnostics', () => {
  const items = (html) =>
    [...html.matchAll(/<li>(.*?)<\/li>/gs)].map((match) => match[1].trim().replace(/\s+/g, ' '));

  const full = {
    nodeId: 5,
    name: "Nico's Shade",
    status: 4,
    neighbors: [4, 6, 8],
    lastWorkingRoute: {
      repeaters: [4],
      direct: false,
      ackRSSI: -86,
      protocolDataRate: 2,
      routeFailedBetween: [4, 5],
    },
    nextToLastWorkingRoute: { repeaters: [], direct: true, ackRSSI: -90, protocolDataRate: 3 },
    averageAckRSSI: -87,
    roundTripTimeMs: 740.6,
    commandsTX: 39,
    commandsRX: 38,
    commandsDroppedTX: 1,
    commandsDroppedRX: 0,
    lastSeen: '2026-10-19T04:09:20.410Z',
    backgroundRSSI: { rssiChannel0: -97, rssiChannel1: -104 },
  };

  it('titles the dialog with the node and its name as plain text', () => {
    expect(renderDiagnostics(full).title).toBe("Node 5 (Nico's Shade) radio and routes");
  });

  it('lays out every figure of a complete report', () => {
    expect(items(renderDiagnostics(full).html)).toEqual([
      'Neighbor nodes: 4, 6, 8',
      'Last working route: via 4, ACK RSSI -86 dBm, protocol/speed code 2, a transmission recently failed between nodes 4 and 5',
      'Next-to-last working route: direct (no repeaters), ACK RSSI -90 dBm, protocol/speed code 3',
      'Average ACK RSSI at the controller (first hop): -87 dBm',
      'Average round trip: 741 ms',
      'Commands sent / received: 39 / 38',
      'Commands dropped sending / receiving: 1 / 0',
      'Last seen: 2026-10-19T04:09:20.410Z',
      'Controller background RSSI (network-wide, not this node): ch0 -97 dBm, ch1 -104 dBm',
    ]);
  });

  it('says what the signal figures describe', () => {
    // The paragraphs wrap across lines in the markup; the reader sees them as running text.
    const text = renderDiagnostics(full).html.replace(/\s+/g, ' ');

    expect(text).toContain(
      "A route's ACK RSSI and the average ACK RSSI show the signal strength of acknowledgement frames received by the controller.",
    );
    expect(text).toContain(
      'they describe the first hop, usually the nearest repeater, not the device itself.',
    );
    expect(text).toContain(
      'Controller background RSSI is a separate, network-wide measurement of ambient radio noise.',
    );
    expect(text).toContain('Routes are chosen per transmission');
  });

  it('does not call the background measurement an acknowledgement', () => {
    const { html } = renderDiagnostics(full);

    const text = html.replace(/\s+/g, ' ');

    expect(text).not.toContain('Every RSSI');
    expect(text).not.toMatch(/background[^.]*acknowledg/i);
  });

  it('labels the aggregate as an average at the controller, never as this node\'s own signal', () => {
    const { html } = renderDiagnostics(full);

    expect(html).toContain('Average ACK RSSI at the controller (first hop)');
    expect(html).not.toContain("this node's frames");
    expect(html).not.toContain('Last ACK RSSI');
  });

  it('labels the background figures as the controller\'s, not the node\'s', () => {
    expect(renderDiagnostics(full).html).toContain(
      'Controller background RSSI (network-wide, not this node)',
    );
  });

  it('shows what is missing as missing', () => {
    expect(items(renderDiagnostics({ nodeId: 6, name: 'Remote' }).html)).toEqual([
      'Neighbor nodes: not available',
      'Last working route: not recorded',
      'Next-to-last working route: not recorded',
      'Average ACK RSSI at the controller (first hop): not recorded',
      'Average round trip: not recorded',
      'Commands sent / received: 0 / 0',
      'Commands dropped sending / receiving: 0 / 0',
      'Last seen: not recorded',
      'Controller background RSSI (network-wide, not this node): not available',
    ]);
  });

  it.each([
    [127, 'N/A'],
    [126, 'Receiver saturated'],
    [125, 'No signal detected'],
  ])('shows RSSI error state %i as words in the average and in a background channel', (_code, words) => {
    const lines = items(
      renderDiagnostics({
        ...full,
        averageAckRSSI: words,
        backgroundRSSI: { rssiChannel0: words, rssiChannel1: -98 },
      }).html,
    );

    expect(lines).toContain(`Average ACK RSSI at the controller (first hop): ${words}`);
    expect(lines).toContain(
      `Controller background RSSI (network-wide, not this node): ch0 ${words}, ch1 -98 dBm`,
    );
    expect(lines.join(' ')).not.toMatch(/\b12[567] dBm/);
  });

  it('shows a counter that is not a number as 0', () => {
    const lines = items(
      renderDiagnostics({ ...full, commandsTX: '<b>1</b>', commandsRX: null, commandsDroppedTX: {} }).html,
    );

    expect(lines).toContain('Commands sent / received: 0 / 0');
    expect(lines).toContain('Commands dropped sending / receiving: 0 / 0');
  });

  it('writes nothing the plugin supplied into the markup unescaped', () => {
    const hostile = '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>';
    const { html } = renderDiagnostics({
      ...full,
      neighbors: [hostile],
      lastWorkingRoute: {
        repeaters: [hostile],
        direct: false,
        ackRSSI: hostile,
        routeFailedBetween: [hostile, hostile],
      },
      averageAckRSSI: hostile,
      lastSeen: hostile,
      backgroundRSSI: { ['rssiChannel0' + hostile]: hostile },
    });

    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img');
  });

  it('does not throw for a missing report', () => {
    expect(() => renderDiagnostics(undefined)).not.toThrow();
  });
});
