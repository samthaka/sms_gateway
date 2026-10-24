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
  DesktopGatewayStatus,
  GatewayHealth,
  PairDeviceRequest,
  PairDeviceResponse,
  PairedDevice,
  PairedDeviceInfo,
} from '@sms-gateway/shared-contracts';
import { pairDeviceRequestSchema } from '@sms-gateway/validation';

export const DEFAULT_GATEWAY_PORT = 47832;
const PAIRING_CODE_LIFETIME_MS = 5 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;
const MAX_REQUEST_BYTES = 4096;

interface StoredDevice extends PairedDevice {
  tokenHash: string;
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
  let pairingCode = '';
  let pairingCodeExpiresAt = 0;
  let pairingAttempts = 0;

  const rotatePairingCode = () => {
    pairingCode = randomInt(0, 1_000_000).toString().padStart(6, '0');
    pairingCodeExpiresAt = Date.now() + PAIRING_CODE_LIFETIME_MS;
    pairingAttempts = 0;
  };

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
      if (Date.now() >= pairingCodeExpiresAt || pairingAttempts >= MAX_PAIRING_ATTEMPTS) {
        sendJson(response, 410, { error: 'Pairing code expired' });
        return;
      }

      const parsed = pairDeviceRequestSchema.safeParse(
        await readJsonBody(request),
      );
      if (!parsed.success) {
        pairingAttempts += 1;
        sendJson(response, 400, { error: 'Invalid pairing request' });
        return;
      }

      const submittedCode = Buffer.from(parsed.data.code);
      const expectedCode = Buffer.from(pairingCode);
      if (
        submittedCode.length !== expectedCode.length ||
        !timingSafeEqual(submittedCode, expectedCode)
      ) {
        pairingAttempts += 1;
        sendJson(
          response,
          pairingAttempts >= MAX_PAIRING_ATTEMPTS ? 410 : 401,
          { error: 'Pairing code is incorrect or expired' },
        );
        return;
      }

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
        throw error;
      }
      pairingCodeExpiresAt = 0;
      pairingCode = '';

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
      const token = bearerToken(request);
      const device = token
        ? store.devices.find((candidate) =>
            safeHashEquals(token, candidate.tokenHash),
          )
        : undefined;

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
    close: () => {
      if (closed) {
        return Promise.resolve();
      }
      closed = true;
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
