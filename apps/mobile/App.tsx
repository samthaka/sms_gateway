import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { createGatewayClient } from '@sms-gateway/api-client';
import type { PairDeviceResponse } from '@sms-gateway/shared-contracts';
import {
  gatewayTransport,
  getSecureValue,
  inspectGatewayCertificate,
  removeSecureValue,
  setSecureValue,
} from './gateway-security';

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
  | { status: 'inspecting' }
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

function normalizeGatewayAddress(value: string): string {
  const url = new URL(value.trim());
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('Enter the desktop HTTPS address, including its port.');
  }
  return url.origin;
}

function App() {
  const [gatewayAddress, setGatewayAddress] = useState(
    'https://10.0.2.2:47832',
  );
  const [deviceName, setDeviceName] = useState('Android gateway');
  const [pairingCode, setPairingCode] = useState('');
  const [observedPin, setObservedPin] = useState<string>();
  const [trustedPin, setTrustedPin] = useState<string>();
  const [storedPairing, setStoredPairing] = useState<SavedPairing>();
  const [connection, setConnection] = useState<ConnectionState>({
    status: 'disconnected',
  });

  useEffect(() => {
    let active = true;
    getSecureValue(SAVED_PAIRING_KEY)
      .then(async (value) => {
        if (!value || !active) {
          return;
        }
        const saved = parseSavedPairing(value);
        setStoredPairing(saved);
        setGatewayAddress(saved.baseUrl);
        setDeviceName(saved.deviceName);
        const client = createGatewayClient(
          saved.baseUrl,
          saved.certificatePin,
          gatewayTransport,
        );
        await client.getPairedDevice(saved.token);
        if (active) {
          setTrustedPin(saved.certificatePin);
          setObservedPin(saved.certificatePin);
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

  async function inspectDesktop() {
    setConnection({ status: 'inspecting' });
    setObservedPin(undefined);
    setTrustedPin(undefined);
    try {
      const baseUrl = normalizeGatewayAddress(gatewayAddress);
      const pin = await inspectGatewayCertificate(
        new URL('/v1/health', baseUrl).toString(),
      );
      setObservedPin(pin);
      setConnection({ status: 'disconnected' });
    } catch (error) {
      setConnection({
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Could not inspect the desktop certificate.',
      });
    }
  }

  async function pairWithDesktop() {
    if (!trustedPin) {
      setConnection({
        status: 'error',
        message: 'Verify the certificate fingerprint before pairing.',
      });
      return;
    }

    setConnection({ status: 'pairing' });
    try {
      const baseUrl = normalizeGatewayAddress(gatewayAddress);
      await setSecureValue('pairing-storage-check', 'available');
      await removeSecureValue('pairing-storage-check');
      const client = createGatewayClient(baseUrl, trustedPin, gatewayTransport);
      const paired: PairDeviceResponse = await client.pairDevice({
        code: pairingCode.trim(),
        deviceName: deviceName.trim(),
      });
      const saved: SavedPairing = {
        baseUrl,
        certificatePin: trustedPin,
        deviceId: paired.deviceId,
        deviceName: paired.deviceName,
        token: paired.token,
      };
      await setSecureValue(SAVED_PAIRING_KEY, JSON.stringify(saved));
      setStoredPairing(saved);
      setConnection({ status: 'connected', pairing: saved });
      setPairingCode('');
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
    if (!storedPairing || !trustedPin) {
      return;
    }

    setConnection({ status: 'pairing' });
    try {
      const baseUrl = normalizeGatewayAddress(gatewayAddress);
      const client = createGatewayClient(baseUrl, trustedPin, gatewayTransport);
      const device = await client.getPairedDevice(storedPairing.token);
      const saved: SavedPairing = {
        ...storedPairing,
        baseUrl,
        certificatePin: trustedPin,
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
      setTrustedPin(undefined);
      setObservedPin(undefined);
      setPairingCode('');
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

  const busy =
    connection.status === 'inspecting' || connection.status === 'pairing';
  const paired =
    connection.status === 'connected' ? connection.pairing : undefined;

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.eyebrow}>SECURE DEVICE PAIRING</Text>
          <Text style={styles.title}>Connect your device</Text>
          <Text style={styles.description}>
            Pair with the desktop gateway on your local network. The connection
            uses HTTPS with a certificate pin verified by you.
          </Text>

          <View style={styles.card}>
            <Text style={styles.label}>Desktop HTTPS address</Text>
            <TextInput
              accessibilityLabel="Desktop gateway address"
              testID="gateway-address-input"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy && !paired}
              keyboardType="url"
              onChangeText={(address) => {
                setGatewayAddress(address);
                setObservedPin(undefined);
                setTrustedPin(undefined);
                setConnection({ status: 'disconnected' });
              }}
              placeholder="https://192.168.1.10:47832"
              placeholderTextColor="#94a3b8"
              style={styles.input}
              value={gatewayAddress}
            />
            {!paired && (
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={inspectDesktop}
                testID="inspect-certificate-button"
                style={({ pressed }) => [
                  styles.button,
                  styles.secondaryButton,
                  pressed && styles.buttonPressed,
                  busy && styles.buttonDisabled,
                ]}
              >
                {connection.status === 'inspecting' ? (
                  <ActivityIndicator color="#1d4ed8" />
                ) : (
                  <Text style={styles.secondaryButtonText}>
                    Check desktop certificate
                  </Text>
                )}
              </Pressable>
            )}

            {observedPin && !paired && (
              <View style={styles.fingerprintPanel}>
                <Text style={styles.label}>Certificate fingerprint</Text>
                <Text selectable style={styles.fingerprint}>
                  {observedPin}
                </Text>
                <Text style={styles.warning}>
                  Compare this exact value with the fingerprint shown on the
                  desktop. Continue only if they match.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setTrustedPin(observedPin)}
                  testID="trust-certificate-button"
                  style={({ pressed }) => [
                    styles.button,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={styles.buttonText}>
                    I verified the desktop fingerprint
                  </Text>
                </Pressable>
              </View>
            )}

            {trustedPin && !paired && (
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
                      Or pair another device with a new desktop code.
                    </Text>
                  </>
                )}
                <Text style={styles.label}>One-time pairing code</Text>
                <TextInput
                  accessibilityLabel="One-time pairing code"
                  testID="pairing-code-input"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="number-pad"
                  maxLength={6}
                  onChangeText={setPairingCode}
                  placeholder="6-digit code from desktop"
                  placeholderTextColor="#94a3b8"
                  style={styles.input}
                  value={pairingCode}
                />
                <Text style={styles.label}>Device name</Text>
                <TextInput
                  accessibilityLabel="Device name"
                  onChangeText={setDeviceName}
                  style={styles.input}
                  value={deviceName}
                />
                <Pressable
                  accessibilityRole="button"
                  disabled={busy || pairingCode.length !== 6}
                  onPress={pairWithDesktop}
                  testID="pair-device-button"
                  style={({ pressed }) => [
                    styles.button,
                    pressed && styles.buttonPressed,
                    (busy || pairingCode.length !== 6) &&
                      styles.buttonDisabled,
                  ]}
                >
                  {connection.status === 'pairing' ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>Pair device</Text>
                  )}
                </Pressable>
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
              Android emulator: use https://10.0.2.2:47832. For a physical
              phone, use an HTTPS address shown in the desktop app. The
              fingerprint is inspected before any pairing secret is sent.
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
  label: {
    color: '#334155',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 9,
    marginTop: 12,
  },
  input: {
    borderColor: '#cbd5e1',
    borderRadius: 10,
    borderWidth: 1,
    color: '#0f172a',
    fontSize: 15,
    minHeight: 48,
    paddingHorizontal: 12,
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
  fingerprintPanel: {
    borderTopColor: '#e2e8f0',
    borderTopWidth: 1,
    marginTop: 20,
    paddingTop: 8,
  },
  fingerprint: {
    backgroundColor: '#f1f5f9',
    borderRadius: 8,
    color: '#0f172a',
    fontSize: 12,
    lineHeight: 18,
    padding: 10,
  },
  warning: {
    color: '#92400e',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 10,
  },
  pairingFields: {
    borderTopColor: '#e2e8f0',
    borderTopWidth: 1,
    marginTop: 20,
    paddingTop: 8,
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
