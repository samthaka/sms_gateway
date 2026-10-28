import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  ActivityIndicator,
  PermissionsAndroid,
  Pressable,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { createGatewayClient } from '@sms-gateway/api-client';
import type {
  PairDeviceResponse,
  SmsJob,
  SmsQueueStatus,
} from '@sms-gateway/shared-contracts';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useCodeScanner,
} from 'react-native-vision-camera';
import {
  getDeviceName,
  gatewayTransport,
  getPendingDeliveryReports,
  acknowledgeDeliveryReport,
  getSecureValue,
  removeSecureValue,
  sendSms,
  setSecureValue,
} from './gateway-security';
import { parsePairingQrPayload } from './pairing-qr';
import { getPairingDeviceName } from './device-name';

const SAVED_PAIRING_KEY = 'paired-gateway';
const EMPTY_QUEUE_STATUS: SmsQueueStatus = {
  asOf: new Date(0).toISOString(),
  queued: 0,
  sending: 0,
  sent: 0,
  failed: 0,
};

function isAppInForeground(): boolean {
  return AppState.currentState === 'active' || AppState.currentState === null;
}

interface SavedPairing {
  baseUrl: string;
  certificatePin: string;
  deviceId: string;
  deviceName: string;
  token: string;
}

type ConnectionState =
  | { status: 'disconnected' }
  | { status: 'pairing' }
  | { status: 'connected'; pairing: SavedPairing }
  | { status: 'error'; message: string };

function parseSavedPairing(value: string): SavedPairing {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('baseUrl' in parsed) ||
    !('certificatePin' in parsed) ||
    !('deviceId' in parsed) ||
    !('deviceName' in parsed) ||
    !('token' in parsed) ||
    typeof parsed.baseUrl !== 'string' ||
    typeof parsed.certificatePin !== 'string' ||
    typeof parsed.deviceId !== 'string' ||
    typeof parsed.deviceName !== 'string' ||
    typeof parsed.token !== 'string'
  ) {
    throw new Error('Saved pairing details are invalid. Forget this device and pair again.');
  }

  return {
    baseUrl: parsed.baseUrl,
    certificatePin: parsed.certificatePin,
    deviceId: parsed.deviceId,
    deviceName: parsed.deviceName,
    token: parsed.token,
  };
}

function App() {
  const [isScanning, setIsScanning] = useState(false);
  const [storedPairing, setStoredPairing] = useState<SavedPairing>();
  const [queueStatus, setQueueStatus] = useState(EMPTY_QUEUE_STATUS);
  const [pendingJobs, setPendingJobs] = useState<SmsJob[]>([]);
  const [failedJobs, setFailedJobs] = useState<SmsJob[]>([]);
  const [sentJobs, setSentJobs] = useState<SmsJob[]>([]);
  const [queueError, setQueueError] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [updatingJobId, setUpdatingJobId] = useState<string>();
  const [connection, setConnection] = useState<ConnectionState>({
    status: 'disconnected',
  });
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraDevice = useCameraDevice('back');
  const scanHandled = useRef(false);

  useEffect(() => {
    let active = true;
    getSecureValue(SAVED_PAIRING_KEY)
      .then(async (value) => {
        if (!value || !active) {
          return;
        }
        const saved = parseSavedPairing(value);
        setStoredPairing(saved);
        const client = createGatewayClient(
          saved.baseUrl,
          saved.certificatePin,
          gatewayTransport,
        );
        await client.getPairedDevice(saved.token);
        if (active) {
          setConnection({ status: 'connected', pairing: saved });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setConnection({
            status: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Could not restore the paired device.',
          });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  async function pairWithQr(value: string) {
    setConnection({ status: 'pairing' });
    try {
      const payload = parsePairingQrPayload(value);
      await setSecureValue('pairing-storage-check', 'available');
      await removeSecureValue('pairing-storage-check');
      const client = createGatewayClient(
        payload.baseUrl,
        payload.certificatePin,
        gatewayTransport,
      );
      const health = await client.getHealth();
      if (health.serverId !== payload.serverId) {
        throw new Error(
          'The gateway identity does not match the scanned QR code. Pairing was cancelled.',
        );
      }
      const configuredDeviceName = await getDeviceName();
      const pairingDeviceName = getPairingDeviceName(
        configuredDeviceName,
        Platform.OS === 'android' ? Platform.constants.Model : undefined,
      );
      const paired: PairDeviceResponse = await client.pairDevice({
        code: payload.pairingCode,
        deviceName: pairingDeviceName,
      });
      if (paired.serverId !== payload.serverId) {
        throw new Error('The gateway returned an unexpected server identity.');
      }
      const saved: SavedPairing = {
        baseUrl: payload.baseUrl,
        certificatePin: payload.certificatePin,
        deviceId: paired.deviceId,
        deviceName: paired.deviceName,
        token: paired.token,
      };
      await setSecureValue(SAVED_PAIRING_KEY, JSON.stringify(saved));
      setStoredPairing(saved);
      setConnection({ status: 'connected', pairing: saved });
    } catch (error) {
      setConnection({
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Could not pair with the desktop gateway.',
      });
    }
  }

  async function reconnectExistingDevice() {
    if (!storedPairing) {
      return;
    }

    setConnection({ status: 'pairing' });
    try {
      const client = createGatewayClient(
        storedPairing.baseUrl,
        storedPairing.certificatePin,
        gatewayTransport,
      );
      const device = await client.getPairedDevice(storedPairing.token);
      const saved: SavedPairing = {
        ...storedPairing,
        deviceName: device.deviceName,
      };
      await setSecureValue(SAVED_PAIRING_KEY, JSON.stringify(saved));
      setStoredPairing(saved);
      setConnection({ status: 'connected', pairing: saved });
    } catch (error) {
      setConnection({
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Could not reconnect the paired device.',
      });
    }
  }

  async function forgetDevice() {
    try {
      await removeSecureValue(SAVED_PAIRING_KEY);
      setStoredPairing(undefined);
      setConnection({ status: 'disconnected' });
      setIsScanning(false);
    } catch (error) {
      setConnection({
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Could not remove saved pairing details.',
      });
    }
  }

  const busy = connection.status === 'pairing';
  const paired =
    connection.status === 'connected' ? connection.pairing : undefined;

  const refreshQueueData = useCallback(async (
    pairing: SavedPairing,
    isActive: () => boolean = () => true,
  ) => {
    const client = createGatewayClient(
      pairing.baseUrl,
      pairing.certificatePin,
      gatewayTransport,
    );
    if (Platform.OS === 'android') {
      const reports = await getPendingDeliveryReports();
      const currentJobs = await client.getSmsJobs(pairing.token);
      for (const report of reports) {
        if (currentJobs.some((job) => job.id === report.jobId && job.status === 'sent')) {
          await client.updateSmsDeliveryReport(pairing.token, report.jobId, {
            status: report.status,
          });
        }
        await acknowledgeDeliveryReport(report.jobId);
      }
    }
    const status = await client.getSmsQueueStatus(pairing.token);
    if (isActive()) {
      setQueueStatus(status);
    }
    const jobs = await client.getSmsJobs(pairing.token);
    if (isActive()) {
      setPendingJobs(jobs.filter((job) => job.status === 'queued'));
      setFailedJobs(jobs.filter((job) => job.status === 'failed'));
      setSentJobs(jobs.filter((job) => job.status === 'sent'));
      setQueueError('');
    }
    return status;
  }, []);

  useEffect(() => {
    if (!paired) {
      setQueueStatus(EMPTY_QUEUE_STATUS);
      setPendingJobs([]);
      setFailedJobs([]);
      setSentJobs([]);
      setQueueError('');
      return;
    }

    let active = true;
    const refreshQueueStatus = async () => {
      if (!isAppInForeground()) {
        return;
      }
      try {
        await refreshQueueData(paired, () => active);
      } catch (error) {
        if (active) {
          setQueueError(
            error instanceof Error
              ? error.message
              : 'Could not check the message queue.',
          );
        }
      }
    };

    refreshQueueStatus();
    const interval = setInterval(() => {
      refreshQueueStatus();
    }, 5000);
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        refreshQueueStatus();
      }
    });
    return () => {
      active = false;
      clearInterval(interval);
      appStateSubscription.remove();
    };
  }, [paired, refreshQueueData]);

  async function retryFailedJob(jobId: string) {
    if (!paired || updatingJobId) {
      return;
    }
    setUpdatingJobId(jobId);
    setQueueError('');
    try {
      const client = createGatewayClient(
        paired.baseUrl,
        paired.certificatePin,
        gatewayTransport,
      );
      await client.retrySmsJob(paired.token, jobId);
      await refreshQueueData(paired);
    } catch (error) {
      setQueueError(
        error instanceof Error ? error.message : 'Could not retry this message.',
      );
    } finally {
      setUpdatingJobId(undefined);
    }
  }

  async function deleteFailedJob(jobId: string) {
    if (!paired || updatingJobId) {
      return;
    }
    setUpdatingJobId(jobId);
    setQueueError('');
    try {
      const client = createGatewayClient(
        paired.baseUrl,
        paired.certificatePin,
        gatewayTransport,
      );
      await client.deleteFailedSmsJob(paired.token, jobId);
      await refreshQueueData(paired);
    } catch (error) {
      setQueueError(
        error instanceof Error ? error.message : 'Could not delete this message.',
      );
    } finally {
      setUpdatingJobId(undefined);
    }
  }

  async function sendQueuedMessages(
    pairing: SavedPairing,
    createdBefore: string,
  ) {
    setIsSending(true);
    setQueueError('');
    try {
      const client = createGatewayClient(
        pairing.baseUrl,
        pairing.certificatePin,
        gatewayTransport,
      );
      while (isAppInForeground()) {
        const job = await client.getNextSmsJob(pairing.token, createdBefore);
        if (!job) {
          break;
        }
        let result: { status: 'sent' | 'failed'; failureReason?: string };
        try {
          await sendSms(job.id, job.phoneNumber, job.message);
          result = { status: 'sent' };
        } catch (error) {
          result = {
            status: 'failed',
            failureReason:
              error instanceof Error
                ? error.message.slice(0, 500)
                : 'Android could not submit this message.',
          };
        }
        await client.completeSmsJob(pairing.token, job.id, result);
        await refreshQueueData(pairing);
      }
      await refreshQueueData(pairing);
    } catch (error) {
      setQueueError(
        error instanceof Error
          ? error.message
          : 'Could not send queued messages.',
      );
    } finally {
      setIsSending(false);
    }
  }

  async function confirmBatchSend() {
    if (!paired || isSending) {
      return;
    }
    try {
      const client = createGatewayClient(
        paired.baseUrl,
        paired.certificatePin,
        gatewayTransport,
      );
      const currentQueue = await client.getSmsQueueStatus(paired.token);
      setQueueStatus(currentQueue);
      if (currentQueue.queued === 0) {
        return;
      }
      const permission = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.SEND_SMS,
      );
      if (permission !== PermissionsAndroid.RESULTS.GRANTED) {
        setQueueError('SMS permission is required before messages can be sent.');
        return;
      }
      Alert.alert(
        'Send queued messages?',
        `${currentQueue.queued} SMS message${currentQueue.queued === 1 ? '' : 's'} ` +
          'will be submitted one at a time using this phone’s default SIM. ' +
          'Carrier charges may apply.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Send messages',
            onPress: () => {
              sendQueuedMessages(paired, currentQueue.asOf);
            },
          },
        ],
      );
    } catch (error) {
      setQueueError(
        error instanceof Error
          ? error.message
          : 'Could not request SMS permission.',
      );
    }
  }

  const codeScanner = useCodeScanner({
    codeTypes: ['qr'],
    onCodeScanned: (codes) => {
      const value = codes.find((code) => code.value)?.value;
      if (!value || scanHandled.current) {
        return;
      }
      scanHandled.current = true;
      setIsScanning(false);
      return pairWithQr(value);
    },
  });

  async function startScanning() {
    try {
      const granted = hasPermission || (await requestPermission());
      if (!granted) {
        throw new Error('Camera access is required to scan the desktop QR code.');
      }
      if (!cameraDevice) {
        throw new Error('No camera is available on this device.');
      }
      scanHandled.current = false;
      setConnection({ status: 'disconnected' });
      setIsScanning(true);
    } catch (error) {
      setConnection({
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Could not start the QR scanner.',
      });
    }
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.eyebrow}>SECURE DEVICE PAIRING</Text>
          <Text style={styles.title}>Connect your device</Text>
          <Text style={styles.description}>
            Scan the QR code shown in the desktop app. The QR code supplies the
            certificate pin and one-time code; the gateway identity is checked
            before the code is sent.
          </Text>

          <View style={styles.card}>
            {!paired && (
              <View style={styles.pairingFields}>
                {storedPairing && (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={reconnectExistingDevice}
                      testID="reconnect-device-button"
                      style={({ pressed }) => [
                        styles.button,
                        styles.secondaryButton,
                        pressed && styles.buttonPressed,
                        busy && styles.buttonDisabled,
                      ]}
                    >
                      <Text style={styles.secondaryButtonText}>
                        Reconnect saved device
                      </Text>
                    </Pressable>
                    <Text style={styles.hint}>
                      Or pair another device by scanning a new desktop QR code.
                    </Text>
                  </>
                )}
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={startScanning}
                  testID="scan-pairing-qr-button"
                  style={({ pressed }) => [
                    styles.button,
                    pressed && styles.buttonPressed,
                    busy && styles.buttonDisabled,
                  ]}
                >
                  {connection.status === 'pairing' ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>Scan desktop QR code</Text>
                  )}
                </Pressable>
                {isScanning && hasPermission && cameraDevice && (
                  <View style={styles.cameraFrame}>
                    <Camera
                      codeScanner={codeScanner}
                      device={cameraDevice}
                      isActive={isScanning}
                      style={StyleSheet.absoluteFill}
                      testID="pairing-camera"
                    />
                    <Text style={styles.cameraHint}>
                      Point the camera at a pairing QR code on the desktop.
                    </Text>
                  </View>
                )}
              </View>
            )}

            {paired && (
              <View style={styles.pairedPanel}>
                <Text style={styles.connectedTitle}>Device paired</Text>
                <Text style={styles.description}>
                  {paired.deviceName} is securely connected to the desktop
                  gateway.
                </Text>
                <Text style={styles.queueStatus}>
                  {queueStatus.queued} waiting · {queueStatus.sending} sending
                  {'\n'}
                  {queueStatus.sent} submitted to Android · {queueStatus.failed}{' '}
                  failed
                </Text>
                <Pressable
                  accessibilityRole="button"
                  disabled={isSending || queueStatus.queued === 0}
                  onPress={confirmBatchSend}
                  testID="send-queued-messages-button"
                  style={({ pressed }) => [
                    styles.button,
                    pressed && styles.buttonPressed,
                    (isSending || queueStatus.queued === 0) &&
                      styles.buttonDisabled,
                  ]}
                >
                  {isSending ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>
                      Send queued messages ({queueStatus.queued})
                    </Text>
                  )}
                </Pressable>
                <View style={styles.jobSection}>
                  <Text style={styles.sectionTitle}>Pending messages</Text>
                  {pendingJobs.length === 0 ? (
                    <Text style={styles.hint}>No messages are waiting.</Text>
                  ) : (
                    pendingJobs.map((job) => (
                      <View key={job.id} style={styles.jobRow}>
                        <Text style={styles.jobRecipient}>{job.phoneNumber}</Text>
                        <Text style={styles.jobMessage}>{job.message}</Text>
                      </View>
                    ))
                  )}
                </View>
                <View style={styles.jobSection}>
                  <Text style={styles.sectionTitle}>Failed attempts</Text>
                  {failedJobs.length === 0 ? (
                    <Text style={styles.hint}>No failed attempts.</Text>
                  ) : (
                    failedJobs.map((job) => (
                      <View key={job.id} style={styles.jobRow}>
                        <Text style={styles.jobRecipient}>{job.phoneNumber}</Text>
                        <Text style={styles.jobMessage}>{job.message}</Text>
                        <Text style={styles.jobFailure}>
                          {job.failureReason ?? 'The message could not be submitted.'}
                        </Text>
                        <View style={styles.jobActions}>
                          <Pressable
                            accessibilityRole="button"
                            disabled={updatingJobId !== undefined}
                            onPress={() => retryFailedJob(job.id)}
                            testID={`retry-failed-job-${job.id}`}
                            style={({ pressed }) => [
                              styles.jobButton,
                              styles.retryJobButton,
                              pressed && styles.buttonPressed,
                              updatingJobId !== undefined && styles.buttonDisabled,
                            ]}
                          >
                            <Text style={styles.retryJobText}>Retry</Text>
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            disabled={updatingJobId !== undefined}
                            onPress={() =>
                              Alert.alert(
                                'Delete failed message?',
                                `Permanently delete the failed message to ${job.phoneNumber}?`,
                                [
                                  { text: 'Cancel', style: 'cancel' },
                                  {
                                    text: 'Delete',
                                    style: 'destructive',
                                    onPress: () => deleteFailedJob(job.id),
                                  },
                                ],
                              )
                            }
                            testID={`delete-failed-job-${job.id}`}
                            style={({ pressed }) => [
                              styles.jobButton,
                              styles.deleteJobButton,
                              pressed && styles.buttonPressed,
                              updatingJobId !== undefined && styles.buttonDisabled,
                            ]}
                          >
                            <Text style={styles.deleteJobText}>Delete</Text>
                          </Pressable>
                        </View>
                      </View>
                    ))
                  )}
                  {failedJobs.length > 0 && (
                    <Text style={styles.hint}>
                      Retry returns the message to pending. Tap Send queued
                      messages when you are ready to try again.
                    </Text>
                  )}
                </View>
                <View style={styles.jobSection}>
                  <Text style={styles.sectionTitle}>Sent messages</Text>
                  {sentJobs.length === 0 ? (
                    <Text style={styles.hint}>No messages have been sent yet.</Text>
                  ) : (
                    sentJobs.map((job) => (
                      <View key={job.id} style={styles.jobRow}>
                        <Text style={styles.jobRecipient}>{job.phoneNumber}</Text>
                        <Text style={styles.jobMessage}>{job.message}</Text>
                        <Text style={styles.sentJobStatus}>
                          {job.deliveryStatus === 'delivered'
                            ? 'Sent · Delivered'
                            : job.deliveryStatus === 'not-delivered'
                              ? 'Sent · Not delivered'
                              : 'Sent'}
                        </Text>
                      </View>
                    ))
                  )}
                  <Text style={styles.hint}>
                    Delivery reports depend on the carrier and recipient network.
                    Without a report, only sent status is shown.
                  </Text>
                </View>
                <Text style={styles.hint}>
                  Keep this app open while sending. Messages are sent one at a
                  time via the phone’s default SIM; sent means accepted by
                  Android, not confirmed delivered.
                </Text>
                {!!queueError && (
                  <Text
                    accessibilityLiveRegion="polite"
                    style={styles.errorMessage}
                  >
                    {queueError}
                  </Text>
                )}
                <Pressable
                  accessibilityRole="button"
                  onPress={forgetDevice}
                  testID="forget-device-button"
                  style={({ pressed }) => [
                    styles.button,
                    styles.secondaryButton,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={styles.secondaryButtonText}>
                    Forget on this phone
                  </Text>
                </Pressable>
                <Text style={styles.hint}>
                  To revoke access completely, also select Revoke for this
                  device in the desktop app.
                </Text>
              </View>
            )}
          </View>

          {connection.status === 'error' && (
            <Text accessibilityLiveRegion="polite" style={styles.errorMessage}>
              {connection.message}
            </Text>
          )}

          {storedPairing && !paired && (
            <Pressable
              accessibilityRole="button"
              onPress={forgetDevice}
              testID="forget-saved-device-button"
              style={({ pressed }) => [
                styles.button,
                styles.secondaryButton,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text style={styles.secondaryButtonText}>
                Forget saved pairing
              </Text>
            </Pressable>
          )}

          {!paired && (
            <Text style={styles.hint}>
              The pairing QR code expires automatically. Keep the desktop app
              open and scan its current code.
            </Text>
          )}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#f8fafc',
    flex: 1,
  },
  content: {
    alignSelf: 'center',
    maxWidth: 480,
    padding: 24,
    width: '100%',
  },
  eyebrow: {
    color: '#2563eb',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 12,
  },
  title: {
    color: '#0f172a',
    fontSize: 26,
    fontWeight: '700',
    marginBottom: 10,
  },
  description: {
    color: '#475569',
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 18,
  },
  queueStatus: {
    color: '#0f172a',
    fontSize: 14,
    lineHeight: 21,
    marginTop: 6,
  },
  sectionTitle: {
    color: '#0f172a',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
  },
  jobSection: {
    borderTopColor: '#e2e8f0',
    borderTopWidth: 1,
    marginTop: 18,
    paddingTop: 16,
  },
  jobRow: {
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    marginTop: 8,
    padding: 12,
  },
  jobRecipient: {
    color: '#0f172a',
    fontSize: 14,
    fontWeight: '700',
  },
  jobMessage: {
    color: '#334155',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4,
  },
  jobFailure: {
    color: '#b91c1c',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
  },
  sentJobStatus: {
    color: '#15803d',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 8,
  },
  jobActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  jobButton: {
    borderRadius: 8,
    borderWidth: 1,
    minWidth: 84,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  retryJobButton: {
    backgroundColor: '#eff6ff',
    borderColor: '#bfdbfe',
  },
  retryJobText: {
    color: '#1d4ed8',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  deleteJobButton: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
  },
  deleteJobText: {
    color: '#b91c1c',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  card: {
    backgroundColor: '#fff',
    borderColor: '#e2e8f0',
    borderRadius: 16,
    borderWidth: 1,
    padding: 18,
  },
  button: {
    alignItems: 'center',
    backgroundColor: '#2563eb',
    borderRadius: 10,
    justifyContent: 'center',
    marginTop: 14,
    minHeight: 48,
    paddingHorizontal: 12,
  },
  secondaryButton: {
    backgroundColor: '#eff6ff',
    borderColor: '#bfdbfe',
    borderWidth: 1,
  },
  secondaryButtonText: {
    color: '#1d4ed8',
    fontSize: 15,
    fontWeight: '700',
  },
  buttonPressed: {
    opacity: 0.82,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  buttonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  pairingFields: {
    borderTopColor: '#e2e8f0',
    borderTopWidth: 1,
    marginTop: 20,
    paddingTop: 8,
  },
  cameraFrame: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    height: 320,
    marginTop: 16,
    overflow: 'hidden',
  },
  cameraHint: {
    backgroundColor: '#0f172acc',
    bottom: 0,
    color: '#fff',
    fontSize: 13,
    left: 0,
    padding: 12,
    position: 'absolute',
    right: 0,
    textAlign: 'center',
  },
  pairedPanel: {
    borderTopColor: '#e2e8f0',
    borderTopWidth: 1,
    marginTop: 20,
    paddingTop: 16,
  },
  connectedTitle: {
    color: '#15803d',
    fontSize: 18,
    fontWeight: '700',
  },
  errorMessage: {
    color: '#b91c1c',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 12,
  },
  hint: {
    color: '#64748b',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 18,
  },
});

export default App;
