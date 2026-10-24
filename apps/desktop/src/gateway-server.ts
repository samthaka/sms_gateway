import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { createServer, type Server } from 'node:http';
import type {
  DesktopGatewayStatus,
  GatewayHealth,
} from '@sms-gateway/shared-contracts';

export const DEFAULT_GATEWAY_PORT = 47832;

export interface GatewayServerOptions {
  host?: string;
  port?: number;
}

export interface GatewayRuntime {
  getStatus(): DesktopGatewayStatus;
  close(): Promise<void>;
}

function getLanAddresses(port: number): string[] {
  const addresses = Object.values(networkInterfaces())
    .flatMap((interfaces) => interfaces ?? [])
    .filter(
      (address) =>
        !address.internal &&
        address.family === 'IPv4',
    )
    .map((address) => `http://${address.address}:${port}`);

  return [...new Set(addresses)];
}

export function startGatewayServer(
  options: GatewayServerOptions = {},
): Promise<GatewayRuntime> {
  const host = options.host ?? '0.0.0.0';
  const port = options.port ?? DEFAULT_GATEWAY_PORT;
  const serverId = randomUUID();

  const server: Server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/v1/health') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const health: GatewayHealth = {
      status: 'ok',
      protocolVersion: 1,
      serverId,
    };

    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify(health));
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };

    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Gateway server did not bind to a TCP port'));
        return;
      }

      resolve({
        getStatus: () => ({
          status: 'ok',
          protocolVersion: 1,
          serverId,
          port: address.port,
          addresses: getLanAddresses(address.port),
        }),
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          }),
      });
    });
  });
}
