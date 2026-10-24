import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { fetchGatewayHealth } from '@sms-gateway/api-client';

function App() {
  const [gatewayAddress, setGatewayAddress] = useState(
    'http://10.0.2.2:47832',
  );
  const [connection, setConnection] = useState<
    { status: 'disconnected' } |
    { status: 'connecting' } |
    { status: 'connected'; serverId: string } |
    { status: 'error'; message: string }
  >({ status: 'disconnected' });

  async function connectToGateway() {
    setConnection({ status: 'connecting' });
    try {
      const health = await fetchGatewayHealth(gatewayAddress.trim());
      setConnection({ status: 'connected', serverId: health.serverId });
    } catch (error) {
      setConnection({
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Could not connect to the desktop gateway.',
      });
    }
  }

  const statusLabel =
    connection.status === 'connected'
      ? 'Connected to desktop'
      : connection.status === 'connecting'
        ? 'Connecting…'
        : connection.status === 'error'
          ? 'Connection failed'
          : 'Gateway not connected';

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={styles.container}>
        <View style={styles.content}>
          <Text style={styles.eyebrow}>MOBILE SMS GATEWAY</Text>
          <Text style={styles.title}>Connect your device</Text>
          <Text style={styles.description}>
            Connect to the desktop app on the same local network. SMS sending
            and SIM selection will be added after this connection step.
          </Text>

          <View style={styles.card}>
            <Text style={styles.label}>Desktop gateway address</Text>
            <TextInput
              accessibilityLabel="Desktop gateway address"
              testID="gateway-address-input"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onChangeText={(address) => {
                setGatewayAddress(address);
                setConnection({ status: 'disconnected' });
              }}
              placeholder="http://192.168.1.10:47832"
              placeholderTextColor="#94a3b8"
              style={styles.input}
              value={gatewayAddress}
            />
            <Pressable
              accessibilityRole="button"
              disabled={connection.status === 'connecting'}
              onPress={connectToGateway}
              testID="connect-gateway-button"
              style={({ pressed }) => [
                styles.button,
                pressed && styles.buttonPressed,
                connection.status === 'connecting' && styles.buttonDisabled,
              ]}
            >
              {connection.status === 'connecting' ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Connect</Text>
              )}
            </Pressable>
          </View>

          <View style={styles.connectionPanel}>
            <View
              style={[
                styles.statusDot,
                connection.status === 'connected' && styles.connectedDot,
                connection.status === 'error' && styles.errorDot,
              ]}
            />
            <Text
              accessibilityLiveRegion="polite"
              style={[
                styles.status,
                connection.status === 'connected' && styles.connectedStatus,
                connection.status === 'error' && styles.errorStatus,
              ]}
            >
              {statusLabel}
            </Text>
          </View>

          {connection.status === 'connected' && (
            <Text style={styles.feedback}>
              Gateway verified. Device ID: {connection.serverId.slice(0, 8)}
            </Text>
          )}
          {connection.status === 'error' && (
            <Text style={styles.errorMessage}>{connection.message}</Text>
          )}

          <Text style={styles.hint}>
            Android emulator: use 10.0.2.2. For a physical phone, enter one of
            the network addresses shown in the desktop app.
          </Text>
        </View>
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
    marginBottom: 24,
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
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 10,
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
  },
  buttonPressed: {
    backgroundColor: '#1d4ed8',
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  connectionPanel: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 9,
    marginTop: 22,
  },
  statusDot: {
    backgroundColor: '#d97706',
    borderRadius: 5,
    height: 10,
    width: 10,
  },
  connectedDot: {
    backgroundColor: '#16a34a',
  },
  errorDot: {
    backgroundColor: '#dc2626',
  },
  status: {
    color: '#b45309',
    fontSize: 14,
    fontWeight: '600',
  },
  connectedStatus: {
    color: '#15803d',
  },
  errorStatus: {
    color: '#b91c1c',
  },
  feedback: {
    color: '#15803d',
    fontSize: 13,
    marginTop: 8,
  },
  errorMessage: {
    color: '#b91c1c',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
  },
  hint: {
    color: '#64748b',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 18,
  },
});

export default App;
