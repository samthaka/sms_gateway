import { z } from 'zod';

export const enqueueSmsRequestSchema = z.object({
  phoneNumber: z.string().trim().regex(/^\+?[0-9]{7,15}$/),
  message: z.string().min(1),
  idempotencyKey: z.string().trim().min(1).max(128),
});

export const smsJobSchema = z.object({
  id: z.string().uuid(),
  phoneNumber: z.string().min(1).max(32),
  message: z.string().min(1),
  status: z.enum(['queued', 'sending', 'sent', 'failed', 'cancelled']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  failureReason: z.string().max(500).optional(),
});

export const nextSmsJobResponseSchema = z.object({
  job: smsJobSchema.nullable(),
});

export const smsQueueStatusSchema = z.object({
  asOf: z.string().datetime(),
  queued: z.number().int().nonnegative(),
  sending: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const completeSmsJobRequestSchema = z.object({
  status: z.enum(['sent', 'failed']),
  failureReason: z.string().max(500).optional(),
}).strict();

export const completeSmsJobResponseSchema = z.object({
  job: smsJobSchema,
});

export const gatewayHealthSchema = z.object({
  status: z.literal('ok'),
  protocolVersion: z.literal(1),
  serverId: z.string().min(1),
});

export const pairDeviceRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  deviceName: z.string().trim().min(1).max(60),
});

export const pairingQrPayloadSchema = z.object({
  version: z.literal(1),
  baseUrl: z.string().url(),
  certificatePin: z.string().regex(/^sha256\/[A-Za-z0-9+/]{43}=$/),
  pairingCode: z.string().regex(/^\d{6}$/),
  serverId: z.string().uuid(),
  expiresAt: z.string().datetime(),
}).strict();

export const pairDeviceResponseSchema = z.object({
  deviceId: z.string().uuid(),
  deviceName: z.string().min(1),
  serverId: z.string().uuid(),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const pairedDeviceInfoSchema = z.object({
  deviceId: z.string().uuid(),
  deviceName: z.string().min(1),
  pairedAt: z.string().datetime(),
  serverId: z.string().uuid(),
});
