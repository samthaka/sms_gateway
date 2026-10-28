import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import selfsigned from 'selfsigned';
import type {
  EnqueueSmsRequest,
  SmsJob,
  SmsQueueStatus,
  DesktopGatewayStatus,
  GatewayHealth,
  PairDeviceRequest,
  PairDeviceResponse,
  PairedDevice,
  PairedDeviceInfo,
} from '@sms-gateway/shared-contracts';
import {
  completeSmsJobRequestSchema,
  enqueueSmsRequestSchema,
  pairDeviceRequestSchema,
  smsJobSchema,
  smsDeliveryReportRequestSchema,
} from '@sms-gateway/validation';

export const DEFAULT_GATEWAY_PORT = 47832;
const PAIRING_CODE_LIFETIME_MS = 5 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;
const PAIRING_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const MAX_REQUEST_BYTES = 8192;

interface StoredDevice extends PairedDevice {
  tokenHash: string;
}

interface StoredSmsJob extends SmsJob {
  deviceId: string;
  idempotencyKey: string;
}

interface DeviceStore {
  devices: StoredDevice[];
}

interface StoredCertificate {
  certificate: string;
  privateKey: string;
}

export interface GatewayServerOptions {
  host?: string;
  port?: number;
  storageDir: string;
}

export interface GatewayRuntime {
  getStatus(): DesktopGatewayStatus;
  getCertificate(): string;
  rotatePairingCode(): DesktopGatewayStatus;
  revokeDevice(deviceId: string): Promise<void>;
  enqueueSmsBatch(
    deviceId: string,
    requests: EnqueueSmsRequest[],
  ): Promise<number>;
  getSmsQueueStatus(deviceId?: string): SmsQueueStatus;
  getSmsJobs(deviceId?: string): SmsJob[];
  retrySmsJob(
    jobId: string,
    deviceId?: string,
  ): Promise<{ status: 'retried'; job: SmsJob } | { status: 'not-found' } | { status: 'not-failed' }>;
  deleteFailedSmsJob(
    jobId: string,
    deviceId?: string,
  ): Promise<'deleted' | 'not-found' | 'not-failed'>;
  updateSmsDeliveryReport(
    jobId: string,
    deviceId: string,
    status: 'delivered' | 'not-delivered',
  ): Promise<'updated' | 'not-found' | 'not-sent' | 'conflict'>;
  close(): Promise<void>;
}

function getLanAddresses(port: number): string[] {
  const addresses = Object.values(networkInterfaces())
    .flatMap((interfaces) => interfaces ?? [])
    .filter(
      (address) => !address.internal && address.family === 'IPv4',
    )
    .map((address) => `https://${address.address}:${port}`);

  return [...new Set(addresses)];
}

function getCertificatePin(certificate: string): string {
  const publicKey = new X509Certificate(certificate).publicKey.export({
    type: 'spki',
    format: 'der',
  });
  return `sha256/${createHash('sha256').update(publicKey).digest('base64')}`;
}

function getCertificateAddresses(): string[] {
  return [
    '127.0.0.1',
    '10.0.2.2',
    ...Object.values(networkInterfaces())
      .flatMap((interfaces) => interfaces ?? [])
      .filter(
        (address) => !address.internal && address.family === 'IPv4',
      )
      .map((address) => address.address),
  ];
}

async function loadOrCreateCertificate(
  storageDir: string,
): Promise<StoredCertificate> {
  const certificatePath = path.join(storageDir, 'gateway-certificate.json');
  const expectedAddresses = getCertificateAddresses();
  let existingCertificate: StoredCertificate | undefined;

  try {
    const parsed: unknown = JSON.parse(
      await readFile(certificatePath, 'utf8'),
    );
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('certificate' in parsed) ||
      typeof parsed.certificate !== 'string' ||
      !('privateKey' in parsed) ||
      typeof parsed.privateKey !== 'string'
    ) {
      throw new Error('Stored gateway certificate has an invalid format');
    }
    existingCertificate = {
      certificate: parsed.certificate,
      privateKey: parsed.privateKey,
    };
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  if (existingCertificate) {
    const x509 = new X509Certificate(existingCertificate.certificate);
    const san = x509.subjectAltName ?? '';
    const hasCurrentAddresses = expectedAddresses.every((address) =>
      san.includes(address),
    );
    const now = Date.now();
    const isValid =
      new Date(x509.validFrom).getTime() <= now &&
      new Date(x509.validTo).getTime() > now;
    if (hasCurrentAddresses && isValid) {
      await chmod(certificatePath, 0o600);
      return existingCertificate;
    }
  }

  const certificate = await selfsigned.generate(
    [{ name: 'commonName', value: 'SMS Gateway' }],
    {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notAfterDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      extensions: [
        { name: 'basicConstraints', cA: false },
        {
          name: 'keyUsage',
          digitalSignature: true,
        },
        { name: 'extKeyUsage', serverAuth: true },
        {
          name: 'subjectAltName',
          altNames: expectedAddresses.map((address) => ({
            type: 7,
            ip: address,
          })),
        },
      ],
    },
  );
  const stored = {
    certificate: certificate.cert,
    privateKey: certificate.private,
  };
  const tempPath = `${certificatePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(stored), { mode: 0o600 });
  await rename(tempPath, certificatePath);
  await chmod(certificatePath, 0o600);
  return stored;
}

async function loadDeviceStore(storageDir: string): Promise<DeviceStore> {
  const storePath = path.join(storageDir, 'paired-devices.json');

  try {
    const parsed: unknown = JSON.parse(await readFile(storePath, 'utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('devices' in parsed) ||
      !Array.isArray(parsed.devices)
    ) {
      throw new Error('Paired device store has an invalid format');
    }

    const devices: unknown[] = parsed.devices;
    if (
      !devices.every(
        (device: unknown): device is StoredDevice =>
          typeof device === 'object' &&
          device !== null &&
          'id' in device &&
          typeof device.id === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            device.id,
          ) &&
          'name' in device &&
          typeof device.name === 'string' &&
          device.name.trim().length > 0 &&
          'pairedAt' in device &&
          typeof device.pairedAt === 'string' &&
          !Number.isNaN(Date.parse(device.pairedAt)) &&
          'tokenHash' in device &&
          typeof device.tokenHash === 'string' &&
          /^[a-f0-9]{64}$/.test(device.tokenHash),
      )
    ) {
      throw new Error('Paired device store contains invalid device records');
    }

    return { devices };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { devices: [] };
    }
    throw error;
  }
}

async function saveDeviceStore(
  storageDir: string,
  store: DeviceStore,
): Promise<void> {
  const storePath = path.join(storageDir, 'paired-devices.json');
  const tempPath = `${storePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(store), { mode: 0o600 });
  await rename(tempPath, storePath);
  await chmod(storePath, 0o600);
}

async function loadSmsJobs(storageDir: string): Promise<StoredSmsJob[]> {
  const storePath = path.join(storageDir, 'sms-jobs.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(storePath, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('jobs' in parsed) ||
    !Array.isArray(parsed.jobs)
  ) {
    throw new Error('SMS job store has an invalid format');
  }

  const jobs: StoredSmsJob[] = [];
  for (const value of parsed.jobs as unknown[]) {
    if (typeof value !== 'object' || value === null) {
      throw new Error('SMS job store contains an invalid job');
    }
    const job = smsJobSchema.safeParse(value);
    if (
      !job.success ||
      !('deviceId' in value) ||
      typeof value.deviceId !== 'string' ||
      !('idempotencyKey' in value) ||
      typeof value.idempotencyKey !== 'string'
    ) {
      throw new Error('SMS job store contains an invalid job');
    }
    jobs.push({
      ...job.data,
      deviceId: value.deviceId,
      idempotencyKey: value.idempotencyKey,
    });
  }
  return jobs;
}

async function saveSmsJobs(
  storageDir: string,
  jobs: StoredSmsJob[],
): Promise<void> {
  const storePath = path.join(storageDir, 'sms-jobs.json');
  const tempPath = `${storePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify({ jobs }), { mode: 0o600 });
  await rename(tempPath, storePath);
  await chmod(storePath, 0o600);
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<unknown | undefined> {
  const contentLength = Number(request.headers['content-length'] ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    return undefined;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      return undefined;
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function bearerToken(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  if (!value?.startsWith('Bearer ')) {
    return undefined;
  }
  return value.slice('Bearer '.length);
}

function safeHashEquals(token: string, storedHash: string): boolean {
  if (token.length !== 43) {
    return false;
  }
  const candidate = createHash('sha256').update(token).digest();
  const expected = Buffer.from(storedHash, 'hex');
  return expected.length === candidate.length && timingSafeEqual(candidate, expected);
}

export async function startGatewayServer(
  options: GatewayServerOptions,
): Promise<GatewayRuntime> {
  const host = options.host ?? '0.0.0.0';
  const port = options.port ?? DEFAULT_GATEWAY_PORT;
  const serverId = randomUUID();
  await mkdir(options.storageDir, { recursive: true, mode: 0o700 });
  await chmod(options.storageDir, 0o700);
  const tls = await loadOrCreateCertificate(options.storageDir);
  const certificatePin = getCertificatePin(tls.certificate);
  const store = await loadDeviceStore(options.storageDir);
  let smsJobs = await loadSmsJobs(options.storageDir);
  let recoveredJobs = false;
  for (const job of smsJobs) {
    if (job.status === 'sending') {
      job.status = 'failed';
      job.failureReason =
        'Delivery state was unknown after the gateway restarted; this message was not resent.';
      job.updatedAt = new Date().toISOString();
      recoveredJobs = true;
    }
  }
  if (recoveredJobs) {
    await saveSmsJobs(options.storageDir, smsJobs);
  }
  let smsJobMutation = Promise.resolve();
  const mutateSmsJobs = <T>(
    operation: (jobs: StoredSmsJob[]) => T,
  ): Promise<T> => {
    const mutation = smsJobMutation.then(async () => {
      const nextJobs = smsJobs.map((job) => ({ ...job }));
      const result = operation(nextJobs);
      await saveSmsJobs(options.storageDir, nextJobs);
      smsJobs = nextJobs;
      return result;
    });
    smsJobMutation = mutation.then(
      () => undefined,
      () => undefined,
    );
    return mutation;
  };
  const getSmsQueueStatus = (deviceId?: string): SmsQueueStatus => {
    const jobs = deviceId
      ? smsJobs.filter((job) => job.deviceId === deviceId)
      : smsJobs;
    return {
      asOf: new Date().toISOString(),
      queued: jobs.filter((job) => job.status === 'queued').length,
      sending: jobs.filter((job) => job.status === 'sending').length,
      sent: jobs.filter((job) => job.status === 'sent').length,
      failed: jobs.filter((job) => job.status === 'failed').length,
    };
  };
  const getSmsJobs = (deviceId?: string): SmsJob[] =>
    smsJobs
      .filter(
        (job) =>
          (!deviceId || job.deviceId === deviceId) &&
          (job.status === 'queued' ||
            job.status === 'failed' ||
            job.status === 'sent'),
      )
      .map(publicSmsJob);
  let pairingCode = '';
  let pairingCodeExpiresAt = 0;
  let pairingInProgress = false;
  let pairingAttemptTimes: number[] = [];
  let pairingCodeTimer: ReturnType<typeof setTimeout> | undefined;

  const rotatePairingCode = () => {
    if (pairingInProgress) {
      return;
    }
    if (pairingCodeTimer) {
      clearTimeout(pairingCodeTimer);
    }
    pairingCode = randomInt(0, 1_000_000).toString().padStart(6, '0');
    pairingCodeExpiresAt = Date.now() + PAIRING_CODE_LIFETIME_MS;
    pairingInProgress = false;
    pairingCodeTimer = setTimeout(rotatePairingCode, PAIRING_CODE_LIFETIME_MS);
    pairingCodeTimer.unref();
  };

  const prunePairingAttempts = () => {
    const cutoff = Date.now() - PAIRING_ATTEMPT_WINDOW_MS;
    pairingAttemptTimes = pairingAttemptTimes.filter((time) => time > cutoff);
  };

  const recordPairingAttempt = () => {
    prunePairingAttempts();
    pairingAttemptTimes.push(Date.now());
  };

  const getAuthorizedDevice = (
    request: IncomingMessage,
  ): StoredDevice | undefined => {
    const token = bearerToken(request);
    return token
      ? store.devices.find((candidate) =>
          safeHashEquals(token, candidate.tokenHash),
        )
      : undefined;
  };

  const publicSmsJob = (job: StoredSmsJob): SmsJob => ({
    id: job.id,
    phoneNumber: job.phoneNumber,
    message: job.message,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.failureReason ? { failureReason: job.failureReason } : {}),
    ...(job.deliveryStatus ? { deliveryStatus: job.deliveryStatus } : {}),
  });
  const retrySmsJob: GatewayRuntime['retrySmsJob'] = (jobId, deviceId) =>
    mutateSmsJobs((jobs) => {
      const job = jobs.find(
        (candidate) =>
          candidate.id === jobId &&
          (!deviceId || candidate.deviceId === deviceId),
      );
      if (!job) {
        return { status: 'not-found' };
      }
      if (job.status !== 'failed') {
        return { status: 'not-failed' };
      }
      job.status = 'queued';
      job.failureReason = undefined;
      job.updatedAt = new Date().toISOString();
      return { status: 'retried', job: publicSmsJob(job) };
    });
  const deleteFailedSmsJob: GatewayRuntime['deleteFailedSmsJob'] = (
    jobId,
    deviceId,
  ) =>
    mutateSmsJobs((jobs) => {
      const index = jobs.findIndex(
        (candidate) =>
          candidate.id === jobId &&
          (!deviceId || candidate.deviceId === deviceId),
      );
      if (index === -1) {
        return 'not-found';
      }
      if (jobs[index].status !== 'failed') {
        return 'not-failed';
      }
      jobs.splice(index, 1);
      return 'deleted';
    });
  const updateSmsDeliveryReport: GatewayRuntime['updateSmsDeliveryReport'] = (
    jobId,
    deviceId,
    status,
  ) =>
    mutateSmsJobs((jobs) => {
      const job = jobs.find(
        (candidate) =>
          candidate.id === jobId && candidate.deviceId === deviceId,
      );
      if (!job) {
        return 'not-found';
      }
      if (job.status !== 'sent') {
        return 'not-sent';
      }
      if (job.deliveryStatus && job.deliveryStatus !== status) {
        return 'conflict';
      }
      job.deliveryStatus = status;
      job.updatedAt = new Date().toISOString();
      return 'updated';
    });

  const getStatus = (): DesktopGatewayStatus => ({
    status: 'ok',
    protocolVersion: 1,
    serverId,
    port: actualPort,
    addresses: getLanAddresses(actualPort),
    certificatePin,
    pairingCode:
      Date.now() < pairingCodeExpiresAt ? pairingCode : 'expired',
    pairingCodeExpiresAt: new Date(pairingCodeExpiresAt).toISOString(),
    pairedDevices: store.devices.map(({ id, name, pairedAt }) => ({
      id,
      name,
      pairedAt,
    })),
  });

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const requestUrl = new URL(request.url ?? '/', 'https://gateway.local');
    if (request.method === 'GET' && request.url === '/v1/health') {
      const health: GatewayHealth = {
        status: 'ok',
        protocolVersion: 1,
        serverId,
      };
      sendJson(response, 200, health);
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/pair') {
      if (pairingInProgress || Date.now() >= pairingCodeExpiresAt) {
        sendJson(response, 410, { error: 'Pairing code expired' });
        return;
      }
      prunePairingAttempts();
      if (pairingAttemptTimes.length >= MAX_PAIRING_ATTEMPTS) {
        sendJson(response, 429, { error: 'Too many pairing attempts. Try again later.' });
        return;
      }

      const parsed = pairDeviceRequestSchema.safeParse(
        await readJsonBody(request),
      );
      prunePairingAttempts();
      if (pairingAttemptTimes.length >= MAX_PAIRING_ATTEMPTS) {
        sendJson(response, 429, { error: 'Too many pairing attempts. Try again later.' });
        return;
      }
      if (pairingInProgress || Date.now() >= pairingCodeExpiresAt) {
        sendJson(response, 410, { error: 'Pairing code expired' });
        return;
      }
      if (!parsed.success) {
        recordPairingAttempt();
        sendJson(response, 400, { error: 'Invalid pairing request' });
        return;
      }

      const submittedCode = Buffer.from(parsed.data.code);
      const expectedCode = Buffer.from(pairingCode);
      if (
        submittedCode.length !== expectedCode.length ||
        !timingSafeEqual(submittedCode, expectedCode)
      ) {
        recordPairingAttempt();
        sendJson(response, 401, { error: 'Pairing code is incorrect or expired' });
        return;
      }

      pairingInProgress = true;
      const token = randomBytes(32).toString('base64url');
      const device: StoredDevice = {
        id: randomUUID(),
        name: parsed.data.deviceName,
        pairedAt: new Date().toISOString(),
        tokenHash: createHash('sha256').update(token).digest('hex'),
      };
      store.devices.push(device);
      try {
        await saveDeviceStore(options.storageDir, store);
      } catch (error) {
        store.devices.pop();
        pairingInProgress = false;
        rotatePairingCode();
        throw error;
      }
      pairingCodeExpiresAt = 0;
      pairingCode = '';
      pairingInProgress = false;
      if (pairingCodeTimer) {
        clearTimeout(pairingCodeTimer);
        pairingCodeTimer = undefined;
      }

      const result: PairDeviceResponse = {
        deviceId: device.id,
        deviceName: device.name,
        serverId,
        token,
      };
      sendJson(response, 201, result);
      return;
    }

    if (request.method === 'GET' && request.url === '/v1/devices/me') {
      const device = getAuthorizedDevice(request);

      if (!device) {
        sendJson(response, 401, { error: 'Device is not paired' });
        return;
      }

      const result: PairedDeviceInfo = {
        deviceId: device.id,
        deviceName: device.name,
        pairedAt: device.pairedAt,
        serverId,
      };
      sendJson(response, 200, result);
      return;
    }

    if (
      (request.method === 'GET' && request.url === '/v1/jobs/status') ||
      (request.method === 'GET' && request.url === '/v1/jobs') ||
      (request.method === 'GET' && requestUrl.pathname === '/v1/jobs/next') ||
      (request.method === 'POST' &&
        /^\/v1\/jobs\/[0-9a-f-]+\/(?:result|retry|delivery-report)$/i.test(request.url ?? '')) ||
      (request.method === 'DELETE' &&
        /^\/v1\/jobs\/[0-9a-f-]+$/i.test(request.url ?? ''))
    ) {
      const device = getAuthorizedDevice(request);
      if (!device) {
        sendJson(response, 401, { error: 'Device is not paired' });
        return;
      }

      if (request.method === 'GET' && request.url === '/v1/jobs/status') {
        sendJson(response, 200, getSmsQueueStatus(device.id));
        return;
      }

      if (request.method === 'GET' && request.url === '/v1/jobs') {
        sendJson(response, 200, { jobs: getSmsJobs(device.id) });
        return;
      }

      const reportJobId = request.url?.match(
        /^\/v1\/jobs\/([0-9a-f-]+)\/delivery-report$/i,
      )?.[1];
      if (request.method === 'POST' && reportJobId) {
        const parsed = smsDeliveryReportRequestSchema.safeParse(
          await readJsonBody(request),
        );
        if (!parsed.success) {
          sendJson(response, 400, { error: 'Invalid SMS delivery report' });
          return;
        }
        const result = await updateSmsDeliveryReport(
          reportJobId,
          device.id,
          parsed.data.status,
        );
        if (result === 'not-found') {
          sendJson(response, 404, { error: 'SMS job was not found' });
          return;
        }
        if (result === 'not-sent') {
          sendJson(response, 409, { error: 'SMS job has not been sent' });
          return;
        }
        if (result === 'conflict') {
          sendJson(response, 409, { error: 'SMS delivery report is already recorded' });
          return;
        }
        const job = getSmsJobs(device.id).find((candidate) => candidate.id === reportJobId);
        if (!job) {
          throw new Error('Updated SMS job was not found');
        }
        sendJson(response, 200, { job });
        return;
      }

      const retryJobId = request.url?.match(
        /^\/v1\/jobs\/([0-9a-f-]+)\/retry$/i,
      )?.[1];
      if (request.method === 'POST' && retryJobId) {
        const result = await retrySmsJob(retryJobId, device.id);
        if (result.status === 'not-found') {
          sendJson(response, 404, { error: 'SMS job was not found' });
          return;
        }
        if (result.status === 'not-failed') {
          sendJson(response, 409, { error: 'SMS job is not failed' });
          return;
        }
        sendJson(response, 200, { job: result.job });
        return;
      }

      const deleteJobId = request.url?.match(
        /^\/v1\/jobs\/([0-9a-f-]+)$/i,
      )?.[1];
      if (request.method === 'DELETE' && deleteJobId) {
        const result = await deleteFailedSmsJob(deleteJobId, device.id);
        if (result === 'not-found') {
          sendJson(response, 404, { error: 'SMS job was not found' });
          return;
        }
        if (result === 'not-failed') {
          sendJson(response, 409, { error: 'SMS job is not failed' });
          return;
        }
        sendJson(response, 200, { deleted: true });
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/v1/jobs/next') {
        const requestedCutoff = requestUrl.searchParams.get('createdBefore');
        const cutoff = requestedCutoff ? Date.parse(requestedCutoff) : Date.now();
        if (!Number.isFinite(cutoff)) {
          sendJson(response, 400, { error: 'SMS queue cutoff is invalid' });
          return;
        }
        const job = await mutateSmsJobs((jobs) => {
          const queuedJob = jobs.find(
            (candidate) =>
              candidate.deviceId === device.id &&
              candidate.status === 'queued' &&
              Date.parse(candidate.createdAt) <= cutoff,
          );
          if (!queuedJob) {
            return null;
          }
          queuedJob.status = 'sending';
          queuedJob.updatedAt = new Date().toISOString();
          return publicSmsJob(queuedJob);
        });
        sendJson(response, 200, { job });
        return;
      }

      const jobId = request.url?.match(/^\/v1\/jobs\/([0-9a-f-]+)\/result$/i)?.[1];
      const parsed = completeSmsJobRequestSchema.safeParse(
        await readJsonBody(request),
      );
      if (!jobId || !parsed.success) {
        sendJson(response, 400, { error: 'Invalid SMS job result' });
        return;
      }
      const updatedJob = await mutateSmsJobs((jobs) => {
        const job = jobs.find(
          (candidate) =>
            candidate.id === jobId && candidate.deviceId === device.id,
        );
        if (!job) {
          return undefined;
        }
        if (job.status !== 'sending') {
          return null;
        }
        job.status = parsed.data.status;
        job.failureReason =
          parsed.data.status === 'failed'
            ? parsed.data.failureReason ?? 'Android could not submit this message.'
            : undefined;
        job.updatedAt = new Date().toISOString();
        return publicSmsJob(job);
      });
      if (updatedJob === undefined) {
        sendJson(response, 404, { error: 'SMS job was not found' });
        return;
      }
      if (updatedJob === null) {
        sendJson(response, 409, { error: 'SMS job is not awaiting a result' });
        return;
      }
      sendJson(response, 200, { job: updatedJob });
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  };

  const server: Server = createServer(
    { cert: tls.certificate, key: tls.privateKey },
    (request, response) => {
      void handleRequest(request, response).catch((error: unknown) => {
        console.error('Gateway request failed:', error);
        if (!response.headersSent) {
          sendJson(response, 500, { error: 'Gateway request failed' });
        } else {
          response.destroy();
        }
      });
    },
  );

  let actualPort = port;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Gateway server did not bind to a TCP port'));
        return;
      }
      actualPort = address.port;
      resolve();
    });
  });

  rotatePairingCode();
  let closed = false;

  return {
    getStatus,
    getCertificate: () => tls.certificate,
    rotatePairingCode: () => {
      rotatePairingCode();
      return getStatus();
    },
    revokeDevice: async (deviceId) => {
      const index = store.devices.findIndex((device) => device.id === deviceId);
      if (index === -1) {
        throw new Error('Paired device was not found');
      }
      store.devices.splice(index, 1);
      await saveDeviceStore(options.storageDir, store);
    },
    enqueueSmsBatch: async (deviceId, requests) => {
      if (!store.devices.some((device) => device.id === deviceId)) {
        throw new Error('Paired device was not found');
      }
      if (requests.length === 0) {
        throw new TypeError('SMS batch must contain at least one message');
      }
      const parsedRequests = requests.map((request) => {
        const parsed = enqueueSmsRequestSchema.safeParse(request);
        if (!parsed.success) {
          throw new TypeError('SMS batch contains an invalid message');
        }
        return parsed.data;
      });
      return mutateSmsJobs((jobs) => {
        let added = 0;
        for (const request of parsedRequests) {
          const existing = jobs.find(
            (job) =>
              job.deviceId === deviceId &&
              job.idempotencyKey === request.idempotencyKey,
          );
          if (existing) {
            if (
              existing.phoneNumber !== request.phoneNumber ||
              existing.message !== request.message
            ) {
              throw new TypeError('SMS idempotency key was reused for another message');
            }
            continue;
          }
          const timestamp = new Date().toISOString();
          jobs.push({
            id: randomUUID(),
            deviceId,
            idempotencyKey: request.idempotencyKey,
            phoneNumber: request.phoneNumber,
            message: request.message,
            status: 'queued',
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          added += 1;
        }
        return added;
      });
    },
    getSmsQueueStatus,
    getSmsJobs,
    retrySmsJob,
    deleteFailedSmsJob,
    updateSmsDeliveryReport,
    close: () => {
      if (closed) {
        return Promise.resolve();
      }
      closed = true;
      if (pairingCodeTimer) {
        clearTimeout(pairingCodeTimer);
        pairingCodeTimer = undefined;
      }
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
