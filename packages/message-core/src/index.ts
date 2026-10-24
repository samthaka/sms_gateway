import type { SmsJobStatus } from '@sms-gateway/shared-contracts';

const allowedTransitions: Record<SmsJobStatus, readonly SmsJobStatus[]> = {
  queued: ['sending', 'cancelled'],
  sending: ['sent', 'failed'],
  sent: [],
  failed: ['queued', 'cancelled'],
  cancelled: [],
};

export function canTransitionJobStatus(
  current: SmsJobStatus,
  next: SmsJobStatus,
): boolean {
  return allowedTransitions[current].includes(next);
}
