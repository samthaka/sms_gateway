import type { PairingQrPayload } from '@sms-gateway/shared-contracts';
import { pairingQrPayloadSchema } from '@sms-gateway/validation';

export function parsePairingQrPayload(value: string): PairingQrPayload {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error('This QR code is not a valid gateway pairing code.');
  }

  const parsed = pairingQrPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error('This QR code does not contain valid gateway pairing details.');
  }

  const url = new URL(parsed.data.baseUrl);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('The QR code contains an invalid gateway address.');
  }

  if (Date.parse(parsed.data.expiresAt) <= Date.now()) {
    throw new Error('This pairing QR code has expired. Scan the current code on the desktop.');
  }

  return { ...parsed.data, baseUrl: url.origin };
}
