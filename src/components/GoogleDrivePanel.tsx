import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { User as FirebaseUser } from 'firebase/auth';
import {
  CheckCircle2,
  CloudUpload,
  DatabaseBackup,
  Download,
  FileSpreadsheet,
  FileText,
  Folder,
  HardDrive,
  LogOut,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  fetchExportExcelBlob,
  restorePortalSnapshotApi,
  uploadSpreadsheetFile,
} from '../api';
import {
  deletePortalBackupFromDrive,
  disconnectGoogleDrive,
  downloadDriveFileAsFile,
  findPortalBackupFile,
  getCachedGoogleUser,
  getDriveAccessToken,
  GOOGLE_SHEET_MIME,
  initGoogleDriveAuth,
  isSpreadsheetDriveFile,
  listDriveFiles,
  loadPortalBackupFromDrive,
  PORTAL_BACKUP_FILENAME,
  signInWithGoogleDrive,
  trashDriveFile,
  uploadBlobToGoogleDrive,
  XLSX_MIME,
  type DriveFileItem,
} from '../lib/googleDriveAuth';
import type { DatasetInfo, RestoreSummary, UploadProgress, User } from '../types';
import { formatBytes, formatHindiDateTime } from '../types';
import { GoogleSignInButton } from './GoogleSignInButton';

interface GoogleDrivePanelProps {
  currentUser: User;
  dataset: DatasetInfo | null;
  totalRemarks: number;
  driveSyncEnabled: boolean;
  syncingDrive: boolean;
  lastSyncedAt: string | null;
  onRequestEnableSync: () => void;
  onManualSyncNow: () => Promise<void>;
  onDriveBackupDeleted: () => void;
  onDatasetChanged: () => Promise<void>;
  onPortalRestored: (summary: RestoreSummary) => Promise<void>;
  onNotify: (message: string) => void;
  onOpenSearch: () => void;
}

type DriveFilterMode = 'spreadsheets' | 'all';

function getDriveFileTypeLabel(mimeType: string, name: string): string {
  if (mimeType === 'application/vnd.google-apps.folder') return 'फ़ोल्डर';
  if (mimeType === GOOGLE_SHEET_MIME) return 'Google Sheets';
  if (mimeType === XLSX_MIME || /\.xlsx$/i.test(name)) return 'Excel (.xlsx)';
  if (mimeType === 'application/vnd.ms-excel' || /\.xls$/i.test(name)) return 'Excel (.xls)';
  if (mimeType === 'text/csv' || /\.csv$/i.test(name)) return 'CSV';
  if (mimeType === 'application/pdf') return 'PDF';
  return 'फ़ाइल';
}

export function GoogleDrivePanel({
  currentUser,
  dataset,
  totalRemarks,
  driveSyncEnabled,
  syncingDrive,
  lastSyncedAt,
  onRequestEnableSync,
  onManualSyncNow,
  onDriveBackupDeleted,
  onDatasetChanged,
  onPortalRestored,
  onNotify,
  onOpenSearch,
}: GoogleDrivePanelProps) {
  const isAdmin = currentUser.role === 'admin';

  const [needsAuth, setNeedsAuth] = useState<boolean>(() => !getDriveAccessToken());
  const [googleUser, setGoogleUser] = useState<FirebaseUser | null>(() => getCachedGoogleUser());
  const [connecting, setConnecting] = useState(false);

  const [files, setFiles] = useState<DriveFileItem[]>([]);
  const [portalBackupFile, setPortalBackupFile] = useState<DriveFileItem | null>(null);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>(undefined);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [filterMode, setFilterMode] = useState<DriveFilterMode>('spreadsheets');
  const [searchInput, setSearchInput] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');

  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<UploadProgress | null>(null);
  const [importingName, setImportingName] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Explicit confirmation modals for every mutating/destructive Google Drive operation
  const [confirmUploadBackup, setConfirmUploadBackup] = useState(false);
  const [uploadingBackup, setUploadingBackup] = useState(false);
  const [confirmDeleteFile, setConfirmDeleteFile] = useState<DriveFileItem | null>(null);
  const [deletingFile, setDeletingFile] = useState(false);
  const [confirmImportFile, setConfirmImportFile] = useState<DriveFileItem | null>(null);
  const [confirmRestoreCloud, setConfirmRestoreCloud] = useState(false);
  const [restoringCloud, setRestoringCloud] = useState(false);
  const [confirmDeleteCloudBackup, setConfirmDeleteCloudBackup] = useState(false);
  const [deletingCloudBackup, setDeletingCloudBackup] = useState(false);

  useEffect(() => {
    const unsubscribe = initGoogleDriveAuth(
      (user) => {
        setGoogleUser(user);
        setNeedsAuth(false);
      },
      () => {
        setGoogleUser(null);
        setNeedsAuth(true);
      }
    );
    return unsubscribe;
  }, []);

  const loadFiles = useCallback(
    async (options: { append?: boolean; pageToken?: string } = {}) => {
      const token = getDriveAccessToken();
      if (!token) {
        setNeedsAuth(true);
        return;
      }

      setError(null);
      if (options.append) {
        setLoadingMore(true);
      } else {
        setLoadingFiles(true);
      }

      try {
        const [res, cloudFile] = await Promise.all([
          listDriveFiles({
            accessToken: token,
            queryText: appliedSearch,
            onlySpreadsheets: filterMode === 'spreadsheets',
            pageToken: options.pageToken,
          }),
          isAdmin && !options.append ? findPortalBackupFile(token) : Promise.resolve(undefined),
        ]);
        setFiles((prev) => (options.append ? [...prev, ...res.files] : res.files));
        setNextPageToken(res.nextPageToken);
        if (cloudFile !== undefined) {
          setPortalBackupFile(cloudFile);
        }
      } catch (err) {
        if (err instanceof Error && err.message === 'DRIVE_AUTH_EXPIRED') {
          setNeedsAuth(true);
          setError('Google Drive सेशन समाप्त हो गया है। कृपया पुनः साइन इन करें।');
        } else {
          setError(err instanceof Error ? err.message : 'Google Drive फ़ाइलें लोड नहीं हो सकीं।');
        }
      } finally {
        setLoadingFiles(false);
        setLoadingMore(false);
      }
    },
    [appliedSearch, filterMode, isAdmin]
  );

  useEffect(() => {
    if (!needsAuth) {
      void loadFiles();
    }
  }, [needsAuth, loadFiles, lastSyncedAt]);

  async function handleConnectGoogle() {
    setError(null);
    setConnecting(true);
    try {
      const session = await signInWithGoogleDrive();
      setGoogleUser(session.user);
      setNeedsAuth(false);
      onNotify(
        `Google Drive कनेक्ट हो गया (${session.user.email ?? session.user.displayName ?? 'Google Account'})।`
      );
    } catch (err) {
      const code =
        typeof err === 'object' && err && 'code' in err
          ? String((err as { code?: unknown }).code)
          : '';
      if (code === 'auth/popup-closed-by-user') {
        setError('Google साइन-इन पॉपअप बंद कर दिया गया। कृपया पुनः प्रयास करें।');
      } else if (code === 'auth/popup-blocked') {
        setError('ब्राउज़र ने साइन-इन पॉपअप रोक दिया है। कृपया पॉपअप अनुमति दें और फिर से प्रयास करें।');
      } else {
        setError(err instanceof Error ? err.message : 'Google Drive कनेक्ट करने में त्रुटि हुई।');
      }
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setError(null);
    try {
      await disconnectGoogleDrive();
      setFiles([]);
      setPortalBackupFile(null);
      setNextPageToken(undefined);
      setGoogleUser(null);
      setNeedsAuth(true);
      onNotify('Google Drive डिस्कनेक्ट कर दिया गया।');
    } catch {
      setError('Google Drive डिस्कनेक्ट करने में त्रुटि हुई।');
    }
  }

  function handleSearchSubmit(e: FormEvent) {
    e.preventDefault();
    setAppliedSearch(searchInput.trim());
  }

  async function executeImportFromDrive(file: DriveFileItem) {
    const token = getDriveAccessToken();
    if (!token) {
      setNeedsAuth(true);
      return;
    }

    setError(null);
    setConfirmImportFile(null);
    setBusyActionId(file.id);
    setImportingName(file.name);
    setImportProgress({ phase: 'uploading', uploadedBytes: 0, totalBytes: 1, percent: 5 });

    try {
      const localFile = await downloadDriveFileAsFile(token, file);
      const res = await uploadSpreadsheetFile(localFile, {
        onProgress: (prog) => setImportProgress(prog),
      });
      await onDatasetChanged();
      onNotify(
        `Google Drive से "${res.dataset.fileName}" पोर्टल में लोड हो गई (${res.dataset.rowCount.toLocaleString('hi-IN')} पंक्तियाँ)।`
      );
      onOpenSearch();
    } catch (err) {
      if (err instanceof Error && err.message === 'DRIVE_AUTH_EXPIRED') {
        setNeedsAuth(true);
        setError('Google Drive सेशन समाप्त हो गया है। कृपया पुनः साइन इन करें।');
      } else {
        setError(
          err instanceof Error ? err.message : 'Google Drive से फ़ाइल इम्पोर्ट करने में त्रुटि हुई।'
        );
      }
    } finally {
      setBusyActionId(null);
      setImportProgress(null);
      setImportingName('');
    }
  }

  function requestImportFromDrive(file: DriveFileItem) {
    if (!isAdmin) return;
    if (dataset && totalRemarks > 0) {
      setConfirmImportFile(file);
      return;
    }
    void executeImportFromDrive(file);
  }

  async function handleDownloadLocal(file: DriveFileItem) {
    const token = getDriveAccessToken();
    if (!token) {
      setNeedsAuth(true);
      return;
    }
    setError(null);
    setBusyActionId(file.id);
    try {
      const localFile = await downloadDriveFileAsFile(token, file);
      const objectUrl = URL.createObjectURL(localFile);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = localFile.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      onNotify(`"${localFile.name}" डाउनलोड हो गई।`);
    } catch (err) {
      if (err instanceof Error && err.message === 'DRIVE_AUTH_EXPIRED') {
        setNeedsAuth(true);
        setError('Google Drive सेशन समाप्त हो गया है। कृपया पुनः साइन इन करें।');
      } else {
        setError(err instanceof Error ? err.message : 'फ़ाइल डाउनलोड करने में त्रुटि हुई।');
      }
    } finally {
      setBusyActionId(null);
    }
  }

  async function executeBackupToDrive() {
    const token = getDriveAccessToken();
    if (!token) {
      setConfirmUploadBackup(false);
      setNeedsAuth(true);
      return;
    }
    setError(null);
    setUploadingBackup(true);
    try {
      const { blob, fileName } = await fetchExportExcelBlob();
      const uploaded = await uploadBlobToGoogleDrive({
        accessToken: token,
        blob,
        fileName,
        mimeType: XLSX_MIME,
      });
      setConfirmUploadBackup(false);
      onNotify(`"${uploaded.name}" सफलतापूर्वक Google Drive में सेव हो गई।`);
      await loadFiles();
    } catch (err) {
      if (err instanceof Error && err.message === 'DRIVE_AUTH_EXPIRED') {
        setConfirmUploadBackup(false);
        setNeedsAuth(true);
        setError('Google Drive सेशन समाप्त हो गया है। कृपया पुनः साइन इन करें।');
      } else {
        setError(err instanceof Error ? err.message : 'Google Drive में बैकअप सेव नहीं हो सका।');
      }
    } finally {
      setUploadingBackup(false);
    }
  }

  async function executeDeleteDriveFile() {
    if (!confirmDeleteFile) return;
    const token = getDriveAccessToken();
    if (!token) {
      setConfirmDeleteFile(null);
      setNeedsAuth(true);
      return;
    }
    setError(null);
    setDeletingFile(true);
    try {
      await trashDriveFile(token, confirmDeleteFile.id);
      const deletedName = confirmDeleteFile.name;
      if (portalBackupFile?.id === confirmDeleteFile.id) {
        setPortalBackupFile(null);
        onDriveBackupDeleted();
      }
      setFiles((prev) => prev.filter((item) => item.id !== confirmDeleteFile.id));
      setConfirmDeleteFile(null);
      onNotify(`"${deletedName}" को Google Drive के Trash में भेज दिया गया।`);
    } catch (err) {
      if (err instanceof Error && err.message === 'DRIVE_AUTH_EXPIRED') {
        setConfirmDeleteFile(null);
        setNeedsAuth(true);
        setError('Google Drive सेशन समाप्त हो गया है। कृपया पुनः साइन इन करें।');
      } else {
        setError(err instanceof Error ? err.message : 'Google Drive से फ़ाइल हटाने में त्रुटि हुई।');
      }
    } finally {
      setDeletingFile(false);
    }
  }

  async function executeRestorePortalFromCloud() {
    const token = getDriveAccessToken();
    if (!token) {
      setConfirmRestoreCloud(false);
      setNeedsAuth(true);
      return;
    }
    setError(null);
    setRestoringCloud(true);
    try {
      const backup = await loadPortalBackupFromDrive(token);
      if (!backup) {
        setConfirmRestoreCloud(false);
        setError(`Google Drive में "${PORTAL_BACKUP_FILENAME}" नहीं मिला।`);
        return;
      }
      const res = await restorePortalSnapshotApi(backup.snapshot);
      setConfirmRestoreCloud(false);
      await onPortalRestored(res.summary);
    } catch (err) {
      if (err instanceof Error && err.message === 'DRIVE_AUTH_EXPIRED') {
        setConfirmRestoreCloud(false);
        setNeedsAuth(true);
        setError('Google Drive सेशन समाप्त हो गया है। कृपया पुनः साइन इन करें।');
      } else {
        setError(
          err instanceof Error ? err.message : 'Google Drive से पोर्टल डाटा रिस्टोर नहीं हो सका।'
        );
      }
    } finally {
      setRestoringCloud(false);
    }
  }

  async function executeDeleteCloudPortalBackup() {
    const token = getDriveAccessToken();
    if (!token) {
      setConfirmDeleteCloudBackup(false);
      setNeedsAuth(true);
      return;
    }
    setError(null);
    setDeletingCloudBackup(true);
    try {
      const deleted = await deletePortalBackupFromDrive(token);
      setConfirmDeleteCloudBackup(false);
      setPortalBackupFile(null);
      onDriveBackupDeleted();
      if (deleted) {
        onNotify(`Google Drive से "${PORTAL_BACKUP_FILENAME}" (Admin व पोर्टल स्टोरेज बैकअप) डिलीट कर दिया गया।`);
        await loadFiles();
      } else {
        onNotify('Google Drive में कोई पोर्टल बैकअप फ़ाइल मौजूद नहीं थी।');
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'DRIVE_AUTH_EXPIRED') {
        setConfirmDeleteCloudBackup(false);
        setNeedsAuth(true);
        setError('Google Drive सेशन समाप्त हो गया है। कृपया पुनः साइन इन करें।');
      } else {
        setError(
          err instanceof Error ? err.message : 'Google Drive से पोर्टल डाटा डिलीट करने में त्रुटि हुई।'
        );
      }
    } finally {
      setDeletingCloudBackup(false);
    }
  }

  const backupTargetFileName = dataset
    ? `${dataset.fileName.replace(/\.[^.]+$/, '').replace(/[^\w\s-]/g, '') || 'data'}_with_remarks.xlsx`
    : 'data_with_remarks.xlsx';

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900">Google Drive स्टोरेज</h1>
          <p className="text-sm text-slate-600 mt-1">
            {isAdmin
              ? 'Admin खाता, सभी यूज़र, Excel शीट और रिमार्क Google Drive में ऑटो-सेव रखें और सीधे Excel फ़ाइलें लोड/बैकअप करें।'
              : 'अपने Google Drive से फ़ाइलें खोजें, देखें और डाउनलोड करें।'}
          </p>
        </div>

        {!needsAuth && (
          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            {isAdmin && dataset && (
              <button
                type="button"
                disabled={uploadingBackup || Boolean(busyActionId)}
                onClick={() => setConfirmUploadBackup(true)}
                className="min-h-[46px] px-4 sm:px-5 rounded-xl bg-emerald-700 hover:bg-emerald-800 active:scale-[0.99] disabled:opacity-60 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-all whitespace-nowrap cursor-pointer"
              >
                <CloudUpload className="h-4 w-4" />
                <span>रिमार्क सहित Excel सेव करें</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => void handleDisconnect()}
              className="min-h-[46px] px-4 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-semibold text-sm inline-flex items-center gap-2 whitespace-nowrap cursor-pointer"
            >
              <LogOut className="h-4 w-4" />
              <span>डिस्कनेक्ट</span>
            </button>
          </div>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl bg-red-50 border border-red-200 px-4 py-3.5 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      {needsAuth ? (
        <section className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-10 text-center max-w-xl mx-auto">
          <HardDrive className="h-11 w-11 text-blue-700 mx-auto mb-4" />
          <h2 className="text-lg sm:text-xl font-bold text-slate-900">
            Google Drive से कनेक्ट करें
          </h2>
          <p className="text-sm text-slate-600 mt-2 max-w-md mx-auto leading-relaxed">
            {isAdmin
              ? 'अपने Google खाते से साइन इन करें ताकि आपका Admin खाता, सभी यूज़र, Excel शीट और सभी रिमार्क हमेशा Google Drive में सुरक्षित रहें और बार-बार नया Admin न बनाना पड़े।'
              : 'अपनी Google Drive फ़ाइलें देखने और डाउनलोड करने के लिए Google खाते से साइन इन करें।'}
          </p>

          <div className="mt-6 flex justify-center">
            <GoogleSignInButton
              onClick={() => void handleConnectGoogle()}
              loading={connecting}
              label="Sign in with Google"
            />
          </div>
        </section>
      ) : (
        <>
          {/* Admin Cloud Storage Auto-Sync Card */}
          {isAdmin && (
            <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <DatabaseBackup className="h-5 w-5 text-blue-700 shrink-0" />
                    <h2 className="text-base sm:text-lg font-bold text-slate-900">
                      पोर्टल स्थायी स्टोरेज (Google Drive ऑटो-सिंक)
                    </h2>
                  </div>
                  <p className="text-sm text-slate-600 leading-relaxed">
                    आपका Admin खाता, सभी यूज़र, Excel शीट और सभी रिमार्क Google Drive में{' '}
                    <span className="font-mono-tabular font-semibold text-slate-800">
                      {PORTAL_BACKUP_FILENAME}
                    </span>{' '}
                    फ़ाइल में सेव रहते हैं। यह डाटा केवल तभी हटेगा जब आप स्वयं इसे यहाँ से डिलीट करें।
                  </p>
                </div>

                {driveSyncEnabled && (
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 shrink-0">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>ऑटो-सिंक चालू</span>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 tabular-nums border-t border-slate-100 pt-3">
                <span>
                  बैकअप स्थिति:{' '}
                  <strong className="text-slate-900">
                    {portalBackupFile ? 'Google Drive में सुरक्षित है' : 'अभी सेव नहीं किया गया'}
                  </strong>
                </span>
                {(lastSyncedAt || portalBackupFile?.modifiedTime) && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      अंतिम सिंक:{' '}
                      <strong className="text-slate-900">
                        {formatHindiDateTime(lastSyncedAt || portalBackupFile?.modifiedTime || '')}
                      </strong>
                    </span>
                  </>
                )}
                {portalBackupFile?.size && Number(portalBackupFile.size) > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>आकार: {formatBytes(Number(portalBackupFile.size))}</span>
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2.5 pt-1">
                {driveSyncEnabled ? (
                  <button
                    type="button"
                    disabled={syncingDrive}
                    onClick={() => void onManualSyncNow()}
                    className="min-h-[44px] px-4 rounded-xl bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-sm font-semibold inline-flex items-center gap-2 cursor-pointer"
                  >
                    <RefreshCw className={`h-4 w-4 ${syncingDrive ? 'animate-spin' : ''}`} />
                    <span>{syncingDrive ? 'सिंक हो रहा है...' : 'अभी Google Drive में सिंक करें'}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={syncingDrive}
                    onClick={onRequestEnableSync}
                    className="min-h-[44px] px-4 rounded-xl bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-sm font-semibold inline-flex items-center gap-2 cursor-pointer"
                  >
                    <CloudUpload className="h-4 w-4" />
                    <span>Google Drive ऑटो-सिंक चालू करें</span>
                  </button>
                )}

                {portalBackupFile && (
                  <>
                    <button
                      type="button"
                      disabled={restoringCloud || syncingDrive}
                      onClick={() => setConfirmRestoreCloud(true)}
                      className="min-h-[44px] px-4 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-60 text-slate-800 text-sm font-semibold inline-flex items-center gap-2 cursor-pointer"
                    >
                      <RotateCcw className="h-4 w-4" />
                      <span>Drive से रिस्टोर करें</span>
                    </button>

                    <button
                      type="button"
                      disabled={deletingCloudBackup || syncingDrive}
                      onClick={() => setConfirmDeleteCloudBackup(true)}
                      className="min-h-[44px] px-4 rounded-xl border border-red-200 bg-white hover:bg-red-50 disabled:opacity-60 text-red-700 text-sm font-semibold inline-flex items-center gap-2 cursor-pointer"
                    >
                      <Trash2 className="h-4 w-4" />
                      <span>Admin व पोर्टल डाटा डिलीट करें</span>
                    </button>
                  </>
                )}
              </div>
            </section>
          )}

          {/* Connected Account Strip & Search Controls */}
          <section className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100 text-xs sm:text-sm text-slate-600">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-semibold text-slate-900">कनेक्टेड Google खाता:</span>
                <span>{googleUser?.displayName || 'Google User'}</span>
                {googleUser?.email && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono-tabular text-slate-700">{googleUser.email}</span>
                  </>
                )}
              </div>
              <button
                type="button"
                disabled={loadingFiles}
                onClick={() => void loadFiles()}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 hover:text-blue-900 disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loadingFiles ? 'animate-spin' : ''}`} />
                <span>रिफ्रेश करें</span>
              </button>
            </div>

            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <form onSubmit={handleSearchSubmit} className="flex-1 flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder="Google Drive में फ़ाइल नाम से खोजें..."
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 bg-white pl-10 pr-4 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
                  />
                </div>
                <button
                  type="submit"
                  className="min-h-[44px] px-4 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold whitespace-nowrap cursor-pointer"
                >
                  खोजें
                </button>
              </form>

              <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-xl shrink-0">
                <button
                  type="button"
                  onClick={() => setFilterMode('spreadsheets')}
                  className={`min-h-[38px] px-3 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                    filterMode === 'spreadsheets'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Excel / Sheets
                </button>
                <button
                  type="button"
                  onClick={() => setFilterMode('all')}
                  className={`min-h-[38px] px-3 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                    filterMode === 'all'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  सभी फ़ाइलें
                </button>
              </div>
            </div>

            {importProgress && (
              <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 space-y-2">
                <div className="flex items-center justify-between gap-2 text-xs sm:text-sm">
                  <span className="font-semibold text-blue-950 truncate">
                    पोर्टल में लोड हो रही है: {importingName}
                  </span>
                  <span className="font-mono-tabular font-semibold text-blue-800 shrink-0">
                    {importProgress.phase === 'processing'
                      ? 'प्रोसेसिंग...'
                      : `${importProgress.percent}%`}
                  </span>
                </div>
                <div className="w-full h-2 bg-blue-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      importProgress.phase === 'processing'
                        ? 'bg-emerald-600 animate-pulse w-full'
                        : 'bg-blue-700'
                    }`}
                    style={
                      importProgress.phase === 'uploading'
                        ? { width: `${importProgress.percent}%` }
                        : undefined
                    }
                  />
                </div>
              </div>
            )}
          </section>

          {/* Drive Files List */}
          <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-2">
              <h2 className="text-sm sm:text-base font-bold text-slate-900 tabular-nums">
                Google Drive फ़ाइलें ({files.length})
              </h2>
              <span className="text-xs text-slate-500">
                {filterMode === 'spreadsheets' ? 'Excel, CSV और Google Sheets' : 'सभी फ़ाइलें'}
              </span>
            </div>

            {loadingFiles ? (
              <div className="p-5 space-y-3">
                {[1, 2, 3, 4].map((n) => (
                  <div key={n} className="h-14 rounded-xl bg-slate-100 animate-pulse" />
                ))}
              </div>
            ) : files.length === 0 ? (
              <div className="p-8 text-center space-y-1.5">
                <p className="text-sm font-semibold text-slate-700">कोई फ़ाइल नहीं मिली।</p>
                <p className="text-xs text-slate-500">
                  {filterMode === 'spreadsheets'
                    ? 'आप "सभी फ़ाइलें" फ़िल्टर आज़मा सकते हैं या ऊपर सर्च बदल सकते हैं।'
                    : 'सर्च शब्द बदलकर पुनः खोजें।'}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-slate-200">
                {files.map((file) => {
                  const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
                  const isSheet = isSpreadsheetDriveFile(file);
                  const isGoogleWorkspaceDoc =
                    file.mimeType.startsWith('application/vnd.google-apps.') &&
                    file.mimeType !== GOOGLE_SHEET_MIME;
                  const isBusy = busyActionId === file.id;
                  const sizeNum = file.size ? Number(file.size) : NaN;

                  return (
                    <li
                      key={file.id}
                      className="px-4 sm:px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/70 transition-colors"
                    >
                      <div className="flex items-start gap-3 min-w-0">
                        <div className="mt-0.5 text-slate-500 shrink-0">
                          {isFolder ? (
                            <Folder className="h-5 w-5 text-amber-600" />
                          ) : isSheet ? (
                            <FileSpreadsheet className="h-5 w-5 text-emerald-700" />
                          ) : (
                            <FileText className="h-5 w-5 text-slate-500" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-900 break-all">
                            {file.name}
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 tabular-nums">
                            <span>{getDriveFileTypeLabel(file.mimeType, file.name)}</span>
                            {Number.isFinite(sizeNum) && sizeNum > 0 && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>{formatBytes(sizeNum)}</span>
                              </>
                            )}
                            {file.modifiedTime && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>{formatHindiDateTime(file.modifiedTime)}</span>
                              </>
                            )}
                          </p>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {isAdmin && isSheet && (
                          <button
                            type="button"
                            disabled={Boolean(busyActionId)}
                            onClick={() => requestImportFromDrive(file)}
                            className="min-h-[40px] px-3.5 rounded-xl bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                          >
                            <Upload className="h-3.5 w-3.5" />
                            <span>{isBusy ? 'लोड हो रहा है...' : 'पोर्टल में लोड करें'}</span>
                          </button>
                        )}

                        {!isFolder && !isGoogleWorkspaceDoc && (
                          <button
                            type="button"
                            disabled={Boolean(busyActionId)}
                            onClick={() => void handleDownloadLocal(file)}
                            className="min-h-[40px] px-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-60 text-slate-700 text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                          >
                            <Download className="h-3.5 w-3.5" />
                            <span>डाउनलोड</span>
                          </button>
                        )}

                        {!isFolder && (
                          <button
                            type="button"
                            disabled={Boolean(busyActionId)}
                            onClick={() => setConfirmDeleteFile(file)}
                            className="min-h-[40px] px-3 rounded-xl border border-red-200 bg-white hover:bg-red-50 disabled:opacity-60 text-red-700 text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>हटाएँ</span>
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {nextPageToken && (
              <div className="p-4 border-t border-slate-200 text-center">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => void loadFiles({ append: true, pageToken: nextPageToken })}
                  className="min-h-[44px] px-5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-sm font-semibold text-slate-800 disabled:opacity-60 cursor-pointer"
                >
                  {loadingMore ? 'और फ़ाइलें लोड हो रही हैं...' : 'और फ़ाइलें देखें'}
                </button>
              </div>
            )}
          </section>
        </>
      )}

      {/* Explicit Confirmation Modal: Save Excel + Remarks to Google Drive */}
      {confirmUploadBackup && dataset && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="drive-backup-title"
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-xl">
            <h3 id="drive-backup-title" className="text-lg font-bold text-slate-900">
              Google Drive में Excel सेव करें?
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              आपके Google Drive में नई फ़ाइल{' '}
              <strong className="text-slate-900 break-all">&quot;{backupTargetFileName}&quot;</strong>{' '}
              ({dataset.rowCount.toLocaleString('hi-IN')} रिकॉर्ड और{' '}
              {totalRemarks.toLocaleString('hi-IN')} रिमार्क सहित) अपलोड की जाएगी। क्या आप आगे बढ़ना
              चाहते हैं?
            </p>
            <div className="flex flex-wrap justify-end gap-2.5 pt-2">
              <button
                type="button"
                disabled={uploadingBackup}
                onClick={() => setConfirmUploadBackup(false)}
                className="min-h-[44px] px-4 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-sm font-medium text-slate-700 cursor-pointer"
              >
                रद्द करें
              </button>
              <button
                type="button"
                disabled={uploadingBackup}
                onClick={() => void executeBackupToDrive()}
                className="min-h-[44px] px-5 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white text-sm font-semibold inline-flex items-center gap-2 cursor-pointer"
              >
                <CloudUpload className="h-4 w-4" />
                <span>{uploadingBackup ? 'सेव हो रहा है...' : 'हाँ, Drive में सेव करें'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Explicit Confirmation Modal: Delete / Trash Individual File in Google Drive */}
      {confirmDeleteFile && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="drive-delete-title"
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-xl">
            <h3 id="drive-delete-title" className="text-lg font-bold text-red-900">
              Google Drive से फ़ाइल हटाएँ?
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              क्या आप वाकई Google Drive की फ़ाइल{' '}
              <strong className="text-slate-900 break-all">&quot;{confirmDeleteFile.name}&quot;</strong> को
              Trash में भेजना चाहते हैं?
            </p>
            <div className="flex flex-wrap justify-end gap-2.5 pt-2">
              <button
                type="button"
                disabled={deletingFile}
                onClick={() => setConfirmDeleteFile(null)}
                className="min-h-[44px] px-4 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-sm font-medium text-slate-700 cursor-pointer"
              >
                रद्द करें
              </button>
              <button
                type="button"
                disabled={deletingFile}
                onClick={() => void executeDeleteDriveFile()}
                className="min-h-[44px] px-5 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-semibold inline-flex items-center gap-2 cursor-pointer"
              >
                <Trash2 className="h-4 w-4" />
                <span>{deletingFile ? 'हटाया जा रहा है...' : 'हाँ, Drive से हटाएँ'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Explicit Confirmation Modal: Replace Portal Dataset with Drive File */}
      {confirmImportFile && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="drive-import-title"
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-xl">
            <h3 id="drive-import-title" className="text-lg font-bold text-slate-900">
              वर्तमान शीट बदलें?
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              वर्तमान पोर्टल शीट में अभी <strong className="tabular-nums">{totalRemarks}</strong> रिमार्क
              दर्ज हैं। क्या आप Google Drive से{' '}
              <strong className="text-slate-900 break-all">&quot;{confirmImportFile.name}&quot;</strong>{' '}
              लोड करके इसे बदलना चाहते हैं?
            </p>
            <div className="flex flex-wrap justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setConfirmImportFile(null)}
                className="min-h-[44px] px-4 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-sm font-medium text-slate-700 cursor-pointer"
              >
                रद्द करें
              </button>
              <button
                type="button"
                onClick={() => void executeImportFromDrive(confirmImportFile)}
                className="min-h-[44px] px-5 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold cursor-pointer"
              >
                हाँ, Drive से लोड करें
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Explicit Confirmation Modal: Restore Full Portal Snapshot from Google Drive */}
      {confirmRestoreCloud && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="drive-restore-cloud-title"
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-xl">
            <h3 id="drive-restore-cloud-title" className="text-lg font-bold text-slate-900">
              Google Drive से पूरा डाटा रिस्टोर करें?
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              इससे Google Drive की{' '}
              <strong className="font-mono-tabular text-slate-900">{PORTAL_BACKUP_FILENAME}</strong>{' '}
              फ़ाइल से सभी Admin/यूज़र खाते, Excel डाटा और रिमार्क वर्तमान पोर्टल में रिस्टोर हो जाएंगे।
            </p>
            <div className="flex flex-wrap justify-end gap-2.5 pt-2">
              <button
                type="button"
                disabled={restoringCloud}
                onClick={() => setConfirmRestoreCloud(false)}
                className="min-h-[44px] px-4 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-sm font-medium text-slate-700 cursor-pointer"
              >
                रद्द करें
              </button>
              <button
                type="button"
                disabled={restoringCloud}
                onClick={() => void executeRestorePortalFromCloud()}
                className="min-h-[44px] px-5 rounded-xl bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-sm font-semibold inline-flex items-center gap-2 cursor-pointer"
              >
                <RotateCcw className="h-4 w-4" />
                <span>{restoringCloud ? 'रिस्टोर हो रहा है...' : 'हाँ, रिस्टोर करें'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Explicit Confirmation Modal: Delete Cloud Portal Backup (Admin Account & All Data) from Google Drive */}
      {confirmDeleteCloudBackup && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="drive-delete-cloud-title"
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-xl">
            <h3 id="drive-delete-cloud-title" className="text-lg font-bold text-red-900">
              Google Drive से Admin व पोर्टल डाटा डिलीट करें?
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              इससे आपके Google Drive में सेव{' '}
              <strong className="font-mono-tabular text-slate-900">{PORTAL_BACKUP_FILENAME}</strong>{' '}
              फ़ाइल (जिसमें Admin खाता, सभी यूज़र, Excel शीट और रिमार्क सेव हैं) Trash में चली जाएगी
              और Google Drive ऑटो-सिंक बंद हो जाएगा।
            </p>
            <div className="flex flex-wrap justify-end gap-2.5 pt-2">
              <button
                type="button"
                disabled={deletingCloudBackup}
                onClick={() => setConfirmDeleteCloudBackup(false)}
                className="min-h-[44px] px-4 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-sm font-medium text-slate-700 cursor-pointer"
              >
                रद्द करें
              </button>
              <button
                type="button"
                disabled={deletingCloudBackup}
                onClick={() => void executeDeleteCloudPortalBackup()}
                className="min-h-[44px] px-5 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-semibold inline-flex items-center gap-2 cursor-pointer"
              >
                <Trash2 className="h-4 w-4" />
                <span>
                  {deletingCloudBackup ? 'डिलीट हो रहा है...' : 'हाँ, Google Drive से डिलीट करें'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
