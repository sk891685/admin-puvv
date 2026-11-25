import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Check, Pencil, Save, Trash2, X } from 'lucide-react';
import { addRowRemark, editRemark, removeRemark } from '../api';
import type { DatasetRow, RemarkItem, User } from '../types';
import { formatHindiDateTime, ROLE_META } from '../types';

interface RemarkSheetProps {
  row: DatasetRow | null;
  headers: string[];
  remarks: RemarkItem[];
  currentUser: User;
  onClose: () => void;
  onRemarkAdded: (rowId: number, remark: RemarkItem) => void;
  onRemarkUpdated: (rowId: number, remark: RemarkItem) => void;
  onRemarkDeleted: (rowId: number, remarkId: number) => void;
  onNotify: (message: string) => void;
}

const QUICK_REMARKS = [
  'उपभोक्ता से संपर्क हुआ',
  'भुगतान का आश्वासन मिला',
  'मीटर चालू एवं सही है',
  'लाइन डिस्कनेक्ट की गई',
  'घर बंद मिला',
  'मीटर खराब पाया गया',
];

export function RemarkSheet({
  row,
  headers,
  remarks,
  currentUser,
  onClose,
  onRemarkAdded,
  onRemarkUpdated,
  onRemarkDeleted,
  onNotify,
}: RemarkSheetProps) {
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  useEffect(() => {
    setComment('');
    setError(null);
    setEditingId(null);
    setDeletingId(null);
  }, [row?.id]);

  useEffect(() => {
    if (!row) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [row, onClose]);

  if (!row) return null;

  async function handleSaveNew(e: FormEvent) {
    e.preventDefault();
    if (!row) return;
    const trimmed = comment.trim();
    if (!trimmed) {
      setError('कृपया पहले रिमार्क लिखें।');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await addRowRemark(row.id, trimmed);
      onRemarkAdded(row.id, res.remark);
      setComment('');
      onNotify('रिमार्क सफलतापूर्वक सेव हो गया।');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'रिमार्क सेव करने में त्रुटि हुई।');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveEdit(remarkId: number) {
    if (!row) return;
    const trimmed = editText.trim();
    if (!trimmed) return;
    setEditSaving(true);
    setError(null);
    try {
      const res = await editRemark(remarkId, trimmed);
      onRemarkUpdated(row.id, res.remark);
      setEditingId(null);
      onNotify('रिमार्क अपडेट हो गया।');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'रिमार्क अपडेट नहीं हो सका।');
    } finally {
      setEditSaving(false);
    }
  }

  async function handleConfirmDelete(remarkId: number) {
    if (!row) return;
    setError(null);
    try {
      await removeRemark(remarkId);
      onRemarkDeleted(row.id, remarkId);
      setDeletingId(null);
      onNotify('रिमार्क हटा दिया गया।');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'रिमार्क हटाने में त्रुटि हुई।');
    }
  }

  const primaryTitle =
    row.data[headers[0]] || row.data[headers[1]] || `रिकॉर्ड #${row.rowIndex}`;
  const secondaryTitle = headers[1] ? row.data[headers[1]] : '';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-stretch md:justify-end bg-slate-900/50 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="remark-sheet-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full md:max-w-xl bg-white rounded-t-3xl md:rounded-t-none md:rounded-l-2xl max-h-[92vh] md:max-h-full md:h-full flex flex-col shadow-2xl overflow-hidden">
        {/* Mobile grab handle */}
        <div className="md:hidden pt-2.5 pb-1 flex justify-center">
          <div className="w-10 h-1.5 bg-slate-300 rounded-full" />
        </div>

        {/* Sheet Header */}
        <div className="px-5 sm:px-6 py-4 border-b border-slate-200 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-500 tabular-nums">
              पंक्ति #{row.rowIndex} · रिमार्क एवं विवरण
            </p>
            <h2
              id="remark-sheet-title"
              className="text-lg sm:text-xl font-bold text-slate-900 truncate mt-0.5"
            >
              {primaryTitle}
              {secondaryTitle && secondaryTitle !== primaryTitle ? ` — ${secondaryTitle}` : ''}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="बंद करें"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-900 cursor-pointer shrink-0"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto px-5 sm:px-6 py-5 space-y-6">
          {/* Read-only Original Excel Data */}
          <section>
            <div className="flex items-center justify-between gap-2 mb-3">
              <h3 className="text-sm font-semibold text-slate-900">मूल Excel विवरण</h3>
              <span className="text-xs text-slate-500">सुरक्षित (बदला नहीं जा सकता)</span>
            </div>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5 bg-slate-50 border border-slate-200 rounded-xl p-4">
              {headers.map((header) => (
                <div key={header} className="min-w-0">
                  <dt className="text-xs text-slate-500 truncate">{header}</dt>
                  <dd className="text-sm font-medium text-slate-900 break-words tabular-nums mt-0.5">
                    {row.data[header] || '—'}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {/* Add New Remark Form */}
          <section className="border-t border-slate-200 pt-5">
            <h3 className="text-sm font-semibold text-slate-900 mb-2">नया रिमार्क लिखें</h3>

            {error && (
              <div className="mb-3 rounded-xl bg-red-50 border border-red-200 px-3.5 py-2.5 text-sm text-red-800">
                {error}
              </div>
            )}

            {/* Quick preset buttons for faster mobile field entry */}
            <div className="flex flex-wrap gap-1.5 mb-3">
              {QUICK_REMARKS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() =>
                    setComment((prev) => (prev.trim() ? `${prev.trim()}। ${preset}` : preset))
                  }
                  className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-blue-50 hover:border-blue-300 text-xs font-medium text-slate-700 hover:text-blue-800 transition-colors cursor-pointer"
                >
                  + {preset}
                </button>
              ))}
            </div>

            <form onSubmit={handleSaveNew} className="space-y-3">
              <textarea
                rows={3}
                maxLength={1000}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="यहाँ अपनी टिप्पणी या फील्ड निरीक्षण का विवरण लिखें..."
                className="w-full rounded-xl border border-slate-300 bg-white p-3.5 text-base text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20 resize-y"
              />
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-slate-500">
                  {currentUser.fullName} · {ROLE_META[currentUser.role].label} के रूप में सेव होगा
                </span>
                <button
                  type="submit"
                  disabled={saving || !comment.trim()}
                  className="min-h-[46px] px-6 rounded-xl bg-blue-700 hover:bg-blue-800 active:scale-[0.98] disabled:opacity-50 text-white font-semibold text-sm flex items-center gap-2 transition-all whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Save className="h-4 w-4" />
                  <span>{saving ? 'सेव हो रहा है...' : 'Save (सेव करें)'}</span>
                </button>
              </div>
            </form>
          </section>

          {/* Visible Remarks List */}
          <section className="border-t border-slate-200 pt-5">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 mb-3">
              <h3 className="text-sm font-semibold text-slate-900 tabular-nums">
                दर्ज रिमार्क ({remarks.length})
              </h3>
              <span className="text-xs text-slate-500">
                {ROLE_META[currentUser.role].remarkVisibilityHint}
              </span>
            </div>

            {remarks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-7 text-center">
                <p className="text-sm font-medium text-slate-700">अभी कोई रिमार्क दर्ज नहीं है।</p>
                <p className="text-xs text-slate-500 mt-1">
                  ऊपर बॉक्स में लिखकर &quot;Save (सेव करें)&quot; दबाएँ।
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-slate-200 border border-slate-200 rounded-xl bg-white">
                {remarks.map((item) => {
                  const canManage =
                    currentUser.role === 'admin' || item.userId === currentUser.id;
                  const isEditing = editingId === item.id;

                  return (
                    <li key={item.id} className="p-4 space-y-2">
                      {isEditing ? (
                        <div className="space-y-2.5">
                          <textarea
                            rows={2}
                            maxLength={1000}
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            className="w-full rounded-lg border border-blue-400 p-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
                          />
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              className="min-h-[38px] px-3.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                            >
                              रद्द करें
                            </button>
                            <button
                              type="button"
                              disabled={editSaving || !editText.trim()}
                              onClick={() => handleSaveEdit(item.id)}
                              className="min-h-[38px] px-4 rounded-lg bg-blue-700 text-white text-xs font-semibold hover:bg-blue-800 disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
                            >
                              <Check className="h-3.5 w-3.5" />
                              <span>अपडेट करें</span>
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="text-sm sm:text-base text-slate-900 whitespace-pre-wrap break-words leading-relaxed">
                            {item.comment}
                          </p>
                          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                            <div className="text-xs text-slate-500 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 tabular-nums">
                              <span className="font-semibold text-slate-700">{item.userName}</span>
                              <span aria-hidden="true">·</span>
                              <span>{ROLE_META[item.userRole].label}</span>
                              <span aria-hidden="true">·</span>
                              <span>{formatHindiDateTime(item.updatedAt)}</span>
                            </div>

                            {canManage && (
                              <div className="flex items-center gap-1">
                                {deletingId === item.id ? (
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => handleConfirmDelete(item.id)}
                                      className="min-h-[34px] px-2.5 rounded-lg bg-red-600 text-white text-xs font-medium hover:bg-red-700 cursor-pointer"
                                    >
                                      हटाएँ
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setDeletingId(null)}
                                      className="min-h-[34px] px-2.5 rounded-lg border border-slate-300 text-xs text-slate-600 hover:bg-slate-50 cursor-pointer"
                                    >
                                      नहीं
                                    </button>
                                  </div>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingId(item.id);
                                        setEditText(item.comment);
                                      }}
                                      aria-label="रिमार्क संपादित करें"
                                      className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 cursor-pointer"
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setDeletingId(item.id)}
                                      aria-label="रिमार्क हटाएँ"
                                      className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-700 cursor-pointer"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
