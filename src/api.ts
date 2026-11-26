import type {
  AuthStatus,
  DatasetInfo,
  DatasetPayload,
  LoginResponse,
  RemarkFilterMode,
  RemarkItem,
  UploadProgress,
  User,
  UserRole,
} from './types';

// Keep auth token strictly in JS memory (never localStorage or sessionStorage)
let memoryToken: string | null = null;

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB

export function setAuthToken(token: string | null): void {
  memoryToken = token;
}

export function getAuthToken(): string | null {
  return memoryToken;
}

async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (memoryToken) {
    headers.set('Authorization', `Bearer ${memoryToken}`);
  }
  if (options.body && !(options.body instanceof Blob) && !(options.body instanceof ArrayBuffer) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    let message = 'अनुरोध पूरा करने में समस्या आई।';
    try {
      const errBody = (await response.json()) as { error?: string };
      if (errBody.error) message = errBody.error;
    } catch {
      // keep fallback message
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  return apiFetch<AuthStatus>('/api/auth/status');
}

export async function setupFirstAdmin(input: {
  username?: string;
  email: string;
  mobile: string;
  fullName: string;
  password: string;
}): Promise<{ token: string; user: User }> {
  return apiFetch<{ token: string; user: User }>('/api/auth/setup-admin', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function loginWithPassword(
  username: string,
  password: string
): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export async function logoutSession(): Promise<void> {
  try {
    await apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  } finally {
    setAuthToken(null);
  }
}

export interface DatasetQueryOptions {
  q?: string;
  column?: string;
  value?: string;
  remarkFilter?: RemarkFilterMode;
  page?: number;
  pageSize?: number;
}

export async function fetchDataset(options: DatasetQueryOptions = {}): Promise<DatasetPayload> {
  const params = new URLSearchParams();
  if (options.q) params.set('q', options.q);
  if (options.column && options.column !== '__ALL__') params.set('column', options.column);
  if (options.value && options.value !== '__ALL__') params.set('value', options.value);
  if (options.remarkFilter && options.remarkFilter !== 'all') {
    params.set('remarkFilter', options.remarkFilter);
  }
  if (options.page) params.set('page', String(options.page));
  if (options.pageSize) params.set('pageSize', String(options.pageSize));

  const query = params.toString();
  return apiFetch<DatasetPayload>(query ? `/api/dataset?${query}` : '/api/dataset');
}

export async function fetchColumnValues(column: string): Promise<string[]> {
  const params = new URLSearchParams({ column });
  const res = await apiFetch<{ values: string[] }>(`/api/dataset/column-values?${params.toString()}`);
  return res.values;
}

/**
 * Chunked binary file upload supporting files up to 10 GB without loading the file into RAM.
 * Slices the File directly from disk in 4 MB chunks.
 */
export async function uploadSpreadsheetFile(
  file: File,
  options: {
    onProgress?: (progress: UploadProgress) => void;
    signal?: AbortSignal;
  } = {}
): Promise<{ dataset: DatasetInfo }> {
  if (file.size <= 0) {
    throw new Error('चुनी गई फ़ाइल खाली है।');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error('फ़ाइल का आकार अधिकतम 10 GB तक हो सकता है।');
  }

  const init = await apiFetch<{ uploadId: string; chunkSize: number }>('/api/dataset/upload/init', {
    method: 'POST',
    body: JSON.stringify({
      fileName: file.name,
      fileSize: file.size,
    }),
    signal: options.signal,
  });

  const { uploadId, chunkSize } = init;
  let offset = 0;

  try {
    options.onProgress?.({
      phase: 'uploading',
      uploadedBytes: 0,
      totalBytes: file.size,
      percent: 0,
    });

    while (offset < file.size) {
      if (options.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const end = Math.min(offset + chunkSize, file.size);
      const blobSlice = file.slice(offset, end);

      const headers = new Headers({
        'Content-Type': 'application/octet-stream',
      });
      if (memoryToken) {
        headers.set('Authorization', `Bearer ${memoryToken}`);
      }

      const chunkRes = await fetch(`/api/dataset/upload/chunk/${uploadId}`, {
        method: 'PUT',
        headers,
        body: blobSlice,
        signal: options.signal,
      });

      if (!chunkRes.ok) {
        let message = 'फ़ाइल अपलोड के दौरान त्रुटि हुई।';
        try {
          const errBody = (await chunkRes.json()) as { error?: string };
          if (errBody.error) message = errBody.error;
        } catch {
          // ignore
        }
        throw new Error(message);
      }

      offset = end;
      options.onProgress?.({
        phase: 'uploading',
        uploadedBytes: offset,
        totalBytes: file.size,
        percent: Math.min(100, Math.round((offset / file.size) * 100)),
      });
    }

    options.onProgress?.({
      phase: 'processing',
      uploadedBytes: file.size,
      totalBytes: file.size,
      percent: 100,
    });

    return await apiFetch<{ dataset: DatasetInfo }>(`/api/dataset/upload/complete/${uploadId}`, {
      method: 'POST',
      signal: options.signal,
    });
  } catch (err) {
    // Best-effort cleanup of temp upload on server if aborted or failed
    void apiFetch<{ ok: boolean }>(`/api/dataset/upload/${uploadId}`, {
      method: 'DELETE',
    }).catch(() => {});

    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('अपलोड रद्द कर दिया गया।');
    }
    throw err;
  }
}

export async function deleteActiveDataset(): Promise<void> {
  await apiFetch<{ ok: boolean }>('/api/dataset', {
    method: 'DELETE',
  });
}

export async function loadSampleDataset(): Promise<{ dataset: DatasetInfo }> {
  return apiFetch<{ dataset: DatasetInfo }>('/api/dataset/load-sample', {
    method: 'POST',
  });
}

async function downloadBinaryFile(url: string, fallbackName: string): Promise<void> {
  const headers = new Headers();
  if (memoryToken) {
    headers.set('Authorization', `Bearer ${memoryToken}`);
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    let message = 'फ़ाइल डाउनलोड करने में त्रुटि हुई।';
    try {
      const errBody = (await response.json()) as { error?: string };
      if (errBody.error) message = errBody.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = disposition.match(/filename="?([^"]+)"?/i);
  const fileName = match?.[1] || fallbackName;
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

export async function fetchExportExcelBlob(): Promise<{ blob: Blob; fileName: string }> {
  const headers = new Headers();
  if (memoryToken) {
    headers.set('Authorization', `Bearer ${memoryToken}`);
  }
  const response = await fetch('/api/dataset/export', { headers });
  if (!response.ok) {
    let message = 'Excel बैकअप तैयार करने में त्रुटि हुई।';
    try {
      const errBody = (await response.json()) as { error?: string };
      if (errBody.error) message = errBody.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = disposition.match(/filename="?([^"]+)"?/i);
  const fileName = match?.[1] || 'data_with_remarks.xlsx';
  return { blob, fileName };
}

export async function downloadExcelWithRemarks(): Promise<void> {
  await downloadBinaryFile('/api/dataset/export', 'data_with_remarks.xlsx');
}

export async function downloadSampleTemplate(): Promise<void> {
  await downloadBinaryFile('/api/dataset/sample-template', 'sample_consumer_data.xlsx');
}

export async function addRowRemark(rowId: number, comment: string): Promise<{ remark: RemarkItem }> {
  return apiFetch<{ remark: RemarkItem }>(`/api/rows/${rowId}/remarks`, {
    method: 'POST',
    body: JSON.stringify({ comment }),
  });
}

export async function editRemark(remarkId: number, comment: string): Promise<{ remark: RemarkItem }> {
  return apiFetch<{ remark: RemarkItem }>(`/api/remarks/${remarkId}`, {
    method: 'PATCH',
    body: JSON.stringify({ comment }),
  });
}

export async function removeRemark(remarkId: number): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/remarks/${remarkId}`, {
    method: 'DELETE',
  });
}

export async function fetchUsers(): Promise<{ users: User[] }> {
  return apiFetch<{ users: User[] }>('/api/users');
}

export async function createUser(input: {
  username?: string;
  email: string;
  mobile: string;
  fullName: string;
  password: string;
  role: UserRole;
  supervisorId: number | null;
}): Promise<{ user: User }> {
  return apiFetch<{ user: User }>('/api/users', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateUser(
  userId: number,
  input: {
    fullName?: string;
    email?: string;
    mobile?: string;
    role?: UserRole;
    supervisorId?: number | null;
    password?: string;
  }
): Promise<{ user: User }> {
  return apiFetch<{ user: User }>(`/api/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteUser(userId: number): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/users/${userId}`, {
    method: 'DELETE',
  });
}
