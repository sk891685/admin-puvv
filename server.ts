import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import {
  addRemark,
  authenticateUser,
  claimFirstAdmin,
  createLoginOtpChallenge,
  createLoginPreAuth,
  createSession,
  createUserAccount,
  deleteActiveDataset,
  deleteLoginPreAuth,
  deleteRemark,
  deleteUserAccount,
  deriveUniqueUsername,
  findUserByEmail,
  getActiveDataset,
  getAllRemarksByRowAdmin,
  getDistinctColumnValues,
  getEnvAdminConfig,
  getLoginPreAuthUser,
  getOtpChallengeMeta,
  getUserById,
  getUserBySessionToken,
  isValidEmail,
  isValidRole,
  iterateDatasetRows,
  listUsers,
  needsAdminSetup,
  normalizeMobile,
  queryDatasetRows,
  revokeSession,
  saveNewDataset,
  updateOwnRemark,
  updateUserAccount,
  verifyLoginOtpChallenge,
} from './server/db.ts';
import type { SafeUser } from './server/db.ts';
import {
  buildSampleTemplateBuffer,
  SAMPLE_UTILITY_DATA,
  streamExportWorkbookToResponse,
  streamImportSpreadsheetFromFile,
} from './server/excel.ts';
import { isSmtpConfigured, maskEmail, sendLoginOtpEmail } from './server/mailer.ts';

interface AuthedRequest extends Request {
  currentUser?: SafeUser;
  authToken?: string;
}

interface UploadSession {
  id: string;
  userId: number;
  fileName: string;
  expectedSize: number;
  receivedBytes: number;
  tempFilePath: string;
  createdAt: number;
}

const PORT = Number(process.env.PORT) || 3000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
const CHUNK_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB chunks (safe through reverse proxies)
const UPLOAD_SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const tmpUploadDir = path.resolve(process.cwd(), 'data', 'tmp_uploads');
fs.mkdirSync(tmpUploadDir, { recursive: true });

// Clean up any stale temp files from prior server runs
try {
  for (const entry of fs.readdirSync(tmpUploadDir)) {
    const candidate = path.resolve(tmpUploadDir, entry);
    if (candidate.startsWith(tmpUploadDir + path.sep) && entry.endsWith('.part')) {
      fs.unlinkSync(candidate);
    }
  }
} catch {
  // ignore cleanup errors on startup
}

const uploadSessions = new Map<string, UploadSession>();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveTempUploadPath(uploadId: string): string {
  const resolved = path.resolve(tmpUploadDir, `${uploadId}.part`);
  if (!resolved.startsWith(tmpUploadDir + path.sep)) {
    throw new Error('INVALID_UPLOAD_PATH');
  }
  return resolved;
}

async function cleanupUploadSession(uploadId: string): Promise<void> {
  const session = uploadSessions.get(uploadId);
  if (!session) return;
  uploadSessions.delete(uploadId);
  try {
    await fs.promises.unlink(session.tempFilePath);
  } catch {
    // file may already be deleted
  }
}

function purgeExpiredUploadSessions(): void {
  const now = Date.now();
  for (const [id, session] of uploadSessions.entries()) {
    if (now - session.createdAt > UPLOAD_SESSION_TTL_MS) {
      void cleanupUploadSession(id);
    }
  }
}

// Simple in-memory rate limit for login attempts per IP
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 20) {
    return false;
  }
  entry.count += 1;
  return true;
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return token.length > 0 ? token : null;
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'कृपया पहले लॉगिन करें।' });
    return;
  }
  const user = getUserBySessionToken(token);
  if (!user) {
    res.status(401).json({ error: 'आपका सेशन समाप्त हो गया है। कृपया पुनः लॉगिन करें।' });
    return;
  }
  req.currentUser = user;
  req.authToken = token;
  next();
}

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.currentUser || req.currentUser.role !== 'admin') {
    res.status(403).json({ error: 'यह कार्य केवल Admin के लिए अनुमत है।' });
    return;
  }
  next();
}

async function startServer(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  // --- Auth Routes ---

  app.get('/api/auth/status', (_req: Request, res: Response) => {
    const envAdmin = getEnvAdminConfig();
    res.json({
      needsAdminSetup: needsAdminSetup(),
      envAdminConfigured: Boolean(envAdmin),
      smtpConfigured: isSmtpConfigured(),
    });
  });

  app.post('/api/auth/setup-admin', (req: Request, res: Response) => {
    try {
      if (!needsAdminSetup()) {
        res.status(409).json({ error: 'एडमिन खाता पहले से सेटअप किया जा चुका है।' });
        return;
      }
      const { username, email, mobile, fullName, password } = req.body ?? {};
      if (
        typeof email !== 'string' ||
        typeof mobile !== 'string' ||
        typeof fullName !== 'string' ||
        typeof password !== 'string'
      ) {
        res.status(400).json({ error: 'कृपया पूरा नाम, ईमेल, मोबाइल नंबर और पासवर्ड भरें।' });
        return;
      }
      const cleanEmail = email.trim().toLowerCase();
      if (!isValidEmail(cleanEmail)) {
        res.status(400).json({ error: 'कृपया एक मान्य ईमेल आईडी दर्ज करें।' });
        return;
      }
      const cleanMobile = normalizeMobile(mobile);
      if (!cleanMobile) {
        res.status(400).json({ error: 'कृपया सही 10 अंकों का मोबाइल नंबर दर्ज करें।' });
        return;
      }
      const cleanName = fullName.trim();
      if (cleanName.length < 2 || cleanName.length > 80) {
        res.status(400).json({ error: 'पूरा नाम कम से कम 2 अक्षरों का होना चाहिए।' });
        return;
      }
      if (password.length < 6 || password.length > 100) {
        res.status(400).json({ error: 'पासवर्ड कम से कम 6 अक्षरों का होना चाहिए।' });
        return;
      }

      const preferredUsername =
        typeof username === 'string' && username.trim() ? username.trim().toLowerCase() : undefined;
      if (preferredUsername && !/^[a-z0-9._-]{3,32}$/.test(preferredUsername)) {
        res.status(400).json({
          error: 'यूज़र आईडी 3 से 32 अक्षरों की होनी चाहिए (केवल अंग्रेज़ी अक्षर, अंक, ., _, -)।',
        });
        return;
      }
      const finalUsername = preferredUsername ?? deriveUniqueUsername(cleanEmail);

      const adminUser = claimFirstAdmin({
        username: finalUsername,
        email: cleanEmail,
        mobile: cleanMobile,
        fullName: cleanName,
        password,
      });
      const token = createSession(adminUser.id);
      res.status(201).json({ token, user: adminUser });
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      if (code === 'ADMIN_ALREADY_EXISTS' || code === 'ADMIN_ENV_CONFIGURED') {
        res.status(409).json({ error: 'एडमिन खाता पहले से मौजूद है। कृपया लॉगिन करें।' });
        return;
      }
      res.status(500).json({ error: 'एडमिन खाता बनाने में त्रुटि हुई।' });
    }
  });

  app.post('/api/auth/login', async (req: Request, res: Response) => {
    const clientIp = req.ip || 'unknown';
    if (!checkLoginRateLimit(clientIp)) {
      res.status(429).json({ error: 'बहुत अधिक प्रयास किए गए। कृपया 1 मिनट बाद पुनः प्रयास करें।' });
      return;
    }
    const { email, username, password } = req.body ?? {};
    const identifier = typeof username === 'string' && username.trim() ? username : email;
    if (typeof identifier !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'यूज़र नाम और पासवर्ड आवश्यक हैं।' });
      return;
    }
    const user = authenticateUser(identifier, password);
    if (!user) {
      res.status(401).json({ error: 'यूज़र नाम या पासवर्ड गलत है।' });
      return;
    }

    // Step 2 Verification: Gmail OTP is required before creating a session
    if (!isSmtpConfigured()) {
      res.json({
        step: 'smtp_setup_required',
        maskedEmail: user.email && isValidEmail(user.email) ? maskEmail(user.email) : '',
      });
      return;
    }

    // If account has no saved email yet (e.g. existing admin), ask for Gmail in Step 2
    if (!user.email || !isValidEmail(user.email)) {
      const preAuth = createLoginPreAuth(user.id);
      res.json({
        step: 'gmail_required',
        preAuthId: preAuth.preAuthId,
        expiresInSeconds: preAuth.expiresInSeconds,
      });
      return;
    }

    try {
      const challenge = createLoginOtpChallenge(user.id, user.email);
      await sendLoginOtpEmail({
        to: user.email,
        fullName: user.fullName,
        otp: challenge.otp,
      });
      res.json({
        step: 'otp_verify',
        challengeId: challenge.challengeId,
        maskedEmail: maskEmail(user.email),
        expiresInSeconds: challenge.expiresInSeconds,
      });
    } catch {
      res.status(502).json({
        error: 'Gmail पर OTP भेजने में समस्या आई। कृपया Gmail SMTP सेटिंग्स जांचें या पुनः प्रयास करें।',
      });
    }
  });

  app.post('/api/auth/step2-send-otp', async (req: Request, res: Response) => {
    const clientIp = req.ip || 'unknown';
    if (!checkLoginRateLimit(clientIp)) {
      res.status(429).json({ error: 'बहुत अधिक प्रयास किए गए। कृपया 1 मिनट बाद पुनः प्रयास करें।' });
      return;
    }
    if (!isSmtpConfigured()) {
      res.status(503).json({
        error: 'Gmail पर OTP भेजने के लिए Settings → Secrets में GMAIL_USER और GMAIL_APP_PASSWORD सेट करें।',
      });
      return;
    }
    const { preAuthId, email } = req.body ?? {};
    if (typeof preAuthId !== 'string' || !UUID_REGEX.test(preAuthId)) {
      res.status(400).json({ error: 'सेशन समाप्त हो गया है। कृपया पुनः लॉगिन करें।' });
      return;
    }
    if (typeof email !== 'string' || !isValidEmail(email)) {
      res.status(400).json({ error: 'कृपया एक मान्य Gmail/ईमेल पता दर्ज करें।' });
      return;
    }
    const user = getLoginPreAuthUser(preAuthId);
    if (!user) {
      res.status(401).json({ error: 'वेरिफिकेशन सेशन समाप्त हो गया है। कृपया दोबारा लॉगिन करें।' });
      return;
    }
    if (user.email && isValidEmail(user.email)) {
      res.status(409).json({ error: 'इस खाते में ईमेल पहले से पंजीकृत है। कृपया पुनः लॉगिन करें।' });
      return;
    }
    const cleanEmail = email.trim().toLowerCase();
    const existingOwner = findUserByEmail(cleanEmail);
    if (existingOwner && existingOwner.id !== user.id) {
      res.status(409).json({ error: 'यह ईमेल आईडी किसी अन्य खाते में पंजीकृत है।' });
      return;
    }

    try {
      const challenge = createLoginOtpChallenge(user.id, cleanEmail);
      await sendLoginOtpEmail({
        to: cleanEmail,
        fullName: user.fullName,
        otp: challenge.otp,
      });
      deleteLoginPreAuth(preAuthId);
      res.json({
        step: 'otp_verify',
        challengeId: challenge.challengeId,
        maskedEmail: maskEmail(cleanEmail),
        expiresInSeconds: challenge.expiresInSeconds,
      });
    } catch {
      res.status(502).json({
        error: 'Gmail पर OTP भेजने में त्रुटि हुई। कृपया Gmail SMTP सेटिंग्स जांचें।',
      });
    }
  });

  app.post('/api/auth/resend-otp', async (req: Request, res: Response) => {
    const clientIp = req.ip || 'unknown';
    if (!checkLoginRateLimit(clientIp)) {
      res.status(429).json({ error: 'कृपया थोड़ी देर बाद पुनः प्रयास करें।' });
      return;
    }
    if (!isSmtpConfigured()) {
      res.status(503).json({ error: 'Gmail OTP सेवा कॉन्फ़िगर नहीं है।' });
      return;
    }
    const { challengeId } = req.body ?? {};
    if (typeof challengeId !== 'string' || !UUID_REGEX.test(challengeId)) {
      res.status(400).json({ error: 'अमान्य OTP अनुरोध।' });
      return;
    }
    const meta = getOtpChallengeMeta(challengeId);
    if (!meta) {
      res.status(404).json({ error: 'OTP सेशन समाप्त हो गया है। कृपया दोबारा लॉगिन शुरू करें।' });
      return;
    }
    if (Date.now() - meta.createdAtMs < 25_000) {
      res.status(429).json({ error: 'कृपया नया OTP भेजने से पहले 30 सेकंड प्रतीक्षा करें।' });
      return;
    }
    const user = getUserById(meta.userId);
    const targetEmail = meta.email && isValidEmail(meta.email) ? meta.email : user?.email || '';
    if (!user || !targetEmail) {
      res.status(404).json({ error: 'खाता उपलब्ध नहीं है।' });
      return;
    }
    try {
      const fresh = createLoginOtpChallenge(user.id, targetEmail);
      await sendLoginOtpEmail({
        to: targetEmail,
        fullName: user.fullName,
        otp: fresh.otp,
      });
      res.json({
        challengeId: fresh.challengeId,
        maskedEmail: maskEmail(targetEmail),
        expiresInSeconds: fresh.expiresInSeconds,
      });
    } catch {
      res.status(502).json({ error: 'OTP पुनः भेजने में त्रुटि हुई।' });
    }
  });

  app.post('/api/auth/verify-otp', (req: Request, res: Response) => {
    const clientIp = req.ip || 'unknown';
    if (!checkLoginRateLimit(clientIp)) {
      res.status(429).json({ error: 'बहुत अधिक प्रयास किए गए। कृपया 1 मिनट बाद पुनः प्रयास करें।' });
      return;
    }
    const { challengeId, otp } = req.body ?? {};
    if (typeof challengeId !== 'string' || !UUID_REGEX.test(challengeId) || typeof otp !== 'string') {
      res.status(400).json({ error: 'कृपया सही 6-अंक का OTP दर्ज करें।' });
      return;
    }
    if (!/^\d{6}$/.test(otp.trim())) {
      res.status(400).json({ error: 'OTP ठीक 6 अंकों का होना चाहिए।' });
      return;
    }
    try {
      const user = verifyLoginOtpChallenge(challengeId, otp);
      const token = createSession(user.id);
      res.json({ token, user });
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      if (code === 'OTP_EXPIRED') {
        res.status(400).json({ error: 'OTP की समय-सीमा (5 मिनट) समाप्त हो गई है। कृपया नया OTP मंगाएँ।' });
        return;
      }
      if (code === 'OTP_MAX_ATTEMPTS') {
        res.status(429).json({ error: 'गलत OTP के अधिक प्रयास हुए। कृपया दोबारा लॉगिन करके नया OTP मंगाएँ।' });
        return;
      }
      if (code === 'OTP_INVALID') {
        res.status(401).json({ error: 'दर्ज किया गया OTP गलत है। कृपया दोबारा जाँचें।' });
        return;
      }
      res.status(400).json({ error: 'OTP सेशन अमान्य है। कृपया पुनः प्रयास करें।' });
    }
  });

  app.post('/api/auth/logout', requireAuth, (req: AuthedRequest, res: Response) => {
    if (req.authToken) {
      revokeSession(req.authToken);
    }
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res: Response) => {
    res.json({ user: req.currentUser });
  });

  // --- Admin User Management Routes ---

  app.get('/api/users', requireAuth, requireAdmin, (_req: AuthedRequest, res: Response) => {
    res.json({ users: listUsers() });
  });

  app.post('/api/users', requireAuth, requireAdmin, (req: AuthedRequest, res: Response) => {
    try {
      const { username, email, mobile, fullName, password, role, supervisorId } = req.body ?? {};
      if (
        typeof email !== 'string' ||
        typeof mobile !== 'string' ||
        typeof fullName !== 'string' ||
        typeof password !== 'string'
      ) {
        res.status(400).json({ error: 'पूरा नाम, ईमेल आईडी, मोबाइल नंबर और पासवर्ड आवश्यक हैं।' });
        return;
      }
      const cleanEmail = email.trim().toLowerCase();
      if (!isValidEmail(cleanEmail)) {
        res.status(400).json({ error: 'कृपया एक मान्य ईमेल आईडी दर्ज करें।' });
        return;
      }
      const cleanMobile = normalizeMobile(mobile);
      if (!cleanMobile) {
        res.status(400).json({ error: 'कृपया सही 10 अंकों का मोबाइल नंबर दर्ज करें।' });
        return;
      }
      const cleanName = fullName.trim();
      if (cleanName.length < 2 || cleanName.length > 80) {
        res.status(400).json({ error: 'कृपया सही पूरा नाम दर्ज करें।' });
        return;
      }
      if (password.length < 4 || password.length > 100) {
        res.status(400).json({ error: 'पासवर्ड कम से कम 4 अक्षरों का होना चाहिए।' });
        return;
      }
      if (!isValidRole(role)) {
        res.status(400).json({ error: 'कृपया सही रोल चुनें (Admin, JE, Supervisor, Lineman)।' });
        return;
      }

      const preferredUsername =
        typeof username === 'string' && username.trim() ? username.trim().toLowerCase() : undefined;
      if (preferredUsername && !/^[a-z0-9._-]{3,32}$/.test(preferredUsername)) {
        res.status(400).json({
          error: 'यूज़र नाम 3 से 32 अक्षरों का होना चाहिए (केवल अंग्रेज़ी अक्षर, अंक, ., _, -)।',
        });
        return;
      }
      const finalUsername = preferredUsername ?? deriveUniqueUsername(cleanEmail);

      const parsedSupervisorId =
        supervisorId === null || supervisorId === undefined || supervisorId === ''
          ? null
          : Number(supervisorId);
      if (parsedSupervisorId !== null && (!Number.isInteger(parsedSupervisorId) || parsedSupervisorId <= 0)) {
        res.status(400).json({ error: 'अमान्य सुपरवाइज़र चयन।' });
        return;
      }

      const created = createUserAccount({
        username: finalUsername,
        email: cleanEmail,
        mobile: cleanMobile,
        fullName: cleanName,
        password,
        role,
        supervisorId: role === 'lineman' ? parsedSupervisorId : null,
      });
      res.status(201).json({ user: created });
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      if (code === 'USERNAME_TAKEN') {
        res.status(409).json({ error: 'यह यूज़र नाम पहले से उपयोग में है।' });
        return;
      }
      if (code === 'EMAIL_TAKEN') {
        res.status(409).json({ error: 'यह ईमेल आईडी पहले से किसी खाते में पंजीकृत है।' });
        return;
      }
      if (code === 'INVALID_SUPERVISOR') {
        res.status(400).json({ error: 'चुना गया सुपरवाइज़र उपलब्ध नहीं है।' });
        return;
      }
      res.status(500).json({ error: 'यूज़र बनाने में त्रुटि हुई।' });
    }
  });

  app.patch('/api/users/:id', requireAuth, requireAdmin, (req: AuthedRequest, res: Response) => {
    try {
      const targetId = Number(req.params.id);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        res.status(400).json({ error: 'अमान्य यूज़र आईडी।' });
        return;
      }
      const { fullName, email, mobile, role, supervisorId, password } = req.body ?? {};
      if (role !== undefined && !isValidRole(role)) {
        res.status(400).json({ error: 'अमान्य रोल।' });
        return;
      }

      let validatedEmail: string | undefined;
      if (typeof email === 'string' && email.trim() !== '') {
        if (!isValidEmail(email)) {
          res.status(400).json({ error: 'कृपया एक मान्य ईमेल आईडी दर्ज करें।' });
          return;
        }
        validatedEmail = email.trim().toLowerCase();
      }

      let validatedMobile: string | undefined;
      if (typeof mobile === 'string' && mobile.trim() !== '') {
        const norm = normalizeMobile(mobile);
        if (!norm) {
          res.status(400).json({ error: 'कृपया सही 10 अंकों का मोबाइल नंबर दर्ज करें।' });
          return;
        }
        validatedMobile = norm;
      }

      const parsedSupervisorId =
        supervisorId === undefined
          ? undefined
          : supervisorId === null || supervisorId === ''
          ? null
          : Number(supervisorId);

      const updated = updateUserAccount(
        targetId,
        {
          fullName: typeof fullName === 'string' ? fullName : undefined,
          email: validatedEmail,
          mobile: validatedMobile,
          role,
          supervisorId: parsedSupervisorId,
          password: typeof password === 'string' && password.length > 0 ? password : undefined,
        },
        req.currentUser!.id
      );
      res.json({ user: updated });
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      if (code === 'USER_NOT_FOUND') {
        res.status(404).json({ error: 'यूज़र नहीं मिला।' });
        return;
      }
      if (code === 'EMAIL_TAKEN') {
        res.status(409).json({ error: 'यह ईमेल आईडी पहले से उपयोग में है।' });
        return;
      }
      if (code === 'CANNOT_DEMOTE_SELF' || code === 'LAST_ADMIN') {
        res.status(400).json({ error: 'अंतिम Admin या स्वयं का Admin रोल नहीं बदला जा सकता।' });
        return;
      }
      if (code === 'INVALID_SUPERVISOR') {
        res.status(400).json({ error: 'चुना गया सुपरवाइज़र मान्य नहीं है।' });
        return;
      }
      res.status(500).json({ error: 'यूज़र अपडेट करने में त्रुटि हुई।' });
    }
  });

  app.delete('/api/users/:id', requireAuth, requireAdmin, (req: AuthedRequest, res: Response) => {
    try {
      const targetId = Number(req.params.id);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        res.status(400).json({ error: 'अमान्य यूज़र आईडी।' });
        return;
      }
      deleteUserAccount(targetId, req.currentUser!.id);
      res.json({ ok: true });
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      if (code === 'CANNOT_DELETE_SELF') {
        res.status(400).json({ error: 'आप अपना स्वयं का खाता नहीं हटा सकते।' });
        return;
      }
      if (code === 'LAST_ADMIN') {
        res.status(400).json({ error: 'कम से कम एक Admin खाता रहना आवश्यक है।' });
        return;
      }
      if (code === 'USER_NOT_FOUND') {
        res.status(404).json({ error: 'यूज़र नहीं मिला।' });
        return;
      }
      res.status(500).json({ error: 'यूज़र हटाने में त्रुटि हुई।' });
    }
  });

  // --- Dataset Query & Column Values Routes (Server-Side Search & Pagination) ---

  app.get('/api/dataset', requireAuth, (req: AuthedRequest, res: Response) => {
    const dataset = getActiveDataset();
    if (!dataset) {
      res.json({
        dataset: null,
        rows: [],
        remarksByRow: {},
        totalFiltered: 0,
        rowsWithRemarksCount: 0,
        totalVisibleRemarks: 0,
        page: 1,
        pageSize: 25,
      });
      return;
    }

    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const column = typeof req.query.column === 'string' ? req.query.column : '__ALL__';
    const value = typeof req.query.value === 'string' ? req.query.value : '__ALL__';
    const rawFilter = typeof req.query.remarkFilter === 'string' ? req.query.remarkFilter : 'all';
    const remarkFilter =
      rawFilter === 'with_remarks' || rawFilter === 'without_remarks' ? rawFilter : 'all';
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 25;

    const result = queryDatasetRows({
      dataset,
      user: req.currentUser!,
      q,
      column,
      value,
      remarkFilter,
      page,
      pageSize,
    });

    res.json({
      dataset,
      ...result,
    });
  });

  app.get('/api/dataset/column-values', requireAuth, (req: AuthedRequest, res: Response) => {
    const dataset = getActiveDataset();
    const column = typeof req.query.column === 'string' ? req.query.column : '';
    if (!dataset || !column || !dataset.headers.includes(column)) {
      res.json({ values: [] });
      return;
    }
    const values = getDistinctColumnValues(dataset, column);
    res.json({ values });
  });

  // --- Chunked Streaming File Upload Routes (Supports up to 10 GB) ---

  app.post('/api/dataset/upload/init', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
    purgeExpiredUploadSessions();
    try {
      const { fileName, fileSize } = req.body ?? {};
      if (typeof fileName !== 'string' || !fileName.trim()) {
        res.status(400).json({ error: 'कृपया एक वैध Excel या CSV फ़ाइल चुनें।' });
        return;
      }
      const cleanName = path.basename(fileName.trim());
      if (!/\.(xlsx|xls|csv)$/i.test(cleanName)) {
        res.status(400).json({ error: 'केवल .xlsx, .xls या .csv फ़ाइल ही अपलोड की जा सकती है।' });
        return;
      }
      const sizeNum = Number(fileSize);
      if (!Number.isFinite(sizeNum) || sizeNum <= 0) {
        res.status(400).json({ error: 'फ़ाइल का आकार अमान्य है या फ़ाइल खाली है।' });
        return;
      }
      if (sizeNum > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: 'फ़ाइल का आकार अधिकतम 10 GB तक हो सकता है।' });
        return;
      }

      const uploadId = crypto.randomUUID();
      const tempFilePath = resolveTempUploadPath(uploadId);
      await fs.promises.writeFile(tempFilePath, Buffer.alloc(0));

      uploadSessions.set(uploadId, {
        id: uploadId,
        userId: req.currentUser!.id,
        fileName: cleanName,
        expectedSize: sizeNum,
        receivedBytes: 0,
        tempFilePath,
        createdAt: Date.now(),
      });

      res.status(201).json({
        uploadId,
        chunkSize: CHUNK_SIZE_BYTES,
        maxBytes: MAX_UPLOAD_BYTES,
      });
    } catch {
      res.status(500).json({ error: 'अपलोड शुरू करने में त्रुटि हुई।' });
    }
  });

  app.put(
    '/api/dataset/upload/chunk/:uploadId',
    requireAuth,
    requireAdmin,
    express.raw({ type: 'application/octet-stream', limit: '8mb' }),
    async (req: AuthedRequest, res: Response) => {
      const { uploadId } = req.params;
      if (!UUID_REGEX.test(uploadId)) {
        res.status(400).json({ error: 'अमान्य अपलोड आईडी।' });
        return;
      }
      const session = uploadSessions.get(uploadId);
      if (!session || session.userId !== req.currentUser!.id) {
        res.status(404).json({ error: 'अपलोड सेशन नहीं मिला या समाप्त हो गया है।' });
        return;
      }

      const chunk = req.body;
      if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
        res.status(400).json({ error: 'फ़ाइल चंक खाली है।' });
        return;
      }
      if (session.receivedBytes + chunk.length > MAX_UPLOAD_BYTES) {
        await cleanupUploadSession(uploadId);
        res.status(413).json({ error: 'फ़ाइल का आकार 10 GB की सीमा से अधिक है।' });
        return;
      }

      try {
        await fs.promises.appendFile(session.tempFilePath, chunk);
        session.receivedBytes += chunk.length;
        res.json({
          receivedBytes: session.receivedBytes,
          expectedSize: session.expectedSize,
        });
      } catch (err) {
        await cleanupUploadSession(uploadId);
        const msg =
          err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOSPC'
            ? 'सर्वर डिस्क में पर्याप्त खाली स्थान नहीं है।'
            : 'फ़ाइल चंक सेव करने में त्रुटि हुई।';
        res.status(500).json({ error: msg });
      }
    }
  );

  app.post('/api/dataset/upload/complete/:uploadId', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
    const { uploadId } = req.params;
    if (!UUID_REGEX.test(uploadId)) {
      res.status(400).json({ error: 'अमान्य अपलोड आईडी।' });
      return;
    }
    const session = uploadSessions.get(uploadId);
    if (!session || session.userId !== req.currentUser!.id) {
      res.status(404).json({ error: 'अपलोड सेशन नहीं मिला।' });
      return;
    }

    try {
      const saved = await streamImportSpreadsheetFromFile(
        session.tempFilePath,
        session.fileName,
        req.currentUser!
      );
      res.status(201).json({ dataset: saved });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'फ़ाइल प्रोसेस करने में त्रुटि हुई।';
      res.status(400).json({ error: msg });
    } finally {
      await cleanupUploadSession(uploadId);
    }
  });

  app.delete('/api/dataset/upload/:uploadId', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
    const { uploadId } = req.params;
    if (UUID_REGEX.test(uploadId)) {
      const session = uploadSessions.get(uploadId);
      if (session && session.userId === req.currentUser!.id) {
        await cleanupUploadSession(uploadId);
      }
    }
    res.json({ ok: true });
  });

  app.delete('/api/dataset', requireAuth, requireAdmin, (_req: AuthedRequest, res: Response) => {
    try {
      const deleted = deleteActiveDataset();
      if (!deleted) {
        res.status(404).json({ error: 'हटाने के लिए कोई सक्रिय Excel डाटा उपलब्ध नहीं है।' });
        return;
      }
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Excel डाटा हटाने में त्रुटि हुई।' });
    }
  });

  app.post('/api/dataset/load-sample', requireAuth, requireAdmin, (req: AuthedRequest, res: Response) => {
    try {
      const saved = saveNewDataset(
        'नमूना_उपभोक्ता_फीडर_डाटा.xlsx',
        SAMPLE_UTILITY_DATA.headers,
        SAMPLE_UTILITY_DATA.rows,
        req.currentUser!
      );
      res.status(201).json({ dataset: saved });
    } catch {
      res.status(500).json({ error: 'नमूना डाटा लोड करने में त्रुटि हुई।' });
    }
  });

  app.get('/api/dataset/sample-template', requireAuth, requireAdmin, async (_req: AuthedRequest, res: Response) => {
    try {
      const buf = await buildSampleTemplateBuffer();
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', 'attachment; filename="sample_consumer_data.xlsx"');
      res.send(buf);
    } catch {
      res.status(500).json({ error: 'नमूना फ़ाइल बनाने में त्रुटि हुई।' });
    }
  });

  app.get('/api/dataset/export', requireAuth, requireAdmin, async (_req: AuthedRequest, res: Response) => {
    try {
      const dataset = getActiveDataset();
      if (!dataset) {
        res.status(404).json({ error: 'डाउनलोड के लिए कोई Excel डाटा उपलब्ध नहीं है।' });
        return;
      }
      const remarksByRow = getAllRemarksByRowAdmin(dataset.id);
      const baseSafeName = dataset.fileName.replace(/\.[^.]+$/, '').replace(/[^\w\s-]/g, '') || 'data';

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${baseSafeName}_with_remarks.xlsx"`
      );

      await streamExportWorkbookToResponse({
        stream: res,
        headers: dataset.headers,
        rowsIterator: iterateDatasetRows(dataset.id),
        remarksByRow,
      });
    } catch {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Excel डाउनलोड फ़ाइल तैयार करने में त्रुटि हुई।' });
      }
    }
  });

  // --- Remarks Routes (Original Excel rows are NEVER modified) ---

  app.post('/api/rows/:rowId/remarks', requireAuth, (req: AuthedRequest, res: Response) => {
    try {
      const rowId = Number(req.params.rowId);
      if (!Number.isInteger(rowId) || rowId <= 0) {
        res.status(400).json({ error: 'अमान्य रो आईडी।' });
        return;
      }
      const { comment } = req.body ?? {};
      if (typeof comment !== 'string' || !comment.trim()) {
        res.status(400).json({ error: 'कृपया रिमार्क लिखें।' });
        return;
      }
      if (comment.trim().length > 1000) {
        res.status(400).json({ error: 'रिमार्क 1000 अक्षरों से अधिक नहीं हो सकता।' });
        return;
      }
      const remark = addRemark(rowId, comment, req.currentUser!);
      res.status(201).json({ remark });
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      if (code === 'ROW_NOT_FOUND' || code === 'DATASET_INACTIVE') {
        res.status(404).json({ error: 'यह रिकॉर्ड अब सक्रिय शीट में मौजूद नहीं है।' });
        return;
      }
      res.status(500).json({ error: 'रिमार्क सेव करने में त्रुटि हुई।' });
    }
  });

  app.patch('/api/remarks/:id', requireAuth, (req: AuthedRequest, res: Response) => {
    try {
      const remarkId = Number(req.params.id);
      if (!Number.isInteger(remarkId) || remarkId <= 0) {
        res.status(400).json({ error: 'अमान्य रिमार्क आईडी।' });
        return;
      }
      const { comment } = req.body ?? {};
      if (typeof comment !== 'string' || !comment.trim() || comment.trim().length > 1000) {
        res.status(400).json({ error: 'कृपया 1 से 1000 अक्षरों के बीच रिमार्क लिखें।' });
        return;
      }
      const updated = updateOwnRemark(remarkId, comment, req.currentUser!);
      res.json({ remark: updated });
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      if (code === 'REMARK_NOT_FOUND') {
        res.status(404).json({ error: 'रिमार्क नहीं मिला।' });
        return;
      }
      if (code === 'FORBIDDEN_REMARK') {
        res.status(403).json({ error: 'आप केवल अपना रिमार्क ही संपादित कर सकते हैं।' });
        return;
      }
      res.status(500).json({ error: 'रिमार्क अपडेट करने में त्रुटि हुई।' });
    }
  });

  app.delete('/api/remarks/:id', requireAuth, (req: AuthedRequest, res: Response) => {
    try {
      const remarkId = Number(req.params.id);
      if (!Number.isInteger(remarkId) || remarkId <= 0) {
        res.status(400).json({ error: 'अमान्य रिमार्क आईडी।' });
        return;
      }
      deleteRemark(remarkId, req.currentUser!);
      res.json({ ok: true });
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      if (code === 'REMARK_NOT_FOUND') {
        res.status(404).json({ error: 'रिमार्क नहीं मिला।' });
        return;
      }
      if (code === 'FORBIDDEN_REMARK') {
        res.status(403).json({ error: 'आप यह रिमार्क नहीं हटा सकते।' });
        return;
      }
      res.status(500).json({ error: 'रिमार्क हटाने में त्रुटि हुई।' });
    }
  });

  // --- Vite Dev Middleware or Production Static Files ---

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
  // Allow long-running streaming complete/export requests for very large files
  server.requestTimeout = 0;
  server.headersTimeout = 120_000;
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
