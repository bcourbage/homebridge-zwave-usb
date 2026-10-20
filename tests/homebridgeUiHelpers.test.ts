const {
  escapeHtml,
  normalizeSecurityKey,
  getInvalidSecurityKeyFields,
  buildPluginConfig,
  describeHealStart,
  healIsRunning,
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

describe('route rebuild helpers', () => {
  it('watches for the rebuild to end when one was started', () => {
    expect(describeHealStart('started')).toEqual({
      status: expect.stringContaining('Rebuilding routes'),
      watch: true,
    });
  });

  it('waits for a rebuild that was already running elsewhere', () => {
    // busy is not a failure: the driver is rebuilding from a request this plugin no longer
    // tracks, so there is something to wait for.
    const outcome = describeHealStart('busy');

    expect(outcome.watch).toBe(true);
    expect(outcome.status).toContain('already running');
  });

  it('does not watch when the controller refused', () => {
    expect(describeHealStart('refused')).toEqual({
      status: 'The controller did not start a route rebuild.',
      watch: false,
    });
  });

  it('treats an unrecognized outcome as refused rather than watching forever', () => {
    expect(describeHealStart('something new' as never).watch).toBe(false);
  });

  it.each([
    [{ healing: true, rebuilding: false }, true],
    [{ healing: false, rebuilding: true }, true],
    [{ healing: true, rebuilding: true }, true],
    [{ healing: false, rebuilding: false }, false],
    [undefined, false],
  ])('reads %p as running=%p', (state, running) => {
    // A rebuild this plugin did not start shows only in rebuilding, which is the whole reason
    // the status route reports both.
    expect(healIsRunning(state as never)).toBe(running);
  });
});
