import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  Eye,
  EyeOff,
  HardDrive,
  Lock,
  Mail,
  Phone,
  ShieldCheck,
  User as UserIcon,
} from 'lucide-react';
import {
  loginWithPassword,
  restorePortalSnapshotApi,
  setupFirstAdmin,
} from '../api';
import {
  hasKnownDriveBackupHint,
  loadPortalBackupFromDrive,
  PORTAL_BACKUP_FILENAME,
  signInWithGoogleDrive,
} from '../lib/googleDriveAuth';
import type { AuthStatus, RestoreSummary, User } from '../types';
import { GoogleSignInButton } from './GoogleSignInButton';
import { PuvvnlLogo } from './PuvvnlLogo';

interface LoginViewProps {
  authStatus: AuthStatus;
  onAuthenticated: (token: string, user: User, justCreatedAdmin?: boolean) => void;
  onRestoredFromDrive: (summary: RestoreSummary) => Promise<void>;
}

export function LoginView({
  authStatus,
  onAuthenticated,
  onRestoredFromDrive,
}: LoginViewProps) {
  const isSetupMode = authStatus.needsAdminSetup;
  const [hasDriveHint] = useState<boolean>(() => hasKnownDriveBackupHint());
  const [showCreateAdminForm, setShowCreateAdminForm] = useState<boolean>(
    () => !hasKnownDriveBackupHint()
  );

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [restoringDrive, setRestoringDrive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  async function handleRestoreFromGoogleDrive() {
    setError(null);
    setInfoMsg(null);
    setRestoringDrive(true);
    try {
      const session = await signInWithGoogleDrive();
      const backup = await loadPortalBackupFromDrive(session.accessToken);
      if (!backup) {
        setShowCreateAdminForm(true);
        setInfoMsg(
          `आपके Google Drive में "${PORTAL_BACKUP_FILENAME}" नहीं मिला। कृपया नीचे अपना नया Admin खाता बनाएँ — बनाते ही यह Google Drive में सेव हो जाएगा।`
        );
        return;
      }

      const restored = await restorePortalSnapshotApi(backup.snapshot);
      await onRestoredFromDrive(restored.summary);
      setInfoMsg(
        `Google Drive से आपका Admin खाता (${restored.summary.userCount} यूज़र` +
          (restored.summary.datasetFileName
            ? `, ${restored.summary.rowCount.toLocaleString('hi-IN')} रिकॉर्ड और ${restored.summary.remarkCount} रिमार्क`
            : '') +
          `) सफलतापूर्वक रिस्टोर हो गया! अब अपनी यूज़र आईडी और पासवर्ड से लॉगिन करें।`
      );
    } catch (err) {
      const code =
        typeof err === 'object' && err && 'code' in err
          ? String((err as { code?: unknown }).code)
          : '';
      if (code === 'auth/popup-closed-by-user') {
        setError('Google साइन-इन पॉपअप बंद हो गया। कृपया पुनः प्रयास करें।');
      } else if (code === 'auth/popup-blocked') {
        setError('ब्राउज़र ने साइन-इन पॉपअप रोक दिया। कृपया पॉपअप अनुमति दें और पुनः प्रयास करें।');
      } else {
        setError(
          err instanceof Error ? err.message : 'Google Drive से डाटा रिस्टोर करने में त्रुटि हुई।'
        );
      }
    } finally {
      setRestoringDrive(false);
    }
  }

  async function handleSetupSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfoMsg(null);
    if (password !== confirmPassword) {
      setError('दोनों पासवर्ड एक समान होने चाहिए।');
      return;
    }
    setSubmitting(true);
    try {
      const res = await setupFirstAdmin({
        username: username.trim(),
        email,
        mobile,
        fullName,
        password,
      });
      onAuthenticated(res.token, res.user, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'एडमिन सेटअप में त्रुटि हुई।');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLoginSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await loginWithPassword(username, password);
      onAuthenticated(res.token, res.user, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'लॉगिन विफल रहा।');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="bg-white border-b border-slate-200 px-4 sm:px-8 py-3.5">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <PuvvnlLogo size="sm" />
            <span className="text-base sm:text-lg font-bold tracking-tight text-slate-900 truncate">
              PuVVNL डाटा रिमार्क पोर्टल
            </span>
          </div>
          <span className="text-xs sm:text-sm text-slate-500 whitespace-nowrap shrink-0">
            पूर्वांचल विद्युत वितरण निगम लि.
          </span>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-8 sm:py-12">
        <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
          {/* Left PuVVNL Identity Panel */}
          <section className="lg:col-span-5 bg-blue-950 text-white rounded-2xl p-6 sm:p-9 flex flex-col items-center justify-center text-center">
            <PuvvnlLogo size="lg" className="p-1.5 shadow-sm mb-5" />
            <p className="text-xs sm:text-sm text-blue-200 font-medium">
              पूर्वांचल विद्युत वितरण निगम लिमिटेड
            </p>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mt-2">
              Excel डाटा सर्च एवं रिमार्क पोर्टल
            </h1>
            <p className="text-sm text-blue-100/90 leading-relaxed mt-4 max-w-xs">
              उपभोक्ता संख्या, नाम, फीडर और ट्रांसफार्मर के अनुसार रिकॉर्ड खोजें और फील्ड रिमार्क दर्ज करें।
            </p>
          </section>

          {/* Right Authentication Panel */}
          <section className="lg:col-span-7 bg-white border border-slate-200 rounded-2xl p-6 sm:p-10 flex flex-col justify-center">
            {isSetupMode ? (
              <>
                {infoMsg && (
                  <div className="mb-4 rounded-xl bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-900">
                    {infoMsg}
                  </div>
                )}

                {error && (
                  <div
                    role="alert"
                    className="mb-4 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800"
                  >
                    {error}
                  </div>
                )}

                {!showCreateAdminForm ? (
                  /* Known Google Drive Backup: Restore first so user is NEVER asked to recreate Admin */
                  <div className="space-y-5">
                    <div>
                      <div className="flex items-center gap-2 text-blue-800 mb-2">
                        <HardDrive className="h-5 w-5" />
                        <span className="text-xs font-semibold uppercase tracking-wider">
                          Google Drive स्टोरेज
                        </span>
                      </div>
                      <h2 className="text-xl sm:text-2xl font-bold text-slate-900">
                        अपना सेव किया हुआ Admin खाता व डाटा लोड करें
                      </h2>
                      <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">
                        आपका Admin खाता, सभी यूज़र, Excel शीट और रिमार्क आपके Google Drive में सुरक्षित हैं। नया खाता बनाने की ज़रूरत नहीं—Google Drive से तुरंत रिस्टोर करें।
                      </p>
                    </div>

                    <div className="pt-1">
                      <GoogleSignInButton
                        onClick={() => void handleRestoreFromGoogleDrive()}
                        loading={restoringDrive}
                        label="Sign in with Google (डाटा रिस्टोर करें)"
                      />
                    </div>

                    <div className="pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                      <span>यदि आपने Google Drive से पुराना बैकअप डिलीट कर दिया है:</span>
                      <button
                        type="button"
                        onClick={() => setShowCreateAdminForm(true)}
                        className="font-semibold text-blue-700 hover:underline cursor-pointer"
                      >
                        नया Admin खाता बनाएँ
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Restore from Google Drive bar above fresh Admin setup */}
                    <div className="mb-5 rounded-xl bg-slate-50 border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900">
                          पहले से Admin खाता Google Drive में सेव है?
                        </p>
                        <p className="text-xs text-slate-600 mt-0.5">
                          दोबारा खाता बनाए बिना सीधे Google Drive से रिस्टोर करें।
                        </p>
                      </div>
                      <div className="shrink-0">
                        <GoogleSignInButton
                          onClick={() => void handleRestoreFromGoogleDrive()}
                          loading={restoringDrive}
                          label="Sign in with Google"
                        />
                      </div>
                    </div>

                    <div className="mb-5">
                      <h2 className="text-xl sm:text-2xl font-bold text-slate-900">
                        Admin User ID और Password बनाएँ
                      </h2>
                      <p className="text-sm text-slate-600 mt-1">
                        पहली बार पोर्टल शुरू करने के लिए अपनी यूज़र आईडी, ईमेल, मोबाइल नंबर और पासवर्ड तय करें।
                      </p>
                    </div>

                    <form onSubmit={handleSetupSubmit} className="space-y-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label htmlFor="setup-fullname" className="block text-sm font-semibold text-slate-800 mb-1.5">
                            एडमिन का पूरा नाम
                          </label>
                          <input
                            id="setup-fullname"
                            type="text"
                            required
                            value={fullName}
                            onChange={(e) => setFullName(e.target.value)}
                            placeholder="जैसे: राजेश कुमार सिंह"
                            className="w-full min-h-[48px] rounded-xl border border-slate-300 bg-white px-4 text-base text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
                          />
                        </div>

                        <div>
                          <label htmlFor="setup-username" className="block text-sm font-semibold text-slate-800 mb-1.5">
                            यूज़र आईडी (User ID)
                          </label>
                          <div className="relative">
                            <UserIcon className="h-5 w-5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                            <input
                              id="setup-username"
                              type="text"
                              autoComplete="username"
                              required
                              minLength={3}
                              maxLength={32}
                              value={username}
                              onChange={(e) => setUsername(e.target.value)}
                              placeholder="जैसे: admin या rajesh01"
                              className="w-full min-h-[48px] rounded-xl border border-slate-300 bg-white pl-11 pr-4 text-base text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
                            />
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label htmlFor="setup-email" className="block text-sm font-semibold text-slate-800 mb-1.5">
                            ईमेल आईडी (Email)
                          </label>
                          <div className="relative">
                            <Mail className="h-5 w-5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                            <input
                              id="setup-email"
                              type="email"
                              autoComplete="email"
                              required
                              value={email}
                              onChange={(e) => setEmail(e.target.value)}
                              placeholder="example@gmail.com"
                              className="w-full min-h-[48px] rounded-xl border border-slate-300 bg-white pl-11 pr-4 text-base text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
                            />
                          </div>
                        </div>

                        <div>
                          <label htmlFor="setup-mobile" className="block text-sm font-semibold text-slate-800 mb-1.5">
                            मोबाइल नंबर (Mobile)
                          </label>
                          <div className="relative">
                            <Phone className="h-5 w-5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                            <input
                              id="setup-mobile"
                              type="tel"
                              autoComplete="tel"
                              required
                              value={mobile}
                              onChange={(e) => setMobile(e.target.value)}
                              placeholder="10 अंकों का मोबाइल नंबर"
                              className="w-full min-h-[48px] rounded-xl border border-slate-300 bg-white pl-11 pr-4 text-base text-slate-900 placeholder:text-slate-400 tabular-nums focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
                            />
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label htmlFor="setup-password" className="block text-sm font-semibold text-slate-800 mb-1.5">
                            पासवर्ड (Password)
                          </label>
                          <div className="relative">
                            <Lock className="h-5 w-5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                            <input
                              id="setup-password"
                              type={showPassword ? 'text' : 'password'}
                              autoComplete="new-password"
                              required
                              minLength={6}
                              value={password}
                              onChange={(e) => setPassword(e.target.value)}
                              placeholder="कम से कम 6 अक्षर"
                              className="w-full min-h-[48px] rounded-xl border border-slate-300 bg-white pl-11 pr-11 text-base text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
                            />
                            <button
                              type="button"
                              onClick={() => setShowPassword((prev) => !prev)}
                              aria-label={showPassword ? 'पासवर्ड छुपाएँ' : 'पासवर्ड देखें'}
                              className="absolute right-1.5 top-1/2 -translate-y-1/2 min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-800 cursor-pointer"
                            >
                              {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                            </button>
                          </div>
                        </div>

                        <div>
                          <label htmlFor="setup-confirm" className="block text-sm font-semibold text-slate-800 mb-1.5">
                            पासवर्ड की पुष्टि करें
                          </label>
                          <input
                            id="setup-confirm"
                            type={showPassword ? 'text' : 'password'}
                            autoComplete="new-password"
                            required
                            minLength={6}
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            placeholder="पासवर्ड दोबारा लिखें"
                            className="w-full min-h-[48px] rounded-xl border border-slate-300 bg-white px-4 text-base text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
                          />
                        </div>
                      </div>

                      <button
                        type="submit"
                        disabled={submitting}
                        className="w-full min-h-[50px] mt-1 rounded-xl bg-blue-700 hover:bg-blue-800 active:scale-[0.99] disabled:opacity-60 text-white font-semibold text-base flex items-center justify-center gap-2 transition-all cursor-pointer"
                      >
                        <ShieldCheck className="h-5 w-5" />
                        <span>{submitting ? 'प्रतीक्षा करें...' : 'User ID और Password बनाएँ'}</span>
                      </button>

                      {hasDriveHint && (
                        <button
                          type="button"
                          onClick={() => setShowCreateAdminForm(false)}
                          className="w-full text-xs font-semibold text-blue-700 hover:underline pt-1 cursor-pointer"
                        >
                          Google Drive रिस्टोर विकल्प पर वापस जाएँ
                        </button>
                      )}
                    </form>
                  </>
                )}
              </>
            ) : (
              <>
                <div className="mb-6">
                  <h2 className="text-xl sm:text-2xl font-bold text-slate-900">
                    पोर्टल में लॉगिन करें
                  </h2>
                  <p className="text-sm text-slate-600 mt-1.5">
                    अपनी यूज़र आईडी और पासवर्ड दर्ज करें।
                  </p>
                </div>

                {infoMsg && (
                  <div className="mb-4 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-900">
                    {infoMsg}
                  </div>
                )}

                {error && (
                  <div
                    role="alert"
                    className="mb-5 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800"
                  >
                    {error}
                  </div>
                )}

                <form onSubmit={handleLoginSubmit} className="space-y-4">
                  <div>
                    <label htmlFor="login-username" className="block text-sm font-semibold text-slate-800 mb-1.5">
                      यूज़र आईडी (User ID)
                    </label>
                    <div className="relative">
                      <UserIcon className="h-5 w-5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        id="login-username"
                        type="text"
                        autoComplete="username"
                        required
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="यूज़र आईडी या ईमेल लिखें"
                        className="w-full min-h-[48px] rounded-xl border border-slate-300 bg-white pl-11 pr-4 text-base text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="login-password" className="block text-sm font-semibold text-slate-800 mb-1.5">
                      पासवर्ड (Password)
                    </label>
                    <div className="relative">
                      <Lock className="h-5 w-5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        id="login-password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="current-password"
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="अपना पासवर्ड लिखें"
                        className="w-full min-h-[48px] rounded-xl border border-slate-300 bg-white pl-11 pr-12 text-base text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((prev) => !prev)}
                        aria-label={showPassword ? 'पासवर्ड छुपाएँ' : 'पासवर्ड देखें'}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-800 cursor-pointer"
                      >
                        {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full min-h-[50px] mt-2 rounded-xl bg-blue-700 hover:bg-blue-800 active:scale-[0.99] disabled:opacity-60 text-white font-semibold text-base flex items-center justify-center gap-2 transition-all cursor-pointer"
                  >
                    <ShieldCheck className="h-5 w-5" />
                    <span>{submitting ? 'जाँच हो रही है...' : 'लॉगिन करें'}</span>
                  </button>
                </form>
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
