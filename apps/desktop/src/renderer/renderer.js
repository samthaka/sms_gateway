const statusElement = document.getElementById('gateway-status');
const connectionStatusElement = document.getElementById('connection-gateway-status');
const connectionSummaryElement = document.getElementById('connection-summary');
const detailsElement = document.getElementById('gateway-details');
const addressesElement = document.getElementById('gateway-addresses');
const pairingExpiryElement = document.getElementById('pairing-expiry');
const pairingQrCodesElement = document.getElementById('pairing-qr-codes');
const devicesElement = document.getElementById('paired-devices');
const uploadButton = document.getElementById('upload-spreadsheet');
const uploadMessageElement = document.getElementById('upload-message');
const uploadsElement = document.getElementById('spreadsheet-uploads');
const spreadsheetSelect = document.getElementById('active-spreadsheet');
const sheetSelect = document.getElementById('active-sheet');
const sheetSelectContainer = document.getElementById('sheet-select-container');
const templateEditor = document.getElementById('message-template');
const templateFieldsElement = document.getElementById('template-fields');
const templatePreviewElement = document.getElementById('template-preview');
const phoneColumnSelect = document.getElementById('phone-column');
const sendDeviceSelect = document.getElementById('send-device');
const sendDeviceDropdown = document.getElementById('send-device-dropdown');
const sendDeviceTrigger = document.getElementById('send-device-trigger');
const sendDeviceOptions = document.getElementById('send-device-options');
const queueCampaignButton = document.getElementById('queue-campaign');
const campaignMessageElement = document.getElementById('campaign-message');
const queueStatusElement = document.getElementById('queue-status');
const pendingJobsElement = document.getElementById('pending-jobs');
const failedJobsElement = document.getElementById('failed-jobs');
const sentJobsElement = document.getElementById('sent-jobs');
const refreshQueueButton = document.getElementById('refresh-queue');
const uploadsPageElement = document.getElementById('uploads-page');
const spreadsheetsPageElement = document.getElementById('spreadsheets-page');
const connectionPageElement = document.getElementById('connection-page');
const settingsPageElement = document.getElementById('settings-page');
const openConnectionButton = document.getElementById('open-connection');
const dashboardNavButton = document.getElementById('dashboard-nav');
const spreadsheetsNavButton = document.getElementById('spreadsheets-nav');
const settingsNavButton = document.getElementById('settings-nav');
let activeSheets = [];

const themeModeButtons = document.querySelectorAll('[data-theme-mode]');
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
let themeMode = window.localStorage.getItem('sms-gateway-theme');

if (themeMode !== 'light' && themeMode !== 'dark' && themeMode !== 'system') {
  themeMode = 'system';
}

function applyThemeMode(mode) {
  const theme = mode === 'system' ? (systemTheme.matches ? 'dark' : 'light') : mode;
  document.body.setAttribute('data-theme', theme);
  for (const button of themeModeButtons) {
    const selected = button.dataset.themeMode === mode;
    button.setAttribute('aria-pressed', String(selected));
    button.classList.toggle('selected', selected);
  }
}

function updateThemeMode(mode) {
  themeMode = mode;
  window.localStorage.setItem('sms-gateway-theme', mode);
  applyThemeMode(mode);
}

for (const button of themeModeButtons) {
  button.addEventListener('click', () => {
    const mode = button.dataset.themeMode;
    if (mode === 'light' || mode === 'dark' || mode === 'system') {
      updateThemeMode(mode);
    }
  });
}

systemTheme.addEventListener('change', () => {
  if (themeMode === 'system') {
    applyThemeMode(themeMode);
  }
});

applyThemeMode(themeMode);

const templateStorageKey = 'sms-gateway-message-template';
templateEditor.value = window.localStorage.getItem(templateStorageKey) ?? '';

function selectedSheet() {
  return activeSheets.find((candidate) => candidate.number === Number(sheetSelect.value));
}

function updateCampaignAvailability() {
  queueCampaignButton.disabled = !(
    spreadsheetSelect.value &&
    selectedSheet() &&
    phoneColumnSelect.value &&
    templateEditor.value.trim() &&
    sendDeviceSelect.value
  );
}

function closeSendDeviceDropdown() {
  sendDeviceDropdown.classList.remove('is-open');
  sendDeviceOptions.hidden = true;
  sendDeviceTrigger.setAttribute('aria-expanded', 'false');
}

function syncSendDeviceDropdown() {
  const isOpen = !sendDeviceOptions.hidden;
  sendDeviceTrigger.textContent =
    sendDeviceSelect.selectedOptions[0]?.textContent ?? 'Choose a paired phone';
  sendDeviceOptions.replaceChildren();

  for (const [index, option] of [...sendDeviceSelect.options].entries()) {
    const item = document.createElement('button');
    item.className = 'custom-select-option';
    item.type = 'button';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(option.value === sendDeviceSelect.value));
    item.dataset.optionIndex = String(index);
    item.textContent = option.textContent;
    item.addEventListener('click', () => {
      sendDeviceSelect.value = option.value;
      sendDeviceSelect.dispatchEvent(new Event('change', { bubbles: true }));
      syncSendDeviceDropdown();
      closeSendDeviceDropdown();
      sendDeviceTrigger.focus();
    });
    sendDeviceOptions.append(item);
  }

  if (isOpen) {
    sendDeviceOptions.children[sendDeviceSelect.selectedIndex]?.focus();
  }
}

function openSendDeviceDropdown() {
  sendDeviceDropdown.classList.add('is-open');
  sendDeviceOptions.hidden = false;
  sendDeviceTrigger.setAttribute('aria-expanded', 'true');
  const selectedOption = sendDeviceOptions.children[sendDeviceSelect.selectedIndex];
  (selectedOption ?? sendDeviceOptions.firstElementChild)?.focus();
}

sendDeviceTrigger.addEventListener('click', () => {
  if (sendDeviceOptions.hidden) {
    openSendDeviceDropdown();
  } else {
    closeSendDeviceDropdown();
  }
});

sendDeviceTrigger.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openSendDeviceDropdown();
  }
});

sendDeviceOptions.addEventListener('keydown', (event) => {
  const options = [...sendDeviceOptions.querySelectorAll('[role="option"]')];
  const currentIndex = options.indexOf(document.activeElement);
  let nextIndex;
  if (event.key === 'ArrowDown') {
    nextIndex = Math.min(currentIndex + 1, options.length - 1);
  } else if (event.key === 'ArrowUp') {
    nextIndex = Math.max(currentIndex - 1, 0);
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = options.length - 1;
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeSendDeviceDropdown();
    sendDeviceTrigger.focus();
    return;
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    document.activeElement.click();
    return;
  } else {
    return;
  }

  event.preventDefault();
  options[nextIndex]?.focus();
});

sendDeviceDropdown.addEventListener('focusout', (event) => {
  if (!sendDeviceDropdown.contains(event.relatedTarget)) {
    closeSendDeviceDropdown();
  }
});

document.addEventListener('click', (event) => {
  if (!sendDeviceDropdown.contains(event.target)) {
    closeSendDeviceDropdown();
  }
});

syncSendDeviceDropdown();

function renderPhoneColumnOptions(sheet) {
  phoneColumnSelect.replaceChildren();
  const promptOption = document.createElement('option');
  promptOption.value = '';
  promptOption.textContent = sheet ? 'Choose a phone-number column' : 'Choose a sheet first';
  phoneColumnSelect.append(promptOption);
  if (sheet) {
    let suggestedHeader = '';
    for (const header of sheet.headers) {
      const option = document.createElement('option');
      option.value = header;
      option.textContent = header;
      phoneColumnSelect.append(option);
      if (!suggestedHeader && /phone|mobile|telephone|cell/i.test(header)) {
        suggestedHeader = header;
      }
    }
    phoneColumnSelect.value = suggestedHeader;
  }
  updateCampaignAvailability();
}

function renderTemplatePreview() {
  const sheet = selectedSheet();
  if (!sheet || sheet.sample.length === 0 || !templateEditor.value) {
    templatePreviewElement.textContent = !spreadsheetSelect.value
      ? 'Select a spreadsheet to preview the message.'
      : activeSheets.length > 1 && !sheet
      ? 'Choose a sheet number to preview the message.'
      : !templateEditor.value
      ? 'Enter a message to preview it.'
      : 'No sample data row is available for this sheet.';
    updateCampaignAvailability();
    return;
  }

  let preview = templateEditor.value;
  for (const { header, value } of sheet.sample) {
    preview = preview.split(`{${header}}`).join(value);
  }
  templatePreviewElement.textContent = preview;
  updateCampaignAvailability();
}

function renderTemplateFields(sheet) {
  templateFieldsElement.replaceChildren();
  if (!sheet || sheet.headers.length === 0) {
    const message = document.createElement('p');
    message.className = 'muted';
    message.textContent = !spreadsheetSelect.value
      ? 'Select a spreadsheet to load its headers.'
      : activeSheets.length > 1 && !sheet
      ? 'Choose a sheet number to load its headers.'
      : 'No column headers were found on this sheet.';
    templateFieldsElement.append(message);
    renderPhoneColumnOptions(sheet);
    renderTemplatePreview();
    return;
  }

  for (const header of sheet.headers) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'field-chip';
    button.textContent = header;
    button.title = `Insert {${header}}`;
    button.addEventListener('click', () => {
      const start = templateEditor.selectionStart;
      const end = templateEditor.selectionEnd;
      const placeholder = `{${header}}`;
      templateEditor.setRangeText(placeholder, start, end, 'end');
      templateEditor.dispatchEvent(new Event('input', { bubbles: true }));
      templateEditor.focus();
    });
    templateFieldsElement.append(button);
  }
  renderPhoneColumnOptions(sheet);
  renderTemplatePreview();
}

async function loadSpreadsheet(uploadId) {
  activeSheets = [];
  sheetSelect.replaceChildren();
  templateFieldsElement.replaceChildren();
  if (!uploadId) {
    sheetSelectContainer.hidden = true;
    renderTemplateFields(undefined);
    return;
  }

  try {
    const sheets = await window.smsGateway.readSpreadsheetSheets(uploadId);
    if (spreadsheetSelect.value !== uploadId) {
      return;
    }
    activeSheets = sheets;
    sheetSelectContainer.hidden = activeSheets.length < 2;
    if (activeSheets.length > 1) {
      const promptOption = document.createElement('option');
      promptOption.value = '';
      promptOption.textContent = 'Choose a sheet number';
      sheetSelect.append(promptOption);
    }
    for (const sheet of activeSheets) {
      const option = document.createElement('option');
      option.value = String(sheet.number);
      option.textContent = `${sheet.number}. ${sheet.name}`;
      sheetSelect.append(option);
    }
    const selectedSheet = activeSheets.length === 1 ? activeSheets[0] : undefined;
    sheetSelect.value = selectedSheet ? String(selectedSheet.number) : '';
    renderTemplateFields(selectedSheet);
  } catch (error) {
    if (spreadsheetSelect.value === uploadId) {
      templateFieldsElement.textContent = `Could not read spreadsheet headers: ${error.message}`;
    }
  }
}

async function renderActiveSpreadsheetOptions(uploads, selectedUploadId) {
  spreadsheetSelect.replaceChildren();
  const emptyOption = document.createElement('option');
  emptyOption.value = '';
  emptyOption.textContent = 'Choose a spreadsheet';
  spreadsheetSelect.append(emptyOption);
  for (const upload of uploads) {
    const option = document.createElement('option');
    option.value = upload.id;
    option.textContent = upload.name;
    spreadsheetSelect.append(option);
  }
  const selectedId = uploads.some((upload) => upload.id === selectedUploadId) ? selectedUploadId : uploads[0]?.id ?? '';
  spreadsheetSelect.value = selectedId;
  await loadSpreadsheet(selectedId);
}

spreadsheetSelect.addEventListener('change', () => {
  void loadSpreadsheet(spreadsheetSelect.value);
});

sheetSelect.addEventListener('change', () => {
  const sheet = activeSheets.find((candidate) => candidate.number === Number(sheetSelect.value));
  renderTemplateFields(sheet);
});

templateEditor.addEventListener('input', () => {
  window.localStorage.setItem(templateStorageKey, templateEditor.value);
  renderTemplatePreview();
});

phoneColumnSelect.addEventListener('change', updateCampaignAvailability);
sendDeviceSelect.addEventListener('change', updateCampaignAvailability);

queueCampaignButton.addEventListener('click', async () => {
  const sheet = selectedSheet();
  if (
    !sheet ||
    !spreadsheetSelect.value ||
    !phoneColumnSelect.value ||
    !sendDeviceSelect.value ||
    !templateEditor.value.trim()
  ) {
    return;
  }
  queueCampaignButton.disabled = true;
  campaignMessageElement.textContent = '';
  try {
    const result = await window.smsGateway.enqueueSpreadsheetCampaign({
      uploadId: spreadsheetSelect.value,
      sheetNumber: sheet.number,
      phoneHeader: phoneColumnSelect.value,
      template: templateEditor.value,
      deviceId: sendDeviceSelect.value,
    });
    campaignMessageElement.textContent =
      `Queued ${result.enqueued} message${result.enqueued === 1 ? '' : 's'}. ` +
      'Keep the selected phone app open; it will ask before sending.';
    renderQueueStatus(result.queueStatus);
    void refreshQueueStatus();
  } catch (error) {
    campaignMessageElement.textContent = `Could not queue messages: ${error.message}`;
  } finally {
    updateCampaignAvailability();
  }
});

function renderQueueStatus(status) {
  queueStatusElement.textContent =
    `Queue: ${status.queued} waiting, ${status.sending} sending, ` +
    `${status.sent} submitted to Android, ${status.failed} failed.`;
}

function dateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function dateGroupLabel(timestamp) {
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

function groupJobsByDate(jobs, getTimestamp) {
  const groups = new Map();
  const sortedJobs = [...jobs].sort(
    (left, right) => new Date(getTimestamp(right)).getTime() - new Date(getTimestamp(left)).getTime(),
  );
  for (const job of sortedJobs) {
    const timestamp = getTimestamp(job);
    const key = dateKey(new Date(timestamp));
    if (!groups.has(key)) {
      groups.set(key, { label: dateGroupLabel(timestamp), jobs: [] });
    }
    groups.get(key).jobs.push(job);
  }
  return [...groups.values()];
}

function appendDateHeading(list, label) {
  const heading = document.createElement('li');
  heading.className = 'job-date-heading';
  heading.textContent = label;
  list.append(heading);
}

function renderSmsJobs(jobs) {
  latestSmsJobs = jobs;
  const pending = jobs.filter((job) => job.status === 'queued');
  const failed = jobs.filter((job) => job.status === 'failed');
  const sent = jobs.filter((job) => job.status === 'sent');
  pendingJobsElement.replaceChildren();
  failedJobsElement.replaceChildren();
  sentJobsElement.replaceChildren();

  if (pending.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.textContent = 'No messages are waiting.';
    pendingJobsElement.append(empty);
  }
  for (const group of groupJobsByDate(pending, (job) => job.createdAt)) {
    appendDateHeading(pendingJobsElement, group.label);
    for (const job of group.jobs) {
      const item = document.createElement('li');
      item.className = 'job-row';
      const details = document.createElement('span');
      details.className = 'job-details';
      const recipient = document.createElement('strong');
      recipient.textContent = job.phoneNumber;
      const message = document.createElement('span');
      message.textContent = job.message;
      const created = document.createElement('span');
      created.className = 'muted';
      created.textContent = `Queued ${new Date(job.createdAt).toLocaleString()}`;
      details.append(recipient, message, created);
      item.append(details);
      pendingJobsElement.append(item);
    }
  }

  if (failed.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.textContent = 'No failed attempts.';
    failedJobsElement.append(empty);
  }
  for (const group of groupJobsByDate(failed, (job) => job.updatedAt)) {
    appendDateHeading(failedJobsElement, group.label);
    for (const job of group.jobs) {
      const item = document.createElement('li');
      item.className = 'job-row';
      const details = document.createElement('span');
      details.className = 'job-details';
      const recipient = document.createElement('strong');
      recipient.textContent = job.phoneNumber;
      const message = document.createElement('span');
      message.textContent = job.message;
      const reason = document.createElement('span');
      reason.className = 'muted';
      reason.textContent = job.failureReason ?? 'The message could not be submitted.';
      const updated = document.createElement('span');
      updated.className = 'muted';
      updated.textContent = `Failed ${new Date(job.updatedAt).toLocaleString()}`;
      details.append(recipient, message, reason, updated);

      const actions = document.createElement('span');
      actions.className = 'job-actions';
      const retry = document.createElement('button');
      retry.className = 'retry-job-button';
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.setAttribute('aria-label', `Retry message to ${job.phoneNumber}`);
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        try {
          await window.smsGateway.retrySmsJob(job.id);
          await refreshQueueStatus();
        } catch (error) {
          window.alert(`Could not retry message: ${error.message}`);
          retry.disabled = false;
        }
      });
      const remove = document.createElement('button');
      remove.className = 'delete-job-button';
      remove.type = 'button';
      remove.textContent = 'Delete';
      remove.setAttribute('aria-label', `Delete failed message to ${job.phoneNumber}`);
      remove.addEventListener('click', async () => {
        if (!window.confirm(`Permanently delete the failed message to ${job.phoneNumber}?`)) {
          return;
        }
        remove.disabled = true;
        try {
          await window.smsGateway.deleteFailedSmsJob(job.id);
          await refreshQueueStatus();
        } catch (error) {
          window.alert(`Could not delete failed message: ${error.message}`);
          remove.disabled = false;
        }
      });
      actions.append(retry, remove);
      item.append(details, actions);
      failedJobsElement.append(item);
    }
  }

  if (sent.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.textContent = 'No messages have been sent yet.';
    sentJobsElement.append(empty);
  }
  for (const group of groupJobsByDate(sent, (job) => job.sentAt ?? job.updatedAt)) {
    appendDateHeading(sentJobsElement, group.label);
    for (const job of group.jobs) {
      const item = document.createElement('li');
      item.className = 'job-row';
      const details = document.createElement('span');
      details.className = 'job-details';
      const recipient = document.createElement('strong');
      recipient.textContent = job.phoneNumber;
      const message = document.createElement('span');
      message.textContent = job.message;
      const status = document.createElement('span');
      status.className = 'muted';
      status.textContent =
        job.deliveryStatus === 'delivered'
          ? 'Sent · Delivered'
          : job.deliveryStatus === 'not-delivered'
          ? 'Sent · Not delivered'
          : 'Sent';
      const sentAt = document.createElement('span');
      sentAt.className = 'muted';
      sentAt.textContent = `Sent ${new Date(job.sentAt ?? job.updatedAt).toLocaleString()}`;
      details.append(recipient, message, status, sentAt);
      item.append(details);
      sentJobsElement.append(item);
    }
  }
}

let latestSmsJobs = [];

function scheduleDateGroupRefresh() {
  const nextMidnight = new Date();
  nextMidnight.setHours(24, 0, 0, 0);
  window.setTimeout(() => {
    renderSmsJobs(latestSmsJobs);
    scheduleDateGroupRefresh();
  }, Math.max(nextMidnight.getTime() - Date.now(), 1));
}

scheduleDateGroupRefresh();

function refreshQueueStatus() {
  return window.smsGateway
    .getSmsQueueStatus()
    .then((status) => {
      renderQueueStatus(status);
      return window.smsGateway.getSmsJobs();
    })
    .then((jobs) => {
      renderSmsJobs(jobs);
    })
    .catch((error) => {
      queueStatusElement.textContent = `Queue data unavailable: ${error.message}`;
    });
}

refreshQueueButton.addEventListener('click', refreshQueueStatus);

function showPage(page) {
  uploadsPageElement.hidden = page !== 'dashboard';
  spreadsheetsPageElement.hidden = page !== 'spreadsheets';
  connectionPageElement.hidden = page !== 'connections';
  settingsPageElement.hidden = page !== 'settings';

  for (const button of document.querySelectorAll('.nav-item[data-view]')) {
    button.classList.toggle('active', button.dataset.view === page);
  }
}

dashboardNavButton.addEventListener('click', () => {
  showPage('dashboard');
});

spreadsheetsNavButton.addEventListener('click', () => {
  showPage('spreadsheets');
});

openConnectionButton.addEventListener('click', () => {
  showPage('connections');
});

settingsNavButton.addEventListener('click', () => {
  showPage('settings');
});

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
    const details = document.createElement('span');
    details.className = 'upload-details';
    const name = document.createElement('span');
    name.textContent = upload.name;
    const size = document.createElement('span');
    size.className = 'muted';
    size.textContent = `${(upload.size / 1024).toFixed(1)} KB`;
    details.append(name, size);
    const deleteButton = document.createElement('button');
    deleteButton.className = 'delete-upload-button';
    deleteButton.type = 'button';
    deleteButton.textContent = 'Delete';
    deleteButton.setAttribute('aria-label', `Delete ${upload.name}`);
    deleteButton.addEventListener('click', async () => {
      if (!window.confirm(`Permanently delete ${upload.name} from this computer?`)) {
        return;
      }
      deleteButton.disabled = true;
      uploadMessageElement.textContent = '';
      try {
        const remainingUploads = await window.smsGateway.deleteSpreadsheetUpload(upload.id);
        renderUploads(remainingUploads);
        await renderActiveSpreadsheetOptions(remainingUploads, spreadsheetSelect.value);
        uploadMessageElement.textContent = `Permanently deleted ${upload.name} from this computer.`;
      } catch (error) {
        uploadMessageElement.textContent = `Could not delete ${upload.name}: ${error.message}`;
        deleteButton.disabled = false;
      }
    });
    item.append(details, deleteButton);
    uploadsElement.append(item);
  }
}

uploadButton.addEventListener('click', async () => {
  uploadButton.disabled = true;
  uploadMessageElement.textContent = '';
  try {
    const selection = await window.smsGateway.selectSpreadsheet();
    renderUploads(selection.uploads);
    await renderActiveSpreadsheetOptions(selection.uploads, selection.selectedUploadId ?? spreadsheetSelect.value);
    if (selection.uploaded) {
      uploadMessageElement.textContent = 'Spreadsheet saved on this computer.';
      if (activeSheets.length > 1) {
        uploadMessageElement.textContent = 'Spreadsheet saved. Choose the sheet number to load its headers.';
      }
    }
  } catch (error) {
    uploadMessageElement.textContent = `Could not save the spreadsheet: ${error.message}`;
  } finally {
    uploadButton.disabled = false;
  }
});

window.smsGateway
  .listSpreadsheetUploads()
  .then((uploads) => {
    renderUploads(uploads);
    void renderActiveSpreadsheetOptions(uploads);
  })
  .catch((error) => {
    uploadMessageElement.textContent = `Could not load saved spreadsheets: ${error.message}`;
  });

function renderStatus(status) {
  statusElement.classList.remove('error');
  connectionStatusElement.classList.remove('error');
  statusElement.classList.add('ready');
  connectionStatusElement.classList.add('ready');
  statusElement.querySelector('.status-label').textContent = 'Connected';
  connectionStatusElement.querySelector('.connection-status-label').textContent = 'Gateway is running';
  connectionSummaryElement.textContent = 'SMS Gateway is connected via Local API.';
  detailsElement.hidden = false;
  pairingExpiryElement.textContent =
    status.pairingCode === 'expired'
      ? ''
      : `One-time code expires at ${new Date(status.pairingCodeExpiresAt).toLocaleTimeString()}.`;

  addressesElement.replaceChildren();
  pairingQrCodesElement.replaceChildren();
  devicesElement.replaceChildren();
  const selectedDeviceId = sendDeviceSelect.value;
  sendDeviceSelect.replaceChildren();
  const devicePrompt = document.createElement('option');
  devicePrompt.value = '';
  devicePrompt.textContent = status.pairedDevices.length === 0 ? 'No paired phone available' : 'Choose a paired phone';
  sendDeviceSelect.append(devicePrompt);
  for (const device of status.pairedDevices) {
    const option = document.createElement('option');
    option.value = device.id;
    option.textContent = device.name;
    sendDeviceSelect.append(option);
  }
  sendDeviceSelect.value = status.pairedDevices.some((device) => device.id === selectedDeviceId)
    ? selectedDeviceId
    : status.pairedDevices.length === 1
    ? status.pairedDevices[0].id
    : '';
  syncSendDeviceDropdown();
  updateCampaignAvailability();

  if (status.addresses.length === 0) {
    const item = document.createElement('li');
    item.textContent = 'No local network address found. Connect this computer to Wi-Fi or Ethernet.';
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
    refreshQueueStatus();
    return;
  }

  for (const device of status.pairedDevices) {
    const row = document.createElement('div');
    row.className = 'device-row';
    const label = document.createElement('span');
    label.className = 'device-name';
    label.textContent = `${device.name} · Paired on ${new Date(device.pairedAt).toLocaleString()}`;
    label.title = label.textContent;
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
  refreshQueueStatus();
}

window.smsGateway
  .getStatus()
  .then(renderStatus)
  .catch((error) => {
    statusElement.classList.remove('ready');
    statusElement.classList.add('error');
    connectionStatusElement.classList.remove('ready');
    connectionStatusElement.classList.add('error');
    statusElement.querySelector('.status-label').textContent = 'Gateway unavailable';
    connectionStatusElement.querySelector('.connection-status-label').textContent =
      `Gateway failed to start: ${error.message}`;
    connectionSummaryElement.textContent = 'Unable to connect to the local SMS gateway.';
  });

window.setInterval(() => {
  window.smsGateway
    .getStatus()
    .then(renderStatus)
    .catch((error) => {
      statusElement.classList.remove('ready');
      statusElement.classList.add('error');
      connectionStatusElement.classList.remove('ready');
      connectionStatusElement.classList.add('error');
      statusElement.querySelector('.status-label').textContent = 'Gateway unavailable';
      connectionStatusElement.querySelector('.connection-status-label').textContent =
        `Gateway status unavailable: ${error.message}`;
      connectionSummaryElement.textContent = 'Unable to connect to the local SMS gateway.';
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
