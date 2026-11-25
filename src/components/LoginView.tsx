import { useState } from 'react';
import type { FormEvent } from 'react';
import { Eye, EyeOff, Lock, ShieldCheck, User as UserIcon } from 'lucide-react';
import { loginWithPassword, setupFirstAdmin } from '../api';
import type { AuthStatus, User } from '../types';
import { ROLE_META } from '../types';
import { PuvvnlLogo } from './PuvvnlLogo';

interface LoginViewProps {
  authStatus: AuthStatus;
  onAuthenticated: (token: string, user: User) => void;
}

export function LoginView({ authStatus, onAuthenticated }: LoginViewProps) {
  const isSetupMode = authStatus.needsAdminSetup;

  const [username, setUsername] = useState(isSetupMode ? 'admin' : '');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (isSetupMode) {
      if (password !== confirmPassword) {
        setError('दोनों पासवर्ड एक समान होने चाहिए।');
        return;
      }
      setSubmitting(true);
      try {
        const res = await setupFirstAdmin({ username, fullName, password });
        onAuthenticated(res.token, res.user);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'एडमिन सेटअप में त्रुटि हुई।');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    setSubmitting(true);
    try {
      const res = await loginWithPassword(username, password);
      onAuthenticated(res.token, res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'लॉगिन विफल रहा।');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="bg-white border-b border-slate-200 px-4 sm:px-8 py-3.5">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
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
        <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
          {/* Left Identity & Role Guide Panel */}
          <section className="lg:col-span-6 bg-blue-950 text-white rounded-2xl p-6 sm:p-10 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-4 mb-6">
                <PuvvnlLogo size="lg" className="p-1 shadow-sm" />
                <div>
                  <p className="text-xs text-blue-200 font-medium">
                    पूर्वांचल विद्युत वितरण निगम लिमिटेड
                  </p>
                  <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mt-0.5">
                    Excel डाटा सर्च एवं फील्ड रिमार्क प्रणाली
                  </h1>
                </div>
              </div>

              <p className="text-sm sm:text-base text-blue-100 leading-relaxed mb-8">
                उपभोक्ता संख्या, नाम, फीडर और ट्रांसफार्मर के अनुसार तुरंत रिकॉर्ड खोजें और सुरक्षित रोल-आधारित रिमार्क दर्ज करें। मूल Excel डाटा हमेशा सुरक्षित रहता है।
              </p>

              <div className="border-t border-blue-800/80 pt-6 space-y-4">
                <h2 className="text-sm font-semibold text-blue-200">
                  रोल के अनुसार अनुमतियाँ
                </h2>
                <dl className="space-y-3 text-sm">
                  {(['admin', 'je', 'supervisor', 'lineman'] as const).map((roleKey) => (
                    <div
                      key={roleKey}
                      className="grid grid-cols-1 sm:grid-cols-12 gap-1 sm:gap-3 pb-3 border-b border-blue-900/80 last:border-b-0 last:pb-0"
                    >
                      <dt className="sm:col-span-4 font-semibold text-white">
                        {ROLE_META[roleKey].hindiLabel}
                      </dt>
                      <dd className="sm:col-span-8 text-blue-100/90 leading-snug">
                        {ROLE_META[roleKey].permissionSummary}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>

            <p className="text-xs text-blue-300 mt-8 pt-4 border-t border-blue-900">
              सभी रिमार्क यूज़र नाम, रोल और तारीख-समय के साथ अपने-आप सेव होते हैं।
            </p>
          </section>

          {/* Right Form Panel */}
          <section className="lg:col-span-6 bg-white border border-slate-200 rounded-2xl p-6 sm:p-10 flex flex-col justify-center">
            <div className="mb-6">
              <h2 className="text-xl sm:text-2xl font-bold text-slate-900">
                {isSetupMode ? 'पहली बार Admin खाता सेटअप करें' : 'पोर्टल में लॉगिन करें'}
              </h2>
              <p className="text-sm text-slate-600 mt-1.5">
                {isSetupMode
                  ? 'शुरुआत करने के लिए मुख्य Admin का यूज़र नाम और पासवर्ड तय करें। इसके बाद आप JE, Supervisor और Lineman बना सकेंगे।'
                  : 'अपने Admin द्वारा दिए गए यूज़र नाम और पासवर्ड से प्रवेश करें।'}
              </p>
            </div>

            {error && (
              <div
                role="alert"
                className="mb-5 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800"
              >
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              {isSetupMode && (
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
                    placeholder="उदाहरण: राजेश कुमार सिंह"
                    className="w-full min-h-[48px] rounded-xl border border-slate-300 bg-white px-4 text-base text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
                  />
                </div>
              )}

              <div>
                <label htmlFor="login-username" className="block text-sm font-semibold text-slate-800 mb-1.5">
                  यूज़र नाम (Username)
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
                    placeholder={isSetupMode ? 'admin' : 'अपना यूज़र नाम लिखें'}
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
                    autoComplete={isSetupMode ? 'new-password' : 'current-password'}
                    required
                    minLength={isSetupMode ? 6 : 1}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={isSetupMode ? 'कम से कम 6 अक्षर का पासवर्ड' : 'अपना पासवर्ड लिखें'}
                    className="w-full min-h-[48px] rounded-xl border border-slate-300 bg-white pl-11 pr-12 text-base text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={showPassword ? 'पासवर्ड छुपाएँ' : 'पासवर्ड देखें'}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-800"
                  >
                    {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
              </div>

              {isSetupMode && (
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
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full min-h-[50px] mt-2 rounded-xl bg-blue-700 hover:bg-blue-800 active:scale-[0.99] disabled:opacity-60 text-white font-semibold text-base flex items-center justify-center gap-2 transition-all cursor-pointer"
              >
                <ShieldCheck className="h-5 w-5" />
                <span>
                  {submitting
                    ? 'प्रतीक्षा करें...'
                    : isSetupMode
                    ? 'Admin खाता बनाएं और लॉगिन करें'
                    : 'लॉगिन करें'}
                </span>
              </button>
            </form>
          </section>
        </div>
      </main>
    </div>
  );
}
