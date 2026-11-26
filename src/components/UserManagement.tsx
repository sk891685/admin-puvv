import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Check, Eye, EyeOff, Mail, Pencil, Phone, Trash2, UserPlus, X } from 'lucide-react';
import { createUser, deleteUser, fetchUsers, updateUser } from '../api';
import type { User, UserRole } from '../types';
import { formatHindiDateTime, ROLE_META } from '../types';

interface UserManagementProps {
  currentUser: User;
  onNotify: (message: string) => void;
  onUsersChanged?: () => void;
}

const ROLES: UserRole[] = ['admin', 'je', 'supervisor', 'lineman'];

export function UserManagement({ currentUser, onNotify, onUsersChanged }: UserManagementProps) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form state
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [role, setRole] = useState<UserRole>('lineman');
  const [supervisorId, setSupervisorId] = useState<string>('');
  const [creating, setCreating] = useState(false);

  // Edit / Delete inline state
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editFullName, setEditFullName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editMobile, setEditMobile] = useState('');
  const [editRole, setEditRole] = useState<UserRole>('lineman');
  const [editSupervisorId, setEditSupervisorId] = useState<string>('');
  const [editPassword, setEditPassword] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const supervisors = useMemo(
    () => users.filter((u) => u.role === 'supervisor'),
    [users]
  );

  async function loadUsers() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchUsers();
      setUsers(res.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'यूज़र सूची लोड करने में त्रुटि हुई।');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadUsers();
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const res = await createUser({
        fullName,
        email,
        mobile,
        username: username.trim() || undefined,
        password,
        role,
        supervisorId: role === 'lineman' && supervisorId ? Number(supervisorId) : null,
      });
      setUsers((prev) => [...prev, res.user]);
      setFullName('');
      setEmail('');
      setMobile('');
      setUsername('');
      setPassword('');
      setRole('lineman');
      setSupervisorId('');
      onNotify(
        `नया यूज़र "${res.user.fullName}" (User ID: ${res.user.username} · ${ROLE_META[res.user.role].label}) बनाया गया।`
      );
      await loadUsers();
      onUsersChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'यूज़र बनाने में त्रुटि हुई।');
    } finally {
      setCreating(false);
    }
  }

  function startEdit(u: User) {
    setEditingUser(u);
    setEditFullName(u.fullName);
    setEditEmail(u.email);
    setEditMobile(u.mobile);
    setEditRole(u.role);
    setEditSupervisorId(u.supervisorId ? String(u.supervisorId) : '');
    setEditPassword('');
    setConfirmDeleteId(null);
  }

  async function handleSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editingUser) return;
    setError(null);
    setSavingEdit(true);
    try {
      await updateUser(editingUser.id, {
        fullName: editFullName,
        email: editEmail,
        mobile: editMobile,
        role: editRole,
        supervisorId: editRole === 'lineman' && editSupervisorId ? Number(editSupervisorId) : null,
        password: editPassword.trim() ? editPassword.trim() : undefined,
      });
      setEditingUser(null);
      onNotify('यूज़र जानकारी अपडेट हो गई।');
      await loadUsers();
      onUsersChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'यूज़र अपडेट करने में त्रुटि हुई।');
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDelete(targetId: number) {
    setError(null);
    try {
      await deleteUser(targetId);
      setConfirmDeleteId(null);
      onNotify('यूज़र हटा दिया गया।');
      await loadUsers();
      onUsersChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'यूज़र हटाने में त्रुटि हुई।');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-slate-900">यूज़र और रोल प्रबंधन</h1>
        <p className="text-sm text-slate-600 mt-1">
          ईमेल आईडी और मोबाइल नंबर के साथ नए Admin, JE, Supervisor और Lineman खाते बनाएँ।
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Create New User Form */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-5 sm:p-6">
          <h2 className="text-base font-bold text-slate-900 mb-4">नया यूज़र जोड़ें</h2>

          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label htmlFor="new-fullname" className="block text-sm font-semibold text-slate-800 mb-1">
                पूरा नाम
              </label>
              <input
                id="new-fullname"
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="जैसे: सुरेश यादव"
                className="w-full min-h-[46px] rounded-xl border border-slate-300 px-3.5 text-sm sm:text-base text-slate-900 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
              />
            </div>

            <div>
              <label htmlFor="new-email" className="block text-sm font-semibold text-slate-800 mb-1">
                ईमेल आईडी (Email)
              </label>
              <div className="relative">
                <Mail className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="new-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="suresh@puvvnl.in"
                  className="w-full min-h-[46px] rounded-xl border border-slate-300 pl-10 pr-3.5 text-sm sm:text-base text-slate-900 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
                />
              </div>
            </div>

            <div>
              <label htmlFor="new-mobile" className="block text-sm font-semibold text-slate-800 mb-1">
                मोबाइल नंबर (Mobile Number)
              </label>
              <div className="relative">
                <Phone className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="new-mobile"
                  type="tel"
                  required
                  value={mobile}
                  onChange={(e) => setMobile(e.target.value)}
                  placeholder="जैसे: 9839012345"
                  className="w-full min-h-[46px] rounded-xl border border-slate-300 pl-10 pr-3.5 text-sm sm:text-base text-slate-900 tabular-nums focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="new-username" className="block text-sm font-semibold text-slate-800 mb-1">
                  यूज़र आईडी (User ID)
                </label>
                <input
                  id="new-username"
                  type="text"
                  required
                  minLength={3}
                  maxLength={32}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="जैसे: suresh01"
                  className="w-full min-h-[46px] rounded-xl border border-slate-300 px-3.5 text-sm sm:text-base text-slate-900 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
                />
              </div>

              <div>
                <label htmlFor="new-password" className="block text-sm font-semibold text-slate-800 mb-1">
                  पासवर्ड (Password)
                </label>
                <div className="relative">
                  <input
                    id="new-password"
                    type={showNewPassword ? 'text' : 'password'}
                    required
                    minLength={4}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="कम से कम 4 अक्षर"
                    className="w-full min-h-[46px] rounded-xl border border-slate-300 pl-3.5 pr-10 text-sm sm:text-base text-slate-900 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword((prev) => !prev)}
                    aria-label={showNewPassword ? 'पासवर्ड छुपाएँ' : 'पासवर्ड देखें'}
                    className="absolute right-1 top-1/2 -translate-y-1/2 min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-800 cursor-pointer"
                  >
                    {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>

            <div>
              <label htmlFor="new-role" className="block text-sm font-semibold text-slate-800 mb-1">
                रोल चुनें
              </label>
              <select
                id="new-role"
                value={role}
                onChange={(e) => setRole(e.target.value as UserRole)}
                className="w-full min-h-[46px] rounded-xl border border-slate-300 bg-white px-3.5 text-sm sm:text-base text-slate-900 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_META[r].hindiLabel}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-500 mt-1.5 leading-snug">
                {ROLE_META[role].permissionSummary}
              </p>
            </div>

            {role === 'lineman' && (
              <div>
                <label htmlFor="new-supervisor" className="block text-sm font-semibold text-slate-800 mb-1">
                  सुपरवाइज़र जोड़ें (वैकल्पिक)
                </label>
                <select
                  id="new-supervisor"
                  value={supervisorId}
                  onChange={(e) => setSupervisorId(e.target.value)}
                  className="w-full min-h-[46px] rounded-xl border border-slate-300 bg-white px-3.5 text-sm sm:text-base text-slate-900 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
                >
                  <option value="">कोई सुपरवाइज़र चयनित नहीं</option>
                  {supervisors.map((sup) => (
                    <option key={sup.id} value={sup.id}>
                      {sup.fullName} ({sup.email || `@${sup.username}`})
                    </option>
                  ))}
                </select>
                {supervisors.length === 0 && (
                  <p className="text-xs text-amber-700 mt-1">
                    पहले एक Supervisor खाता बनाएँ ताकि लाइनमैन को उससे जोड़ा जा सके।
                  </p>
                )}
              </div>
            )}

            <button
              type="submit"
              disabled={creating}
              className="w-full min-h-[48px] rounded-xl bg-blue-700 hover:bg-blue-800 active:scale-[0.99] disabled:opacity-60 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-all cursor-pointer"
            >
              <UserPlus className="h-5 w-5" />
              <span>{creating ? 'बनाया जा रहा है...' : 'नया यूज़र बनाएँ'}</span>
            </button>
          </form>
        </section>

        {/* Existing Users List */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-2xl overflow-hidden">
          <div className="px-5 sm:px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-2">
            <h2 className="text-base font-bold text-slate-900 tabular-nums">
              मौजूदा यूज़र ({users.length})
            </h2>
            <span className="text-xs text-slate-500">Admin · JE · Supervisor · Lineman</span>
          </div>

          {loading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((n) => (
                <div key={n} className="h-14 rounded-xl bg-slate-100 animate-pulse" />
              ))}
            </div>
          ) : users.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">कोई यूज़र नहीं मिला।</div>
          ) : (
            <ul className="divide-y divide-slate-200">
              {users.map((u) => {
                const isSelf = u.id === currentUser.id;
                const isEditing = editingUser?.id === u.id;

                return (
                  <li key={u.id} className="p-4 sm:px-6">
                    {isEditing ? (
                      <form onSubmit={handleSaveEdit} className="space-y-3 bg-slate-50 rounded-xl p-4 border border-slate-200">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-semibold text-slate-700 mb-1">
                              पूरा नाम
                            </label>
                            <input
                              type="text"
                              required
                              value={editFullName}
                              onChange={(e) => setEditFullName(e.target.value)}
                              className="w-full min-h-[42px] rounded-lg border border-slate-300 bg-white px-3 text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-semibold text-slate-700 mb-1">
                              रोल
                            </label>
                            <select
                              value={editRole}
                              disabled={isSelf}
                              onChange={(e) => setEditRole(e.target.value as UserRole)}
                              className="w-full min-h-[42px] rounded-lg border border-slate-300 bg-white px-3 text-sm disabled:opacity-60"
                            >
                              {ROLES.map((r) => (
                                <option key={r} value={r}>
                                  {ROLE_META[r].hindiLabel}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-semibold text-slate-700 mb-1">
                              ईमेल आईडी
                            </label>
                            <input
                              type="email"
                              value={editEmail}
                              onChange={(e) => setEditEmail(e.target.value)}
                              placeholder="example@puvvnl.in"
                              className="w-full min-h-[42px] rounded-lg border border-slate-300 bg-white px-3 text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-semibold text-slate-700 mb-1">
                              मोबाइल नंबर
                            </label>
                            <input
                              type="tel"
                              value={editMobile}
                              onChange={(e) => setEditMobile(e.target.value)}
                              placeholder="10 अंकों का मोबाइल नंबर"
                              className="w-full min-h-[42px] rounded-lg border border-slate-300 bg-white px-3 text-sm tabular-nums"
                            />
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {editRole === 'lineman' && (
                            <div>
                              <label className="block text-xs font-semibold text-slate-700 mb-1">
                                सुपरवाइज़र
                              </label>
                              <select
                                value={editSupervisorId}
                                onChange={(e) => setEditSupervisorId(e.target.value)}
                                className="w-full min-h-[42px] rounded-lg border border-slate-300 bg-white px-3 text-sm"
                              >
                                <option value="">कोई नहीं</option>
                                {supervisors.map((sup) => (
                                  <option key={sup.id} value={sup.id}>
                                    {sup.fullName} ({sup.email || `@${sup.username}`})
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}

                          <div>
                            <label className="block text-xs font-semibold text-slate-700 mb-1">
                              नया पासवर्ड (बदलना हो तो लिखें)
                            </label>
                            <input
                              type="password"
                              minLength={4}
                              value={editPassword}
                              onChange={(e) => setEditPassword(e.target.value)}
                              placeholder="खाली छोड़ें तो पुराना रहेगा"
                              className="w-full min-h-[42px] rounded-lg border border-slate-300 bg-white px-3 text-sm"
                            />
                          </div>
                        </div>

                        <div className="flex items-center justify-end gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => setEditingUser(null)}
                            className="min-h-[40px] px-4 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 flex items-center gap-1 cursor-pointer"
                          >
                            <X className="h-4 w-4" />
                            <span>रद्द करें</span>
                          </button>
                          <button
                            type="submit"
                            disabled={savingEdit}
                            className="min-h-[40px] px-4 rounded-lg bg-blue-700 text-white text-xs font-semibold hover:bg-blue-800 disabled:opacity-50 flex items-center gap-1 cursor-pointer"
                          >
                            <Check className="h-4 w-4" />
                            <span>{savingEdit ? 'सेव हो रहा है...' : 'बदलाव सेव करें'}</span>
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <span className="text-sm sm:text-base font-semibold text-slate-900">
                              {u.fullName}
                            </span>
                            <span className="font-mono-tabular text-xs text-slate-500">
                              @{u.username}
                            </span>
                            {isSelf && (
                              <span className="text-xs font-medium text-blue-700">(आप)</span>
                            )}
                          </div>

                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-600 tabular-nums">
                            <span className="font-semibold text-slate-800">
                              {ROLE_META[u.role].hindiLabel}
                            </span>
                            {u.email && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="break-all">{u.email}</span>
                              </>
                            )}
                            {u.mobile && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono-tabular">{u.mobile}</span>
                              </>
                            )}
                          </div>

                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 tabular-nums">
                            {u.role === 'lineman' && (
                              <>
                                <span>
                                  सुपरवाइज़र:{' '}
                                  <strong className="font-medium text-slate-700">
                                    {u.supervisorName ?? 'तय नहीं'}
                                  </strong>
                                </span>
                                <span aria-hidden="true">·</span>
                              </>
                            )}
                            <span>{formatHindiDateTime(u.createdAt)}</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {confirmDeleteId === u.id ? (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => void handleDelete(u.id)}
                                className="min-h-[40px] px-3.5 rounded-xl bg-red-600 text-white text-xs font-semibold hover:bg-red-700 cursor-pointer"
                              >
                                पक्का हटाएँ
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="min-h-[40px] px-3 rounded-xl border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                              >
                                रद्द
                              </button>
                            </div>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => startEdit(u)}
                                className="min-h-[40px] px-3.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 flex items-center gap-1.5 cursor-pointer"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                                <span>संपादित</span>
                              </button>
                              {!isSelf && (
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(u.id)}
                                  className="min-h-[40px] px-3.5 rounded-xl border border-red-200 bg-white hover:bg-red-50 text-xs font-medium text-red-700 flex items-center gap-1.5 cursor-pointer"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                  <span>हटाएँ</span>
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
