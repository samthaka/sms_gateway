import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { createGatewayClient } from '@sms-gateway/api-client';
import type { PairDeviceResponse } from '@sms-gateway/shared-contracts';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useCodeScanner,
} from 'react-native-vision-camera';
import {
  gatewayTransport,
  getSecureValue,
  removeSecureValue,
  setSecureValue,
} from './gateway-security';
import { parsePairingQrPayload } from './pairing-qr';

const SAVED_PAIRING_KEY = 'paired-gateway';

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
  const deviceName = 'Android gateway';
  const [isScanning, setIsScanning] = useState(false);
  const [storedPairing, setStoredPairing] = useState<SavedPairing>();
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
      const paired: PairDeviceResponse = await client.pairDevice({
        code: payload.pairingCode,
        deviceName: deviceName.trim(),
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
