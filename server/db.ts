import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type UserRole = 'admin' | 'je' | 'supervisor' | 'lineman';

export interface DbUser {
  id: number;
  username: string;
  full_name: string;
  password_hash: string;
  role: UserRole;
  supervisor_id: number | null;
  created_at: string;
}

export interface SafeUser {
  id: number;
  username: string;
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

const VALID_ROLES = new Set<UserRole>(['admin', 'je', 'supervisor', 'lineman']);

export function isValidRole(value: unknown): value is UserRole {
  return typeof value === 'string' && VALID_ROLES.has(value as UserRole);
}

const dataDir = path.resolve(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.resolve(dataDir, 'portal.db');

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
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
`);

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

export function getEnvAdminConfig(): { username: string; password: string } | null {
  const rawPass = process.env.ADMIN_PASSWORD?.trim();
  if (!rawPass) return null;
  const envPass = rawPass.replace(/^["']|["']$/g, '').trim();
  if (
    !envPass ||
    /^MY_/i.test(envPass) ||
    /^YOUR_/i.test(envPass) ||
    /^CHANGE_ME/i.test(envPass) ||
    envPass === 'undefined' ||
    envPass === 'null'
  ) {
    return null;
  }
  const rawUser = process.env.ADMIN_USERNAME?.trim().replace(/^["']|["']$/g, '').trim();
  const envUser = rawUser && !/^MY_/i.test(rawUser) ? rawUser.toLowerCase() : 'admin';
  return { username: envUser, password: envPass };
}

export function countAdmins(): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin'").get() as { cnt: number };
  return row.cnt;
}

export function needsAdminSetup(): boolean {
  if (getEnvAdminConfig()) return false;
  return countAdmins() === 0;
}

function mapSafeUser(row: {
  id: number;
  username: string;
  full_name: string;
  role: UserRole;
  supervisor_id: number | null;
  supervisor_name: string | null;
  created_at: string;
}): SafeUser {
  return {
    id: row.id,
    username: row.username,
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
      `SELECT u.id, u.username, u.full_name, u.role, u.supervisor_id, s.full_name AS supervisor_name, u.created_at
       FROM users u
       LEFT JOIN users s ON u.supervisor_id = s.id
       WHERE u.id = ?`
    )
    .get(userId) as
    | {
        id: number;
        username: string;
        full_name: string;
        role: UserRole;
        supervisor_id: number | null;
        supervisor_name: string | null;
        created_at: string;
      }
    | undefined;
  return row ? mapSafeUser(row) : null;
}

export function listUsers(): SafeUser[] {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.role, u.supervisor_id, s.full_name AS supervisor_name, u.created_at
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
    full_name: string;
    role: UserRole;
    supervisor_id: number | null;
    supervisor_name: string | null;
    created_at: string;
  }>;
  return rows.map(mapSafeUser);
}

const claimFirstAdminTxn = db.transaction(
  (username: string, fullName: string, passwordHash: string): SafeUser => {
    const existingAdmins = db
      .prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin'")
      .get() as { cnt: number };
    if (existingAdmins.cnt > 0) {
      throw new Error('ADMIN_ALREADY_EXISTS');
    }
    const now = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO users (username, full_name, password_hash, role, supervisor_id, created_at)
         VALUES (?, ?, ?, 'admin', NULL, ?)`
      )
      .run(username, fullName, passwordHash, now);
    const created = getUserById(Number(info.lastInsertRowid));
    if (!created) {
      throw new Error('FAILED_TO_CREATE_ADMIN');
    }
    return created;
  }
);

export function claimFirstAdmin(input: {
  username: string;
  fullName: string;
  password: string;
}): SafeUser {
  if (getEnvAdminConfig()) {
    throw new Error('ADMIN_ENV_CONFIGURED');
  }
  const passwordHash = hashPassword(input.password);
  return claimFirstAdminTxn(input.username, input.fullName, passwordHash);
}

export function authenticateUser(usernameInput: string, passwordInput: string): SafeUser | null {
  const normalizedUsername = usernameInput.trim().toLowerCase();
  if (!normalizedUsername || !passwordInput) return null;

  const envAdmin = getEnvAdminConfig();
  if (envAdmin && normalizedUsername === envAdmin.username) {
    if (!timingSafeStringCompare(passwordInput, envAdmin.password)) {
      return null;
    }
    // Ensure a matching DB record exists for the env-configured admin
    const existing = db
      .prepare('SELECT id FROM users WHERE lower(username) = ?')
      .get(normalizedUsername) as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
      return getUserById(existing.id);
    }
    const now = new Date().toISOString();
    const placeholderHash = hashPassword(crypto.randomBytes(24).toString('hex'));
    const info = db
      .prepare(
        `INSERT INTO users (username, full_name, password_hash, role, supervisor_id, created_at)
         VALUES (?, ?, ?, 'admin', NULL, ?)`
      )
      .run(normalizedUsername, 'मुख्य एडमिन', placeholderHash, now);
    return getUserById(Number(info.lastInsertRowid));
  }

  const row = db
    .prepare('SELECT id, username, full_name, password_hash, role, supervisor_id, created_at FROM users WHERE lower(username) = ?')
    .get(normalizedUsername) as DbUser | undefined;
  if (!row) return null;
  if (!verifyPassword(passwordInput, row.password_hash)) return null;
  return getUserById(row.id);
}

export function createSession(userId: number): string {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 7); // 7 days
  // Cleanup expired sessions occasionally
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
  fullName: string;
  password: string;
  role: UserRole;
  supervisorId: number | null;
}): SafeUser {
  const normalizedUsername = input.username.trim().toLowerCase();
  const existing = db
    .prepare('SELECT id FROM users WHERE lower(username) = ?')
    .get(normalizedUsername) as { id: number } | undefined;
  if (existing) {
    throw new Error('USERNAME_TAKEN');
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
      `INSERT INTO users (username, full_name, password_hash, role, supervisor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(normalizedUsername, input.fullName.trim(), passwordHash, input.role, validatedSupervisorId, now);

  const created = getUserById(Number(info.lastInsertRowid));
  if (!created) throw new Error('CREATE_FAILED');
  return created;
}

export function updateUserAccount(
  targetId: number,
  updates: {
    fullName?: string;
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
    db.prepare('UPDATE users SET full_name = ?, role = ?, supervisor_id = ?, password_hash = ? WHERE id = ?').run(
      nextFullName,
      nextRole,
      nextSupervisorId,
      newHash,
      targetId
    );
  } else {
    db.prepare('UPDATE users SET full_name = ?, role = ?, supervisor_id = ? WHERE id = ?').run(
      nextFullName,
      nextRole,
      nextSupervisorId,
      targetId
    );
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

const replaceActiveDatasetTxn = db.transaction(
  (
    fileName: string,
    headers: string[],
    rows: Array<Record<string, string>>,
    uploadedBy: SafeUser
  ): DatasetInfo => {
    db.prepare('UPDATE datasets SET is_active = 0 WHERE is_active = 1').run();
    const now = new Date().toISOString();
    const dsInfo = db
      .prepare(
        `INSERT INTO datasets (file_name, headers_json, row_count, uploaded_by_id, uploaded_by_name, uploaded_at, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      )
      .run(fileName, JSON.stringify(headers), rows.length, uploadedBy.id, uploadedBy.fullName, now);

    const datasetId = Number(dsInfo.lastInsertRowid);
    const insertRow = db.prepare(
      `INSERT INTO dataset_rows (dataset_id, row_index, data_json, search_text)
       VALUES (?, ?, ?, ?)`
    );

    for (let i = 0; i < rows.length; i += 1) {
      const rowData = rows[i];
      const searchText = headers
        .map((h) => rowData[h] ?? '')
        .join(' ')
        .toLowerCase();
      insertRow.run(datasetId, i + 1, JSON.stringify(rowData), searchText);
    }

    return {
      id: datasetId,
      fileName,
      headers,
      rowCount: rows.length,
      uploadedByName: uploadedBy.fullName,
      uploadedAt: now,
    };
  }
);

export function saveNewDataset(
  fileName: string,
  headers: string[],
  rows: Array<Record<string, string>>,
  uploadedBy: SafeUser
): DatasetInfo {
  return replaceActiveDatasetTxn(fileName, headers, rows, uploadedBy);
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

export function getDatasetRows(datasetId: number): DatasetRowRecord[] {
  const rows = db
    .prepare(
      `SELECT id, dataset_id, row_index, data_json
       FROM dataset_rows
       WHERE dataset_id = ?
       ORDER BY row_index ASC`
    )
    .all(datasetId) as Array<{
    id: number;
    dataset_id: number;
    row_index: number;
    data_json: string;
  }>;

  return rows.map((r) => {
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

/**
 * Enforces strict server-side role visibility for remarks:
 * - Admin & JE: all remarks
 * - Supervisor: own remarks + remarks of linemen assigned to them
 * - Lineman: own remarks only
 */
export function getVisibleRemarksForDataset(datasetId: number, user: SafeUser): RemarkRecord[] {
  if (user.role === 'admin' || user.role === 'je') {
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
    return rows.map(mapRemark);
  }

  if (user.role === 'supervisor') {
    const rows = db
      .prepare(
        `SELECT r.id, r.dataset_id, r.row_id, r.user_id, r.user_name, r.user_role, r.comment, r.created_at, r.updated_at
         FROM remarks r
         WHERE r.dataset_id = ?
           AND (
             r.user_id = ?
             OR r.user_id IN (SELECT id FROM users WHERE role = 'lineman' AND supervisor_id = ?)
           )
         ORDER BY r.created_at DESC, r.id DESC`
      )
      .all(datasetId, user.id, user.id) as Array<{
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
    return rows.map(mapRemark);
  }

  // Lineman: strictly own remarks
  const rows = db
    .prepare(
      `SELECT id, dataset_id, row_id, user_id, user_name, user_role, comment, created_at, updated_at
       FROM remarks
       WHERE dataset_id = ? AND user_id = ?
       ORDER BY created_at DESC, id DESC`
    )
    .all(datasetId, user.id) as Array<{
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
  return rows.map(mapRemark);
}

export function getAllRemarksForDatasetAdmin(datasetId: number): RemarkRecord[] {
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
  return rows.map(mapRemark);
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
