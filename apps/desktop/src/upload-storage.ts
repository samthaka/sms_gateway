import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

const SPREADSHEET_EXTENSIONS = new Set(['.xls', '.xlsx']);
const UPLOAD_FILENAME_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})--(.+)$/i;

export interface SpreadsheetUpload {
  id: string;
  name: string;
  size: number;
}

export function isSpreadsheetFile(filePath: string): boolean {
  return SPREADSHEET_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function storeSpreadsheetUpload(
  uploadDir: string,
  sourcePath: string,
): Promise<SpreadsheetUpload> {
  if (!isSpreadsheetFile(sourcePath)) {
    throw new TypeError('Only .xls and .xlsx files can be uploaded');
  }

  const sourceStats = await stat(sourcePath);
  if (!sourceStats.isFile()) {
    throw new TypeError('The selected spreadsheet must be a regular file');
  }

  const name = path.basename(sourcePath);
  const id = randomUUID();
  const destinationName = `${id}--${name}`;
  const temporaryPath = path.join(uploadDir, `.${destinationName}.tmp`);
  const destinationPath = path.join(uploadDir, destinationName);
  await mkdir(uploadDir, { recursive: true, mode: 0o700 });
  await chmod(uploadDir, 0o700);

  try {
    await copyFile(sourcePath, temporaryPath);
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, destinationPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }

  const savedStats = await stat(destinationPath);
  return { id, name, size: savedStats.size };
}

export async function listSpreadsheetUploads(
  uploadDir: string,
): Promise<SpreadsheetUpload[]> {
  await mkdir(uploadDir, { recursive: true, mode: 0o700 });
  await chmod(uploadDir, 0o700);
  const entries = await readdir(uploadDir, { withFileTypes: true });
  const uploads = await Promise.all(
    entries.flatMap((entry) => {
      const match = UPLOAD_FILENAME_PATTERN.exec(entry.name);
      if (!entry.isFile() || !match || !isSpreadsheetFile(match[2])) {
        return [];
      }
      return [
        stat(path.join(uploadDir, entry.name)).then((fileStats) => ({
          id: match[1],
          name: match[2],
          size: fileStats.size,
        })),
      ];
    }),
  );
  return uploads.sort((left, right) => left.name.localeCompare(right.name));
}

export async function getSpreadsheetUploadPath(
  uploadDir: string,
  uploadId: string,
): Promise<string> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      uploadId,
    )
  ) {
    throw new TypeError('Spreadsheet ID is invalid');
  }

  const upload = (await listSpreadsheetUploads(uploadDir))
    .find((entry) => entry.id === uploadId);
  if (!upload) {
    throw new Error('Spreadsheet upload was not found');
  }
  return path.join(uploadDir, `${upload.id}--${upload.name}`);
}

export async function deleteSpreadsheetUpload(
  uploadDir: string,
  uploadId: string,
): Promise<void> {
  const uploadPath = await getSpreadsheetUploadPath(uploadDir, uploadId);
  await unlink(uploadPath);
}
