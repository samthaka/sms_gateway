const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createGatewayClient } = require('@sms-gateway/api-client');
const { startGatewayServer } = require('../dist/gateway-server.js');

function httpsTransport(certificate) {
  return {
    request(url, _pin, method, body, token) {
      return new Promise((resolve, reject) => {
        const request = https.request(
          new URL(url),
          {
            ca: certificate,
            headers: {
              accept: 'application/json',
              ...(body ? { 'content-type': 'application/json' } : {}),
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            method,
          },
          (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => {
              resolve({
                status: response.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
              });
            });
          },
        );
        request.on('error', reject);
        request.end(body);
      });
    },
  };
}

async function makeServer(t) {
  const storageDir = await mkdtemp(path.join(os.tmpdir(), 'sms-gateway-test-'));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  const gateway = await startGatewayServer({
    host: '127.0.0.1',
    port: 0,
    storageDir,
  });
  t.after(() => gateway.close());
  return { gateway, storageDir };
}

function createClient(gateway) {
  const status = gateway.getStatus();
  return createGatewayClient(
    `https://127.0.0.1:${status.port}`,
    status.certificatePin,
    httpsTransport(gateway.getCertificate()),
  );
}

test('serves health over TLS with a stable certificate pin', async (t) => {
  const { gateway, storageDir } = await makeServer(t);
  const client = createClient(gateway);
  const health = await client.getHealth();

  assert.deepEqual(health, {
    status: 'ok',
    protocolVersion: 1,
    serverId: gateway.getStatus().serverId,
  });
  assert.match(gateway.getStatus().certificatePin, /^sha256\/[A-Za-z0-9+/]{43}=$/);

  await gateway.close();
  const restarted = await startGatewayServer({
    host: '127.0.0.1',
    port: 0,
    storageDir,
  });
  t.after(() => restarted.close());
  assert.equal(
    restarted.getStatus().certificatePin,
    gateway.getStatus().certificatePin,
  );
});

test('pairs with a one-time code, persists credentials by hash, and supports revocation', async (t) => {
  const { gateway, storageDir } = await makeServer(t);
  const client = createClient(gateway);
  const { pairingCode } = gateway.getStatus();
  const paired = await client.pairDevice({
    code: pairingCode,
    deviceName: 'Test Android',
  });

  assert.equal(paired.deviceName, 'Test Android');
  assert.equal(gateway.getStatus().pairedDevices.length, 1);
  assert.equal(
    (await client.getPairedDevice(paired.token)).deviceId,
    paired.deviceId,
  );
  await assert.rejects(client.pairDevice({
    code: pairingCode,
    deviceName: 'Second device',
  }));

  const persistedDevices = await readFile(
    path.join(storageDir, 'paired-devices.json'),
    'utf8',
  );
  assert.equal(persistedDevices.includes(paired.token), false);

  await gateway.close();
  const restarted = await startGatewayServer({
    host: '127.0.0.1',
    port: 0,
    storageDir,
  });
  t.after(() => restarted.close());
  const restartedClient = createClient(restarted);
  assert.equal(
    (await restartedClient.getPairedDevice(paired.token)).deviceId,
    paired.deviceId,
  );

  await restarted.revokeDevice(paired.deviceId);
  await assert.rejects(
    restartedClient.getPairedDevice(paired.token),
    /status 401/,
  );
});

test('a pairing code can only establish one concurrent link and can be rotated for another device', async (t) => {
  const { gateway } = await makeServer(t);
  const client = createClient(gateway);
  const firstCode = gateway.getStatus().pairingCode;
  const results = await Promise.allSettled([
    client.pairDevice({ code: firstCode, deviceName: 'First device' }),
    client.pairDevice({ code: firstCode, deviceName: 'Racing device' }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(gateway.getStatus().pairedDevices.length, 1);

  gateway.rotatePairingCode();
  const second = await client.pairDevice({
    code: gateway.getStatus().pairingCode,
    deviceName: 'Second device',
  });
  assert.equal(second.deviceName, 'Second device');
  assert.equal(gateway.getStatus().pairedDevices.length, 2);
});

test('queues jobs for the paired phone, records SMS results, and does not resend interrupted jobs', async (t) => {
  const { gateway, storageDir } = await makeServer(t);
  const client = createClient(gateway);
  const paired = await client.pairDevice({
    code: gateway.getStatus().pairingCode,
    deviceName: 'Test Android',
  });
  assert.equal(
    await gateway.enqueueSmsBatch(paired.deviceId, [
      {
        phoneNumber: '+254700000001',
        message: 'Hello one',
        idempotencyKey: 'row-1',
      },
    ]),
    1,
  );
  const firstQueueSnapshot = await client.getSmsQueueStatus(paired.token);
  assert.deepEqual(
    (({ asOf, ...status }) => status)(firstQueueSnapshot),
    {
      queued: 1,
      sending: 0,
      sent: 0,
      failed: 0,
    },
  );
  assert.equal(
    await gateway.enqueueSmsBatch(paired.deviceId, [
      {
        phoneNumber: '+254700000002',
        message: 'Hello two',
        idempotencyKey: 'row-2',
      },
    ]),
    1,
  );
  const firstJob = await client.getNextSmsJob(
    paired.token,
    firstQueueSnapshot.asOf,
  );
  assert.equal(firstJob?.phoneNumber, '+254700000001');
  assert.equal(firstJob?.status, 'sending');
  await client.completeSmsJob(paired.token, firstJob.id, { status: 'sent' });
  assert.equal(
    await client.getNextSmsJob(paired.token, firstQueueSnapshot.asOf),
    null,
  );
  const interruptedJob = await client.getNextSmsJob(paired.token);
  assert.equal(interruptedJob?.phoneNumber, '+254700000002');

  await gateway.close();
  const restarted = await startGatewayServer({
    host: '127.0.0.1',
    port: 0,
    storageDir,
  });
  t.after(() => restarted.close());
  const restartedClient = createClient(restarted);
  const restartedQueue = await restartedClient.getSmsQueueStatus(paired.token);
  assert.deepEqual(
    (({ asOf, ...status }) => status)(restartedQueue),
    {
      queued: 0,
      sending: 0,
      sent: 1,
      failed: 1,
    },
  );
  await assert.rejects(
    restartedClient.completeSmsJob(paired.token, interruptedJob.id, {
      status: 'sent',
    }),
    /status 409/,
  );
});

test('lists pending and failed jobs and supports retrying or deleting failed jobs', async (t) => {
  const { gateway } = await makeServer(t);
  const client = createClient(gateway);
  const paired = await client.pairDevice({
    code: gateway.getStatus().pairingCode,
    deviceName: 'Test Android',
  });
  await gateway.enqueueSmsBatch(paired.deviceId, [
    {
      phoneNumber: '+254700000001',
      message: 'Hello again',
      idempotencyKey: 'row-1',
    },
  ]);
  const [pendingJob] = await client.getSmsJobs(paired.token);
  assert.equal(pendingJob.status, 'queued');
  await assert.rejects(
    client.retrySmsJob(paired.token, pendingJob.id),
    /status 409/,
  );
  const jobId = pendingJob.id;
  const sendingJob = await client.getNextSmsJob(paired.token);
  assert.equal(sendingJob.id, pendingJob.id);
  await client.completeSmsJob(paired.token, sendingJob.id, {
    status: 'failed',
    failureReason: 'SIM unavailable',
  });

  const [failedJob] = await client.getSmsJobs(paired.token);
  assert.equal(failedJob.id, jobId);
  assert.equal(failedJob.status, 'failed');
  assert.equal(failedJob.failureReason, 'SIM unavailable');

  const retriedJob = await client.retrySmsJob(paired.token, failedJob.id);
  assert.equal(retriedJob.status, 'queued');
  assert.equal(retriedJob.failureReason, undefined);
  assert.equal((await client.getSmsJobs(paired.token))[0].status, 'queued');
  await assert.rejects(
    client.deleteFailedSmsJob(paired.token, failedJob.id),
    /status 409/,
  );

  const secondAttempt = await client.getNextSmsJob(paired.token);
  await client.completeSmsJob(paired.token, secondAttempt.id, {
    status: 'failed',
    failureReason: 'Still unavailable',
  });
  assert.deepEqual(
    await client.deleteFailedSmsJob(paired.token, failedJob.id),
    { deleted: true },
  );
  assert.deepEqual(await client.getSmsJobs(paired.token), []);
});

test('queue job listing and failed-job actions are scoped to the paired device', async (t) => {
  const { gateway } = await makeServer(t);
  const client = createClient(gateway);
  const firstDevice = await client.pairDevice({
    code: gateway.getStatus().pairingCode,
    deviceName: 'First phone',
  });
  gateway.rotatePairingCode();
  const secondDevice = await client.pairDevice({
    code: gateway.getStatus().pairingCode,
    deviceName: 'Second phone',
  });
  await gateway.enqueueSmsBatch(firstDevice.deviceId, [
    {
      phoneNumber: '+254700000001',
      message: 'Private to first phone',
      idempotencyKey: 'row-1',
    },
  ]);
  const [firstDeviceJob] = await client.getSmsJobs(firstDevice.token);
  const jobId = firstDeviceJob.id;
  const sendingJob = await client.getNextSmsJob(firstDevice.token);
  await client.completeSmsJob(firstDevice.token, sendingJob.id, {
    status: 'failed',
  });

  assert.deepEqual(await client.getSmsJobs(secondDevice.token), []);
  await assert.rejects(
    client.retrySmsJob(secondDevice.token, jobId),
    /status 404/,
  );
  await assert.rejects(
    client.deleteFailedSmsJob(secondDevice.token, jobId),
    /status 404/,
  );
  assert.equal((await client.getSmsJobs(firstDevice.token))[0].id, jobId);
});

test('rejects SMS queue access without a valid paired-device token', async (t) => {
  const { gateway } = await makeServer(t);
  const client = createClient(gateway);
  await assert.rejects(
    client.getSmsQueueStatus('not-a-valid-token'),
    /status 401/,
  );
  await assert.rejects(
    client.getSmsJobs('not-a-valid-token'),
    /status 401/,
  );
});

test('rejects incorrect pairing codes and enforces the attempt limit', async (t) => {
  const { gateway } = await makeServer(t);
  const client = createClient(gateway);
  const correctCode = gateway.getStatus().pairingCode;
  const wrongCode = correctCode === '000000' ? '000001' : '000000';

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      client.pairDevice({ code: wrongCode, deviceName: 'Untrusted device' }),
      /status 401/,
    );
  }
  await assert.rejects(
    client.pairDevice({ code: correctCode, deviceName: 'Late device' }),
    /status 429/,
  );

  gateway.rotatePairingCode();
  const rotatedCode = gateway.getStatus().pairingCode;
  await assert.rejects(
    client.pairDevice({ code: rotatedCode, deviceName: 'Still limited' }),
    /status 429/,
  );
});

test('does not expose unrecognized gateway routes', async (t) => {
  const { gateway } = await makeServer(t);
  const transport = httpsTransport(gateway.getCertificate());
  const response = await transport.request(
    `https://127.0.0.1:${gateway.getStatus().port}/v1/jobs/invalid`,
    gateway.getStatus().certificatePin,
    'GET',
  );

  assert.equal(response.status, 404);
  assert.deepEqual(JSON.parse(response.body), { error: 'Not found' });
});
