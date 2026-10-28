export type SmsJobStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled';

export type SmsDeliveryStatus = 'delivered' | 'not-delivered';

export interface SmsJob {
  id: string;
  phoneNumber: string;
  message: string;
  status: SmsJobStatus;
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
  sentAt?: string;
  deliveryStatus?: SmsDeliveryStatus;
}

export interface EnqueueSmsRequest {
  phoneNumber: string;
  message: string;
  idempotencyKey: string;
}

export interface SmsQueueStatus {
  asOf: string;
  queued: number;
  sending: number;
  sent: number;
  failed: number;
}

export interface SmsJobsResponse {
  jobs: SmsJob[];
}

export interface DeleteSmsJobResponse {
  deleted: true;
}

export interface CompleteSmsJobRequest {
  status: 'sent' | 'failed';
  failureReason?: string;
}

export interface SmsDeliveryReportRequest {
  status: SmsDeliveryStatus;
}

export interface GatewayHealth {
  status: 'ok';
  protocolVersion: 1;
  serverId: string;
}

export interface DesktopGatewayStatus extends GatewayHealth {
  port: number;
  addresses: string[];
  certificatePin: string;
  pairingCode: string;
  pairingCodeExpiresAt: string;
  pairedDevices: PairedDevice[];
}

export interface PairedDevice {
  id: string;
  name: string;
  pairedAt: string;
}

export interface PairDeviceRequest {
  code: string;
  deviceName: string;
}

export interface PairingQrPayload {
  version: 1;
  baseUrl: string;
  certificatePin: string;
  pairingCode: string;
  serverId: string;
  expiresAt: string;
}

export interface PairDeviceResponse {
  deviceId: string;
  deviceName: string;
  serverId: string;
  token: string;
}

export interface PairedDeviceInfo {
  deviceId: string;
  deviceName: string;
  pairedAt: string;
  serverId: string;
}
