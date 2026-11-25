import type { AuthStatus, DatasetInfo, DatasetPayload, RemarkItem, User, UserRole } from './types';

// Keep auth token strictly in JS memory (never localStorage or sessionStorage)
let memoryToken: string | null = null;

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
  if (options.body && !headers.has('Content-Type')) {
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
  username: string;
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
): Promise<{ token: string; user: User }> {
  return apiFetch<{ token: string; user: User }>('/api/auth/login', {
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

export async function fetchDataset(): Promise<DatasetPayload> {
  return apiFetch<DatasetPayload>('/api/dataset');
}

export async function uploadSpreadsheetFile(file: File): Promise<{ dataset: DatasetInfo }> {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const fileBase64 = btoa(binary);
  return apiFetch<{ dataset: DatasetInfo }>('/api/dataset/upload', {
    method: 'POST',
    body: JSON.stringify({
      fileName: file.name,
      fileBase64,
    }),
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
  username: string;
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
