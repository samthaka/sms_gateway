import * as XLSX from '@e965/xlsx';
import { getSpreadsheetUploadPath } from './upload-storage';

export interface SpreadsheetSheet {
  number: number;
  name: string;
  headers: string[];
  sample: Array<{ header: string; value: string }>;
}

export interface SpreadsheetDataRow {
  rowNumber: number;
  values: Array<{ header: string; value: string }>;
}

function getRows(worksheet: XLSX.WorkSheet): string[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    raw: false,
    defval: '',
  }).map((row) => row.map((cell) => String(cell ?? '')));
}

export async function readSpreadsheetSheets(
  uploadDir: string,
  uploadId: string,
): Promise<SpreadsheetSheet[]> {
  const workbookPath = await getSpreadsheetUploadPath(uploadDir, uploadId);
  const workbook = XLSX.readFile(workbookPath, { cellDates: true });

  return workbook.SheetNames.map((name, index) => {
    const worksheet = workbook.Sheets[name];
    const rows = getRows(worksheet);
    const headers = (rows[0] ?? []).map((cell) => cell.trim());
    const sampleRow = rows[1] ?? [];
    const columns = headers.flatMap((header, column) =>
      header
        ? [{ header, value: String(sampleRow[column] ?? '') }]
        : [],
    );

    return {
      number: index + 1,
      name,
      headers: columns.map((column) => column.header),
      sample: columns,
    };
  });
}

export async function readSpreadsheetRows(
  uploadDir: string,
  uploadId: string,
  sheetNumber: number,
): Promise<SpreadsheetDataRow[]> {
  if (!Number.isInteger(sheetNumber) || sheetNumber < 1) {
    throw new TypeError('Sheet number must be a positive integer');
  }
  const workbookPath = await getSpreadsheetUploadPath(uploadDir, uploadId);
  const workbook = XLSX.readFile(workbookPath, { cellDates: true });
  const sheetName = workbook.SheetNames[sheetNumber - 1];
  if (!sheetName) {
    throw new RangeError('Sheet number was not found');
  }
  const rows = getRows(workbook.Sheets[sheetName]);
  const headers = (rows[0] ?? []).map((cell) => cell.trim());
  return rows.slice(1).flatMap((row, index) => {
    const values = headers.flatMap((header, column) =>
      header ? [{ header, value: row[column] ?? '' }] : [],
    );
    if (values.every(({ value }) => value.trim() === '')) {
      return [];
    }
    return [{ rowNumber: index + 2, values }];
  });
}
