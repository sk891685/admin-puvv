import ExcelJS from 'exceljs';
import type { DatasetRowRecord, RemarkRecord, UserRole } from './db.ts';

export interface ParsedSpreadsheet {
  headers: string[];
  rows: Array<Record<string, string>>;
}

const MAX_ROWS = 15000;
const MAX_COLS = 80;

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
  // Trim trailing completely empty columns
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

function parseCsvText(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  // Detect delimiter from first line (comma or tab or semicolon)
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  const tabCount = (firstLine.match(/\t/g) ?? []).length;
  const semiCount = (firstLine.match(/;/g) ?? []).length;
  const delimiter = tabCount > commaCount && tabCount >= semiCount ? '\t' : semiCount > commaCount ? ';' : ',';

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\r') {
      if (clean[i + 1] === '\n') i += 1;
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\n') {
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
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
  // Handle Excel 2003 XML SpreadsheetML (<Row><Cell><Data>...)
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

  // Handle HTML table exported as .xls (very common from utility portals)
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

function matrixToParsed(matrix: string[][]): ParsedSpreadsheet {
  if (matrix.length === 0) {
    throw new Error('फ़ाइल खाली है या कोई वैध पंक्ति नहीं मिली।');
  }
  const headers = normalizeHeaders(matrix[0]);
  if (headers.length === 0) {
    throw new Error('पहली पंक्ति में कोई कॉलम हेडर नहीं मिला।');
  }
  const dataRows: Array<Record<string, string>> = [];
  const limit = Math.min(matrix.length, MAX_ROWS + 1);
  for (let r = 1; r < limit; r += 1) {
    const rawRow = matrix[r];
    const obj: Record<string, string> = {};
    let hasAnyValue = false;
    for (let c = 0; c < headers.length; c += 1) {
      const val = (rawRow[c] ?? '').trim();
      obj[headers[c]] = val;
      if (val !== '') hasAnyValue = true;
    }
    if (hasAnyValue) {
      dataRows.push(obj);
    }
  }
  if (dataRows.length === 0) {
    throw new Error('हेडर पंक्ति के बाद कोई डाटा पंक्ति नहीं मिली।');
  }
  return { headers, rows: dataRows };
}

export async function parseUploadedSpreadsheet(
  buffer: Buffer,
  fileName: string
): Promise<ParsedSpreadsheet> {
  const lower = fileName.toLowerCase();
  const isZipSignature =
    buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
  const isOleBinaryXls =
    buffer.length >= 8 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0;

  if (lower.endsWith('.csv')) {
    const text = buffer.toString('utf8');
    return matrixToParsed(parseCsvText(text));
  }

  if (lower.endsWith('.xlsx') || isZipSignature) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) {
      throw new Error('Excel फ़ाइल में कोई वर्कशीट नहीं मिली।');
    }
    const matrix: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const rowValues: string[] = [];
      const colCount = Math.min(row.cellCount, MAX_COLS);
      for (let c = 1; c <= colCount; c += 1) {
        rowValues.push(cellValueToString(row.getCell(c).value));
      }
      if (rowValues.some((v) => v !== '')) {
        matrix.push(rowValues);
      }
    });
    return matrixToParsed(matrix);
  }

  if (lower.endsWith('.xls')) {
    if (!isOleBinaryXls) {
      // Many portal .xls exports are SpreadsheetML XML, HTML tables, or TSV/CSV text
      const text = buffer.toString('utf8');
      const xmlOrHtml = parseHtmlOrXmlXls(text);
      if (xmlOrHtml) {
        return matrixToParsed(xmlOrHtml);
      }
      return matrixToParsed(parseCsvText(text));
    }
    throw new Error(
      'यह पुराना बाइनरी .xls (Excel 97-2003) फ़ॉर्मेट है। कृपया इसे Excel में खोलकर .xlsx या .csv फ़ॉर्मेट में Save As करके अपलोड करें।'
    );
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

export async function buildExportWorkbookBuffer(params: {
  headers: string[];
  rows: DatasetRowRecord[];
  remarks: RemarkRecord[];
}): Promise<Buffer> {
  const { headers, rows, remarks } = params;
  const remarksByRow = new Map<number, RemarkRecord[]>();
  for (const r of remarks) {
    const list = remarksByRow.get(r.rowId) ?? [];
    list.push(r);
    remarksByRow.set(r.rowId, list);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'डाटा रिमार्क पोर्टल';
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

  const headerRow = sheet.addRow(exportHeaders);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1E3A8A' },
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  headerRow.height = 28;

  for (const row of rows) {
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
  }

  // Set readable column widths
  exportHeaders.forEach((h, idx) => {
    const col = sheet.getColumn(idx + 1);
    if (idx === exportHeaders.length - 1) {
      col.width = 48;
    } else if (idx >= headers.length) {
      col.width = 24;
    } else {
      col.width = Math.max(15, Math.min(30, h.length + 6));
    }
  });

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: exportHeaders.length },
  };

  const arrayBuf = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuf);
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
