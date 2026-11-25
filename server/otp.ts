import nodemailer from 'nodemailer';

export interface OtpChannelStatus {
  emailConfigured: boolean;
}

function cleanEnvValue(raw: string | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (
    !trimmed ||
    /^MY_/i.test(trimmed) ||
    /^YOUR_/i.test(trimmed) ||
    /^CHANGE_ME/i.test(trimmed) ||
    trimmed === 'undefined' ||
    trimmed === 'null'
  ) {
    return '';
  }
  return trimmed;
}

export function normalizeAndValidateEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized.length < 5 || normalized.length > 120) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalized)) return null;
  return normalized;
}

export function normalizeAndValidateMobile(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/[\s\-()]/g, '');
  // Standard 10-digit Indian mobile number -> +91XXXXXXXXXX
  if (/^[6-9]\d{9}$/.test(cleaned)) {
    return `+91${cleaned}`;
  }
  // 0-prefixed 11-digit Indian number -> +91XXXXXXXXXX
  if (/^0[6-9]\d{9}$/.test(cleaned)) {
    return `+91${cleaned.slice(1)}`;
  }
  // 91-prefixed 12-digit Indian number -> +91XXXXXXXXXX
  if (/^91[6-9]\d{9}$/.test(cleaned)) {
    return `+${cleaned}`;
  }
  // International E.164 format (+ followed by 10-15 digits)
  if (/^\+[1-9]\d{9,14}$/.test(cleaned)) {
    return cleaned;
  }
  return null;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const visible = local.length <= 2 ? local[0] : local.slice(0, 2);
  return `${visible}***@${domain}`;
}

export function maskMobile(mobile: string): string {
  if (mobile.length <= 4) return '****';
  const prefix = mobile.startsWith('+') ? mobile.slice(0, 3) : '';
  const last4 = mobile.slice(-4);
  return `${prefix}******${last4}`;
}

function resolveSmtpConfig(): {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
} | null {
  const user = cleanEnvValue(process.env.SMTP_USER);
  const pass = cleanEnvValue(process.env.SMTP_PASS);
  const rawHost = cleanEnvValue(process.env.SMTP_HOST);
  const host = rawHost || (user.toLowerCase().endsWith('@gmail.com') ? 'smtp.gmail.com' : '');
  const portNum = Number(cleanEnvValue(process.env.SMTP_PORT) || '587');
  const port = Number.isFinite(portNum) && portNum > 0 ? portNum : 587;
  const from = cleanEnvValue(process.env.SMTP_FROM) || user;

  if (!host || !user || !pass) {
    return null;
  }
  return { host, port, user, pass, from };
}

export function getOtpChannelStatus(): OtpChannelStatus {
  return {
    emailConfigured: Boolean(resolveSmtpConfig()),
  };
}

/**
 * Dispatches the 6-digit login OTP strictly to the user's registered Email address via SMTP.
 * Never returns the OTP to the caller or bypasses verification.
 */
export async function sendEmailOtpOnly(params: {
  email: string;
  fullName: string;
  otp: string;
}): Promise<void> {
  const smtp = resolveSmtpConfig();
  if (!smtp) {
    throw new Error(
      'ईमेल OTP भेजने के लिए कृपया Settings → Secrets में SMTP_HOST, SMTP_PORT, SMTP_USER और SMTP_PASS सेट करें (Gmail के लिए SMTP_HOST=smtp.gmail.com और 16 अंकों का Google App Password उपयोग करें)।'
    );
  }

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: {
      user: smtp.user,
      pass: smtp.pass,
    },
    connectionTimeout: 12_000,
    greetingTimeout: 12_000,
    socketTimeout: 15_000,
  });

  const safeName = params.fullName.replace(/[<>]/g, '');

  try {
    await transporter.sendMail({
      from: smtp.from,
      to: params.email,
      subject: 'PuVVNL डाटा पोर्टल — लॉगिन OTP कोड',
      text: `नमस्ते ${safeName},\n\nआपका PuVVNL डाटा रिमार्क पोर्टल लॉगिन OTP है: ${params.otp}\nयह कोड 5 मिनट तक वैध है। सुरक्षा के लिए इस OTP को किसी के साथ साझा न करें।`,
      html: `
        <div style="font-family: 'Noto Sans Devanagari', Arial, sans-serif; max-width: 480px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; color: #0f172a;">
          <h2 style="margin: 0 0 8px; color: #1e3a8a; font-size: 18px;">PuVVNL डाटा रिमार्क पोर्टल</h2>
          <p style="margin: 0 0 16px; font-size: 14px; color: #475569;">नमस्ते ${safeName},</p>
          <p style="margin: 0 0 12px; font-size: 14px;">आपके लॉगिन के लिए 6 अंकों का सुरक्षा कोड (OTP):</p>
          <div style="background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 10px; padding: 14px; text-align: center; font-size: 28px; font-weight: 700; letter-spacing: 6px; color: #0f172a; font-family: monospace;">
            ${params.otp}
          </div>
          <p style="margin: 16px 0 0; font-size: 12px; color: #64748b;">
            यह OTP केवल 5 मिनट तक वैध है। कृपया इसे किसी अन्य व्यक्ति के साथ साझा न करें।
          </p>
        </div>
      `,
    });
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
    console.error('Email OTP delivery failed:', code || 'UNKNOWN_SMTP_ERROR');
    if (code === 'EAUTH') {
      throw new Error(
        'ईमेल लॉगिन अस्वीकृत हुआ। कृपया Settings → Secrets में सही SMTP_USER और SMTP_PASS (Gmail के लिए 16 अंकों का App Password) जांचें।'
      );
    }
    throw new Error(
      'ईमेल पर OTP नहीं भेजा जा सका। कृपया Settings → Secrets में SMTP_HOST, SMTP_PORT, SMTP_USER और SMTP_PASS की सही जांच करें।'
    );
  }
}
