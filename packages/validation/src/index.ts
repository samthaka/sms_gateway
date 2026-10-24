import { z } from 'zod';

export const enqueueSmsRequestSchema = z.object({
  phoneNumber: z.string().trim().min(1).max(32),
  message: z.string().min(1),
  idempotencyKey: z.string().trim().min(1).max(128),
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
