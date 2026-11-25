import 'dotenv/config';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import {
  addRemark,
  authenticateUser,
  claimFirstAdmin,
  createSession,
  createUserAccount,
  deleteRemark,
  deleteUserAccount,
  getActiveDataset,
  getAllRemarksForDatasetAdmin,
  getDatasetRows,
  getEnvAdminConfig,
  getUserBySessionToken,
  getVisibleRemarksForDataset,
  isValidRole,
  listUsers,
  needsAdminSetup,
  revokeSession,
  saveNewDataset,
  updateOwnRemark,
  updateUserAccount,
} from './server/db.ts';
import type { SafeUser } from './server/db.ts';
import {
  buildExportWorkbookBuffer,
  buildSampleTemplateBuffer,
  parseUploadedSpreadsheet,
  SAMPLE_UTILITY_DATA,
} from './server/excel.ts';

interface AuthedRequest extends Request {
  currentUser?: SafeUser;
  authToken?: string;
}

const PORT = Number(process.env.PORT) || 3000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB

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
  app.use(express.json({ limit: '16mb' }));

  // --- Auth Routes ---

  app.get('/api/auth/status', (_req: Request, res: Response) => {
    const envAdmin = getEnvAdminConfig();
    res.json({
      needsAdminSetup: needsAdminSetup(),
      envAdminConfigured: Boolean(envAdmin),
    });
  });

  app.post('/api/auth/setup-admin', (req: Request, res: Response) => {
    try {
      if (!needsAdminSetup()) {
        res.status(409).json({ error: 'एडमिन खाता पहले से सेटअप किया जा चुका है।' });
        return;
      }
      const { username, fullName, password } = req.body ?? {};
      if (typeof username !== 'string' || typeof fullName !== 'string' || typeof password !== 'string') {
        res.status(400).json({ error: 'कृपया सभी आवश्यक जानकारी भरें।' });
        return;
      }
      const cleanUser = username.trim().toLowerCase();
      const cleanName = fullName.trim();
      if (!/^[a-z0-9._-]{3,32}$/.test(cleanUser)) {
        res.status(400).json({
          error: 'यूज़र नाम 3 से 32 अक्षरों का होना चाहिए (केवल अंग्रेज़ी अक्षर, अंक, ., _, -)।',
        });
        return;
      }
      if (cleanName.length < 2 || cleanName.length > 80) {
        res.status(400).json({ error: 'पूरा नाम कम से कम 2 अक्षरों का होना चाहिए।' });
        return;
      }
      if (password.length < 6 || password.length > 100) {
        res.status(400).json({ error: 'पासवर्ड कम से कम 6 अक्षरों का होना चाहिए।' });
        return;
      }

      const adminUser = claimFirstAdmin({ username: cleanUser, fullName: cleanName, password });
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

  app.post('/api/auth/login', (req: Request, res: Response) => {
    const clientIp = req.ip || 'unknown';
    if (!checkLoginRateLimit(clientIp)) {
      res.status(429).json({ error: 'बहुत अधिक प्रयास किए गए। कृपया 1 मिनट बाद पुनः प्रयास करें।' });
      return;
    }
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'यूज़र नाम और पासवर्ड आवश्यक हैं।' });
      return;
    }
    const user = authenticateUser(username, password);
    if (!user) {
      res.status(401).json({ error: 'यूज़र नाम या पासवर्ड गलत है।' });
      return;
    }
    const token = createSession(user.id);
    res.json({ token, user });
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
      const { username, fullName, password, role, supervisorId } = req.body ?? {};
      if (typeof username !== 'string' || typeof fullName !== 'string' || typeof password !== 'string') {
        res.status(400).json({ error: 'यूज़र नाम, पूरा नाम और पासवर्ड आवश्यक हैं।' });
        return;
      }
      const cleanUser = username.trim().toLowerCase();
      const cleanName = fullName.trim();
      if (!/^[a-z0-9._-]{3,32}$/.test(cleanUser)) {
        res.status(400).json({
          error: 'यूज़र नाम 3 से 32 अक्षरों का होना चाहिए (केवल अंग्रेज़ी अक्षर, अंक, ., _, -)।',
        });
        return;
      }
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
      const parsedSupervisorId =
        supervisorId === null || supervisorId === undefined || supervisorId === ''
          ? null
          : Number(supervisorId);
      if (parsedSupervisorId !== null && (!Number.isInteger(parsedSupervisorId) || parsedSupervisorId <= 0)) {
        res.status(400).json({ error: 'अमान्य सुपरवाइज़र चयन।' });
        return;
      }

      const created = createUserAccount({
        username: cleanUser,
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
      const { fullName, role, supervisorId, password } = req.body ?? {};
      if (role !== undefined && !isValidRole(role)) {
        res.status(400).json({ error: 'अमान्य रोल।' });
        return;
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

  // --- Dataset & Excel Upload/Export Routes ---

  app.get('/api/dataset', requireAuth, (req: AuthedRequest, res: Response) => {
    const dataset = getActiveDataset();
    if (!dataset) {
      res.json({ dataset: null, rows: [], remarksByRow: {} });
      return;
    }
    const rows = getDatasetRows(dataset.id);
    const visibleRemarks = getVisibleRemarksForDataset(dataset.id, req.currentUser!);
    const remarksByRow: Record<string, typeof visibleRemarks> = {};
    for (const r of visibleRemarks) {
      const key = String(r.rowId);
      if (!remarksByRow[key]) remarksByRow[key] = [];
      remarksByRow[key].push(r);
    }
    res.json({
      dataset,
      rows,
      remarksByRow,
      totalVisibleRemarks: visibleRemarks.length,
    });
  });

  app.post('/api/dataset/upload', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
    try {
      const { fileName, fileBase64 } = req.body ?? {};
      if (typeof fileName !== 'string' || typeof fileBase64 !== 'string' || !fileName.trim() || !fileBase64) {
        res.status(400).json({ error: 'कृपया एक वैध Excel या CSV फ़ाइल चुनें।' });
        return;
      }
      const cleanName = path.basename(fileName.trim());
      if (!/\.(xlsx|xls|csv)$/i.test(cleanName)) {
        res.status(400).json({ error: 'केवल .xlsx, .xls या .csv फ़ाइल ही अपलोड की जा सकती है।' });
        return;
      }
      const buffer = Buffer.from(fileBase64, 'base64');
      if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
        res.status(400).json({ error: 'फ़ाइल का आकार 10 MB से कम होना चाहिए।' });
        return;
      }
      const parsed = await parseUploadedSpreadsheet(buffer, cleanName);
      const saved = saveNewDataset(cleanName, parsed.headers, parsed.rows, req.currentUser!);
      res.status(201).json({ dataset: saved });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'फ़ाइल प्रोसेस करने में त्रुटि हुई।';
      res.status(400).json({ error: msg });
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
      const rows = getDatasetRows(dataset.id);
      const remarks = getAllRemarksForDatasetAdmin(dataset.id);
      const buffer = await buildExportWorkbookBuffer({
        headers: dataset.headers,
        rows,
        remarks,
      });

      const baseSafeName = dataset.fileName.replace(/\.[^.]+$/, '').replace(/[^\w\s-]/g, '') || 'data';
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${baseSafeName}_with_remarks.xlsx"`
      );
      res.send(buffer);
    } catch {
      res.status(500).json({ error: 'Excel डाउनलोड फ़ाइल तैयार करने में त्रुटि हुई।' });
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
