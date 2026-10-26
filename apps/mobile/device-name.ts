const MAX_DEVICE_NAME_LENGTH = 60;

export function getPairingDeviceName(
  configuredName: string | null | undefined,
  model: string | undefined,
): string {
  const deviceName = configuredName?.trim() || model?.trim();
  if (!deviceName) {
    return 'Android device';
  }
  return deviceName.slice(0, MAX_DEVICE_NAME_LENGTH);
}
