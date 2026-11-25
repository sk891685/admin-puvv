import ExcelJS from 'exceljs';
import fs from 'node:fs';
import type { Writable } from 'node:stream';
import {
  abortStagedDataset,
  beginStagedDataset,
  finalizeStagedDataset,
  insertDatasetRowsBatch,
} from './db.ts';
import type { DatasetInfo, DatasetRowRecord, RemarkRecord, SafeUser, UserRole } from './db.ts';

export interface ParsedSpreadsheet {
  headers: string[];
  rows: Array<Record<string, string>>;
}

const MAX_COLS = 100;
const BATCH_SIZE = 1000;

const ROLE_LABELS_HI: Record<UserRole, string> = {
  admin: 'Admin',
  je: 'JE',
  supervisor: 'Supervisor',
  lineman: 'Lineman',
};

function sanitizeFormulaCell(value: string): string {
  if (!value) return '';
  const first = value[0];
  if (first === '=' || first === '+' || first === '-' || first === '@' || first === '\t' || first === '\r') {
    return `'${value}`;
  }
  return value;
}

function cellValueToString(val: ExcelJS.CellValue): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (val instanceof Date) {
    return val.toLocaleDateString('en-IN');
  }
  if (typeof val === 'object') {
    if ('text' in val && typeof val.text === 'string') return val.text.trim();
    if ('richText' in val && Array.isArray(val.richText)) {
      return val.richText.map((part) => part.text ?? '').join('').trim();
    }
    if ('result' in val && val.result !== undefined && val.result !== null) {
      return cellValueToString(val.result as ExcelJS.CellValue);
    }
    if ('hyperlink' in val && typeof val.hyperlink === 'string') {
      return ('text' in val && typeof val.text === 'string' ? val.text : val.hyperlink).trim();
    }
  }
  return String(val).trim();
}

function normalizeHeaders(rawHeaders: string[]): string[] {
  const trimmed = rawHeaders.slice(0, MAX_COLS);
  while (trimmed.length > 0 && !trimmed[trimmed.length - 1]) {
    trimmed.pop();
  }
  const seen = new Map<string, number>();
  return trimmed.map((h, idx) => {
    const base = h.trim() || `कॉलम ${idx + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base} (${count + 1})`;
  });
}

function detectDelimiter(sampleLine: string): string {
  const commaCount = (sampleLine.match(/,/g) ?? []).length;
  const tabCount = (sampleLine.match(/\t/g) ?? []).length;
  const semiCount = (sampleLine.match(/;/g) ?? []).length;
  return tabCount > commaCount && tabCount >= semiCount ? '\t' : semiCount > commaCount ? ';' : ',';
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .trim();
}

function parseHtmlOrXmlXls(text: string): string[][] | null {
  if (/<Row[\s>]/i.test(text) && /<Data[\s>]/i.test(text)) {
    const rowMatches = text.match(/<Row\b[^>]*>[\s\S]*?<\/Row>/gi);
    if (!rowMatches) return null;
    const matrix: string[][] = [];
    for (const rowXml of rowMatches) {
      const cells: string[] = [];
      const cellMatches = rowXml.match(/<Cell\b[^>]*>[\s\S]*?<\/Cell>/gi) ?? [];
      for (const cellXml of cellMatches) {
        const indexMatch = cellXml.match(/ss:Index="(\d+)"/i);
        if (indexMatch) {
          const targetIdx = Number(indexMatch[1]) - 1;
          while (cells.length < targetIdx) cells.push('');
        }
        const dataMatch = cellXml.match(/<Data\b[^>]*>([\s\S]*?)<\/Data>/i);
        cells.push(dataMatch ? decodeHtmlEntities(dataMatch[1]) : '');
      }
      if (cells.some((c) => c !== '')) matrix.push(cells);
    }
    return matrix.length > 0 ? matrix : null;
  }

  if (/<tr[\s>]/i.test(text) && /<t[hd][\s>]/i.test(text)) {
    const rowMatches = text.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi);
    if (!rowMatches) return null;
    const matrix: string[][] = [];
    for (const rowHtml of rowMatches) {
      const cellMatches = rowHtml.match(/<t[hd]\b[^>]*>[\s\S]*?<\/t[hd]>/gi) ?? [];
      const cells = cellMatches.map((cellHtml) =>
        decodeHtmlEntities(cellHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '))
      );
      if (cells.some((c) => c !== '')) matrix.push(cells);
    }
    return matrix.length > 0 ? matrix : null;
  }

  return null;
}

/**
 * Streams a CSV/TSV file from disk without loading it into memory,
 * inserting rows in batches of 1,000 inside SQLite transactions.
 */
async function streamImportCsvFromFile(
  filePath: string,
  fileName: string,
  uploadedBy: SafeUser
): Promise<DatasetInfo> {
  // Peek first 8 KB to detect delimiter
  const fh = await fs.promises.open(filePath, 'r');
  let delimiter = ',';
  try {
    const peekBuf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(peekBuf, 0, 8192, 0);
    const firstLine = peekBuf
      .subarray(0, bytesRead)
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/, 1)[0] ?? '';
    delimiter = detectDelimiter(firstLine);
  } finally {
    await fh.close();
  }

  let datasetId: number | null = null;
  let headers: string[] = [];
  let totalRows = 0;
  let batch: Array<Record<string, string>> = [];

  let currentRow: string[] = [];
  let field = '';
  let inQuotes = false;
  let pendingQuote = false;
  let isFirstChunk = true;

  const flushBatch = () => {
    if (datasetId === null || batch.length === 0) return;
    const startIdx = totalRows - batch.length + 1;
    insertDatasetRowsBatch(datasetId, startIdx, headers, batch);
    batch = [];
  };

  const commitRow = (cells: string[]) => {
    if (!cells.some((c) => c.trim() !== '')) return;
    if (datasetId === null) {
      headers = normalizeHeaders(cells);
      if (headers.length === 0) {
        throw new Error('पहली पंक्ति में कोई कॉलम हेडर नहीं मिला।');
      }
      datasetId = beginStagedDataset(fileName, headers, uploadedBy);
      return;
    }

    const obj: Record<string, string> = {};
    let hasValue = false;
    for (let c = 0; c < headers.length; c += 1) {
      const val = (cells[c] ?? '').trim();
      obj[headers[c]] = val;
      if (val !== '') hasValue = true;
    }
    if (!hasValue) return;
    totalRows += 1;
    batch.push(obj);
    if (batch.length >= BATCH_SIZE) {
      flushBatch();
    }
  };

  try {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 256 * 1024 });
    for await (const rawChunk of stream) {
      const chunk = isFirstChunk ? (rawChunk as string).replace(/^\uFEFF/, '') : (rawChunk as string);
      isFirstChunk = false;

      for (let i = 0; i < chunk.length; i += 1) {
        const ch = chunk[i];

        if (pendingQuote) {
          pendingQuote = false;
          if (ch === '"') {
            field += '"';
            continue;
          }
          inQuotes = false;
          // fall through to process current ch outside quotes
        }

        if (inQuotes) {
          if (ch === '"') {
            pendingQuote = true;
          } else {
            field += ch;
          }
        } else if (ch === '"') {
          inQuotes = true;
        } else if (ch === delimiter) {
          currentRow.push(field.trim());
          field = '';
        } else if (ch === '\r') {
          currentRow.push(field.trim());
          commitRow(currentRow);
          currentRow = [];
          field = '';
        } else if (ch === '\n') {
          if (field.length > 0 || currentRow.length > 0) {
            currentRow.push(field.trim());
            commitRow(currentRow);
            currentRow = [];
            field = '';
          }
        } else {
          field += ch;
        }
      }
    }

    if (field.length > 0 || currentRow.length > 0) {
      currentRow.push(field.trim());
      commitRow(currentRow);
    }

    flushBatch();

    if (datasetId === null || totalRows === 0) {
      if (datasetId !== null) abortStagedDataset(datasetId);
      throw new Error('हेडर पंक्ति के बाद कोई डाटा पंक्ति नहीं मिली।');
    }

    return finalizeStagedDataset(datasetId, totalRows);
  } catch (err) {
    if (datasetId !== null) abortStagedDataset(datasetId);
    throw err;
  }
}

/**
 * Streams an .xlsx file row-by-row from disk using ExcelJS WorkbookReader
 * so multi-GB spreadsheets import cleanly without loading into RAM.
 */
async function streamImportXlsxFromFile(
  filePath: string,
  fileName: string,
  uploadedBy: SafeUser
): Promise<DatasetInfo> {
  let datasetId: number | null = null;
  let headers: string[] = [];
  let totalRows = 0;
  let batch: Array<Record<string, string>> = [];

  const flushBatch = () => {
    if (datasetId === null || batch.length === 0) return;
    const startIdx = totalRows - batch.length + 1;
    insertDatasetRowsBatch(datasetId, startIdx, headers, batch);
    batch = [];
  };

  try {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
      entries: 'emit',
      worksheets: 'emit',
      sharedStrings: 'cache',
      hyperlinks: 'ignore',
      styles: 'ignore',
    });

    let processedFirstSheet = false;

    for await (const worksheetReader of reader) {
      if (processedFirstSheet) break;
      processedFirstSheet = true;

      for await (const row of worksheetReader) {
        const colCount = Math.min(row.cellCount, MAX_COLS);
        const cells: string[] = [];
        for (let c = 1; c <= colCount; c += 1) {
          cells.push(cellValueToString(row.getCell(c).value));
        }
        if (!cells.some((v) => v !== '')) continue;

        if (datasetId === null) {
          headers = normalizeHeaders(cells);
          if (headers.length === 0) {
            throw new Error('पहली पंक्ति में कोई कॉलम हेडर नहीं मिला।');
          }
          datasetId = beginStagedDataset(fileName, headers, uploadedBy);
          continue;
        }

        const obj: Record<string, string> = {};
        let hasValue = false;
        for (let c = 0; c < headers.length; c += 1) {
          const val = cells[c] ?? '';
          obj[headers[c]] = val;
          if (val !== '') hasValue = true;
        }
        if (!hasValue) continue;

        totalRows += 1;
        batch.push(obj);
        if (batch.length >= BATCH_SIZE) {
          flushBatch();
        }
      }
    }

    flushBatch();

    if (datasetId === null || totalRows === 0) {
      if (datasetId !== null) abortStagedDataset(datasetId);
      throw new Error('Excel फ़ाइल में हेडर के बाद कोई डाटा पंक्ति नहीं मिली।');
    }

    return finalizeStagedDataset(datasetId, totalRows);
  } catch (err) {
    if (datasetId !== null) abortStagedDataset(datasetId);
    throw err;
  }
}

export async function streamImportSpreadsheetFromFile(
  filePath: string,
  fileName: string,
  uploadedBy: SafeUser
): Promise<DatasetInfo> {
  const lower = fileName.toLowerCase();

  // Read magic header bytes from disk
  const fh = await fs.promises.open(filePath, 'r');
  const sig = Buffer.alloc(16);
  let readLen = 0;
  try {
    const res = await fh.read(sig, 0, 16, 0);
    readLen = res.bytesRead;
  } finally {
    await fh.close();
  }

  if (readLen === 0) {
    throw new Error('अपलोड की गई फ़ाइल खाली है।');
  }

  const isZipSignature =
    readLen >= 4 && sig[0] === 0x50 && sig[1] === 0x4b && sig[2] === 0x03 && sig[3] === 0x04;
  const isOleBinaryXls =
    readLen >= 8 &&
    sig[0] === 0xd0 &&
    sig[1] === 0xcf &&
    sig[2] === 0x11 &&
    sig[3] === 0xe0;

  if (lower.endsWith('.csv')) {
    return streamImportCsvFromFile(filePath, fileName, uploadedBy);
  }

  if (lower.endsWith('.xlsx') || isZipSignature) {
    return streamImportXlsxFromFile(filePath, fileName, uploadedBy);
  }

  if (lower.endsWith('.xls')) {
    if (isOleBinaryXls) {
      throw new Error(
        'यह पुराना बाइनरी .xls (Excel 97-2003) फ़ॉर्मेट है। कृपया इसे Excel में खोलकर .xlsx या .csv फ़ॉर्मेट में Save As करके अपलोड करें।'
      );
    }
    const stat = await fs.promises.stat(filePath);
    // Check if XML/HTML table .xls (reasonable text size) or TSV/CSV text
    if (stat.size <= 50 * 1024 * 1024) {
      const text = await fs.promises.readFile(filePath, 'utf8');
      const matrix = parseHtmlOrXmlXls(text);
      if (matrix && matrix.length > 1) {
        const headers = normalizeHeaders(matrix[0]);
        const datasetId = beginStagedDataset(fileName, headers, uploadedBy);
        try {
          let totalRows = 0;
          let batch: Array<Record<string, string>> = [];
          for (let r = 1; r < matrix.length; r += 1) {
            const rawRow = matrix[r];
            const obj: Record<string, string> = {};
            let hasVal = false;
            for (let c = 0; c < headers.length; c += 1) {
              const val = (rawRow[c] ?? '').trim();
              obj[headers[c]] = val;
              if (val !== '') hasVal = true;
            }
            if (!hasVal) continue;
            totalRows += 1;
            batch.push(obj);
            if (batch.length >= BATCH_SIZE) {
              insertDatasetRowsBatch(datasetId, totalRows - batch.length + 1, headers, batch);
              batch = [];
            }
          }
          if (batch.length > 0) {
            insertDatasetRowsBatch(datasetId, totalRows - batch.length + 1, headers, batch);
          }
          if (totalRows === 0) {
            abortStagedDataset(datasetId);
            throw new Error('हेडर पंक्ति के बाद कोई डाटा पंक्ति नहीं मिली।');
          }
          return finalizeStagedDataset(datasetId, totalRows);
        } catch (err) {
          abortStagedDataset(datasetId);
          throw err;
        }
      }
    }
    return streamImportCsvFromFile(filePath, fileName, uploadedBy);
  }

  throw new Error('कृपया केवल .xlsx, .xls या .csv फ़ाइल ही अपलोड करें।');
}

function formatDateTimeIST(isoString: string): string {
  try {
    return new Intl.DateTimeFormat('hi-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(isoString));
  } catch {
    return isoString;
  }
}

/**
 * Streams an .xlsx export directly to an HTTP response stream so even very large
 * datasets with remarks export cleanly with low memory usage.
 */
export async function streamExportWorkbookToResponse(params: {
  stream: Writable;
  headers: string[];
  rowsIterator: Iterable<DatasetRowRecord>;
  remarksByRow: Map<number, RemarkRecord[]>;
}): Promise<void> {
  const { stream, headers, rowsIterator, remarksByRow } = params;

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream,
    useStyles: true,
    useSharedStrings: false,
  });
  workbook.creator = 'PuVVNL डाटा रिमार्क पोर्टल';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('डाटा और रिमार्क', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  const exportHeaders = [
    ...headers,
    'कुल रिमार्क',
    'अंतिम रिमार्क',
    'रिमार्क कर्ता व रोल',
    'रिमार्क तारीख-समय',
    'सभी रिमार्क इतिहास',
  ];

  sheet.columns = exportHeaders.map((h, idx) => ({
    header: h,
    key: `c_${idx}`,
    width:
      idx === exportHeaders.length - 1
        ? 48
        : idx >= headers.length
        ? 24
        : Math.max(15, Math.min(30, h.length + 6)),
  }));

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1E3A8A' },
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  headerRow.height = 28;
  headerRow.commit();

  for (const row of rowsIterator) {
    const rowRemarks = remarksByRow.get(row.id) ?? [];
    const latest = rowRemarks[0];
    const historyText = rowRemarks
      .map(
        (rem) =>
          `[${formatDateTimeIST(rem.createdAt)}] ${rem.userName} (${ROLE_LABELS_HI[rem.userRole]}): ${rem.comment}`
      )
      .join('\n');

    const values = [
      ...headers.map((h) => sanitizeFormulaCell(row.data[h] ?? '')),
      rowRemarks.length,
      latest ? sanitizeFormulaCell(latest.comment) : '',
      latest ? `${latest.userName} (${ROLE_LABELS_HI[latest.userRole]})` : '',
      latest ? formatDateTimeIST(latest.updatedAt) : '',
      historyText ? sanitizeFormulaCell(historyText) : '',
    ];

    const added = sheet.addRow(values);
    added.alignment = { vertical: 'top', wrapText: true };
    added.commit();
  }

  await sheet.commit();
  await workbook.commit();
}

export const SAMPLE_UTILITY_DATA: ParsedSpreadsheet = {
  headers: [
    'Consumer No',
    'उपभोक्ता नाम',
    'फीडर',
    'ट्रांसफार्मर',
    'मोबाइल नंबर',
    'गाँव / क्षेत्र',
    'बकाया राशि (₹)',
    'कनेक्शन स्थिति',
  ],
  rows: [
    {
      'Consumer No': 'CN-40218101',
      'उपभोक्ता नाम': 'रामेश्वर प्रसाद वर्मा',
      'फीडर': 'सदर टाउन 11kV',
      'ट्रांसफार्मर': 'DT-104 (100 KVA)',
      'मोबाइल नंबर': '9839104421',
      'गाँव / क्षेत्र': 'शिवपुर कॉलोनी',
      'बकाया राशि (₹)': '14850',
      'कनेक्शन स्थिति': 'चालू',
    },
    {
      'Consumer No': 'CN-40218102',
      'उपभोक्ता नाम': 'सुनीता देवी यादव',
      'फीडर': 'सदर टाउन 11kV',
      'ट्रांसफार्मर': 'DT-104 (100 KVA)',
      'मोबाइल नंबर': '9415228910',
      'गाँव / क्षेत्र': 'शिवपुर कॉलोनी',
      'बकाया राशि (₹)': '3240',
      'कनेक्शन स्थिति': 'चालू',
    },
    {
      'Consumer No': 'CN-40218103',
      'उपभोक्ता नाम': 'मोहम्मद इरफ़ान अंसारी',
      'फीडर': 'मंडी बाजार 11kV',
      'ट्रांसफार्मर': 'DT-209 (250 KVA)',
      'मोबाइल नंबर': '9918765432',
      'गाँव / क्षेत्र': 'नया बाजार रोड',
      'बकाया राशि (₹)': '28400',
      'कनेक्शन स्थिति': 'डिस्कनेक्शन सूची',
    },
    {
      'Consumer No': 'CN-40218104',
      'उपभोक्ता नाम': 'राजेंद्र कुमार मौर्य',
      'फीडर': 'मंडी बाजार 11kV',
      'ट्रांसफार्मर': 'DT-209 (250 KVA)',
      'मोबाइल नंबर': '9794112208',
      'गाँव / क्षेत्र': 'अनाज मंडी पश्चिम',
      'बकाया राशि (₹)': '9600',
      'कनेक्शन स्थिति': 'चालू',
    },
    {
      'Consumer No': 'CN-40218105',
      'उपभोक्ता नाम': 'कमला शंकर त्रिपाठी',
      'फीडर': 'ग्रामीण उत्तर 11kV',
      'ट्रांसफार्मर': 'DT-312 (63 KVA)',
      'मोबाइल नंबर': '9450678812',
      'गाँव / क्षेत्र': 'रामपुर कलां',
      'बकाया राशि (₹)': '18920',
      'कनेक्शन स्थिति': 'मीटर खराब',
    },
    {
      'Consumer No': 'CN-40218106',
      'उपभोक्ता नाम': 'अनीता सिंह चौहान',
      'फीडर': 'ग्रामीण उत्तर 11kV',
      'ट्रांसफार्मर': 'DT-312 (63 KVA)',
      'मोबाइल नंबर': '9621445590',
      'गाँव / क्षेत्र': 'रामपुर कलां',
      'बकाया राशि (₹)': '1150',
      'कनेक्शन स्थिति': 'चालू',
    },
    {
      'Consumer No': 'CN-40218107',
      'उपभोक्ता नाम': 'हरीश चंद्र गुप्ता',
      'फीडर': 'औद्योगिक फीडर 11kV',
      'ट्रांसफार्मर': 'DT-405 (400 KVA)',
      'मोबाइल नंबर': '9838990041',
      'गाँव / क्षेत्र': 'इंडस्ट्रियल एरिया फेज-1',
      'बकाया राशि (₹)': '64200',
      'कनेक्शन स्थिति': 'डिस्कनेक्शन सूची',
    },
    {
      'Consumer No': 'CN-40218108',
      'उपभोक्ता नाम': 'दिनेश कुमार पाल',
      'फीडर': 'औद्योगिक फीडर 11kV',
      'ट्रांसफार्मर': 'DT-405 (400 KVA)',
      'मोबाइल नंबर': '9125334477',
      'गाँव / क्षेत्र': 'इंडस्ट्रियल एरिया फेज-1',
      'बकाया राशि (₹)': '12400',
      'कनेक्शन स्थिति': 'चालू',
    },
    {
      'Consumer No': 'CN-40218109',
      'उपभोक्ता नाम': 'शांति देवी निषाद',
      'फीडर': 'सदर टाउन 11kV',
      'ट्रांसफार्मर': 'DT-108 (100 KVA)',
      'मोबाइल नंबर': '9451882233',
      'गाँव / क्षेत्र': 'गांधी नगर वार्ड-4',
      'बकाया राशि (₹)': '7350',
      'कनेक्शन स्थिति': 'मीटर जांच लंबित',
    },
    {
      'Consumer No': 'CN-40218110',
      'उपभोक्ता नाम': 'अशोक कुमार मिश्रा',
      'फीडर': 'मंडी बाजार 11kV',
      'ट्रांसफार्मर': 'DT-214 (100 KVA)',
      'मोबाइल नंबर': '9793221199',
      'गाँव / क्षेत्र': 'स्टेशन रोड',
      'बकाया राशि (₹)': '21750',
      'कनेक्शन स्थिति': 'डिस्कनेक्शन सूची',
    },
  ],
};

export async function buildSampleTemplateBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('उपभोक्ता सूची');
  const headerRow = sheet.addRow(SAMPLE_UTILITY_DATA.headers);
  headerRow.font = { bold: true };
  for (const row of SAMPLE_UTILITY_DATA.rows) {
    sheet.addRow(SAMPLE_UTILITY_DATA.headers.map((h) => row[h] ?? ''));
  }
  SAMPLE_UTILITY_DATA.headers.forEach((h, idx) => {
    sheet.getColumn(idx + 1).width = Math.max(16, h.length + 6);
  });
  const arr = await workbook.xlsx.writeBuffer();
  return Buffer.from(arr);
}
