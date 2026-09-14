import { matterLabel, matterSerialNumber, MATTER_STRING_MAX } from '../../src/matter/matterText';

describe('Matter string constraints', () => {
  it('leaves values that already fit untouched', () => {
    expect(matterLabel("Nico's Shade")).toBe("Nico's Shade");
    expect(matterSerialNumber('zwave-node-5')).toBe('zwave-node-5');
  });

  it('shortens an over-long label from the end', () => {
    const label = 'A'.repeat(40);

    expect(matterLabel(label)).toHaveLength(MATTER_STRING_MAX);
    expect(matterLabel(label)).toBe('A'.repeat(MATTER_STRING_MAX));
  });

  it('keeps two shades of the same model distinguishable', () => {
    // These are the real serials the plugin builds; they are 33 characters and differ only in
    // the final node ID, so trimming the tail would give both devices the same serial.
    const nico = 'zwave-0x026E:0x5253:0x5A31-node-5';
    const lia = 'zwave-0x026E:0x5253:0x5A31-node-8';

    expect(nico).toHaveLength(33);
    expect(matterSerialNumber(nico)).toHaveLength(MATTER_STRING_MAX);
    expect(matterSerialNumber(lia)).toHaveLength(MATTER_STRING_MAX);
    expect(matterSerialNumber(nico)).not.toBe(matterSerialNumber(lia));
    expect(matterSerialNumber(nico).endsWith('node-5')).toBe(true);
    expect(matterSerialNumber(lia).endsWith('node-8')).toBe(true);
  });

  it('respects an explicit maximum', () => {
    expect(matterLabel('abcdefgh', 4)).toBe('abcd');
    expect(matterSerialNumber('abcdefgh', 4)).toBe('efgh');
  });
});
