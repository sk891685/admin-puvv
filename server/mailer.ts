import nodemailer from 'nodemailer';

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

function cleanEnvValue(raw: string | undefined): string {
  if (!raw) return '';
  const cleaned = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (
    !cleaned ||
    /^(MY_|YOUR_|CHANGE_ME|PLACEHOLDER|DUMMY|EXAMPLE|NOT_SET)/i.test(cleaned) ||
    cleaned === 'undefined' ||
    cleaned === 'null'
  ) {
    return '';
  }
  return cleaned;
}

function isEmailFormat(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

function isGmailAddress(email: string): boolean {
  const lower = email.toLowerCase();
  return lower.endsWith('@gmail.com') || lower.endsWith('@googlemail.com');
}

export function getSmtpConfig(): SmtpConfig | null {
  // 1. Direct Gmail App Password configuration (easiest setup for Gmail OTP)
  const gmailUser = cleanEnvValue(process.env.GMAIL_USER);
  const gmailPassRaw = cleanEnvValue(process.env.GMAIL_APP_PASSWORD);
  if (gmailUser && isEmailFormat(gmailUser) && gmailPassRaw) {
    const gmailPass = gmailPassRaw.replace(/\s+/g, '');
    if (gmailPass.length >= 8) {
      const fromCandidate = cleanEnvValue(process.env.SMTP_FROM);
      const from = fromCandidate && isEmailFormat(fromCandidate) ? fromCandidate : gmailUser;
      return {
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        user: gmailUser,
        pass: gmailPass,
        from,
      };
    }
  }

  // 2. Standard SMTP configuration (auto-defaults to smtp.gmail.com if SMTP_USER is a Gmail address)
  const user = cleanEnvValue(process.env.SMTP_USER);
  const passRaw = cleanEnvValue(process.env.SMTP_PASS);
  if (!user || !passRaw) return null;

  const explicitHost = cleanEnvValue(process.env.SMTP_HOST);
  const gmailAuto = !explicitHost && isEmailFormat(user) && isGmailAddress(user);
  const host = explicitHost || (gmailAuto ? 'smtp.gmail.com' : '');
  if (!host || !host.includes('.')) return null;

  const isGmailHost = host.toLowerCase() === 'smtp.gmail.com' || gmailAuto;
  const pass = isGmailHost ? passRaw.replace(/\s+/g, '') : passRaw;
  if (pass.length < 4) return null;

  const defaultPort = isGmailHost ? '465' : '587';
  const portRaw = Number(cleanEnvValue(process.env.SMTP_PORT) || defaultPort);
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw <= 65535 ? portRaw : 587;
  const fromCandidate = cleanEnvValue(process.env.SMTP_FROM);
  const from = fromCandidate && isEmailFormat(fromCandidate) ? fromCandidate : user;

  return {
    host,
    port,
    secure: port === 465,
    user,
    pass,
    from,
  };
}

export function isSmtpConfigured(): boolean {
  return getSmtpConfig() !== null;
}

export function maskEmail(email: string): string {
  const parts = email.split('@');
  if (parts.length !== 2) return '***';
  const [local, domain] = parts;
  if (local.length <= 2) return `${local[0] ?? '*'}***@${domain}`;
  return `${local.slice(0, 2)}***${local.slice(-1)}@${domain}`;
}

export async function sendLoginOtpEmail(params: {
  to: string;
  fullName: string;
  otp: string;
}): Promise<void> {
  const cfg = getSmtpConfig();
  if (!cfg) {
    throw new Error('SMTP_NOT_CONFIGURED');
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
  });

  const safeName = params.fullName.replace(/[<>]/g, '');

  await transporter.sendMail({
    from: `"PuVVNL डाटा रिमार्क पोर्टल" <${cfg.from}>`,
    to: params.to,
    subject: `${params.otp} — PuVVNL 2-स्टेप वेरिफिकेशन OTP`,
    text: `नमस्ते ${safeName},\n\nPuVVNL डाटा रिमार्क पोर्टल में 2-स्टेप वेरिफिकेशन के लिए आपका 6-अंक का OTP है: ${params.otp}\n\nयह OTP अगले 5 मिनट के लिए मान्य है। कृपया इसे किसी के साथ साझा न करें।`,
    html: `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; color: #0f172a;">
        <p style="font-size: 13px; color: #475569; margin: 0 0 6px;">पूर्वांचल विद्युत वितरण निगम लिमिटेड (PuVVNL)</p>
        <h2 style="margin: 0 0 16px; color: #1e3a8a; font-size: 20px;">2-स्टेप वेरिफिकेशन (Gmail OTP)</h2>
        <p style="font-size: 15px; line-height: 1.6; margin: 0 0 16px;">नमस्ते <strong>${safeName}</strong>,</p>
        <p style="font-size: 14px; line-height: 1.6; margin: 0 0 20px;">पोर्टल में लॉगिन पूरा करने के लिए नीचे दिया गया 6-अंक का OTP दर्ज करें:</p>
        <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 16px; text-align: center; font-size: 30px; font-weight: 700; letter-spacing: 6px; color: #1d4ed8;">
          ${params.otp}
        </div>
        <p style="font-size: 13px; color: #64748b; margin: 20px 0 0;">यह OTP केवल 5 मिनट के लिए मान्य है। यदि आपने लॉगिन का प्रयास नहीं किया है तो इस ईमेल को अनदेखा करें।</p>
      </div>
    `,
  });
}
