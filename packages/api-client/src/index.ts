import type {
  CompleteSmsJobRequest,
  GatewayHealth,
  PairDeviceRequest,
  PairDeviceResponse,
  PairedDeviceInfo,
  SmsJob,
  SmsQueueStatus,
} from '@sms-gateway/shared-contracts';
import {
  completeSmsJobRequestSchema,
  completeSmsJobResponseSchema,
  gatewayHealthSchema,
  nextSmsJobResponseSchema,
  pairDeviceRequestSchema,
  pairDeviceResponseSchema,
  pairedDeviceInfoSchema,
  smsJobSchema,
  smsQueueStatusSchema,
} from '@sms-gateway/validation';

export interface GatewayHttpResponse {
  status: number;
  body: string;
}

export interface GatewayTransport {
  request(
    url: string,
    certificatePin: string,
    method: 'GET' | 'POST',
    body?: string,
    token?: string,
  ): Promise<GatewayHttpResponse>;
}

export interface GatewayClient {
  getHealth(): Promise<GatewayHealth>;
  pairDevice(request: PairDeviceRequest): Promise<PairDeviceResponse>;
  getPairedDevice(token: string): Promise<PairedDeviceInfo>;
  getSmsQueueStatus(token: string): Promise<SmsQueueStatus>;
  getNextSmsJob(
    token: string,
    createdBefore?: string,
  ): Promise<SmsJob | null>;
  completeSmsJob(
    token: string,
    jobId: string,
    result: CompleteSmsJobRequest,
  ): Promise<SmsJob>;
}

function parseResponse<T>(
  response: GatewayHttpResponse,
  expectedStatus: number,
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
): T {
  if (response.status !== expectedStatus) {
    let details = '';
    try {
      const body: unknown = JSON.parse(response.body);
      if (
        typeof body === 'object' &&
        body !== null &&
        'error' in body &&
        typeof body.error === 'string'
      ) {
        details = `: ${body.error}`;
      }
    } catch {
      details = '';
    }
    throw new Error(`Gateway request failed with status ${response.status}${details}`);
  }

  let body: unknown;
  try {
    body = JSON.parse(response.body) as unknown;
  } catch {
    throw new Error('Gateway returned malformed JSON');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success || parsed.data === undefined) {
    throw new Error('Gateway returned a response with an invalid format');
  }
  return parsed.data;
}

export function createGatewayClient(
  baseUrl: string,
  certificatePin: string,
  transport: GatewayTransport,
): GatewayClient {
  const base = new URL(baseUrl);
  if (
    base.protocol !== 'https:' ||
    base.username !== '' ||
    base.password !== '' ||
    base.search !== '' ||
    base.hash !== '' ||
    (base.pathname !== '' && base.pathname !== '/')
  ) {
    throw new TypeError('Gateway address must be an HTTPS origin');
  }
  if (!/^sha256\/[A-Za-z0-9+/]{43}=$/.test(certificatePin)) {
    throw new TypeError('Gateway certificate pin is invalid');
  }

  const request = async <T>(
    method: 'GET' | 'POST',
    route: string,
    expectedStatus: number,
    schema: { safeParse(value: unknown): { success: boolean; data?: T } },
    body?: unknown,
    token?: string,
  ): Promise<T> => {
    const response = await transport.request(
      new URL(route, base).toString(),
      certificatePin,
      method,
      body === undefined ? undefined : JSON.stringify(body),
      token,
    );
    return parseResponse(response, expectedStatus, schema);
  };

  return {
    getHealth: () =>
      request('GET', '/v1/health', 200, gatewayHealthSchema),
    pairDevice: (pairingRequest) => {
      const parsed = pairDeviceRequestSchema.safeParse(pairingRequest);
      if (!parsed.success) {
        throw new TypeError('Pairing details are invalid');
      }
      return request(
        'POST',
        '/v1/pair',
        201,
        pairDeviceResponseSchema,
        parsed.data,
      );
    },
    getPairedDevice: (token) =>
      request(
        'GET',
        '/v1/devices/me',
        200,
        pairedDeviceInfoSchema,
        undefined,
        token,
      ),
    getSmsQueueStatus: (token) =>
      request(
        'GET',
        '/v1/jobs/status',
        200,
        smsQueueStatusSchema,
        undefined,
        token,
      ),
    getNextSmsJob: async (token, createdBefore = new Date().toISOString()) => {
      const cutoff = new Date(createdBefore);
      if (Number.isNaN(cutoff.getTime())) {
        throw new TypeError('SMS queue cutoff is invalid');
      }
      const response = await request(
        'GET',
        `/v1/jobs/next?createdBefore=${encodeURIComponent(cutoff.toISOString())}`,
        200,
        nextSmsJobResponseSchema,
        undefined,
        token,
      );
      return response.job;
    },
    completeSmsJob: async (token, jobId, result) => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
        throw new TypeError('SMS job ID is invalid');
      }
      const parsed = completeSmsJobRequestSchema.safeParse(result);
      if (!parsed.success) {
        throw new TypeError('SMS job result is invalid');
      }
      const response = await request(
        'POST',
        `/v1/jobs/${jobId}/result`,
        200,
        completeSmsJobResponseSchema,
        parsed.data,
        token,
      );
      return response.job;
    },
  };
}
