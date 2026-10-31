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
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { createGatewayClient } from '@sms-gateway/api-client';
import type { PairDeviceResponse, SmsJob, SmsQueueStatus } from '@sms-gateway/shared-contracts';
import { Camera, useCameraDevice, useCameraPermission, useCodeScanner } from 'react-native-vision-camera';
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
const SAVED_THEME_KEY = 'theme-mode';
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

type ThemeMode = 'light' | 'dark' | 'system';

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

function dateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function dateGroupLabel(timestamp: string): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateKey(date) === dateKey(today)) {
    return 'Today';
  }
  if (dateKey(date) === dateKey(yesterday)) {
    return 'Yesterday';
  }
  return date.toLocaleDateString('en-US');
}

function groupJobsByDate(
  jobs: SmsJob[],
  getTimestamp: (job: SmsJob) => string,
): { key: string; label: string; jobs: SmsJob[] }[] {
  const groups = new Map<string, { label: string; jobs: SmsJob[] }>();
  const sortedJobs = [...jobs].sort(
    (left, right) => new Date(getTimestamp(right)).getTime() - new Date(getTimestamp(left)).getTime(),
  );
  for (const job of sortedJobs) {
    const timestamp = getTimestamp(job);
    const key = dateKey(new Date(timestamp));
    const group = groups.get(key);
    if (group) {
      group.jobs.push(job);
    } else {
      groups.set(key, { label: dateGroupLabel(timestamp), jobs: [job] });
    }
  }
  return [...groups].map(([key, group]) => ({ key, ...group }));
}

function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'connections' | 'messages' | 'settings'>('dashboard');
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [themeError, setThemeError] = useState('');
  const systemColorScheme = useColorScheme();
  const isDarkMode = themeMode === 'dark' || (themeMode === 'system' && systemColorScheme === 'dark');
  const [isScanning, setIsScanning] = useState(false);
  const [storedPairing, setStoredPairing] = useState<SavedPairing>();
  const [queueStatus, setQueueStatus] = useState(EMPTY_QUEUE_STATUS);
  const [pendingJobs, setPendingJobs] = useState<SmsJob[]>([]);
  const [failedJobs, setFailedJobs] = useState<SmsJob[]>([]);
  const [sentJobs, setSentJobs] = useState<SmsJob[]>([]);
  const [queueError, setQueueError] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [updatingJobId, setUpdatingJobId] = useState<string>();
  const [, setDateRefresh] = useState(0);
  const [connection, setConnection] = useState<ConnectionState>({
    status: 'disconnected',
  });
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraDevice = useCameraDevice('back');
  const scanHandled = useRef(false);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    const scheduleDateRefresh = () => {
      clearTimeout(timeout);
      const nextMidnight = new Date();
      nextMidnight.setHours(24, 0, 0, 0);
      timeout = setTimeout(() => {
        setDateRefresh((refresh) => refresh + 1);
        scheduleDateRefresh();
      }, Math.max(nextMidnight.getTime() - Date.now(), 1));
    };

    scheduleDateRefresh();
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setDateRefresh((refresh) => refresh + 1);
        scheduleDateRefresh();
      }
    });

    return () => {
      clearTimeout(timeout);
      appStateSubscription.remove();
    };
  }, []);

  useEffect(() => {
    let active = true;
    getSecureValue(SAVED_THEME_KEY)
      .then((value) => {
        if (!active || value === null) {
          return;
        }
        if (value !== 'light' && value !== 'dark' && value !== 'system') {
          throw new Error('Saved theme setting is invalid. Choose a theme to replace it.');
        }
        setThemeMode(value);
      })
      .catch((error: unknown) => {
        if (active) {
          setThemeError(error instanceof Error ? error.message : 'Could not load the saved theme setting.');
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    getSecureValue(SAVED_PAIRING_KEY)
      .then(async (value) => {
        if (!value || !active) {
          return;
        }
        const saved = parseSavedPairing(value);
        setStoredPairing(saved);
        const client = createGatewayClient(saved.baseUrl, saved.certificatePin, gatewayTransport);
        await client.getPairedDevice(saved.token);
        if (active) {
          setConnection({ status: 'connected', pairing: saved });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setConnection({
            status: 'error',
            message: error instanceof Error ? error.message : 'Could not restore the paired device.',
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
      const client = createGatewayClient(payload.baseUrl, payload.certificatePin, gatewayTransport);
      const health = await client.getHealth();
      if (health.serverId !== payload.serverId) {
        throw new Error('The gateway identity does not match the scanned QR code. Pairing was cancelled.');
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
        message: error instanceof Error ? error.message : 'Could not pair with the desktop gateway.',
      });
    }
  }

  async function reconnectExistingDevice() {
    if (!storedPairing) {
      return;
    }

    setConnection({ status: 'pairing' });
    try {
      const client = createGatewayClient(storedPairing.baseUrl, storedPairing.certificatePin, gatewayTransport);
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
        message: error instanceof Error ? error.message : 'Could not reconnect the paired device.',
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
        message: error instanceof Error ? error.message : 'Could not remove saved pairing details.',
      });
    }
  }

  const busy = connection.status === 'pairing';
  const paired = connection.status === 'connected' ? connection.pairing : undefined;
  const styles = createStyles(isDarkMode);

  async function changeTheme(mode: ThemeMode) {
    setThemeMode(mode);
    setThemeError('');
    try {
      await setSecureValue(SAVED_THEME_KEY, mode);
    } catch (error) {
      setThemeError(error instanceof Error ? error.message : 'Could not save the theme setting.');
    }
  }

  const refreshQueueData = useCallback(async (pairing: SavedPairing, isActive: () => boolean = () => true) => {
    const client = createGatewayClient(pairing.baseUrl, pairing.certificatePin, gatewayTransport);
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
          setQueueError(error instanceof Error ? error.message : 'Could not check the message queue.');
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
      const client = createGatewayClient(paired.baseUrl, paired.certificatePin, gatewayTransport);
      await client.retrySmsJob(paired.token, jobId);
      await refreshQueueData(paired);
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not retry this message.');
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
      const client = createGatewayClient(paired.baseUrl, paired.certificatePin, gatewayTransport);
      await client.deleteFailedSmsJob(paired.token, jobId);
      await refreshQueueData(paired);
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not delete this message.');
    } finally {
      setUpdatingJobId(undefined);
    }
  }

  async function sendQueuedMessages(pairing: SavedPairing, createdBefore: string) {
    setIsSending(true);
    setQueueError('');
    try {
      const client = createGatewayClient(pairing.baseUrl, pairing.certificatePin, gatewayTransport);
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
              error instanceof Error ? error.message.slice(0, 500) : 'Android could not submit this message.',
          };
        }
        await client.completeSmsJob(pairing.token, job.id, result);
        await refreshQueueData(pairing);
      }
      await refreshQueueData(pairing);
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not send queued messages.');
    } finally {
      setIsSending(false);
    }
  }

  async function confirmBatchSend() {
    if (!paired || isSending) {
      return;
    }
    try {
      const client = createGatewayClient(paired.baseUrl, paired.certificatePin, gatewayTransport);
      const currentQueue = await client.getSmsQueueStatus(paired.token);
      setQueueStatus(currentQueue);
      if (currentQueue.queued === 0) {
        return;
      }
      const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.SEND_SMS);
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
      setQueueError(error instanceof Error ? error.message : 'Could not request SMS permission.');
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
        message: error instanceof Error ? error.message : 'Could not start the QR scanner.',
      });
    }
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.eyebrow}>SMS GATEWAY</Text>
          <Text style={styles.title}>
            {activeTab === 'dashboard'
              ? 'Dashboard'
              : activeTab === 'connections'
              ? 'Connections'
              : activeTab === 'messages'
              ? 'Messages'
              : 'Settings'}
          </Text>
          <Text style={styles.description}>
            {activeTab === 'dashboard'
              ? 'Your secure SMS gateway at a glance.'
              : activeTab === 'connections'
              ? 'Pair this phone with your desktop gateway.'
              : activeTab === 'messages'
              ? 'Review queued, failed, and sent messages.'
              : 'Make the app feel right for you.'}
          </Text>

          {activeTab === 'dashboard' && !paired && (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Connect your phone</Text>
              <Text style={styles.hint}>
                Pair with your desktop to see message activity and send queued SMS messages securely.
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => setActiveTab('connections')}
                testID="dashboard-connect-button"
                style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
              >
                <Text style={styles.buttonText}>Set up connection</Text>
              </Pressable>
            </View>
          )}

          {activeTab === 'connections' && (
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
                        <Text style={styles.secondaryButtonText}>Reconnect saved device</Text>
                      </Pressable>
                      <Text style={styles.hint}>Or pair another device by scanning a new desktop QR code.</Text>
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
                      <Text style={styles.cameraHint}>Point the camera at a pairing QR code on the desktop.</Text>
                    </View>
                  )}
                </View>
              )}

              {paired && (
                <View style={styles.pairedPanel}>
                  <Text style={styles.connectedTitle}>Device paired</Text>
                  <Text style={styles.description}>
                    {paired.deviceName} is securely connected to the desktop gateway.
                  </Text>
                  <Text style={styles.deviceAddress}>{paired.baseUrl}</Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={forgetDevice}
                    testID="forget-device-button"
                    style={({ pressed }) => [styles.button, styles.secondaryButton, pressed && styles.buttonPressed]}
                  >
                    <Text style={styles.secondaryButtonText}>Forget on this phone</Text>
                  </Pressable>
                  <Text style={styles.hint}>
                    To revoke access completely, also select Revoke for this device in the desktop app.
                  </Text>
                </View>
              )}
            </View>
          )}

          {activeTab === 'dashboard' && paired && (
            <View style={styles.card}>
              <View style={styles.dashboardConnection}>
                <View style={styles.connectionIndicator} />
                <View style={styles.dashboardConnectionCopy}>
                  <Text style={styles.connectedTitle}>Gateway connected</Text>
                  <Text style={styles.hintCompact}>{paired.deviceName}</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setActiveTab('connections')}
                  testID="dashboard-manage-connection-button"
                  style={({ pressed }) => [styles.manageButton, pressed && styles.buttonPressed]}
                >
                  <Text style={styles.manageButtonText}>Manage</Text>
                </Pressable>
              </View>
              <View style={styles.metricsRow}>
                <View style={styles.metricCard}>
                  <Text style={styles.metricValue}>{queueStatus.queued}</Text>
                  <Text style={styles.metricLabel}>Waiting</Text>
                </View>
                <View style={styles.metricCard}>
                  <Text style={styles.metricValue}>{queueStatus.sent}</Text>
                  <Text style={styles.metricLabel}>Submitted</Text>
                </View>
                <View style={styles.metricCard}>
                  <Text style={[styles.metricValue, queueStatus.failed > 0 && styles.metricWarning]}>
                    {queueStatus.failed}
                  </Text>
                  <Text style={styles.metricLabel}>Failed</Text>
                </View>
              </View>
              <Pressable
                accessibilityRole="button"
                disabled={isSending || queueStatus.queued === 0}
                onPress={confirmBatchSend}
                testID="send-queued-messages-button"
                style={({ pressed }) => [
                  styles.button,
                  pressed && styles.buttonPressed,
                  (isSending || queueStatus.queued === 0) && styles.buttonDisabled,
                ]}
              >
                {isSending ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.buttonText}>Send queued messages ({queueStatus.queued})</Text>
                )}
              </Pressable>
              <Text style={styles.hint}>
                Messages are submitted one at a time using this phone’s default SIM. Carrier charges may apply.
              </Text>
            </View>
          )}

          {activeTab === 'messages' && (
            <View style={styles.card}>
              {!paired ? (
                <>
                  <Text style={styles.sectionTitle}>No device connected</Text>
                  <Text style={styles.hint}>Connect a phone to view its message activity.</Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setActiveTab('connections')}
                    testID="messages-connect-button"
                    style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
                  >
                    <Text style={styles.buttonText}>Open connections</Text>
                  </Pressable>
                </>
              ) : (
                <View style={styles.pairedPanel}>
                  <Text style={styles.queueStatus}>
                    {queueStatus.queued} waiting · {queueStatus.sending} sending
                    {'\n'}
                    {queueStatus.sent} submitted to Android · {queueStatus.failed} failed
                  </Text>
                  <View style={styles.jobSection}>
                    <Text style={styles.sectionTitle}>Pending messages</Text>
                    {pendingJobs.length === 0 ? (
                      <Text style={styles.hint}>No messages are waiting.</Text>
                    ) : (
                      groupJobsByDate(pendingJobs, (job) => job.createdAt).map((group) => (
                        <View key={group.key}>
                          <Text style={styles.dateGroupTitle}>{group.label}</Text>
                          {group.jobs.map((job) => (
                            <View key={job.id} style={styles.jobRow}>
                              <Text style={styles.jobRecipient}>{job.phoneNumber}</Text>
                              <Text style={styles.jobMessage}>{job.message}</Text>
                            </View>
                          ))}
                        </View>
                      ))
                    )}
                  </View>
                  <View style={styles.jobSection}>
                    <Text style={styles.sectionTitle}>Failed attempts</Text>
                    {failedJobs.length === 0 ? (
                      <Text style={styles.hint}>No failed attempts.</Text>
                    ) : (
                      groupJobsByDate(failedJobs, (job) => job.updatedAt).map((group) => (
                        <View key={group.key}>
                          <Text style={styles.dateGroupTitle}>{group.label}</Text>
                          {group.jobs.map((job) => (
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
                          ))}
                        </View>
                      ))
                    )}
                    {failedJobs.length > 0 && (
                      <Text style={styles.hint}>
                        Retry returns the message to pending. Tap Send queued messages when you are ready to try again.
                      </Text>
                    )}
                  </View>
                  <View style={styles.jobSection}>
                    <Text style={styles.sectionTitle}>Sent messages</Text>
                    {sentJobs.length === 0 ? (
                      <Text style={styles.hint}>No messages have been sent yet.</Text>
                    ) : (
                      groupJobsByDate(sentJobs, (job) => job.sentAt ?? job.updatedAt).map((group) => (
                        <View key={group.key}>
                          <Text style={styles.dateGroupTitle}>{group.label}</Text>
                          {group.jobs.map((job) => (
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
                          ))}
                        </View>
                      ))
                    )}
                    <Text style={styles.hint}>
                      Delivery reports depend on the carrier and recipient network. Without a report, only sent status
                      is shown.
                    </Text>
                  </View>
                  <Text style={styles.hint}>
                    Keep this app open while sending. Sent means accepted by Android, not confirmed delivered.
                  </Text>
                  {!!queueError && (
                    <Text accessibilityLiveRegion="polite" style={styles.errorMessage}>
                      {queueError}
                    </Text>
                  )}
                </View>
              )}
            </View>
          )}

          {activeTab === 'settings' && (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Appearance</Text>
              <Text style={styles.description}>Choose a theme or follow your device’s appearance setting.</Text>
              <View style={styles.themeOptions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: themeMode === 'light' }}
                  onPress={() => changeTheme('light')}
                  testID="light-theme-button"
                  style={[styles.themeOption, themeMode === 'light' && styles.themeOptionSelected]}
                >
                  <Text style={[styles.themeOptionText, themeMode === 'light' && styles.themeOptionTextSelected]}>
                    Light
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: themeMode === 'dark' }}
                  onPress={() => changeTheme('dark')}
                  testID="dark-theme-button"
                  style={[styles.themeOption, themeMode === 'dark' && styles.themeOptionSelected]}
                >
                  <Text style={[styles.themeOptionText, themeMode === 'dark' && styles.themeOptionTextSelected]}>
                    Dark
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: themeMode === 'system' }}
                  onPress={() => changeTheme('system')}
                  testID="system-theme-button"
                  style={[styles.themeOption, themeMode === 'system' && styles.themeOptionSelected]}
                >
                  <Text style={[styles.themeOptionText, themeMode === 'system' && styles.themeOptionTextSelected]}>
                    System
                  </Text>
                </Pressable>
              </View>
              {!!themeError && (
                <Text accessibilityLiveRegion="polite" style={styles.errorMessage}>
                  {themeError}
                </Text>
              )}
              <View style={styles.settingsSection}>
                <Text style={styles.sectionTitle}>Device security</Text>
                <Text style={styles.hint}>
                  Forgetting a device removes its saved credentials from this phone. Revoke its access in the desktop
                  app to disconnect it completely.
                </Text>
                {paired ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={forgetDevice}
                    testID="settings-forget-device-button"
                    style={({ pressed }) => [styles.button, styles.secondaryButton, pressed && styles.buttonPressed]}
                  >
                    <Text style={styles.secondaryButtonText}>Forget {paired.deviceName}</Text>
                  </Pressable>
                ) : storedPairing ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={forgetDevice}
                    testID="settings-forget-saved-device-button"
                    style={({ pressed }) => [styles.button, styles.secondaryButton, pressed && styles.buttonPressed]}
                  >
                    <Text style={styles.secondaryButtonText}>Forget saved device</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          )}

          {connection.status === 'error' && (
            <Text accessibilityLiveRegion="polite" style={styles.errorMessage}>
              {connection.message}
            </Text>
          )}

          {!paired && activeTab === 'connections' && (
            <Text style={styles.hint}>
              The pairing QR code expires automatically. Keep the desktop app open and scan its current code.
            </Text>
          )}
        </ScrollView>
        <View style={styles.tabBar}>
          {(
            [
              ['dashboard', 'Home'],
              ['connections', 'Connect'],
              ['messages', 'Messages'],
              ['settings', 'Settings'],
            ] as const
          ).map(([tab, label]) => (
            <Pressable
              key={tab}
              accessibilityRole="button"
              accessibilityState={{ selected: activeTab === tab }}
              onPress={() => setActiveTab(tab)}
              testID={`tab-${tab}`}
              style={({ pressed }) => [styles.tabButton, pressed && styles.buttonPressed]}
            >
              <Text style={[styles.tabLabel, activeTab === tab && styles.tabLabelActive]}>{label}</Text>
              {tab === 'messages' && queueStatus.failed > 0 && (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>{queueStatus.failed}</Text>
                </View>
              )}
            </Pressable>
          ))}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function createStyles(isDarkMode: boolean) {
  const colors = isDarkMode
    ? {
        background: '#0c1220',
        surface: '#151e2f',
        border: '#29364a',
        text: '#edf3fd',
        secondaryText: '#aab8ca',
        mutedText: '#8b9bb1',
        subtleSurface: '#1d293b',
        primary: '#6b95ff',
        primarySoft: '#1a2c4b',
        primaryBorder: '#304d7d',
        green: '#4ade80',
        red: '#fca5a5',
        redSoft: '#3b2029',
        redBorder: '#67313d',
      }
    : {
        background: '#f4f7fb',
        surface: '#ffffff',
        border: '#e2e8f0',
        text: '#0f172a',
        secondaryText: '#475569',
        mutedText: '#64748b',
        subtleSurface: '#f8fafc',
        primary: '#2563eb',
        primarySoft: '#eff6ff',
        primaryBorder: '#bfdbfe',
        green: '#15803d',
        red: '#b91c1c',
        redSoft: '#fef2f2',
        redBorder: '#fecaca',
      };

  return StyleSheet.create({
    container: {
      backgroundColor: colors.background,
      flex: 1,
    },
    content: {
      alignSelf: 'center',
      maxWidth: 480,
      paddingHorizontal: 22,
      paddingTop: 22,
      paddingBottom: 28,
      width: '100%',
    },
    eyebrow: {
      color: colors.primary,
      fontSize: 12,
      fontWeight: '700',
      letterSpacing: 1.2,
      marginBottom: 8,
    },
    title: {
      color: colors.text,
      fontSize: 28,
      fontWeight: '700',
      marginBottom: 8,
    },
    description: {
      color: colors.secondaryText,
      fontSize: 15,
      lineHeight: 22,
      marginBottom: 18,
    },
    queueStatus: {
      color: colors.text,
      fontSize: 14,
      lineHeight: 21,
      marginTop: 6,
    },
    sectionTitle: {
      color: colors.text,
      fontSize: 16,
      fontWeight: '700',
      marginBottom: 8,
    },
    dateGroupTitle: {
      color: colors.secondaryText,
      fontSize: 14,
      fontWeight: '700',
      marginTop: 10,
    },
    jobSection: {
      borderTopColor: colors.border,
      borderTopWidth: 1,
      marginTop: 18,
      paddingTop: 16,
    },
    jobRow: {
      backgroundColor: colors.subtleSurface,
      borderRadius: 12,
      marginTop: 8,
      padding: 12,
    },
    jobRecipient: {
      color: colors.text,
      fontSize: 14,
      fontWeight: '700',
    },
    jobMessage: {
      color: colors.secondaryText,
      fontSize: 14,
      lineHeight: 20,
      marginTop: 4,
    },
    jobFailure: {
      color: colors.red,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 4,
    },
    sentJobStatus: {
      color: colors.green,
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
      backgroundColor: colors.primarySoft,
      borderColor: colors.primaryBorder,
    },
    retryJobText: {
      color: colors.primary,
      fontSize: 14,
      fontWeight: '700',
      textAlign: 'center',
    },
    deleteJobButton: {
      backgroundColor: colors.redSoft,
      borderColor: colors.redBorder,
    },
    deleteJobText: {
      color: colors.red,
      fontSize: 14,
      fontWeight: '700',
      textAlign: 'center',
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 18,
      borderWidth: 1,
      elevation: 2,
      padding: 18,
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: isDarkMode ? 0.15 : 0.04,
      shadowRadius: 8,
    },
    button: {
      alignItems: 'center',
      backgroundColor: colors.primary,
      borderRadius: 12,
      justifyContent: 'center',
      marginTop: 14,
      minHeight: 50,
      paddingHorizontal: 12,
    },
    secondaryButton: {
      backgroundColor: colors.primarySoft,
      borderColor: colors.primaryBorder,
      borderWidth: 1,
    },
    secondaryButtonText: {
      color: colors.primary,
      fontSize: 15,
      fontWeight: '700',
    },
    buttonPressed: {
      opacity: 0.82,
    },
    buttonDisabled: {
      opacity: 0.5,
    },
    buttonText: {
      color: '#ffffff',
      fontSize: 15,
      fontWeight: '700',
    },
    pairingFields: {
      borderTopColor: colors.border,
      borderTopWidth: 1,
      marginTop: 4,
      paddingTop: 8,
    },
    cameraFrame: {
      backgroundColor: '#0f172a',
      borderRadius: 12,
      height: 320,
      marginTop: 16,
      overflow: 'hidden',
    },
    cameraHint: {
      backgroundColor: '#0f172acc',
      bottom: 0,
      color: '#ffffff',
      fontSize: 13,
      left: 0,
      padding: 12,
      position: 'absolute',
      right: 0,
      textAlign: 'center',
    },
    pairedPanel: {
      borderTopColor: colors.border,
      borderTopWidth: 1,
      marginTop: 20,
      paddingTop: 16,
    },
    connectedTitle: {
      color: colors.green,
      fontSize: 17,
      fontWeight: '700',
    },
    errorMessage: {
      color: colors.red,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 12,
    },
    hint: {
      color: colors.mutedText,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 18,
    },
    hintCompact: {
      color: colors.mutedText,
      fontSize: 13,
      marginTop: 4,
    },
    dashboardConnection: {
      alignItems: 'center',
      flexDirection: 'row',
      marginBottom: 18,
    },
    dashboardConnectionCopy: {
      flex: 1,
    },
    connectionIndicator: {
      backgroundColor: colors.green,
      borderRadius: 6,
      height: 12,
      marginRight: 12,
      width: 12,
    },
    manageButton: {
      backgroundColor: colors.primarySoft,
      borderRadius: 9,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    manageButtonText: {
      color: colors.primary,
      fontSize: 13,
      fontWeight: '700',
    },
    metricsRow: {
      flexDirection: 'row',
      gap: 10,
      marginTop: 4,
    },
    metricCard: {
      backgroundColor: colors.subtleSurface,
      borderRadius: 12,
      flex: 1,
      minHeight: 78,
      justifyContent: 'center',
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    metricValue: {
      color: colors.text,
      fontSize: 22,
      fontWeight: '700',
    },
    metricWarning: {
      color: colors.red,
    },
    metricLabel: {
      color: colors.mutedText,
      fontSize: 12,
      marginTop: 3,
    },
    deviceAddress: {
      color: colors.mutedText,
      fontSize: 13,
      marginTop: 6,
    },
    themeOptions: {
      backgroundColor: colors.subtleSurface,
      borderRadius: 12,
      flexDirection: 'row',
      gap: 8,
      padding: 5,
    },
    themeOption: {
      alignItems: 'center',
      borderRadius: 9,
      flex: 1,
      minHeight: 44,
      justifyContent: 'center',
    },
    themeOptionSelected: {
      backgroundColor: colors.surface,
      elevation: 1,
    },
    themeOptionText: {
      color: colors.mutedText,
      fontSize: 14,
      fontWeight: '600',
    },
    themeOptionTextSelected: {
      color: colors.primary,
    },
    settingsSection: {
      borderTopColor: colors.border,
      borderTopWidth: 1,
      marginTop: 22,
      paddingTop: 18,
    },
    tabBar: {
      backgroundColor: colors.surface,
      borderTopColor: colors.border,
      borderTopWidth: 1,
      flexDirection: 'row',
      justifyContent: 'space-around',
      paddingHorizontal: 6,
      paddingTop: 10,
      paddingBottom: 8,
    },
    tabButton: {
      alignItems: 'center',
      borderRadius: 10,
      flex: 1,
      justifyContent: 'center',
      minHeight: 44,
    },
    tabLabel: {
      color: colors.mutedText,
      fontSize: 12,
      fontWeight: '600',
    },
    tabLabelActive: {
      color: colors.primary,
      fontWeight: '700',
    },
    tabBadge: {
      alignItems: 'center',
      backgroundColor: colors.red,
      borderRadius: 8,
      height: 16,
      justifyContent: 'center',
      minWidth: 16,
      position: 'absolute',
      right: 14,
      top: 0,
    },
    tabBadgeText: {
      color: '#ffffff',
      fontSize: 10,
      fontWeight: '700',
    },
  });
}

export default App;
