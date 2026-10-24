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
