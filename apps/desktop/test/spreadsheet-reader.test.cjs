const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('@e965/xlsx');
const { storeSpreadsheetUpload } = require('../dist/upload-storage.js');
const {
  readSpreadsheetRows,
  readSpreadsheetSheets,
} = require('../dist/spreadsheet-reader.js');

test('reads numbered sheets, headers, and a sample data row', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'sms-gateway-reader-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const uploadDir = path.join(rootDir, 'uploads');
  const sourcePath = path.join(rootDir, 'contacts.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['Name', 'Phone Number', 'License Plate'],
      ['Samuel Thaka', '+254700000000', 'KBX 136G'],
      ['', '', ''],
      ['Amina Njoroge', '+254711111111', 'KCY 246H'],
    ]),
    'Contacts',
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([['Ignore me']]),
    'Other',
  );
  await writeFile(sourcePath, XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
  }));
  const upload = await storeSpreadsheetUpload(uploadDir, sourcePath);

  assert.deepEqual(await readSpreadsheetSheets(uploadDir, upload.id), [
    {
      number: 1,
      name: 'Contacts',
      headers: ['Name', 'Phone Number', 'License Plate'],
      sample: [
        { header: 'Name', value: 'Samuel Thaka' },
        { header: 'Phone Number', value: '+254700000000' },
        { header: 'License Plate', value: 'KBX 136G' },
      ],
    },
    {
      number: 2,
      name: 'Other',
      headers: ['Ignore me'],
      sample: [{ header: 'Ignore me', value: '' }],
    },
  ]);
  assert.deepEqual(await readSpreadsheetRows(uploadDir, upload.id, 1), [
    {
      rowNumber: 2,
      values: [
        { header: 'Name', value: 'Samuel Thaka' },
        { header: 'Phone Number', value: '+254700000000' },
        { header: 'License Plate', value: 'KBX 136G' },
      ],
    },
    {
      rowNumber: 4,
      values: [
        { header: 'Name', value: 'Amina Njoroge' },
        { header: 'Phone Number', value: '+254711111111' },
        { header: 'License Plate', value: 'KCY 246H' },
      ],
    },
  ]);
});

test('rejects invalid or unknown spreadsheet IDs', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'sms-gateway-reader-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const uploadDir = path.join(rootDir, 'uploads');

  await assert.rejects(
    readSpreadsheetSheets(uploadDir, '../contacts.xlsx'),
    /Spreadsheet ID is invalid/,
  );
  await assert.rejects(
    readSpreadsheetSheets(uploadDir, 'e456ed1e-5ed1-4b60-a005-2621715fa36f'),
    /Spreadsheet upload was not found/,
  );
});

test('reads legacy .xls workbook headers', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'sms-gateway-reader-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const uploadDir = path.join(rootDir, 'uploads');
  const sourcePath = path.join(rootDir, 'contacts.xls');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['Name', 'Phone Number'],
      ['Samuel Thaka', '+254700000000'],
    ]),
    'Contacts',
  );
  await writeFile(sourcePath, XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'biff8',
  }));
  const upload = await storeSpreadsheetUpload(uploadDir, sourcePath);

  assert.deepEqual(await readSpreadsheetSheets(uploadDir, upload.id), [
    {
      number: 1,
      name: 'Contacts',
      headers: ['Name', 'Phone Number'],
      sample: [
        { header: 'Name', value: 'Samuel Thaka' },
        { header: 'Phone Number', value: '+254700000000' },
      ],
    },
  ]);
});
