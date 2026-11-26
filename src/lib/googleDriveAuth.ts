import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  type User as FirebaseUser,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

export const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.activity',
  'https://www.googleapis.com/auth/drive.activity.readonly',
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/drive.apps.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.install',
  'https://www.googleapis.com/auth/drive.meet.readonly',
  'https://www.googleapis.com/auth/drive.metadata',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/drive.photos.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.scripts',
] as const;

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
for (const scope of SCOPES) {
  provider.addScope(scope);
}
provider.setCustomParameters({ prompt: 'select_account' });

// Keep OAuth access token strictly in memory (never localStorage or sessionStorage)
let isSigningIn = false;
let cachedAccessToken: string | null = null;
let cachedGoogleUser: FirebaseUser | null = null;

export interface DriveAuthSession {
  user: FirebaseUser;
  accessToken: string;
}

export function initGoogleDriveAuth(
  onAuthSuccess?: (user: FirebaseUser, token: string) => void,
  onAuthFailure?: () => void
): () => void {
  return onAuthStateChanged(auth, (user) => {
    if (user) {
      cachedGoogleUser = user;
      if (cachedAccessToken) {
        onAuthSuccess?.(user, cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        onAuthFailure?.();
      }
    } else {
      cachedGoogleUser = null;
      cachedAccessToken = null;
      onAuthFailure?.();
    }
  });
}

export async function signInWithGoogleDrive(): Promise<DriveAuthSession> {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Google Drive एक्सेस टोकन प्राप्त नहीं हो सका। कृपया पुनः प्रयास करें।');
    }
    cachedGoogleUser = result.user;
    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } finally {
    isSigningIn = false;
  }
}

export function getDriveAccessToken(): string | null {
  return cachedAccessToken;
}

export function getCachedGoogleUser(): FirebaseUser | null {
  return cachedGoogleUser;
}

export async function disconnectGoogleDrive(): Promise<void> {
  cachedAccessToken = null;
  cachedGoogleUser = null;
  await auth.signOut();
}

export interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

export const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function isSpreadsheetDriveFile(file: DriveFileItem): boolean {
  if (file.mimeType === GOOGLE_SHEET_MIME) return true;
  if (file.mimeType === XLSX_MIME) return true;
  if (file.mimeType === 'application/vnd.ms-excel') return true;
  if (file.mimeType === 'text/csv') return true;
  return /\.(xlsx|xls|csv)$/i.test(file.name);
}

export async function listDriveFiles(params: {
  accessToken: string;
  queryText?: string;
  onlySpreadsheets?: boolean;
  pageToken?: string;
}): Promise<{ files: DriveFileItem[]; nextPageToken?: string }> {
  const filters: string[] = ['trashed = false'];

  if (params.onlySpreadsheets) {
    filters.push(
      `(` +
        `mimeType = '${GOOGLE_SHEET_MIME}' or ` +
        `mimeType = '${XLSX_MIME}' or ` +
        `mimeType = 'application/vnd.ms-excel' or ` +
        `mimeType = 'text/csv' or ` +
        `name contains '.xlsx' or name contains '.xls' or name contains '.csv'` +
        `)`
    );
  }

  const trimmed = params.queryText?.trim();
  if (trimmed) {
    const escaped = trimmed.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    filters.push(`name contains '${escaped}'`);
  }

  const search = new URLSearchParams({
    q: filters.join(' and '),
    pageSize: '30',
    orderBy: 'modifiedTime desc',
    fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink)',
  });
  if (params.pageToken) {
    search.set('pageToken', params.pageToken);
  }

  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${search.toString()}`, {
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
    },
  });

  if (res.status === 401) {
    cachedAccessToken = null;
    throw new Error('DRIVE_AUTH_EXPIRED');
  }
  if (!res.ok) {
    throw new Error('Google Drive फ़ाइल सूची लोड करने में त्रुटि हुई।');
  }

  const data = (await res.json()) as {
    files?: DriveFileItem[];
    nextPageToken?: string;
  };
  return {
    files: data.files ?? [],
    nextPageToken: data.nextPageToken,
  };
}

export async function downloadDriveFileAsFile(
  accessToken: string,
  file: DriveFileItem
): Promise<File> {
  const isGoogleSheet = file.mimeType === GOOGLE_SHEET_MIME;
  const endpoint = isGoogleSheet
    ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`
    : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`;

  const res = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (res.status === 401) {
    cachedAccessToken = null;
    throw new Error('DRIVE_AUTH_EXPIRED');
  }
  if (!res.ok) {
    throw new Error('Google Drive से फ़ाइल डाउनलोड नहीं हो सकी।');
  }

  const blob = await res.blob();
  let finalName = file.name.trim() || 'drive_data.xlsx';
  if (isGoogleSheet && !/\.(xlsx|xls|csv)$/i.test(finalName)) {
    finalName = `${finalName}.xlsx`;
  }
  const finalMime = isGoogleSheet ? XLSX_MIME : blob.type || XLSX_MIME;
  return new File([blob], finalName, { type: finalMime });
}

export async function uploadBlobToGoogleDrive(params: {
  accessToken: string;
  blob: Blob;
  fileName: string;
  mimeType: string;
}): Promise<DriveFileItem> {
  const metadata = {
    name: params.fileName,
    mimeType: params.mimeType,
  };

  const formData = new FormData();
  formData.append(
    'metadata',
    new Blob([JSON.stringify(metadata)], { type: 'application/json; charset=UTF-8' })
  );
  formData.append('file', params.blob, params.fileName);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,modifiedTime,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
      },
      body: formData,
    }
  );

  if (res.status === 401) {
    cachedAccessToken = null;
    throw new Error('DRIVE_AUTH_EXPIRED');
  }
  if (!res.ok) {
    throw new Error('Google Drive में फ़ाइल सेव करने में त्रुटि हुई।');
  }
  return (await res.json()) as DriveFileItem;
}

export async function trashDriveFile(accessToken: string, fileId: string): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ trashed: true }),
    }
  );

  if (res.status === 401) {
    cachedAccessToken = null;
    throw new Error('DRIVE_AUTH_EXPIRED');
  }
  if (!res.ok) {
    throw new Error('Google Drive फ़ाइल हटाने में त्रुटि हुई।');
  }
}
