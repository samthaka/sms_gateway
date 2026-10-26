const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  deleteSpreadsheetUpload,
  getSpreadsheetUploadPath,
  isSpreadsheetFile,
  listSpreadsheetUploads,
  storeSpreadsheetUpload,
} = require('../dist/upload-storage.js');

test('stores spreadsheets and lists them again from persistent storage', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'sms-gateway-uploads-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const uploadDir = path.join(rootDir, 'uploads');
  const sourcePath = path.join(rootDir, 'Contacts.XLSX');
  await writeFile(sourcePath, 'spreadsheet contents');

  const saved = await storeSpreadsheetUpload(uploadDir, sourcePath);

  assert.equal(saved.name, 'Contacts.XLSX');
  assert.equal(saved.size, Buffer.byteLength('spreadsheet contents'));
  assert.match(saved.id, /^[0-9a-f-]{36}$/);
  assert.equal(
    await readFile(path.join(uploadDir, `${saved.id}--${saved.name}`), 'utf8'),
    'spreadsheet contents',
  );
  assert.deepEqual(await listSpreadsheetUploads(uploadDir), [saved]);
});

test('permanently deletes a saved spreadsheet and rejects unknown IDs', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'sms-gateway-uploads-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const uploadDir = path.join(rootDir, 'uploads');
  const sourcePath = path.join(rootDir, 'Contacts.xlsx');
  await writeFile(sourcePath, 'spreadsheet contents');
  const saved = await storeSpreadsheetUpload(uploadDir, sourcePath);
  const savedPath = await getSpreadsheetUploadPath(uploadDir, saved.id);

  await deleteSpreadsheetUpload(uploadDir, saved.id);

  await assert.rejects(readFile(savedPath), { code: 'ENOENT' });
  assert.deepEqual(await listSpreadsheetUploads(uploadDir), []);
  await assert.rejects(
    deleteSpreadsheetUpload(uploadDir, saved.id),
    /Spreadsheet upload was not found/,
  );
  await assert.rejects(
    deleteSpreadsheetUpload(uploadDir, '../Contacts.xlsx'),
    /Spreadsheet ID is invalid/,
  );
});

test('only accepts .xls and .xlsx extensions and ignores temporary files', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'sms-gateway-uploads-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const uploadDir = path.join(rootDir, 'uploads');
  const invalidFile = path.join(rootDir, 'contacts.csv');
  await writeFile(invalidFile, 'not a spreadsheet');

  assert.equal(isSpreadsheetFile('contacts.xls'), true);
  assert.equal(isSpreadsheetFile('contacts.xlsx'), true);
  assert.equal(isSpreadsheetFile('contacts.csv'), false);
  await assert.rejects(
    storeSpreadsheetUpload(uploadDir, invalidFile),
    /Only \.xls and \.xlsx files can be uploaded/,
  );

  await mkdir(uploadDir, { recursive: true });
  await writeFile(
    path.join(uploadDir, '.e2e456ed-5ed1-4b60-a005-2621715fa36f--broken.xlsx.tmp'),
    'incomplete',
  );
  assert.deepEqual(await listSpreadsheetUploads(uploadDir), []);
});
