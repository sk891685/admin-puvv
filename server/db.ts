import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type UserRole = 'admin' | 'je' | 'supervisor' | 'lineman';

export interface DbUser {
  id: number;
  username: string;
  email: string;
  mobile: string;
  full_name: string;
  password_hash: string;
  role: UserRole;
  supervisor_id: number | null;
  created_at: string;
}

export interface SafeUser {
  id: number;
  username: string;
  email: string;
  mobile: string;
  fullName: string;
  role: UserRole;
  supervisorId: number | null;
  supervisorName: string | null;
  createdAt: string;
}

export interface DatasetInfo {
  id: number;
  fileName: string;
  headers: string[];
  rowCount: number;
  uploadedByName: string;
  uploadedAt: string;
}

export interface DatasetRowRecord {
  id: number;
  datasetId: number;
  rowIndex: number;
  data: Record<string, string>;
}

export interface RemarkRecord {
  id: number;
  datasetId: number;
  rowId: number;
  userId: number | null;
  userName: string;
  userRole: UserRole;
  comment: string;
  createdAt: string;
  updatedAt: string;
}

export interface DatasetQueryParams {
  dataset: DatasetInfo;
  user: SafeUser;
  q: string;
  column: string;
  value: string;
  remarkFilter: 'all' | 'with_remarks' | 'without_remarks';
  page: number;
  pageSize: number;
}

export interface DatasetQueryResult {
  rows: DatasetRowRecord[];
  remarksByRow: Record<string, RemarkRecord[]>;
  totalFiltered: number;
  rowsWithRemarksCount: number;
  totalVisibleRemarks: number;
  page: number;
  pageSize: number;
}

const VALID_ROLES = new Set<UserRole>(['admin', 'je', 'supervisor', 'lineman']);

export function isValidRole(value: unknown): value is UserRole {
  return typeof value === 'string' && VALID_ROLES.has(value as UserRole);
}

const dataDir = path.resolve(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.resolve(dataDir, 'portal.db');

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'je', 'supervisor', 'lineman')),
    supervisor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS datasets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT NOT NULL,
    headers_json TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    uploaded_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    uploaded_by_name TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS dataset_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    row_index INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    search_text TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_dataset_rows_dataset_id ON dataset_rows(dataset_id, row_index);

  CREATE TABLE IF NOT EXISTS remarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    row_id INTEGER NOT NULL REFERENCES dataset_rows(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_name TEXT NOT NULL,
    user_role TEXT NOT NULL CHECK(user_role IN ('admin', 'je', 'supervisor', 'lineman')),
    comment TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_remarks_dataset_row ON remarks(dataset_id, row_id);
  CREATE INDEX IF NOT EXISTS idx_remarks_user ON remarks(user_id);

  CREATE TABLE IF NOT EXISTS login_otps (
    challenge_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    otp_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_login_otps_user ON login_otps(user_id);

  CREATE TABLE IF NOT EXISTS login_preauth (
    preauth_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_login_preauth_user ON login_preauth(user_id);
`);

// Safe idempotent migration for email and mobile columns on existing databases
const existingUserCols = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
if (!existingUserCols.some((c) => c.name === 'email')) {
  db.exec("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''");
}
if (!existingUserCols.some((c) => c.name === 'mobile')) {
  db.exec("ALTER TABLE users ADD COLUMN mobile TEXT NOT NULL DEFAULT ''");
}
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
  ON users(lower(email))
  WHERE email IS NOT NULL AND trim(email) != '';
`);

export function isValidEmail(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length < 5 || trimmed.length > 120) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed);
}

export function normalizeMobile(value: string): string | null {
  const digits = value.replace(/[\s\-()]/g, '').replace(/^\+91/, '').replace(/^0(?=\d{10}$)/, '');
  if (/^[6-9]\d{9}$/.test(digits)) return digits;
  const rawPlusDigits = value.replace(/[\s\-()]/g, '').replace(/^\+/, '');
  if (/^\d{10,15}$/.test(rawPlusDigits)) return rawPlusDigits;
  return null;
}

export function deriveUniqueUsername(email: string, preferred?: string): string {
  const baseRaw =
    preferred && preferred.trim()
      ? preferred.trim().toLowerCase()
      : email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const base = (baseRaw.length >= 3 ? baseRaw : `user_${baseRaw || 'acc'}`).slice(0, 26);

  let candidate = base;
  let counter = 1;
  while (
    db.prepare('SELECT 1 FROM users WHERE lower(username) = ?').get(candidate) !== undefined
  ) {
    counter += 1;
    candidate = `${base.slice(0, 24)}_${counter}`;
  }
  return candidate;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const storedKey = Buffer.from(keyHex, 'hex');
  if (derived.length !== storedKey.length) return false;
  return crypto.timingSafeEqual(derived, storedKey);
}

function timingSafeStringCompare(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export function getEnvAdminConfig(): {
  username: string;
  email: string;
  password: string;
} | null {
  const rawPass = process.env.ADMIN_PASSWORD?.trim();
  if (!rawPass) return null;
  const envPass = rawPass.replace(/^["']|["']$/g, '').trim();
  if (
    !envPass ||
    envPass.length < 6 ||
    /^(MY_|YOUR_|CHANGE_ME|PLACEHOLDER|DUMMY|EXAMPLE|NOT_SET)/i.test(envPass) ||
    envPass === 'undefined' ||
    envPass === 'null'
  ) {
    return null;
  }
  const rawUser = process.env.ADMIN_USERNAME?.trim().replace(/^["']|["']$/g, '').trim();
  const envUser =
    rawUser && !/^(MY_|YOUR_|CHANGE_ME|PLACEHOLDER)/i.test(rawUser) ? rawUser.toLowerCase() : 'admin';
  const rawEmail = process.env.ADMIN_EMAIL?.trim().replace(/^["']|["']$/g, '').trim();
  const envEmail = rawEmail && isValidEmail(rawEmail) ? rawEmail.toLowerCase() : '';
  return { username: envUser, email: envEmail, password: envPass };
}

export function countAdmins(): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin'").get() as { cnt: number };
  return row.cnt;
}

export function needsAdminSetup(): boolean {
  return countAdmins() === 0;
}

function mapSafeUser(row: {
  id: number;
  username: string;
  email: string | null;
  mobile: string | null;
  full_name: string;
  role: UserRole;
  supervisor_id: number | null;
  supervisor_name: string | null;
  created_at: string;
}): SafeUser {
  return {
    id: row.id,
    username: row.username,
    email: row.email ?? '',
    mobile: row.mobile ?? '',
    fullName: row.full_name,
    role: row.role,
    supervisorId: row.supervisor_id,
    supervisorName: row.supervisor_name ?? null,
    createdAt: row.created_at,
  };
}

export function getUserById(userId: number): SafeUser | null {
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.email, u.mobile, u.full_name, u.role, u.supervisor_id, s.full_name AS supervisor_name, u.created_at
       FROM users u
       LEFT JOIN users s ON u.supervisor_id = s.id
       WHERE u.id = ?`
    )
    .get(userId) as
    | {
        id: number;
        username: string;
        email: string | null;
        mobile: string | null;
        full_name: string;
        role: UserRole;
        supervisor_id: number | null;
        supervisor_name: string | null;
        created_at: string;
      }
    | undefined;
  return row ? mapSafeUser(row) : null;
}

export function findUserByEmail(emailInput: string): SafeUser | null {
  const normalized = emailInput.trim().toLowerCase();
  if (!normalized || !isValidEmail(normalized)) return null;
  const row = db
    .prepare('SELECT id FROM users WHERE lower(email) = ?')
    .get(normalized) as { id: number } | undefined;
  return row ? getUserById(row.id) : null;
}

export function listUsers(): SafeUser[] {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.email, u.mobile, u.full_name, u.role, u.supervisor_id, s.full_name AS supervisor_name, u.created_at
       FROM users u
       LEFT JOIN users s ON u.supervisor_id = s.id
       ORDER BY
         CASE u.role
           WHEN 'admin' THEN 1
           WHEN 'je' THEN 2
           WHEN 'supervisor' THEN 3
           WHEN 'lineman' THEN 4
         END,
         u.full_name COLLATE NOCASE ASC`
    )
    .all() as Array<{
    id: number;
    username: string;
    email: string | null;
    mobile: string | null;
    full_name: string;
    role: UserRole;
    supervisor_id: number | null;
    supervisor_name: string | null;
    created_at: string;
  }>;
  return rows.map(mapSafeUser);
}

const claimFirstAdminTxn = db.transaction(
  (
    username: string,
    email: string,
    mobile: string,
    fullName: string,
    passwordHash: string
  ): SafeUser => {
    const existingAdmins = db
      .prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin'")
      .get() as { cnt: number };
    if (existingAdmins.cnt > 0) {
      throw new Error('ADMIN_ALREADY_EXISTS');
    }
    const now = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO users (username, email, mobile, full_name, password_hash, role, supervisor_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'admin', NULL, ?)`
      )
      .run(username, email, mobile, fullName, passwordHash, now);
    const created = getUserById(Number(info.lastInsertRowid));
    if (!created) {
      throw new Error('FAILED_TO_CREATE_ADMIN');
    }
    return created;
  }
);

export function claimFirstAdmin(input: {
  username: string;
  email: string;
  mobile: string;
  fullName: string;
  password: string;
}): SafeUser {
  const passwordHash = hashPassword(input.password);
  return claimFirstAdminTxn(
    input.username.trim().toLowerCase(),
    input.email.trim().toLowerCase(),
    input.mobile,
    input.fullName,
    passwordHash
  );
}

export function authenticateUser(identifierInput: string, passwordInput: string): SafeUser | null {
  const normalized = identifierInput.trim().toLowerCase();
  if (!normalized || !passwordInput) return null;

  const envAdmin = getEnvAdminConfig();
  const matchesEnvAdmin =
    envAdmin !== null &&
    (normalized === envAdmin.username || (envAdmin.email !== '' && normalized === envAdmin.email));

  if (envAdmin && matchesEnvAdmin) {
    if (!timingSafeStringCompare(passwordInput, envAdmin.password)) {
      return null;
    }
    const existing = db
      .prepare('SELECT id FROM users WHERE lower(username) = ? OR (email != \'\' AND lower(email) = ?)')
      .get(envAdmin.username, envAdmin.email || envAdmin.username) as { id: number } | undefined;
    if (existing) {
      if (envAdmin.email) {
        db.prepare("UPDATE users SET role = 'admin', email = CASE WHEN trim(email) = '' THEN ? ELSE email END WHERE id = ?").run(
          envAdmin.email,
          existing.id
        );
      } else {
        db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
      }
      return getUserById(existing.id);
    }
    const now = new Date().toISOString();
    const placeholderHash = hashPassword(crypto.randomBytes(24).toString('hex'));
    const info = db
      .prepare(
        `INSERT INTO users (username, email, mobile, full_name, password_hash, role, supervisor_id, created_at)
         VALUES (?, ?, '', ?, ?, 'admin', NULL, ?)`
      )
      .run(envAdmin.username, envAdmin.email, 'मुख्य एडमिन', placeholderHash, now);
    return getUserById(Number(info.lastInsertRowid));
  }

  const row = db
    .prepare(
      `SELECT id, username, email, mobile, full_name, password_hash, role, supervisor_id, created_at
       FROM users
       WHERE (email != '' AND lower(email) = ?) OR lower(username) = ?`
    )
    .get(normalized, normalized) as DbUser | undefined;
  if (!row) return null;
  if (!verifyPassword(passwordInput, row.password_hash)) return null;
  return getUserById(row.id);
}

export function createSession(userId: number): string {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 7);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    tokenHash,
    userId,
    now.toISOString(),
    expires.toISOString()
  );
  return rawToken;
}

export function getUserBySessionToken(rawToken: string): SafeUser | null {
  if (!rawToken || rawToken.length < 32) return null;
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const nowIso = new Date().toISOString();
  const row = db
    .prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
    .get(tokenHash) as { user_id: number; expires_at: string } | undefined;
  if (!row) return null;
  if (row.expires_at < nowIso) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return getUserById(row.user_id);
}

export function revokeSession(rawToken: string): void {
  if (!rawToken) return;
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function createUserAccount(input: {
  username: string;
  email: string;
  mobile: string;
  fullName: string;
  password: string;
  role: UserRole;
  supervisorId: number | null;
}): SafeUser {
  const normalizedUsername = input.username.trim().toLowerCase();
  const normalizedEmail = input.email.trim().toLowerCase();

  const existingUser = db
    .prepare('SELECT id FROM users WHERE lower(username) = ?')
    .get(normalizedUsername) as { id: number } | undefined;
  if (existingUser) {
    throw new Error('USERNAME_TAKEN');
  }

  const existingEmail = db
    .prepare("SELECT id FROM users WHERE email != '' AND lower(email) = ?")
    .get(normalizedEmail) as { id: number } | undefined;
  if (existingEmail) {
    throw new Error('EMAIL_TAKEN');
  }

  let validatedSupervisorId: number | null = null;
  if (input.role === 'lineman' && input.supervisorId !== null) {
    const sup = db
      .prepare("SELECT id FROM users WHERE id = ? AND role = 'supervisor'")
      .get(input.supervisorId) as { id: number } | undefined;
    if (!sup) {
      throw new Error('INVALID_SUPERVISOR');
    }
    validatedSupervisorId = sup.id;
  }

  const now = new Date().toISOString();
  const passwordHash = hashPassword(input.password);
  const info = db
    .prepare(
      `INSERT INTO users (username, email, mobile, full_name, password_hash, role, supervisor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      normalizedUsername,
      normalizedEmail,
      input.mobile,
      input.fullName.trim(),
      passwordHash,
      input.role,
      validatedSupervisorId,
      now
    );

  const created = getUserById(Number(info.lastInsertRowid));
  if (!created) throw new Error('CREATE_FAILED');
  return created;
}

export function updateUserAccount(
  targetId: number,
  updates: {
    fullName?: string;
    email?: string;
    mobile?: string;
    role?: UserRole;
    supervisorId?: number | null;
    password?: string;
  },
  actorId: number
): SafeUser {
  const target = getUserById(targetId);
  if (!target) throw new Error('USER_NOT_FOUND');

  const nextRole = updates.role ?? target.role;
  if (target.role === 'admin' && nextRole !== 'admin') {
    if (target.id === actorId) throw new Error('CANNOT_DEMOTE_SELF');
    if (countAdmins() <= 1) throw new Error('LAST_ADMIN');
  }

  let nextEmail = target.email;
  if (updates.email !== undefined) {
    const cleaned = updates.email.trim().toLowerCase();
    if (cleaned !== '') {
      const dup = db
        .prepare("SELECT id FROM users WHERE email != '' AND lower(email) = ? AND id != ?")
        .get(cleaned, targetId) as { id: number } | undefined;
      if (dup) throw new Error('EMAIL_TAKEN');
    }
    nextEmail = cleaned;
  }

  const nextMobile = updates.mobile !== undefined ? updates.mobile : target.mobile;

  let nextSupervisorId: number | null = target.supervisorId;
  if (nextRole !== 'lineman') {
    nextSupervisorId = null;
  } else if (updates.supervisorId !== undefined) {
    if (updates.supervisorId === null) {
      nextSupervisorId = null;
    } else {
      const sup = db
        .prepare("SELECT id FROM users WHERE id = ? AND role = 'supervisor'")
        .get(updates.supervisorId) as { id: number } | undefined;
      if (!sup) throw new Error('INVALID_SUPERVISOR');
      nextSupervisorId = sup.id;
    }
  }

  const nextFullName = updates.fullName ? updates.fullName.trim() : target.fullName;

  if (updates.password && updates.password.length >= 4) {
    const newHash = hashPassword(updates.password);
    db.prepare(
      'UPDATE users SET full_name = ?, email = ?, mobile = ?, role = ?, supervisor_id = ?, password_hash = ? WHERE id = ?'
    ).run(nextFullName, nextEmail, nextMobile, nextRole, nextSupervisorId, newHash, targetId);
  } else {
    db.prepare(
      'UPDATE users SET full_name = ?, email = ?, mobile = ?, role = ?, supervisor_id = ? WHERE id = ?'
    ).run(nextFullName, nextEmail, nextMobile, nextRole, nextSupervisorId, targetId);
  }

  const updated = getUserById(targetId);
  if (!updated) throw new Error('USER_NOT_FOUND');
  return updated;
}

export function deleteUserAccount(targetId: number, actorId: number): void {
  if (targetId === actorId) {
    throw new Error('CANNOT_DELETE_SELF');
  }
  const target = getUserById(targetId);
  if (!target) {
    throw new Error('USER_NOT_FOUND');
  }
  if (target.role === 'admin' && countAdmins() <= 1) {
    throw new Error('LAST_ADMIN');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
}

// --- Streaming / Staged Dataset Import Helpers (supports huge files up to 10 GB) ---

const insertDatasetRowStmt = db.prepare(
  `INSERT INTO dataset_rows (dataset_id, row_index, data_json, search_text)
   VALUES (?, ?, ?, ?)`
);

const insertRowBatchTxn = db.transaction(
  (
    datasetId: number,
    startRowIndex: number,
    headers: string[],
    batch: Array<Record<string, string>>
  ) => {
    for (let i = 0; i < batch.length; i += 1) {
      const rowData = batch[i];
      const searchText = headers
        .map((h) => rowData[h] ?? '')
        .join(' ')
        .toLowerCase();
      insertDatasetRowStmt.run(datasetId, startRowIndex + i, JSON.stringify(rowData), searchText);
    }
  }
);

export function beginStagedDataset(
  fileName: string,
  headers: string[],
  uploadedBy: SafeUser
): number {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO datasets (file_name, headers_json, row_count, uploaded_by_id, uploaded_by_name, uploaded_at, is_active)
       VALUES (?, ?, 0, ?, ?, ?, 0)`
    )
    .run(fileName, JSON.stringify(headers), uploadedBy.id, uploadedBy.fullName, now);
  return Number(info.lastInsertRowid);
}

export function insertDatasetRowsBatch(
  datasetId: number,
  startRowIndex: number,
  headers: string[],
  batch: Array<Record<string, string>>
): void {
  if (batch.length === 0) return;
  insertRowBatchTxn(datasetId, startRowIndex, headers, batch);
}

const activateDatasetTxn = db.transaction((datasetId: number, rowCount: number): DatasetInfo => {
  db.prepare('UPDATE datasets SET is_active = 0 WHERE is_active = 1').run();
  db.prepare('UPDATE datasets SET is_active = 1, row_count = ? WHERE id = ?').run(rowCount, datasetId);
  const ds = getActiveDataset();
  if (!ds || ds.id !== datasetId) {
    throw new Error('FAILED_TO_ACTIVATE_DATASET');
  }
  return ds;
});

export function finalizeStagedDataset(datasetId: number, rowCount: number): DatasetInfo {
  return activateDatasetTxn(datasetId, rowCount);
}

export function abortStagedDataset(datasetId: number): void {
  db.prepare('DELETE FROM datasets WHERE id = ? AND is_active = 0').run(datasetId);
}

const deleteActiveDatasetTxn = db.transaction((): boolean => {
  const active = db
    .prepare('SELECT id FROM datasets WHERE is_active = 1 ORDER BY id DESC LIMIT 1')
    .get() as { id: number } | undefined;
  if (!active) return false;
  db.prepare('DELETE FROM datasets WHERE id = ?').run(active.id);
  return true;
});

export function deleteActiveDataset(): boolean {
  return deleteActiveDatasetTxn();
}

export function saveNewDataset(
  fileName: string,
  headers: string[],
  rows: Array<Record<string, string>>,
  uploadedBy: SafeUser
): DatasetInfo {
  const datasetId = beginStagedDataset(fileName, headers, uploadedBy);
  try {
    const BATCH_SIZE = 1000;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      insertDatasetRowsBatch(datasetId, i + 1, headers, rows.slice(i, i + BATCH_SIZE));
    }
    return finalizeStagedDataset(datasetId, rows.length);
  } catch (err) {
    abortStagedDataset(datasetId);
    throw err;
  }
}

export function getActiveDataset(): DatasetInfo | null {
  const row = db
    .prepare(
      `SELECT id, file_name, headers_json, row_count, uploaded_by_name, uploaded_at
       FROM datasets
       WHERE is_active = 1
       ORDER BY id DESC
       LIMIT 1`
    )
    .get() as
    | {
        id: number;
        file_name: string;
        headers_json: string;
        row_count: number;
        uploaded_by_name: string;
        uploaded_at: string;
      }
    | undefined;

  if (!row) return null;
  let headers: string[] = [];
  try {
    const parsed = JSON.parse(row.headers_json);
    if (Array.isArray(parsed)) headers = parsed.map(String);
  } catch {
    headers = [];
  }
  return {
    id: row.id,
    fileName: row.file_name,
    headers,
    rowCount: row.row_count,
    uploadedByName: row.uploaded_by_name,
    uploadedAt: row.uploaded_at,
  };
}

export function* iterateDatasetRows(datasetId: number): Generator<DatasetRowRecord> {
  const stmt = db.prepare(
    `SELECT id, dataset_id, row_index, data_json
     FROM dataset_rows
     WHERE dataset_id = ?
     ORDER BY row_index ASC`
  );
  for (const r of stmt.iterate(datasetId) as Iterable<{
    id: number;
    dataset_id: number;
    row_index: number;
    data_json: string;
  }>) {
    let data: Record<string, string> = {};
    try {
      const parsed = JSON.parse(r.data_json);
      if (parsed && typeof parsed === 'object') data = parsed as Record<string, string>;
    } catch {
      data = {};
    }
    yield {
      id: r.id,
      datasetId: r.dataset_id,
      rowIndex: r.row_index,
      data,
    };
  }
}

export function getDatasetRowById(rowId: number): DatasetRowRecord | null {
  const r = db
    .prepare('SELECT id, dataset_id, row_index, data_json FROM dataset_rows WHERE id = ?')
    .get(rowId) as
    | { id: number; dataset_id: number; row_index: number; data_json: string }
    | undefined;
  if (!r) return null;
  let data: Record<string, string> = {};
  try {
    data = JSON.parse(r.data_json) as Record<string, string>;
  } catch {
    data = {};
  }
  return {
    id: r.id,
    datasetId: r.dataset_id,
    rowIndex: r.row_index,
    data,
  };
}

function mapRemark(r: {
  id: number;
  dataset_id: number;
  row_id: number;
  user_id: number | null;
  user_name: string;
  user_role: UserRole;
  comment: string;
  created_at: string;
  updated_at: string;
}): RemarkRecord {
  return {
    id: r.id,
    datasetId: r.dataset_id,
    rowId: r.row_id,
    userId: r.user_id,
    userName: r.user_name,
    userRole: r.user_role,
    comment: r.comment,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function buildVisibleRemarksFilterSql(
  datasetId: number,
  user: SafeUser,
  tableAlias = 'rem'
): { clause: string; params: Array<number | string> } {
  if (user.role === 'admin' || user.role === 'je') {
    return { clause: `${tableAlias}.dataset_id = ?`, params: [datasetId] };
  }
  if (user.role === 'supervisor') {
    return {
      clause: `${tableAlias}.dataset_id = ? AND (${tableAlias}.user_id = ? OR ${tableAlias}.user_id IN (SELECT id FROM users WHERE role = 'lineman' AND supervisor_id = ?))`,
      params: [datasetId, user.id, user.id],
    };
  }
  return {
    clause: `${tableAlias}.dataset_id = ? AND ${tableAlias}.user_id = ?`,
    params: [datasetId, user.id],
  };
}

function buildJsonPathForHeader(header: string): string {
  // SQLite JSON1 supports $."escaped header"
  const escaped = header.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `$."${escaped}"`;
}

export function getDistinctColumnValues(dataset: DatasetInfo, column: string): string[] {
  if (!dataset.headers.includes(column)) return [];
  const jsonPath = buildJsonPathForHeader(column);
  const rows = db
    .prepare(
      `SELECT DISTINCT trim(COALESCE(json_extract(data_json, ?), '')) AS val
       FROM dataset_rows
       WHERE dataset_id = ?
         AND trim(COALESCE(json_extract(data_json, ?), '')) != ''
       ORDER BY val COLLATE NOCASE ASC
       LIMIT 250`
    )
    .all(jsonPath, dataset.id, jsonPath) as Array<{ val: string }>;
  return rows.map((r) => r.val);
}

/**
 * Server-side paginated search & column filtering for datasets of any size (up to 10 GB imports).
 * Strictly enforces role-based remark visibility on the server.
 */
export function queryDatasetRows(params: DatasetQueryParams): DatasetQueryResult {
  const { dataset, user, q, column, value, remarkFilter } = params;
  const pageSize = Math.min(Math.max(10, params.pageSize), 200);
  const requestedPage = Math.max(1, params.page);

  const validColumn = column !== '__ALL__' && dataset.headers.includes(column) ? column : '__ALL__';
  const jsonPath = validColumn !== '__ALL__' ? buildJsonPathForHeader(validColumn) : null;

  const visRem = buildVisibleRemarksFilterSql(dataset.id, user, 'rem');

  // Overall visible remark metrics for this dataset
  const statsRow = db
    .prepare(
      `SELECT COUNT(*) AS total_remarks, COUNT(DISTINCT rem.row_id) AS rows_with_remarks
       FROM remarks rem
       WHERE ${visRem.clause}`
    )
    .get(...visRem.params) as { total_remarks: number; rows_with_remarks: number };

  const whereParts: string[] = ['r.dataset_id = ?'];
  const whereParams: Array<number | string> = [dataset.id];

  if (remarkFilter === 'with_remarks') {
    whereParts.push(
      `EXISTS (SELECT 1 FROM remarks rem WHERE rem.row_id = r.id AND ${visRem.clause})`
    );
    whereParams.push(...visRem.params);
  } else if (remarkFilter === 'without_remarks') {
    whereParts.push(
      `NOT EXISTS (SELECT 1 FROM remarks rem WHERE rem.row_id = r.id AND ${visRem.clause})`
    );
    whereParams.push(...visRem.params);
  }

  if (jsonPath && value && value !== '__ALL__') {
    whereParts.push(`trim(COALESCE(json_extract(r.data_json, ?), '')) = ?`);
    whereParams.push(jsonPath, value.trim());
  }

  const trimmedQ = q.trim().toLowerCase();
  if (trimmedQ) {
    const likePattern = `%${trimmedQ}%`;
    if (jsonPath) {
      whereParts.push(`lower(COALESCE(json_extract(r.data_json, ?), '')) LIKE ?`);
      whereParams.push(jsonPath, likePattern);
    } else {
      whereParts.push(
        `(r.search_text LIKE ? OR EXISTS (SELECT 1 FROM remarks rem WHERE rem.row_id = r.id AND ${visRem.clause} AND (lower(rem.comment) LIKE ? OR lower(rem.user_name) LIKE ?)))`
      );
      whereParams.push(likePattern, ...visRem.params, likePattern, likePattern);
    }
  }

  const whereSql = whereParts.join(' AND ');

  const countRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM dataset_rows r WHERE ${whereSql}`)
    .get(...whereParams) as { cnt: number };
  const totalFiltered = countRow.cnt;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));
  const safePage = Math.min(requestedPage, totalPages);
  const offset = (safePage - 1) * pageSize;

  const pageRowsRaw = db
    .prepare(
      `SELECT r.id, r.dataset_id, r.row_index, r.data_json
       FROM dataset_rows r
       WHERE ${whereSql}
       ORDER BY r.row_index ASC
       LIMIT ? OFFSET ?`
    )
    .all(...whereParams, pageSize, offset) as Array<{
    id: number;
    dataset_id: number;
    row_index: number;
    data_json: string;
  }>;

  const rows: DatasetRowRecord[] = pageRowsRaw.map((r) => {
    let data: Record<string, string> = {};
    try {
      const parsed = JSON.parse(r.data_json);
      if (parsed && typeof parsed === 'object') data = parsed as Record<string, string>;
    } catch {
      data = {};
    }
    return {
      id: r.id,
      datasetId: r.dataset_id,
      rowIndex: r.row_index,
      data,
    };
  });

  const remarksByRow: Record<string, RemarkRecord[]> = {};
  if (rows.length > 0) {
    const placeholders = rows.map(() => '?').join(',');
    const rowIds = rows.map((r) => r.id);
    const pageRemarks = db
      .prepare(
        `SELECT rem.id, rem.dataset_id, rem.row_id, rem.user_id, rem.user_name, rem.user_role, rem.comment, rem.created_at, rem.updated_at
         FROM remarks rem
         WHERE ${visRem.clause} AND rem.row_id IN (${placeholders})
         ORDER BY rem.created_at DESC, rem.id DESC`
      )
      .all(...visRem.params, ...rowIds) as Array<{
      id: number;
      dataset_id: number;
      row_id: number;
      user_id: number | null;
      user_name: string;
      user_role: UserRole;
      comment: string;
      created_at: string;
      updated_at: string;
    }>;

    for (const rawRem of pageRemarks) {
      const mapped = mapRemark(rawRem);
      const key = String(mapped.rowId);
      if (!remarksByRow[key]) remarksByRow[key] = [];
      remarksByRow[key].push(mapped);
    }
  }

  return {
    rows,
    remarksByRow,
    totalFiltered,
    rowsWithRemarksCount: statsRow.rows_with_remarks,
    totalVisibleRemarks: statsRow.total_remarks,
    page: safePage,
    pageSize,
  };
}

export function getAllRemarksByRowAdmin(datasetId: number): Map<number, RemarkRecord[]> {
  const rows = db
    .prepare(
      `SELECT id, dataset_id, row_id, user_id, user_name, user_role, comment, created_at, updated_at
       FROM remarks
       WHERE dataset_id = ?
       ORDER BY created_at DESC, id DESC`
    )
    .all(datasetId) as Array<{
    id: number;
    dataset_id: number;
    row_id: number;
    user_id: number | null;
    user_name: string;
    user_role: UserRole;
    comment: string;
    created_at: string;
    updated_at: string;
  }>;

  const map = new Map<number, RemarkRecord[]>();
  for (const r of rows) {
    const mapped = mapRemark(r);
    const list = map.get(mapped.rowId) ?? [];
    list.push(mapped);
    map.set(mapped.rowId, list);
  }
  return map;
}

export function addRemark(rowId: number, comment: string, user: SafeUser): RemarkRecord {
  const row = getDatasetRowById(rowId);
  if (!row) {
    throw new Error('ROW_NOT_FOUND');
  }
  const active = getActiveDataset();
  if (!active || active.id !== row.datasetId) {
    throw new Error('DATASET_INACTIVE');
  }
  const cleanComment = comment.trim();
  if (!cleanComment) {
    throw new Error('EMPTY_COMMENT');
  }
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO remarks (dataset_id, row_id, user_id, user_name, user_role, comment, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(row.datasetId, row.id, user.id, user.fullName, user.role, cleanComment, now, now);

  const inserted = db
    .prepare(
      `SELECT id, dataset_id, row_id, user_id, user_name, user_role, comment, created_at, updated_at
       FROM remarks WHERE id = ?`
    )
    .get(Number(info.lastInsertRowid)) as {
    id: number;
    dataset_id: number;
    row_id: number;
    user_id: number | null;
    user_name: string;
    user_role: UserRole;
    comment: string;
    created_at: string;
    updated_at: string;
  };
  return mapRemark(inserted);
}

export function updateOwnRemark(remarkId: number, comment: string, user: SafeUser): RemarkRecord {
  const existing = db
    .prepare(
      `SELECT id, dataset_id, row_id, user_id, user_name, user_role, comment, created_at, updated_at
       FROM remarks WHERE id = ?`
    )
    .get(remarkId) as
    | {
        id: number;
        dataset_id: number;
        row_id: number;
        user_id: number | null;
        user_name: string;
        user_role: UserRole;
        comment: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  if (!existing) throw new Error('REMARK_NOT_FOUND');
  if (existing.user_id !== user.id && user.role !== 'admin') {
    throw new Error('FORBIDDEN_REMARK');
  }
  const cleanComment = comment.trim();
  if (!cleanComment) throw new Error('EMPTY_COMMENT');

  const now = new Date().toISOString();
  db.prepare('UPDATE remarks SET comment = ?, updated_at = ? WHERE id = ?').run(
    cleanComment,
    now,
    remarkId
  );

  return mapRemark({
    ...existing,
    comment: cleanComment,
    updated_at: now,
  });
}

export function deleteRemark(remarkId: number, user: SafeUser): void {
  const existing = db
    .prepare('SELECT id, user_id FROM remarks WHERE id = ?')
    .get(remarkId) as { id: number; user_id: number | null } | undefined;
  if (!existing) throw new Error('REMARK_NOT_FOUND');
  if (existing.user_id !== user.id && user.role !== 'admin') {
    throw new Error('FORBIDDEN_REMARK');
  }
  db.prepare('DELETE FROM remarks WHERE id = ?').run(remarkId);
}

// --- Full Portal Backup / Restore (for Google Drive Cloud Storage Sync) ---

export interface PortalSnapshotUser {
  id: number;
  username: string;
  email: string;
  mobile: string;
  fullName: string;
  passwordHash: string;
  role: UserRole;
  supervisorId: number | null;
  createdAt: string;
}

export interface PortalSnapshotDataset {
  id: number;
  fileName: string;
  headers: string[];
  rowCount: number;
  uploadedById: number | null;
  uploadedByName: string;
  uploadedAt: string;
}

export interface PortalSnapshotRow {
  id: number;
  rowIndex: number;
  dataJson: string;
  searchText: string;
}

export interface PortalSnapshotRemark {
  id: number;
  rowId: number;
  userId: number | null;
  userName: string;
  userRole: UserRole;
  comment: string;
  createdAt: string;
  updatedAt: string;
}

export interface PortalSnapshot {
  version: 1;
  app: 'puvvnl-portal';
  exportedAt: string;
  users: PortalSnapshotUser[];
  activeDataset: PortalSnapshotDataset | null;
  rows: PortalSnapshotRow[];
  remarks: PortalSnapshotRemark[];
}

export interface RestoreSummary {
  userCount: number;
  rowCount: number;
  remarkCount: number;
  datasetFileName: string | null;
}

const SCRYPT_HASH_REGEX = /^[0-9a-f]{32}:[0-9a-f]{128}$/i;

export function exportPortalSnapshot(): PortalSnapshot {
  const rawUsers = db
    .prepare(
      `SELECT id, username, email, mobile, full_name, password_hash, role, supervisor_id, created_at
       FROM users
       ORDER BY id ASC`
    )
    .all() as DbUser[];

  const users: PortalSnapshotUser[] = rawUsers.map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email ?? '',
    mobile: u.mobile ?? '',
    fullName: u.full_name,
    passwordHash: u.password_hash,
    role: u.role,
    supervisorId: u.supervisor_id,
    createdAt: u.created_at,
  }));

  const rawDataset = db
    .prepare(
      `SELECT id, file_name, headers_json, row_count, uploaded_by_id, uploaded_by_name, uploaded_at
       FROM datasets
       WHERE is_active = 1
       ORDER BY id DESC
       LIMIT 1`
    )
    .get() as
    | {
        id: number;
        file_name: string;
        headers_json: string;
        row_count: number;
        uploaded_by_id: number | null;
        uploaded_by_name: string;
        uploaded_at: string;
      }
    | undefined;

  let activeDataset: PortalSnapshotDataset | null = null;
  let rows: PortalSnapshotRow[] = [];
  let remarks: PortalSnapshotRemark[] = [];

  if (rawDataset) {
    activeDataset = {
      id: rawDataset.id,
      fileName: rawDataset.file_name,
      headers: JSON.parse(rawDataset.headers_json) as string[],
      rowCount: rawDataset.row_count,
      uploadedById: rawDataset.uploaded_by_id,
      uploadedByName: rawDataset.uploaded_by_name,
      uploadedAt: rawDataset.uploaded_at,
    };

    const rawRows = db
      .prepare(
        `SELECT id, row_index, data_json, search_text
         FROM dataset_rows
         WHERE dataset_id = ?
         ORDER BY row_index ASC`
      )
      .all(rawDataset.id) as Array<{
      id: number;
      row_index: number;
      data_json: string;
      search_text: string;
    }>;

    rows = rawRows.map((r) => ({
      id: r.id,
      rowIndex: r.row_index,
      dataJson: r.data_json,
      searchText: r.search_text,
    }));

    const rawRemarks = db
      .prepare(
        `SELECT id, row_id, user_id, user_name, user_role, comment, created_at, updated_at
         FROM remarks
         WHERE dataset_id = ?
         ORDER BY id ASC`
      )
      .all(rawDataset.id) as Array<{
      id: number;
      row_id: number;
      user_id: number | null;
      user_name: string;
      user_role: UserRole;
      comment: string;
      created_at: string;
      updated_at: string;
    }>;

    remarks = rawRemarks.map((rm) => ({
      id: rm.id,
      rowId: rm.row_id,
      userId: rm.user_id,
      userName: rm.user_name,
      userRole: rm.user_role,
      comment: rm.comment,
      createdAt: rm.created_at,
      updatedAt: rm.updated_at,
    }));
  }

  return {
    version: 1,
    app: 'puvvnl-portal',
    exportedAt: new Date().toISOString(),
    users,
    activeDataset,
    rows,
    remarks,
  };
}

const restoreSnapshotTxn = db.transaction((snapshot: PortalSnapshot): RestoreSummary => {
  // Wipe current tables in FK-safe order
  db.prepare('DELETE FROM remarks').run();
  db.prepare('DELETE FROM dataset_rows').run();
  db.prepare('DELETE FROM datasets').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();

  const insertUserStmt = db.prepare(
    `INSERT INTO users (id, username, email, mobile, full_name, password_hash, role, supervisor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  );

  const validUserIds = new Set<number>();
  for (const u of snapshot.users) {
    insertUserStmt.run(
      u.id,
      u.username.trim().toLowerCase(),
      u.email.trim().toLowerCase(),
      u.mobile.trim(),
      u.fullName.trim(),
      u.passwordHash,
      u.role,
      u.createdAt || new Date().toISOString()
    );
    validUserIds.add(u.id);
  }

  const updateSupStmt = db.prepare('UPDATE users SET supervisor_id = ? WHERE id = ?');
  for (const u of snapshot.users) {
    if (u.role === 'lineman' && u.supervisorId !== null && validUserIds.has(u.supervisorId)) {
      updateSupStmt.run(u.supervisorId, u.id);
    }
  }

  let restoredRows = 0;
  let restoredRemarks = 0;
  let datasetFileName: string | null = null;

  if (snapshot.activeDataset) {
    const ds = snapshot.activeDataset;
    const uploadedById =
      ds.uploadedById !== null && validUserIds.has(ds.uploadedById) ? ds.uploadedById : null;

    db.prepare(
      `INSERT INTO datasets (id, file_name, headers_json, row_count, uploaded_by_id, uploaded_by_name, uploaded_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(
      ds.id,
      ds.fileName,
      JSON.stringify(ds.headers),
      snapshot.rows.length,
      uploadedById,
      ds.uploadedByName || 'Admin',
      ds.uploadedAt || new Date().toISOString()
    );
    datasetFileName = ds.fileName;

    const validRowIds = new Set<number>();
    const insertRowStmt = db.prepare(
      `INSERT INTO dataset_rows (id, dataset_id, row_index, data_json, search_text)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const r of snapshot.rows) {
      insertRowStmt.run(r.id, ds.id, r.rowIndex, r.dataJson, r.searchText);
      validRowIds.add(r.id);
      restoredRows += 1;
    }

    const insertRemarkStmt = db.prepare(
      `INSERT INTO remarks (id, dataset_id, row_id, user_id, user_name, user_role, comment, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const rm of snapshot.remarks) {
      if (!validRowIds.has(rm.rowId)) continue;
      const safeUserId = rm.userId !== null && validUserIds.has(rm.userId) ? rm.userId : null;
      insertRemarkStmt.run(
        rm.id,
        ds.id,
        rm.rowId,
        safeUserId,
        rm.userName,
        rm.userRole,
        rm.comment,
        rm.createdAt || new Date().toISOString(),
        rm.updatedAt || rm.createdAt || new Date().toISOString()
      );
      restoredRemarks += 1;
    }
  }

  return {
    userCount: snapshot.users.length,
    rowCount: restoredRows,
    remarkCount: restoredRemarks,
    datasetFileName,
  };
});

export function restorePortalSnapshot(raw: unknown): RestoreSummary {
  if (!raw || typeof raw !== 'object') {
    throw new Error('INVALID_SNAPSHOT');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1 || obj.app !== 'puvvnl-portal') {
    throw new Error('INVALID_SNAPSHOT_FORMAT');
  }
  if (!Array.isArray(obj.users) || obj.users.length === 0) {
    throw new Error('SNAPSHOT_NO_USERS');
  }

  const parsedUsers: PortalSnapshotUser[] = [];
  let hasAdmin = false;
  const seenIds = new Set<number>();
  const seenUsernames = new Set<string>();

  for (const item of obj.users) {
    if (!item || typeof item !== 'object') throw new Error('INVALID_USER_ENTRY');
    const u = item as Record<string, unknown>;
    if (
      typeof u.id !== 'number' ||
      !Number.isInteger(u.id) ||
      u.id <= 0 ||
      typeof u.username !== 'string' ||
      u.username.trim().length < 2 ||
      typeof u.fullName !== 'string' ||
      u.fullName.trim().length < 1 ||
      typeof u.passwordHash !== 'string' ||
      !SCRYPT_HASH_REGEX.test(u.passwordHash) ||
      !isValidRole(u.role)
    ) {
      throw new Error('INVALID_USER_ENTRY');
    }
    const lowerUser = u.username.trim().toLowerCase();
    if (seenIds.has(u.id) || seenUsernames.has(lowerUser)) {
      throw new Error('DUPLICATE_USER_ENTRY');
    }
    seenIds.add(u.id);
    seenUsernames.add(lowerUser);
    if (u.role === 'admin') hasAdmin = true;

    parsedUsers.push({
      id: u.id,
      username: lowerUser,
      email: typeof u.email === 'string' ? u.email.trim().toLowerCase() : '',
      mobile: typeof u.mobile === 'string' ? u.mobile.trim() : '',
      fullName: u.fullName.trim(),
      passwordHash: u.passwordHash,
      role: u.role,
      supervisorId:
        typeof u.supervisorId === 'number' && Number.isInteger(u.supervisorId) && u.supervisorId > 0
          ? u.supervisorId
          : null,
      createdAt: typeof u.createdAt === 'string' ? u.createdAt : new Date().toISOString(),
    });
  }

  if (!hasAdmin) {
    throw new Error('SNAPSHOT_NO_ADMIN');
  }

  let parsedDataset: PortalSnapshotDataset | null = null;
  const parsedRows: PortalSnapshotRow[] = [];
  const parsedRemarks: PortalSnapshotRemark[] = [];

  if (obj.activeDataset !== null && obj.activeDataset !== undefined) {
    if (typeof obj.activeDataset !== 'object') throw new Error('INVALID_DATASET_ENTRY');
    const ds = obj.activeDataset as Record<string, unknown>;
    if (
      typeof ds.id !== 'number' ||
      !Number.isInteger(ds.id) ||
      ds.id <= 0 ||
      typeof ds.fileName !== 'string' ||
      !ds.fileName.trim() ||
      !Array.isArray(ds.headers) ||
      !ds.headers.every((h) => typeof h === 'string')
    ) {
      throw new Error('INVALID_DATASET_ENTRY');
    }
    parsedDataset = {
      id: ds.id,
      fileName: ds.fileName.trim(),
      headers: ds.headers as string[],
      rowCount: typeof ds.rowCount === 'number' ? ds.rowCount : 0,
      uploadedById:
        typeof ds.uploadedById === 'number' && Number.isInteger(ds.uploadedById)
          ? ds.uploadedById
          : null,
      uploadedByName: typeof ds.uploadedByName === 'string' ? ds.uploadedByName : 'Admin',
      uploadedAt: typeof ds.uploadedAt === 'string' ? ds.uploadedAt : new Date().toISOString(),
    };

    if (Array.isArray(obj.rows)) {
      for (const item of obj.rows) {
        if (!item || typeof item !== 'object') throw new Error('INVALID_ROW_ENTRY');
        const r = item as Record<string, unknown>;
        if (
          typeof r.id !== 'number' ||
          !Number.isInteger(r.id) ||
          r.id <= 0 ||
          typeof r.rowIndex !== 'number' ||
          !Number.isInteger(r.rowIndex) ||
          typeof r.dataJson !== 'string' ||
          typeof r.searchText !== 'string'
        ) {
          throw new Error('INVALID_ROW_ENTRY');
        }
        parsedRows.push({
          id: r.id,
          rowIndex: r.rowIndex,
          dataJson: r.dataJson,
          searchText: r.searchText,
        });
      }
    }

    if (Array.isArray(obj.remarks)) {
      for (const item of obj.remarks) {
        if (!item || typeof item !== 'object') throw new Error('INVALID_REMARK_ENTRY');
        const rm = item as Record<string, unknown>;
        if (
          typeof rm.id !== 'number' ||
          !Number.isInteger(rm.id) ||
          rm.id <= 0 ||
          typeof rm.rowId !== 'number' ||
          !Number.isInteger(rm.rowId) ||
          rm.rowId <= 0 ||
          typeof rm.userName !== 'string' ||
          !isValidRole(rm.userRole) ||
          typeof rm.comment !== 'string'
        ) {
          throw new Error('INVALID_REMARK_ENTRY');
        }
        parsedRemarks.push({
          id: rm.id,
          rowId: rm.rowId,
          userId:
            typeof rm.userId === 'number' && Number.isInteger(rm.userId) && rm.userId > 0
              ? rm.userId
              : null,
          userName: rm.userName,
          userRole: rm.userRole,
          comment: rm.comment,
          createdAt: typeof rm.createdAt === 'string' ? rm.createdAt : new Date().toISOString(),
          updatedAt: typeof rm.updatedAt === 'string' ? rm.updatedAt : new Date().toISOString(),
        });
      }
    }
  }

  return restoreSnapshotTxn({
    version: 1,
    app: 'puvvnl-portal',
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    users: parsedUsers,
    activeDataset: parsedDataset,
    rows: parsedRows,
    remarks: parsedRemarks,
  });
}

