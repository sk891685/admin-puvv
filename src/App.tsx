import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudUpload, FileUp, HardDrive, LogOut, RefreshCw, Search, Users } from 'lucide-react';
import {
  exportPortalSnapshotApi,
  fetchAuthStatus,
  fetchDataset,
  logoutSession,
  setAuthToken,
} from './api';
import { DataSearchView } from './components/DataSearchView';
import { GoogleDrivePanel } from './components/GoogleDrivePanel';
import { GoogleSignInButton } from './components/GoogleSignInButton';
import { LoginView } from './components/LoginView';
import { PuvvnlLogo } from './components/PuvvnlLogo';
import { RemarkSheet } from './components/RemarkSheet';
import { UploadPanel } from './components/UploadPanel';
import { UserManagement } from './components/UserManagement';
import {
  disconnectGoogleDrive,
  getDriveAccessToken,
  PORTAL_BACKUP_FILENAME,
  savePortalBackupToDrive,
  signInWithGoogleDrive,
} from './lib/googleDriveAuth';
import type {
  AuthStatus,
  DatasetInfo,
  DatasetQuery,
  DatasetRow,
  RemarkItem,
  RestoreSummary,
  User,
} from './types';
import { formatHindiDateTime, ROLE_META } from './types';

type ActiveTab = 'search' | 'upload' | 'drive' | 'users';

const DEFAULT_QUERY: DatasetQuery = {
  q: '',
  column: '__ALL__',
  value: '__ALL__',
  remarkFilter: 'all',
  page: 1,
  pageSize: 25,
};

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);

  const [activeTab, setActiveTab] = useState<ActiveTab>('search');
  const [dataset, setDataset] = useState<DatasetInfo | null>(null);
  const [rows, setRows] = useState<DatasetRow[]>([]);
  const [remarksByRow, setRemarksByRow] = useState<Record<string, RemarkItem[]>>({});
  const [totalFiltered, setTotalFiltered] = useState(0);
  const [rowsWithRemarksCount, setRowsWithRemarksCount] = useState(0);
  const [totalVisibleRemarks, setTotalVisibleRemarks] = useState(0);
  const [datasetQuery, setDatasetQuery] = useState<DatasetQuery>(DEFAULT_QUERY);
  const [datasetLoading, setDatasetLoading] = useState(false);

  const [selectedRow, setSelectedRow] = useState<DatasetRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Google Drive Cloud Storage Auto-Sync state (for Admin)
  const [driveSyncEnabled, setDriveSyncEnabled] = useState(false);
  const [syncingDrive, setSyncingDrive] = useState(false);
  const [connectingSync, setConnectingSync] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [showEnableSyncModal, setShowEnableSyncModal] = useState(false);
  const [syncBannerDismissed, setSyncBannerDismissed] = useState(false);
  const syncInFlightRef = useRef(false);

  const showToast = useCallback((message: string) => {
    setToast(message);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const loadAuthStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const status = await fetchAuthStatus();
      setAuthStatus(status);
    } catch {
      setStatusError('सर्वर से संपर्क नहीं हो पा रहा है। कृपया पेज रिफ्रेश करें।');
    }
  }, []);

  useEffect(() => {
    void loadAuthStatus();
  }, [loadAuthStatus]);

  const syncPortalToDrive = useCallback(
    async (options: { notify?: boolean; enableAfter?: boolean } = {}) => {
      if (syncInFlightRef.current) return;
      const token = getDriveAccessToken();
      if (!token) {
        if (options.notify) {
          showToast('Google Drive सेशन समाप्त हो गया है—कृपया दोबारा Google Drive कनेक्ट करें।');
        }
        setDriveSyncEnabled(false);
        return;
      }

      syncInFlightRef.current = true;
      setSyncingDrive(true);
      try {
        const { snapshot } = await exportPortalSnapshotApi();
        const saved = await savePortalBackupToDrive(token, snapshot);
        setLastSyncedAt(saved.modifiedTime ?? new Date().toISOString());
        if (options.enableAfter) {
          setDriveSyncEnabled(true);
        }
        if (options.notify) {
          showToast(`पूरा पोर्टल डाटा Google Drive (${PORTAL_BACKUP_FILENAME}) में सुरक्षित सेव हो गया।`);
        }
      } catch (err) {
        if (err instanceof Error && err.message === 'DRIVE_AUTH_EXPIRED') {
          setDriveSyncEnabled(false);
          showToast('Google Drive सेशन समाप्त हो गया है। ऑटो-सिंक के लिए पुनः कनेक्ट करें।');
        } else if (options.notify) {
          showToast(
            err instanceof Error ? err.message : 'Google Drive में डाटा सिंक करने में त्रुटि हुई।'
          );
        }
      } finally {
        syncInFlightRef.current = false;
        setSyncingDrive(false);
      }
    },
    [showToast]
  );

  const triggerAutoSyncIfEnabled = useCallback(() => {
    if (currentUser?.role === 'admin' && driveSyncEnabled && getDriveAccessToken()) {
      void syncPortalToDrive({ notify: false });
    }
  }, [currentUser?.role, driveSyncEnabled, syncPortalToDrive]);

  async function handleStartEnableDriveSync() {
    if (getDriveAccessToken()) {
      setShowEnableSyncModal(true);
      return;
    }
    setConnectingSync(true);
    try {
      await signInWithGoogleDrive();
      setShowEnableSyncModal(true);
    } catch (err) {
      const code =
        typeof err === 'object' && err && 'code' in err
          ? String((err as { code?: unknown }).code)
          : '';
      if (code === 'auth/popup-closed-by-user') {
        showToast('Google साइन-इन रद्द कर दिया गया।');
      } else if (code === 'auth/popup-blocked') {
        showToast('कृपया ब्राउज़र में पॉपअप अनुमति दें और पुनः प्रयास करें।');
      } else {
        showToast(err instanceof Error ? err.message : 'Google Drive कनेक्ट करने में त्रुटि हुई।');
      }
    } finally {
      setConnectingSync(false);
    }
  }

  async function handleConfirmEnableDriveSync() {
    setShowEnableSyncModal(false);
    await syncPortalToDrive({ notify: true, enableAfter: true });
  }

  const loadDataset = useCallback(
    async (overrideQuery?: DatasetQuery) => {
      const activeQuery = overrideQuery ?? datasetQuery;
      setDatasetLoading(true);
      try {
        const payload = await fetchDataset(activeQuery);
        setDataset(payload.dataset);
        setRows(payload.rows);
        setRemarksByRow(payload.remarksByRow);
        setTotalFiltered(payload.totalFiltered);
        setRowsWithRemarksCount(payload.rowsWithRemarksCount);
        setTotalVisibleRemarks(payload.totalVisibleRemarks);
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'डाटा लोड करने में समस्या आई।');
      } finally {
        setDatasetLoading(false);
      }
    },
    [datasetQuery, showToast]
  );

  useEffect(() => {
    if (currentUser) {
      void loadDataset();
    }
  }, [currentUser, loadDataset]);

  const handleQueryChange = useCallback((patch: Partial<DatasetQuery>) => {
    setDatasetQuery((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleDatasetReplaced = useCallback(async () => {
    setDatasetQuery(DEFAULT_QUERY);
    await loadDataset(DEFAULT_QUERY);
    triggerAutoSyncIfEnabled();
  }, [loadDataset, triggerAutoSyncIfEnabled]);

  const handleRestoredFromDriveOnLogin = useCallback(
    async (_summary: RestoreSummary) => {
      await loadAuthStatus();
    },
    [loadAuthStatus]
  );

  const handlePortalRestoredInSession = useCallback(
    async (summary: RestoreSummary) => {
      await logoutSession();
      setCurrentUser(null);
      setDataset(null);
      setRows([]);
      setRemarksByRow({});
      setTotalFiltered(0);
      setRowsWithRemarksCount(0);
      setTotalVisibleRemarks(0);
      setDatasetQuery(DEFAULT_QUERY);
      setSelectedRow(null);
      setActiveTab('search');
      setDriveSyncEnabled(false);
      await loadAuthStatus();
      showToast(
        `Google Drive से डाटा रिस्टोर हुआ (${summary.userCount} यूज़र, ${summary.rowCount} रिकॉर्ड)। कृपया पुनः लॉगिन करें।`
      );
    },
    [loadAuthStatus, showToast]
  );

  function handleAuthenticated(token: string, user: User, justCreatedAdmin = false) {
    setAuthToken(token);
    setCurrentUser(user);
    setDatasetQuery(DEFAULT_QUERY);
    setActiveTab('search');
    setSyncBannerDismissed(false);
    setAuthStatus((prev) =>
      prev
        ? { ...prev, needsAdminSetup: false }
        : { needsAdminSetup: false, envAdminConfigured: false }
    );
    if (user.role === 'admin' && justCreatedAdmin) {
      showToast(
        'Admin खाता बन गया! अब नीचे "Google Drive ऑटो-सिंक चालू करें" दबाकर इसे हमेशा के लिए Google Drive में सेव करें।'
      );
    }
  }

  async function handleLogout() {
    await logoutSession();
    try {
      await disconnectGoogleDrive();
    } catch {
      // ignore if Google Drive was not connected
    }
    setCurrentUser(null);
    setDataset(null);
    setRows([]);
    setRemarksByRow({});
    setTotalFiltered(0);
    setRowsWithRemarksCount(0);
    setTotalVisibleRemarks(0);
    setDatasetQuery(DEFAULT_QUERY);
    setSelectedRow(null);
    setActiveTab('search');
    setDriveSyncEnabled(false);
    setLastSyncedAt(null);
    setShowEnableSyncModal(false);
    void loadAuthStatus();
  }

  function handleRemarkAdded(rowId: number, remark: RemarkItem) {
    setRemarksByRow((prev) => {
      const key = String(rowId);
      const hadRemarks = (prev[key]?.length ?? 0) > 0;
      if (!hadRemarks) {
        setRowsWithRemarksCount((c) => c + 1);
      }
      return {
        ...prev,
        [key]: [remark, ...(prev[key] ?? [])],
      };
    });
    setTotalVisibleRemarks((c) => c + 1);
    triggerAutoSyncIfEnabled();
  }

  function handleRemarkUpdated(rowId: number, updated: RemarkItem) {
    setRemarksByRow((prev) => {
      const key = String(rowId);
      return {
        ...prev,
        [key]: (prev[key] ?? []).map((r) => (r.id === updated.id ? updated : r)),
      };
    });
    triggerAutoSyncIfEnabled();
  }

  function handleRemarkDeleted(rowId: number, remarkId: number) {
    setRemarksByRow((prev) => {
      const key = String(rowId);
      const nextList = (prev[key] ?? []).filter((r) => r.id !== remarkId);
      if (nextList.length === 0 && (prev[key]?.length ?? 0) > 0) {
        setRowsWithRemarksCount((c) => Math.max(0, c - 1));
      }
      return {
        ...prev,
        [key]: nextList,
      };
    });
    setTotalVisibleRemarks((c) => Math.max(0, c - 1));
    triggerAutoSyncIfEnabled();
  }

  if (statusError) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="bg-white border border-slate-200 rounded-2xl p-6 max-w-md w-full text-center space-y-4">
          <PuvvnlLogo size="md" className="mx-auto" />
          <p className="text-sm text-red-700 font-medium">{statusError}</p>
          <button
            type="button"
            onClick={() => void loadAuthStatus()}
            className="min-h-[44px] px-5 rounded-xl bg-blue-700 text-white text-sm font-semibold hover:bg-blue-800 cursor-pointer"
          >
            पुनः प्रयास करें
          </button>
        </div>
      </div>
    );
  }

  if (!authStatus) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="text-center space-y-3">
          <PuvvnlLogo size="md" className="mx-auto" />
          <p className="text-sm font-medium text-slate-600">पोर्टल लोड हो रहा है...</p>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <LoginView
        authStatus={authStatus}
        onAuthenticated={handleAuthenticated}
        onRestoredFromDrive={handleRestoredFromDriveOnLogin}
      />
    );
  }

  const isAdmin = currentUser.role === 'admin';
  const navItems: Array<{ id: ActiveTab; label: string; icon: typeof Search }> = isAdmin
    ? [
        { id: 'search', label: 'डाटा खोजें', icon: Search },
        { id: 'upload', label: 'Excel प्रबंधन', icon: FileUp },
        { id: 'drive', label: 'Google Drive', icon: HardDrive },
        { id: 'users', label: 'यूज़र प्रबंधन', icon: Users },
      ]
    : [
        { id: 'search', label: 'डाटा खोजें', icon: Search },
        { id: 'drive', label: 'Google Drive', icon: HardDrive },
      ];

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Top Bar: Clean 3-zone contract */}
      <header className="sticky top-0 z-30 h-14 bg-white/95 backdrop-blur-xs border-b border-slate-200 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto h-full flex items-center justify-between gap-8">
          {/* Zone 1: Brand Wordmark */}
          <button
            type="button"
            onClick={() => setActiveTab('search')}
            className="flex items-center gap-2.5 text-left whitespace-nowrap shrink-0 cursor-pointer"
          >
            <PuvvnlLogo size="sm" />
            <span className="text-base sm:text-lg font-bold tracking-tight text-slate-900">
              PuVVNL डाटा पोर्टल
            </span>
          </button>

          {/* Zone 2: Concise single-line desktop nav links */}
          <nav
            aria-label="मुख्य नेविगेशन"
            className="hidden md:flex items-center gap-7 text-sm font-medium"
          >
            {navItems.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`py-4 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    isActive
                      ? 'border-blue-700 text-blue-800 font-semibold'
                      : 'border-transparent text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: Single primary action */}
          <div className="shrink-0">
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="min-h-[40px] px-3.5 sm:px-4 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-slate-800 text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <LogOut className="h-4 w-4" />
              <span>लॉगआउट</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-7 pb-24 md:pb-10">
        {/* Clean Unboxed User Identity Line */}
        <div className="mb-5 pb-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm text-slate-600">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-semibold text-slate-900">{currentUser.fullName}</span>
            <span aria-hidden="true">·</span>
            <span className="font-medium text-blue-800">
              {ROLE_META[currentUser.role].hindiLabel}
            </span>
            {currentUser.role === 'lineman' && currentUser.supervisorName && (
              <>
                <span aria-hidden="true">·</span>
                <span>सुपरवाइज़र: {currentUser.supervisorName}</span>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            {isAdmin && driveSyncEnabled ? (
              <button
                type="button"
                disabled={syncingDrive}
                onClick={() => void syncPortalToDrive({ notify: true })}
                className="inline-flex items-center gap-1.5 font-medium text-emerald-700 hover:text-emerald-900 cursor-pointer"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${syncingDrive ? 'animate-spin' : ''}`} />
                <span>
                  {syncingDrive
                    ? 'Google Drive में सेव हो रहा है...'
                    : lastSyncedAt
                    ? `Google Drive सिंक चालू · ${formatHindiDateTime(lastSyncedAt)}`
                    : 'Google Drive ऑटो-सिंक चालू'}
                </span>
              </button>
            ) : (
              <span>{ROLE_META[currentUser.role].permissionSummary}</span>
            )}
          </div>
        </div>

        {/* Admin Google Drive Auto-Sync Prompt Banner (shown until enabled or dismissed) */}
        {isAdmin && !driveSyncEnabled && !syncBannerDismissed && (
          <div className="mb-5 rounded-2xl bg-blue-50/90 border border-blue-200 px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-0.5 min-w-0">
              <p className="text-sm font-bold text-blue-950">
                Admin खाता और पूरा डाटा Google Drive में ऑटो-सेव रखें
              </p>
              <p className="text-xs sm:text-sm text-blue-900/90 leading-relaxed">
                एक बार Google Drive ऑटो-सिंक चालू करने पर आपका Admin खाता, सभी यूज़र, Excel शीट और रिमार्क लगातार Google Drive में सेव होते रहेंगे।
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {getDriveAccessToken() ? (
                <button
                  type="button"
                  onClick={() => setShowEnableSyncModal(true)}
                  className="min-h-[44px] px-4 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold inline-flex items-center gap-2 whitespace-nowrap cursor-pointer"
                >
                  <CloudUpload className="h-4 w-4" />
                  <span>Google Drive ऑटो-सिंक चालू करें</span>
                </button>
              ) : (
                <GoogleSignInButton
                  onClick={() => void handleStartEnableDriveSync()}
                  loading={connectingSync}
                  label="Sign in with Google (ऑटो-सिंक)"
                />
              )}
              <button
                type="button"
                onClick={() => setSyncBannerDismissed(true)}
                className="min-h-[40px] px-3 text-xs font-semibold text-blue-900/70 hover:text-blue-950 cursor-pointer"
              >
                बाद में
              </button>
            </div>
          </div>
        )}

        {/* Inline Toast Feedback */}
        {toast && (
          <div
            role="status"
            className="mb-5 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm font-medium text-emerald-900 flex items-center justify-between gap-3"
          >
            <span>{toast}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="text-xs font-semibold text-emerald-800 hover:underline cursor-pointer shrink-0"
            >
              ठीक है
            </button>
          </div>
        )}

        {activeTab === 'search' && (
          <DataSearchView
            currentUser={currentUser}
            dataset={dataset}
            rows={rows}
            remarksByRow={remarksByRow}
            totalFiltered={totalFiltered}
            rowsWithRemarksCount={rowsWithRemarksCount}
            query={datasetQuery}
            loading={datasetLoading}
            onQueryChange={handleQueryChange}
            onSelectRowForRemark={(row) => setSelectedRow(row)}
            onGoToUpload={() => setActiveTab('upload')}
            onNotify={showToast}
          />
        )}

        {activeTab === 'upload' && isAdmin && (
          <UploadPanel
            dataset={dataset}
            totalRemarks={totalVisibleRemarks}
            onDatasetChanged={handleDatasetReplaced}
            onNotify={showToast}
            onOpenSearch={() => setActiveTab('search')}
            onOpenDrive={() => setActiveTab('drive')}
          />
        )}

        {activeTab === 'drive' && (
          <GoogleDrivePanel
            currentUser={currentUser}
            dataset={dataset}
            totalRemarks={totalVisibleRemarks}
            driveSyncEnabled={driveSyncEnabled}
            syncingDrive={syncingDrive}
            lastSyncedAt={lastSyncedAt}
            onRequestEnableSync={() => void handleStartEnableDriveSync()}
            onManualSyncNow={() => syncPortalToDrive({ notify: true })}
            onDriveBackupDeleted={() => {
              setDriveSyncEnabled(false);
              setLastSyncedAt(null);
            }}
            onDatasetChanged={handleDatasetReplaced}
            onPortalRestored={handlePortalRestoredInSession}
            onNotify={showToast}
            onOpenSearch={() => setActiveTab('search')}
          />
        )}

        {activeTab === 'users' && isAdmin && (
          <UserManagement
            currentUser={currentUser}
            onNotify={showToast}
            onUsersChanged={triggerAutoSyncIfEnabled}
          />
        )}
      </main>

      {/* Mobile Fixed Bottom Tab Bar */}
      <nav
        aria-label="मोबाइल नेविगेशन"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-slate-200 pb-safe"
      >
        <div className={`grid h-14 ${isAdmin ? 'grid-cols-4' : 'grid-cols-2'}`}>
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer ${
                  isActive ? 'text-blue-700 font-semibold' : 'text-slate-500'
                }`}
              >
                <Icon className="h-5 w-5" />
                <span className="text-[11px] leading-tight whitespace-nowrap">{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Remark Bottom Sheet / Desktop Slide-Over */}
      <RemarkSheet
        row={selectedRow}
        headers={dataset?.headers ?? []}
        remarks={selectedRow ? remarksByRow[String(selectedRow.id)] ?? [] : []}
        currentUser={currentUser}
        onClose={() => setSelectedRow(null)}
        onRemarkAdded={handleRemarkAdded}
        onRemarkUpdated={handleRemarkUpdated}
        onRemarkDeleted={handleRemarkDeleted}
        onNotify={showToast}
      />

      {/* Explicit Confirmation Modal: Enable Google Drive Cloud Storage Auto-Sync */}
      {showEnableSyncModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="enable-drive-sync-title"
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-xl">
            <h3 id="enable-drive-sync-title" className="text-lg font-bold text-slate-900">
              Google Drive में पोर्टल डाटा सेव और ऑटो-सिंक करें?
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              आपके Google Drive में{' '}
              <strong className="font-mono-tabular text-slate-900">{PORTAL_BACKUP_FILENAME}</strong>{' '}
              फ़ाइल बनाई/अपडेट की जाएगी, जिसमें Admin और सभी यूज़र खाते, Excel डाटा तथा सभी रिमार्क सेव रहेंगे। इसके बाद हर बदलाव अपने-आप Google Drive में अपडेट होता रहेगा।
            </p>
            <div className="flex flex-wrap justify-end gap-2.5 pt-2">
              <button
                type="button"
                disabled={syncingDrive}
                onClick={() => setShowEnableSyncModal(false)}
                className="min-h-[44px] px-4 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-sm font-medium text-slate-700 cursor-pointer"
              >
                रद्द करें
              </button>
              <button
                type="button"
                disabled={syncingDrive}
                onClick={() => void handleConfirmEnableDriveSync()}
                className="min-h-[44px] px-5 rounded-xl bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-sm font-semibold inline-flex items-center gap-2 cursor-pointer"
              >
                <CloudUpload className="h-4 w-4" />
                <span>हाँ, Google Drive में सेव और सिंक चालू करें</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
