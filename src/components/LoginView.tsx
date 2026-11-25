import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ArrowLeft,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  Phone,
  RefreshCw,
  ShieldCheck,
  User as UserIcon,
} from 'lucide-react';
import {
  loginWithPassword,
  resendEmailOtp,
  sendStep2GmailOtp,
  setupFirstAdmin,
  verifyEmailOtp,
} from '../api';
import type { AuthStatus, OtpChallenge, User } from '../types';
import { PuvvnlLogo } from './PuvvnlLogo';

interface LoginViewProps {
  authStatus: AuthStatus;
  onAuthenticated: (token: string, user: User) => void;
}

type Step2State =
  | { kind: 'none' }
  | { kind: 'otp_verify'; challenge: OtpChallenge }
  | { kind: 'gmail_required'; preAuthId: string }
  | { kind: 'smtp_setup_required'; maskedEmail: string };

export function LoginView({ authStatus, onAuthenticated }: LoginViewProps) {
  const isSetupMode = authStatus.needsAdminSetup;

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Step 2 Verification state
  const [step2, setStep2] = useState<Step2State>({ kind: 'none' });
  const [step2Gmail, setStep2Gmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resending, setResending] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = window.setInterval(() => {
      setResendCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendCooldown]);

  async function handleSetupSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
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
      onAuthenticated(res.token, res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'एडमिन सेटअप में त्रुटि हुई।');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStep1Login(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfoMsg(null);
    setSubmitting(true);
    try {
      const res = await loginWithPassword(username, password);
      if (res.step === 'otp_verify') {
        setStep2({
          kind: 'otp_verify',
          challenge: {
            challengeId: res.challengeId,
            maskedEmail: res.maskedEmail,
            expiresInSeconds: res.expiresInSeconds,
          },
        });
        setOtpCode('');
        setResendCooldown(30);
        setInfoMsg(`आपके Gmail (${res.maskedEmail}) पर 6-अंक का OTP भेजा गया है।`);
      } else if (res.step === 'gmail_required') {
        setStep2({ kind: 'gmail_required', preAuthId: res.preAuthId });
        setStep2Gmail('');
      } else {
        setStep2({ kind: 'smtp_setup_required', maskedEmail: res.maskedEmail });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'लॉगिन विफल रहा।');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStep2SendGmailOtp(e: FormEvent) {
    e.preventDefault();
    if (step2.kind !== 'gmail_required') return;
    setError(null);
    setInfoMsg(null);
    setSubmitting(true);
    try {
      const challenge = await sendStep2GmailOtp(step2.preAuthId, step2Gmail);
      setStep2({ kind: 'otp_verify', challenge });
      setOtpCode('');
      setResendCooldown(30);
      setInfoMsg(`आपके Gmail (${challenge.maskedEmail}) पर 6-अंक का OTP भेजा गया है।`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gmail पर OTP भेजने में त्रुटि हुई।');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyOtp(e: FormEvent) {
    e.preventDefault();
    if (step2.kind !== 'otp_verify') return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await verifyEmailOtp(step2.challenge.challengeId, otpCode);
      onAuthenticated(res.token, res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OTP सत्यापन विफल रहा।');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResendOtp() {
    if (step2.kind !== 'otp_verify' || resendCooldown > 0 || resending) return;
    setError(null);
    setInfoMsg(null);
    setResending(true);
    try {
      const fresh = await resendEmailOtp(step2.challenge.challengeId);
      setStep2({ kind: 'otp_verify', challenge: fresh });
      setOtpCode('');
      setResendCooldown(30);
      setInfoMsg(`नया OTP आपके Gmail (${fresh.maskedEmail}) पर पुनः भेज दिया गया है।`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OTP पुनः भेजने में त्रुटि हुई।');
    } finally {
      setResending(false);
    }
  }

  function resetToStep1() {
    setStep2({ kind: 'none' });
    setOtpCode('');
    setStep2Gmail('');
    setError(null);
    setInfoMsg(null);
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
                <div className="mb-6">
                  <h2 className="text-xl sm:text-2xl font-bold text-slate-900">
                    Admin User ID और Password बनाएँ
                  </h2>
                  <p className="text-sm text-slate-600 mt-1.5">
                    पहली बार पोर्टल शुरू करने के लिए अपनी यूज़र आईडी, Gmail, मोबाइल नंबर और पासवर्ड तय करें।
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
                        Gmail / ईमेल आईडी
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
                        placeholder="कम से कम 6 अक्षर का पासवर्ड"
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

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full min-h-[50px] mt-2 rounded-xl bg-blue-700 hover:bg-blue-800 active:scale-[0.99] disabled:opacity-60 text-white font-semibold text-base flex items-center justify-center gap-2 transition-all cursor-pointer"
                  >
                    <ShieldCheck className="h-5 w-5" />
                    <span>{submitting ? 'प्रतीक्षा करें...' : 'User ID और Password बनाएँ'}</span>
                  </button>
                </form>
              </>
            ) : step2.kind === 'otp_verify' ? (
              /* Step 2A: 2-Step Verification — Enter Gmail OTP */
              <>
                <div className="mb-6">
                  <button
                    type="button"
                    onClick={resetToStep1}
                    className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    <span>लॉगिन पर वापस जाएँ</span>
                  </button>
                  <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">
                    स्टेप 2 / 2 — 2-स्टेप वेरिफिकेशन
                  </p>
                  <h2 className="text-xl sm:text-2xl font-bold text-slate-900 mt-1">
                    Gmail OTP सत्यापन
                  </h2>
                  <p className="text-sm text-slate-600 mt-1.5">
                    आपके पंजीकृत Gmail <strong className="text-slate-900">{step2.challenge.maskedEmail}</strong> पर भेजा गया 6-अंक का OTP दर्ज करें।
                  </p>
                </div>

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

                <form onSubmit={handleVerifyOtp} className="space-y-4">
                  <div>
                    <label htmlFor="otp-input" className="block text-sm font-semibold text-slate-800 mb-1.5">
                      6-अंक का OTP दर्ज करें
                    </label>
                    <div className="relative">
                      <KeyRound className="h-5 w-5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        id="otp-input"
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        required
                        value={otpCode}
                        onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="000000"
                        className="w-full min-h-[52px] rounded-xl border border-slate-300 bg-white pl-11 pr-4 text-xl font-mono-tabular tracking-[0.35em] text-slate-900 placeholder:text-slate-300 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={submitting || otpCode.length !== 6}
                    className="w-full min-h-[50px] rounded-xl bg-blue-700 hover:bg-blue-800 active:scale-[0.99] disabled:opacity-60 text-white font-semibold text-base flex items-center justify-center gap-2 transition-all cursor-pointer"
                  >
                    <ShieldCheck className="h-5 w-5" />
                    <span>{submitting ? 'सत्यापन हो रहा है...' : 'OTP सत्यापित करें और लॉगिन करें'}</span>
                  </button>

                  <div className="flex items-center justify-between pt-2 text-xs sm:text-sm text-slate-600">
                    <span>OTP 5 मिनट के लिए मान्य है</span>
                    <button
                      type="button"
                      disabled={resendCooldown > 0 || resending}
                      onClick={() => void handleResendOtp()}
                      className="inline-flex items-center gap-1.5 font-semibold text-blue-700 hover:text-blue-900 disabled:text-slate-400 cursor-pointer tabular-nums"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${resending ? 'animate-spin' : ''}`} />
                      <span>
                        {resendCooldown > 0
                          ? `पुनः भेजें (${resendCooldown}s)`
                          : resending
                          ? 'भेजा जा रहा है...'
                          : 'OTP पुनः भेजें'}
                      </span>
                    </button>
                  </div>
                </form>
              </>
            ) : step2.kind === 'gmail_required' ? (
              /* Step 2B: Account has no saved Gmail yet — link Gmail and send OTP */
              <>
                <div className="mb-6">
                  <button
                    type="button"
                    onClick={resetToStep1}
                    className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    <span>लॉगिन पर वापस जाएँ</span>
                  </button>
                  <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">
                    स्टेप 2 / 2 — 2-स्टेप वेरिफिकेशन
                  </p>
                  <h2 className="text-xl sm:text-2xl font-bold text-slate-900 mt-1">
                    अपना Gmail पता दर्ज करें
                  </h2>
                  <p className="text-sm text-slate-600 mt-1.5">
                    आपके खाते में अभी Gmail पता दर्ज नहीं है। अपना Gmail लिखें—उस पर 6-अंक का OTP भेजा जाएगा और सत्यापन के बाद सेव हो जाएगा।
                  </p>
                </div>

                {error && (
                  <div
                    role="alert"
                    className="mb-4 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800"
                  >
                    {error}
                  </div>
                )}

                <form onSubmit={handleStep2SendGmailOtp} className="space-y-4">
                  <div>
                    <label htmlFor="step2-gmail" className="block text-sm font-semibold text-slate-800 mb-1.5">
                      Gmail पता (Email)
                    </label>
                    <div className="relative">
                      <Mail className="h-5 w-5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        id="step2-gmail"
                        type="email"
                        autoComplete="email"
                        required
                        value={step2Gmail}
                        onChange={(e) => setStep2Gmail(e.target.value)}
                        placeholder="yourname@gmail.com"
                        className="w-full min-h-[48px] rounded-xl border border-slate-300 bg-white pl-11 pr-4 text-base text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full min-h-[50px] rounded-xl bg-blue-700 hover:bg-blue-800 active:scale-[0.99] disabled:opacity-60 text-white font-semibold text-base flex items-center justify-center gap-2 transition-all cursor-pointer"
                  >
                    <Mail className="h-5 w-5" />
                    <span>{submitting ? 'OTP भेजा जा रहा है...' : 'Gmail पर OTP भेजें'}</span>
                  </button>
                </form>
              </>
            ) : step2.kind === 'smtp_setup_required' ? (
              /* Step 2C: Password verified, Gmail SMTP Secrets required to send real OTP */
              <>
                <div className="mb-5">
                  <button
                    type="button"
                    onClick={resetToStep1}
                    className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    <span>लॉगिन पर वापस जाएँ</span>
                  </button>
                  <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">
                    स्टेप 2 / 2 — 2-स्टेप वेरिफिकेशन
                  </p>
                  <h2 className="text-xl sm:text-2xl font-bold text-slate-900 mt-1">
                    Gmail OTP सेटअप आवश्यक है
                  </h2>
                  <p className="text-sm text-slate-600 mt-1.5">
                    आपका यूज़र नाम और पासवर्ड सत्यापित हो गया है, लेकिन Gmail पर OTP भेजने के लिए सर्वर पर Gmail App Password कॉन्फ़िगर नहीं है।
                  </p>
                </div>

                <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-amber-950 space-y-2.5">
                  <p className="font-semibold">Gmail OTP चालू करने के 3 सरल चरण:</p>
                  <ol className="list-decimal list-inside space-y-1.5 text-xs sm:text-sm leading-relaxed">
                    <li>
                      अपने Google Account की Security सेटिंग्स में <strong>2-Step Verification</strong> चालू करें और <strong>App Password</strong> (16 अक्षर) बनाएँ।
                    </li>
                    <li>
                      <strong>Settings → Secrets</strong> में ये दो वेरिएबल जोड़ें:{' '}
                      <code className="font-mono-tabular font-semibold">GMAIL_USER</code> (आपका Gmail पता) और{' '}
                      <code className="font-mono-tabular font-semibold">GMAIL_APP_PASSWORD</code>।
                    </li>
                    <li>
                      सेव होने के बाद दोबारा लॉगिन करें—आपके Gmail पर तुरंत 6-अंक का OTP आ जाएगा।
                    </li>
                  </ol>
                </div>

                <button
                  type="button"
                  onClick={resetToStep1}
                  className="w-full min-h-[48px] mt-5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 font-semibold text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer"
                >
                  <ArrowLeft className="h-4 w-4" />
                  <span>लॉगिन स्क्रीन पर वापस जाएँ</span>
                </button>
              </>
            ) : (
              /* Step 1: Original simple Username + Password login */
              <>
                <div className="mb-6">
                  <h2 className="text-xl sm:text-2xl font-bold text-slate-900">
                    पोर्टल में लॉगिन करें
                  </h2>
                  <p className="text-sm text-slate-600 mt-1.5">
                    अपनी यूज़र आईडी और पासवर्ड दर्ज करें।
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

                <form onSubmit={handleStep1Login} className="space-y-4">
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
