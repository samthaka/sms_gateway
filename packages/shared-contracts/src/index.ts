export type SmsJobStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled';

export interface SmsJob {
  id: string;
  phoneNumber: string;
  message: string;
  status: SmsJobStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueSmsRequest {
  phoneNumber: string;
  message: string;
  idempotencyKey: string;
}

export interface GatewayHealth {
  status: 'ok';
  protocolVersion: 1;
  serverId: string;
}

export interface DesktopGatewayStatus extends GatewayHealth {
  port: number;
  addresses: string[];
}
