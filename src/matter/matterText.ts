/**
 * Matter's Bridged Device Basic Information cluster constrains its string attributes, and a
 * value that is one character too long fails the whole accessory registration.
 */
export const MATTER_STRING_MAX = 32;

/**
 * Shortens a label by dropping the end, which is where the least identifying detail usually is.
 */
export function matterLabel(value: string, max = MATTER_STRING_MAX): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * Shortens a serial number by dropping the *start*. The plugin builds serials as a shared device
 * fingerprint followed by the node ID, so two devices of the same model differ only in the last
 * few characters; keeping the head would give them identical serials and Matter would treat them
 * as the same device.
 */
export function matterSerialNumber(value: string, max = MATTER_STRING_MAX): string {
  return value.length <= max ? value : value.slice(value.length - max);
}
