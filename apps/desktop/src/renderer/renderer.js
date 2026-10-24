const statusElement = document.getElementById('gateway-status');
const detailsElement = document.getElementById('gateway-details');
const addressesElement = document.getElementById('gateway-addresses');

window.smsGateway.getStatus()
  .then((status) => {
    statusElement.classList.add('ready');
    statusElement.lastChild.textContent = 'Gateway is running';
    detailsElement.hidden = false;

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
  })
  .catch((error) => {
    statusElement.classList.remove('ready');
    statusElement.lastChild.textContent =
      `Gateway failed to start: ${error.message}`;
  });
