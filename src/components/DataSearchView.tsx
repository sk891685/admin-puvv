import { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  LayoutGrid,
  MessageSquarePlus,
  Search,
  Table2,
  X,
} from 'lucide-react';
import { downloadExcelWithRemarks } from '../api';
import type { DatasetInfo, DatasetRow, RemarkItem, User } from '../types';
import { formatHindiDateTime, ROLE_META } from '../types';

interface DataSearchViewProps {
  currentUser: User;
  dataset: DatasetInfo | null;
  rows: DatasetRow[];
  remarksByRow: Record<string, RemarkItem[]>;
  loading: boolean;
  onSelectRowForRemark: (row: DatasetRow) => void;
  onGoToUpload: () => void;
  onNotify: (message: string) => void;
}

type RemarkFilterMode = 'all' | 'with_remarks' | 'without_remarks';

export function DataSearchView({
  currentUser,
  dataset,
  rows,
  remarksByRow,
  loading,
  onSelectRowForRemark,
  onGoToUpload,
  onNotify,
}: DataSearchViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedColumn, setSelectedColumn] = useState<string>('__ALL__');
  const [selectedValue, setSelectedValue] = useState<string>('__ALL__');
  const [remarkFilter, setRemarkFilter] = useState<RemarkFilterMode>('all');
  const [mobileLayout, setMobileLayout] = useState<'table' | 'cards'>('table');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [exporting, setExporting] = useState(false);

  const headers = dataset?.headers ?? [];

  // Reset column/value filter if dataset changes
  useEffect(() => {
    setSelectedColumn('__ALL__');
    setSelectedValue('__ALL__');
    setPage(1);
  }, [dataset?.id]);

  // Reset value filter & page when column changes
  useEffect(() => {
    setSelectedValue('__ALL__');
    setPage(1);
  }, [selectedColumn]);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, selectedValue, remarkFilter, pageSize]);

  // Distinct values for exact filtering when a specific column is picked
  const columnDistinctValues = useMemo(() => {
    if (selectedColumn === '__ALL__' || rows.length === 0) return [];
    const set = new Set<string>();
    for (const r of rows) {
      const val = (r.data[selectedColumn] ?? '').trim();
      if (val) set.add(val);
      if (set.size > 200) break;
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'hi'));
  }, [rows, selectedColumn]);

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rows.filter((row) => {
      const rowRemarks = remarksByRow[String(row.id)] ?? [];
      if (remarkFilter === 'with_remarks' && rowRemarks.length === 0) return false;
      if (remarkFilter === 'without_remarks' && rowRemarks.length > 0) return false;

      if (selectedColumn !== '__ALL__' && selectedValue !== '__ALL__') {
        const cell = (row.data[selectedColumn] ?? '').trim();
        if (cell !== selectedValue) return false;
      }

      if (!q) return true;

      if (selectedColumn !== '__ALL__') {
        const cellVal = (row.data[selectedColumn] ?? '').toLowerCase();
        return cellVal.includes(q);
      }

      // Search across all Excel columns + visible remarks
      for (const h of headers) {
        if ((row.data[h] ?? '').toLowerCase().includes(q)) return true;
      }
      for (const rem of rowRemarks) {
        if (rem.comment.toLowerCase().includes(q) || rem.userName.toLowerCase().includes(q)) {
          return true;
        }
      }
      return false;
    });
  }, [rows, remarksByRow, remarkFilter, selectedColumn, selectedValue, searchQuery, headers]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visibleRows = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, safePage, pageSize]);

  const rowsWithRemarksCount = useMemo(() => {
    let count = 0;
    for (const r of rows) {
      if ((remarksByRow[String(r.id)]?.length ?? 0) > 0) count += 1;
    }
    return count;
  }, [rows, remarksByRow]);

  async function handleQuickExport() {
    setExporting(true);
    try {
      await downloadExcelWithRemarks();
      onNotify('रिमार्क के साथ Excel फ़ाइल डाउनलोड हो गई।');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'डाउनलोड में त्रुटि हुई।');
    } finally {
      setExporting(false);
    }
  }

  function clearFilters() {
    setSearchQuery('');
    setSelectedColumn('__ALL__');
    setSelectedValue('__ALL__');
    setRemarkFilter('all');
  }

  const hasActiveFilter =
    searchQuery.trim() !== '' ||
    selectedColumn !== '__ALL__' ||
    selectedValue !== '__ALL__' ||
    remarkFilter !== 'all';

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-14 rounded-2xl bg-slate-200/70 animate-pulse" />
        <div className="h-80 rounded-2xl bg-slate-200/60 animate-pulse" />
      </div>
    );
  }

  if (!dataset) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-8 sm:p-12 text-center max-w-2xl mx-auto mt-4">
        <FileSpreadsheet className="h-12 w-12 text-blue-700 mx-auto mb-4" />
        <h1 className="text-xl sm:text-2xl font-bold text-slate-900">
          अभी कोई Excel डाटा अपलोड नहीं किया गया है
        </h1>
        <p className="text-sm sm:text-base text-slate-600 mt-2">
          {currentUser.role === 'admin'
            ? 'शुरुआत करने के लिए अपनी .xlsx, .xls या .csv फ़ाइल अपलोड करें। उसके बाद सभी यूज़र डाटा सर्च कर सकेंगे और रिमार्क लिख सकेंगे।'
            : 'कृपया अपने Admin से Excel शीट अपलोड करने के लिए कहें। अपलोड होते ही यहाँ सारा डाटा सर्च के लिए उपलब्ध हो जाएगा।'}
        </p>
        {currentUser.role === 'admin' && (
          <button
            type="button"
            onClick={onGoToUpload}
            className="mt-6 min-h-[48px] px-6 rounded-xl bg-blue-700 hover:bg-blue-800 text-white font-semibold text-sm inline-flex items-center gap-2 cursor-pointer"
          >
            <FileSpreadsheet className="h-5 w-5" />
            <span>Excel अपलोड पेज पर जाएँ</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header Summary Strip */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 truncate">
            डाटा सर्च एवं रिमार्क
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs sm:text-sm text-slate-600 tabular-nums">
            <span className="font-medium text-slate-800">{dataset.fileName}</span>
            <span aria-hidden="true">·</span>
            <span>कुल {dataset.rowCount} रिकॉर्ड</span>
            <span aria-hidden="true">·</span>
            <span>{rowsWithRemarksCount} में रिमार्क दर्ज</span>
            <span aria-hidden="true">·</span>
            <span className="text-slate-500">{ROLE_META[currentUser.role].remarkVisibilityHint}</span>
          </div>
        </div>

        {currentUser.role === 'admin' && (
          <button
            type="button"
            disabled={exporting}
            onClick={handleQuickExport}
            className="min-h-[44px] px-4 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white font-semibold text-sm flex items-center justify-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="h-4 w-4" />
            <span>{exporting ? 'तैयार हो रहा है...' : 'रिमार्क सहित Excel डाउनलोड'}</span>
          </button>
        )}
      </div>

      {/* Search & Column Filter Controls */}
      <section className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
          {/* Primary Search Input */}
          <div className="lg:col-span-6 relative">
            <label htmlFor="global-search" className="sr-only">
              डाटा खोजें
            </label>
            <Search className="h-5 w-5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id="global-search"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                selectedColumn === '__ALL__'
                  ? 'Consumer No., नाम, फीडर, ट्रांसफार्मर आदि खोजें...'
                  : `"${selectedColumn}" कॉलम में खोजें...`
              }
              className="w-full min-h-[48px] rounded-xl border border-slate-300 bg-white pl-11 pr-11 text-base text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="खोज साफ़ करें"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Column Filter Dropdown */}
          <div className="lg:col-span-3">
            <label htmlFor="column-filter" className="sr-only">
              कॉलम चुनें
            </label>
            <select
              id="column-filter"
              value={selectedColumn}
              onChange={(e) => setSelectedColumn(e.target.value)}
              className="w-full min-h-[48px] rounded-xl border border-slate-300 bg-white px-3.5 text-sm sm:text-base text-slate-900 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
            >
              <option value="__ALL__">कॉलम फ़िल्टर: सभी कॉलम</option>
              {headers.map((h) => (
                <option key={h} value={h}>
                  कॉलम: {h}
                </option>
              ))}
            </select>
          </div>

          {/* Exact Value Filter (active when a column is selected) */}
          <div className="lg:col-span-3">
            <label htmlFor="value-filter" className="sr-only">
              मान फ़िल्टर करें
            </label>
            <select
              id="value-filter"
              disabled={selectedColumn === '__ALL__' || columnDistinctValues.length === 0}
              value={selectedValue}
              onChange={(e) => setSelectedValue(e.target.value)}
              className="w-full min-h-[48px] rounded-xl border border-slate-300 bg-white px-3.5 text-sm sm:text-base text-slate-900 disabled:bg-slate-50 disabled:text-slate-400 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
            >
              <option value="__ALL__">
                {selectedColumn === '__ALL__'
                  ? 'पहले कॉलम चुनें'
                  : `सभी मान (${columnDistinctValues.length})`}
              </option>
              {columnDistinctValues.map((val) => (
                <option key={val} value={val}>
                  {val}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Second Toolbar Row: Segmented Remark Filter + Result Count + Mobile View Toggle */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl overflow-x-auto max-w-full">
            {(
              [
                { id: 'all', label: `सभी (${rows.length})` },
                { id: 'with_remarks', label: `रिमार्क वाले (${rowsWithRemarksCount})` },
                { id: 'without_remarks', label: `बिना रिमार्क (${rows.length - rowsWithRemarksCount})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setRemarkFilter(tab.id)}
                className={`min-h-[38px] px-3.5 rounded-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap shrink-0 tabular-nums cursor-pointer ${
                  remarkFilter === tab.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs sm:text-sm font-medium text-slate-600 tabular-nums">
              परिणाम: <strong className="text-slate-900">{filteredRows.length}</strong>
            </span>

            {hasActiveFilter && (
              <button
                type="button"
                onClick={clearFilters}
                className="min-h-[38px] px-3 rounded-lg border border-slate-200 text-xs font-medium text-blue-700 hover:bg-blue-50 whitespace-nowrap cursor-pointer"
              >
                फ़िल्टर हटाएँ
              </button>
            )}

            {/* Mobile Table vs Card View toggle */}
            <div className="flex md:hidden items-center gap-1 p-1 bg-slate-100 rounded-xl">
              <button
                type="button"
                onClick={() => setMobileLayout('table')}
                aria-label="टेबल व्यू"
                className={`min-h-[36px] px-2.5 rounded-lg text-xs font-medium flex items-center gap-1 cursor-pointer ${
                  mobileLayout === 'table' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                <Table2 className="h-4 w-4" />
                <span>टेबल</span>
              </button>
              <button
                type="button"
                onClick={() => setMobileLayout('cards')}
                aria-label="कार्ड व्यू"
                className={`min-h-[36px] px-2.5 rounded-lg text-xs font-medium flex items-center gap-1 cursor-pointer ${
                  mobileLayout === 'cards' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                <LayoutGrid className="h-4 w-4" />
                <span>कार्ड</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Results Area */}
      {filteredRows.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center">
          <p className="text-base font-semibold text-slate-900">कोई मिलता-जुलता रिकॉर्ड नहीं मिला।</p>
          <p className="text-sm text-slate-500 mt-1">
            कृपया दूसरा शब्द खोजें या कॉलम फ़िल्टर बदलें।
          </p>
          {hasActiveFilter && (
            <button
              type="button"
              onClick={clearFilters}
              className="mt-4 min-h-[44px] px-5 rounded-xl bg-blue-700 text-white text-sm font-semibold hover:bg-blue-800 cursor-pointer"
            >
              सभी रिकॉर्ड दिखाएँ
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Mobile Card Layout (when user chooses Card mode on small screens) */}
          <div className={`${mobileLayout === 'cards' ? 'block md:hidden' : 'hidden'} space-y-3`}>
            {visibleRows.map((row) => {
              const rowRemarks = remarksByRow[String(row.id)] ?? [];
              const latest = rowRemarks[0];
              return (
                <article
                  key={row.id}
                  className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs text-slate-500 tabular-nums">पंक्ति #{row.rowIndex}</p>
                      <h3 className="text-base font-bold text-slate-900 break-words">
                        {row.data[headers[0]] || '—'}
                        {headers[1] && row.data[headers[1]] ? ` · ${row.data[headers[1]]}` : ''}
                      </h3>
                    </div>
                  </div>

                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs border-t border-slate-100 pt-3">
                    {headers.slice(2).map((h) => (
                      <div key={h} className="min-w-0">
                        <dt className="text-slate-500 truncate">{h}</dt>
                        <dd className="font-medium text-slate-900 break-words tabular-nums mt-0.5">
                          {row.data[h] || '—'}
                        </dd>
                      </div>
                    ))}
                  </dl>

                  {latest && (
                    <div className="border-t border-slate-100 pt-2.5 text-xs space-y-0.5">
                      <p className="text-slate-800 line-clamp-2 font-medium">{latest.comment}</p>
                      <p className="text-slate-500 tabular-nums">
                        {latest.userName} · {ROLE_META[latest.userRole].label} ·{' '}
                        {formatHindiDateTime(latest.updatedAt)}
                      </p>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => onSelectRowForRemark(row)}
                    className="w-full min-h-[46px] rounded-xl bg-blue-700 hover:bg-blue-800 active:scale-[0.99] text-white font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <MessageSquarePlus className="h-4 w-4" />
                    <span>
                      {rowRemarks.length > 0
                        ? `Remark देखें / जोड़ें (${rowRemarks.length})`
                        : 'Remark लिखें'}
                    </span>
                  </button>
                </article>
              );
            })}
          </div>

          {/* Crisp Responsive Data Table (Always visible on Desktop, default on Mobile) */}
          <section
            className={`${
              mobileLayout === 'cards' ? 'hidden md:block' : 'block'
            } bg-white border border-slate-200 rounded-2xl overflow-hidden`}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-100/90 border-b border-slate-200 text-xs font-semibold text-slate-700">
                    <th className="py-3 px-3.5 w-12 text-slate-500 tabular-nums whitespace-nowrap">
                      #
                    </th>
                    {headers.map((header) => (
                      <th
                        key={header}
                        className="py-3 px-3.5 whitespace-nowrap"
                      >
                        {header}
                      </th>
                    ))}
                    <th className="py-3 px-3.5 min-w-[220px] whitespace-nowrap">
                      अंतिम रिमार्क
                    </th>
                    <th className="py-3 px-3.5 text-right whitespace-nowrap sticky right-0 bg-slate-100/95 border-l border-slate-200">
                      कार्य (Action)
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-sm">
                  {visibleRows.map((row) => {
                    const rowRemarks = remarksByRow[String(row.id)] ?? [];
                    const latest = rowRemarks[0];
                    return (
                      <tr
                        key={row.id}
                        className="hover:bg-blue-50/40 transition-colors align-top"
                      >
                        <td className="py-3 px-3.5 font-mono-tabular text-xs text-slate-500 whitespace-nowrap">
                          {row.rowIndex}
                        </td>
                        {headers.map((header) => (
                          <td
                            key={header}
                            className="py-3 px-3.5 text-slate-900 tabular-nums max-w-[260px] break-words"
                          >
                            {row.data[header] || '—'}
                          </td>
                        ))}
                        <td className="py-3 px-3.5 max-w-[280px]">
                          {latest ? (
                            <div className="space-y-0.5">
                              <p className="text-slate-900 line-clamp-2 text-xs sm:text-sm leading-snug">
                                {latest.comment}
                              </p>
                              <p className="text-xs text-slate-500 tabular-nums">
                                {latest.userName} · {ROLE_META[latest.userRole].label}
                                {rowRemarks.length > 1 ? ` · +${rowRemarks.length - 1} और` : ''}
                              </p>
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">कोई रिमार्क नहीं</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3.5 text-right whitespace-nowrap sticky right-0 bg-white border-l border-slate-100">
                          <button
                            type="button"
                            onClick={() => onSelectRowForRemark(row)}
                            className={`min-h-[40px] px-4 rounded-xl text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap ${
                              rowRemarks.length > 0
                                ? 'bg-blue-50 text-blue-800 border border-blue-200 hover:bg-blue-100'
                                : 'bg-blue-700 text-white hover:bg-blue-800'
                            }`}
                          >
                            <MessageSquarePlus className="h-4 w-4" />
                            <span>
                              Remark{rowRemarks.length > 0 ? ` (${rowRemarks.length})` : ''}
                            </span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination Footer */}
            <div className="px-4 sm:px-5 py-3.5 border-t border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3 text-xs sm:text-sm">
              <div className="flex items-center gap-2 text-slate-600 tabular-nums">
                <span>
                  पृष्ठ <strong className="text-slate-900">{safePage}</strong> / {totalPages}
                </span>
                <span aria-hidden="true">·</span>
                <label htmlFor="page-size-select" className="sr-only">
                  प्रति पृष्ठ पंक्तियाँ
                </label>
                <select
                  id="page-size-select"
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  className="min-h-[36px] rounded-lg border border-slate-300 bg-white px-2 text-xs text-slate-800"
                >
                  <option value={25}>25 प्रति पृष्ठ</option>
                  <option value={50}>50 प्रति पृष्ठ</option>
                  <option value={100}>100 प्रति पृष्ठ</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="min-h-[40px] px-3.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 text-slate-700 font-medium inline-flex items-center gap-1 cursor-pointer"
                >
                  <ChevronLeft className="h-4 w-4" />
                  <span>पिछला</span>
                </button>
                <button
                  type="button"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="min-h-[40px] px-3.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 text-slate-700 font-medium inline-flex items-center gap-1 cursor-pointer"
                >
                  <span>अगला</span>
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
