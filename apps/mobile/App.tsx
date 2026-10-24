import { StatusBar, StyleSheet, Text } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={styles.container}>
        <Text style={styles.title}>SMS Gateway</Text>
        <Text style={styles.status}>Gateway not connected</Text>
        <Text style={styles.description}>
          Connect to the desktop gateway on your local network to receive SMS
          jobs.
        </Text>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    color: '#0f172a',
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 20,
  },
  status: {
    color: '#b45309',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  description: {
    color: '#475569',
    fontSize: 15,
    lineHeight: 22,
    maxWidth: 320,
    textAlign: 'center',
  },
});

export default App;
