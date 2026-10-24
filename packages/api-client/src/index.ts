import type { GatewayHealth } from '@sms-gateway/shared-contracts';
import { gatewayHealthSchema } from '@sms-gateway/validation';

export async function fetchGatewayHealth(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<GatewayHealth> {
  const url = new URL('/v1/health', baseUrl);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Gateway URL must use HTTP or HTTPS');
  }

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Gateway health request failed with status ${response.status}`);
  }

  const result = gatewayHealthSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error('Gateway returned an invalid health response');
  }

  return result.data;
}
