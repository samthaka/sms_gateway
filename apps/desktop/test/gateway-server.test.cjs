const assert = require('node:assert/strict');
const test = require('node:test');
const { startGatewayServer } = require('../dist/gateway-server.js');
const { fetchGatewayHealth } = require('@sms-gateway/api-client');

test('serves the versioned health endpoint and shuts down', async () => {
  const gateway = await startGatewayServer({ host: '127.0.0.1', port: 0 });
  const { port, serverId } = gateway.getStatus();

  try {
    const health = await fetchGatewayHealth(`http://127.0.0.1:${port}`);
    assert.deepEqual(health, {
      status: 'ok',
      protocolVersion: 1,
      serverId,
    });
  } finally {
    await gateway.close();
  }
});

test('does not expose routes other than the health endpoint', async () => {
  const gateway = await startGatewayServer({ host: '127.0.0.1', port: 0 });
  const { port } = gateway.getStatus();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/jobs`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Not found' });
  } finally {
    await gateway.close();
  }
});
