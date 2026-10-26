const statusElement = document.getElementById('gateway-status');
const detailsElement = document.getElementById('gateway-details');
const addressesElement = document.getElementById('gateway-addresses');
const pairingExpiryElement = document.getElementById('pairing-expiry');
const pairingQrCodesElement = document.getElementById('pairing-qr-codes');
const devicesElement = document.getElementById('paired-devices');
const uploadButton = document.getElementById('upload-spreadsheet');
const uploadMessageElement = document.getElementById('upload-message');
const uploadsElement = document.getElementById('spreadsheet-uploads');

function renderUploads(uploads) {
  uploadsElement.replaceChildren();
  if (uploads.length === 0) {
    const item = document.createElement('li');
    item.className = 'muted';
    item.textContent = 'No spreadsheets uploaded yet.';
    uploadsElement.append(item);
    return;
  }

  for (const upload of uploads) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = upload.name;
    const size = document.createElement('span');
    size.className = 'muted';
    size.textContent = `${(upload.size / 1024).toFixed(1)} KB`;
    item.append(name, size);
    uploadsElement.append(item);
  }
}

uploadButton.addEventListener('click', async () => {
  uploadButton.disabled = true;
  uploadMessageElement.textContent = '';
  try {
    const selection = await window.smsGateway.selectSpreadsheet();
    renderUploads(selection.uploads);
    if (selection.uploaded) {
      uploadMessageElement.textContent =
        'Spreadsheet saved on this computer.';
    }
  } catch (error) {
    uploadMessageElement.textContent =
      `Could not save the spreadsheet: ${error.message}`;
  } finally {
    uploadButton.disabled = false;
  }
});

window.smsGateway.listSpreadsheetUploads()
  .then(renderUploads)
  .catch((error) => {
    uploadMessageElement.textContent =
      `Could not load saved spreadsheets: ${error.message}`;
  });

function renderStatus(status) {
  statusElement.classList.add('ready');
  statusElement.lastChild.textContent = 'Gateway is running';
  detailsElement.hidden = false;
  pairingExpiryElement.textContent =
    status.pairingCode === 'expired'
      ? ''
      : `One-time code expires at ${new Date(status.pairingCodeExpiresAt).toLocaleTimeString()}.`;

  addressesElement.replaceChildren();
  pairingQrCodesElement.replaceChildren();
  devicesElement.replaceChildren();

  if (status.addresses.length === 0) {
    const item = document.createElement('li');
    item.textContent =
      'No local network address found. Connect this computer to Wi-Fi or Ethernet.';
    addressesElement.append(item);
  }

  for (const address of status.addresses) {
    const item = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = address;
    item.append(code);
    addressesElement.append(item);
  }

  for (const qrCode of status.pairingQrCodes) {
    const card = document.createElement('div');
    card.className = 'qr-card';
    const image = document.createElement('img');
    image.alt = `Pairing QR code for ${qrCode.address}`;
    image.src = qrCode.dataUrl;
    const label = document.createElement('code');
    label.textContent = qrCode.address;
    card.append(image, label);
    pairingQrCodesElement.append(card);
  }

  if (status.pairedDevices.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No devices paired yet.';
    devicesElement.append(empty);
    return;
  }

  for (const device of status.pairedDevices) {
    const row = document.createElement('div');
    row.className = 'device-row';
    const label = document.createElement('span');
    label.className = 'device-name';
    label.textContent = `${device.name} · Paired on ${new Date(device.pairedAt).toLocaleString()}`;
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.textContent = 'Revoke';
    revoke.addEventListener('click', async () => {
      revoke.disabled = true;
      try {
        renderStatus(await window.smsGateway.revokeDevice(device.id));
      } catch (error) {
        revoke.disabled = false;
        window.alert(`Could not revoke device: ${error.message}`);
      }
    });
    row.append(label, revoke);
    devicesElement.append(row);
  }
}

window.smsGateway.getStatus()
  .then(renderStatus)
  .catch((error) => {
    statusElement.classList.remove('ready');
    statusElement.lastChild.textContent =
      `Gateway failed to start: ${error.message}`;
  });

window.setInterval(() => {
  window.smsGateway.getStatus()
    .then(renderStatus)
    .catch((error) => {
      statusElement.classList.remove('ready');
      statusElement.lastChild.textContent =
        `Gateway status unavailable: ${error.message}`;
    });
}, 5000);

document.getElementById('rotate-code').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    renderStatus(await window.smsGateway.rotatePairingCode());
  } catch (error) {
    window.alert(`Could not generate a pairing code: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});
