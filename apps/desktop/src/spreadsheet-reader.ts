import * as XLSX from '@e965/xlsx';
import { getSpreadsheetUploadPath } from './upload-storage';

export interface SpreadsheetSheet {
  number: number;
  name: string;
  headers: string[];
  sample: Array<{ header: string; value: string }>;
}

export async function readSpreadsheetSheets(
  uploadDir: string,
  uploadId: string,
): Promise<SpreadsheetSheet[]> {
  const workbookPath = await getSpreadsheetUploadPath(uploadDir, uploadId);
  const workbook = XLSX.readFile(workbookPath, { cellDates: true });

  return workbook.SheetNames.map((name, index) => {
    const worksheet = workbook.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
      header: 1,
      raw: false,
      defval: '',
    });
    const headers = (rows[0] ?? []).map((cell) => String(cell ?? '').trim());
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
