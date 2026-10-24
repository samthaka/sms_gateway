import type { DesktopGatewayStatus } from '@sms-gateway/shared-contracts';

declare global {
  interface Window {
    smsGateway: {
      getStatus(): Promise<DesktopGatewayStatus>;
    };
  }
}

export {};
