import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { Download, FileSpreadsheet, FileUp, Sparkles, X } from 'lucide-react';
import {
  downloadExcelWithRemarks,
  downloadSampleTemplate,
  loadSampleDataset,
  uploadSpreadsheetFile,
} from '../api';
import type { DatasetInfo, UploadProgress } from '../types';
import { formatBytes, formatHindiDateTime, MAX_UPLOAD_BYTES } from '../types';

interface UploadPanelProps {
  dataset: DatasetInfo | null;
  totalRemarks: number;
  onDatasetChanged: () => Promise<void>;
  onNotify: (message: string) => void;
  onOpenSearch: () => void;
}

export function UploadPanel({
  dataset,
  totalRemarks,
  onDatasetChanged,
  onNotify,
  onOpenSearch,
}: UploadPanelProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadingFileName, setUploadingFileName] = useState<string>('');
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [exporting, setExporting] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [confirmSampleReplace, setConfirmSampleReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function processFileUpload(file: File) {
    setError(null);
    setUploading(true);
    setUploadingFileName(file.name);
    setUploadProgress({
      phase: 'uploading',
      uploadedBytes: 0,
      totalBytes: file.size,
      percent: 0,
    });

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await uploadSpreadsheetFile(file, {
        signal: controller.signal,
        onProgress: (prog) => setUploadProgress(prog),
      });
      await onDatasetChanged();
      setPendingFile(null);
      onNotify(`"${res.dataset.fileName}" सफलतापूर्वक अपलोड हुई (${res.dataset.rowCount.toLocaleString('hi-IN')} पंक्तियाँ)।`);
      onOpenSearch();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('अपलोड रद्द कर दिया गया।');
      } else {
        setError(err instanceof Error ? err.message : 'फ़ाइल अपलोड करने में त्रुटि हुई।');
      }
    } finally {
      abortControllerRef.current = null;
      setUploading(false);
      setUploadProgress(null);
      setUploadingFileName('');
    }
  }

  function handleCancelUpload() {
    abortControllerRef.current?.abort();
  }

  function handleSelectedFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
      setError('कृपया केवल .xlsx, .xls या .csv फ़ाइल ही चुनें।');
      return;
    }
    if (file.size === 0) {
      setError('चुनी गई फ़ाइल खाली है।');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('फ़ाइल का आकार अधिकतम 10 GB तक हो सकता है।');
      return;
    }
    if (dataset && totalRemarks > 0) {
      setPendingFile(file);
      return;
    }
    void processFileUpload(file);
  }

  function handleFileInput(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    handleSelectedFile(file);
    e.target.value = '';
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (uploading) return;
    const file = e.dataTransfer.files?.[0];
    handleSelectedFile(file);
  }

  async function handleExport() {
    setError(null);
    setExporting(true);
    try {
      await downloadExcelWithRemarks();
      onNotify('रिमार्क के साथ Excel फ़ाइल डाउनलोड हो गई।');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Excel डाउनलोड में त्रुटि हुई।');
    } finally {
      setExporting(false);
    }
  }

  async function handleLoadSample(force = false) {
    if (dataset && totalRemarks > 0 && !force) {
      setConfirmSampleReplace(true);
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const res = await loadSampleDataset();
      await onDatasetChanged();
      setConfirmSampleReplace(false);
      onNotify(`नमूना डाटा लोड हो गया (${res.dataset.rowCount} उपभोक्ता रिकॉर्ड)।`);
      onOpenSearch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'नमूना डाटा लोड नहीं हो सका।');
    } finally {
      setUploading(false);
    }
  }

  async function handleDownloadTemplate() {
    setError(null);
    try {
      await downloadSampleTemplate();
      onNotify('नमूना Excel टेम्पलेट डाउनलोड हो गया।');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'टेम्पलेट डाउनलोड में त्रुटि हुई।');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900">
            Excel अपलोड एवं डाउनलोड
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            .xlsx, .xls या .csv फ़ाइल अपलोड करें (अधिकतम 10 GB)। पहली पंक्ति अपने-आप कॉलम हेडर बन जाएगी।
          </p>
        </div>

        {dataset && (
          <button
            type="button"
            disabled={exporting}
            onClick={handleExport}
            className="min-h-[48px] px-5 rounded-xl bg-emerald-700 hover:bg-emerald-800 active:scale-[0.99] disabled:opacity-60 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-all whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="h-5 w-5" />
            <span>{exporting ? 'तैयार हो रहा है...' : 'रिमार्क के साथ Excel डाउनलोड करें'}</span>
          </button>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl bg-red-50 border border-red-200 px-4 py-3.5 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      {/* Confirmation Banner if replacing dataset that has remarks */}
      {pendingFile && (
        <div className="rounded-xl bg-amber-50 border border-amber-300 p-4 sm:p-5 space-y-3">
          <p className="text-sm font-semibold text-amber-950">
            नई फ़ाइल &quot;{pendingFile.name}&quot; ({formatBytes(pendingFile.size)}) अपलोड करने से पहले ध्यान दें
          </p>
          <p className="text-sm text-amber-900">
            वर्तमान शीट में अभी <span className="font-bold tabular-nums">{totalRemarks}</span> रिमार्क दर्ज हैं। नई फ़ाइल अपलोड करने से पहले चाहें तो वर्तमान Excel डाउनलोड कर लें।
          </p>
          <div className="flex flex-wrap gap-2.5 pt-1">
            <button
              type="button"
              onClick={handleExport}
              className="min-h-[44px] px-4 rounded-xl bg-white border border-amber-400 text-amber-950 font-semibold text-sm hover:bg-amber-100 cursor-pointer"
            >
              पहले पुरानी Excel डाउनलोड करें
            </button>
            <button
              type="button"
              disabled={uploading}
              onClick={() => void processFileUpload(pendingFile)}
              className="min-h-[44px] px-4 rounded-xl bg-blue-700 text-white font-semibold text-sm hover:bg-blue-800 disabled:opacity-50 cursor-pointer"
            >
              {uploading ? 'अपलोड हो रहा है...' : 'हाँ, नई फ़ाइल अपलोड करें'}
            </button>
            <button
              type="button"
              onClick={() => setPendingFile(null)}
              className="min-h-[44px] px-4 rounded-xl text-slate-700 font-medium text-sm hover:bg-amber-100 cursor-pointer"
            >
              रद्द करें
            </button>
          </div>
        </div>
      )}

      {confirmSampleReplace && (
        <div className="rounded-xl bg-amber-50 border border-amber-300 p-4 sm:p-5 space-y-3">
          <p className="text-sm font-semibold text-amber-950">
            क्या आप वर्तमान शीट को बदलकर नमूना उपभोक्ता डाटा लोड करना चाहते हैं?
          </p>
          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              disabled={uploading}
              onClick={() => void handleLoadSample(true)}
              className="min-h-[44px] px-4 rounded-xl bg-blue-700 text-white font-semibold text-sm hover:bg-blue-800 cursor-pointer"
            >
              हाँ, नमूना डाटा लोड करें
            </button>
            <button
              type="button"
              onClick={() => setConfirmSampleReplace(false)}
              className="min-h-[44px] px-4 rounded-xl border border-slate-300 bg-white text-slate-700 text-sm font-medium hover:bg-slate-50 cursor-pointer"
            >
              रद्द करें
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Upload Dropzone */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-2xl p-5 sm:p-7">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (!uploading) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={`rounded-xl border-2 border-dashed p-6 sm:p-10 text-center transition-colors ${
              dragging
                ? 'border-blue-700 bg-blue-50/70'
                : 'border-slate-300 bg-slate-50/70 hover:border-slate-400'
            }`}
          >
            <FileUp className="h-10 w-10 text-blue-700 mx-auto mb-3" />
            <h2 className="text-base sm:text-lg font-bold text-slate-900">
              Excel या CSV फ़ाइल यहाँ चुनें
            </h2>
            <p className="text-sm text-slate-600 mt-1 max-w-md mx-auto">
              समर्थित फ़ॉर्मेट: .xlsx, .xls, .csv (अधिकतम 10 GB)। बड़ी फ़ाइलें सुरक्षित चंक स्ट्रीमिंग द्वारा अपने-आप अपलोड और प्रोसेस होंगी।
            </p>

            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
              onChange={handleFileInput}
              className="hidden"
            />

            {uploadProgress ? (
              <div className="mt-6 max-w-md mx-auto text-left bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between gap-2 text-xs sm:text-sm">
                  <span className="font-semibold text-slate-900 truncate">
                    {uploadingFileName}
                  </span>
                  <span className="font-mono-tabular font-semibold text-blue-700 shrink-0">
                    {uploadProgress.phase === 'processing'
                      ? 'प्रोसेसिंग...'
                      : `${uploadProgress.percent}%`}
                  </span>
                </div>

                <div className="w-full h-2.5 bg-slate-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-150 ${
                      uploadProgress.phase === 'processing'
                        ? 'bg-emerald-600 animate-pulse w-full'
                        : 'bg-blue-700'
                    }`}
                    style={
                      uploadProgress.phase === 'uploading'
                        ? { width: `${uploadProgress.percent}%` }
                        : undefined
                    }
                  />
                </div>

                <div className="flex items-center justify-between gap-2 text-xs text-slate-600 tabular-nums">
                  <span>
                    {uploadProgress.phase === 'processing'
                      ? 'फ़ाइल अपलोड हो गई — डाटाबेस में रिकॉर्ड सेव किए जा रहे हैं...'
                      : `${formatBytes(uploadProgress.uploadedBytes)} / ${formatBytes(uploadProgress.totalBytes)}`}
                  </span>
                  {uploadProgress.phase === 'uploading' && (
                    <button
                      type="button"
                      onClick={handleCancelUpload}
                      className="text-red-700 hover:underline font-semibold inline-flex items-center gap-1 cursor-pointer shrink-0"
                    >
                      <X className="h-3.5 w-3.5" />
                      <span>रद्द करें</span>
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full sm:w-auto min-h-[48px] px-6 rounded-xl bg-blue-700 hover:bg-blue-800 active:scale-[0.99] disabled:opacity-60 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-all cursor-pointer"
                >
                  <FileSpreadsheet className="h-5 w-5" />
                  <span>{uploading ? 'लोड हो रहा है...' : 'फ़ाइल चुनें और अपलोड करें'}</span>
                </button>
              </div>
            )}
          </div>

          {/* Sample Helpers */}
          <div className="mt-5 pt-5 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-800">तुरंत परीक्षण (Test) करना चाहते हैं?</p>
              <p className="text-xs text-slate-500 mt-0.5">
                बिजली उपभोक्ता, फीडर व ट्रांसफार्मर वाली नमूना शीट आज़माएँ।
              </p>
            </div>
            <div className="flex flex-wrap gap-2 shrink-0">
              <button
                type="button"
                disabled={uploading}
                onClick={() => void handleLoadSample(false)}
                className="min-h-[44px] px-4 rounded-xl border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-800 font-semibold text-xs sm:text-sm flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <Sparkles className="h-4 w-4" />
                <span>नमूना डाटा लोड करें</span>
              </button>
              <button
                type="button"
                onClick={handleDownloadTemplate}
                className="min-h-[44px] px-4 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-medium text-xs sm:text-sm flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <Download className="h-4 w-4" />
                <span>नमूना .xlsx</span>
              </button>
            </div>
          </div>
        </section>

        {/* Active Sheet Info */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-5 sm:p-7 space-y-5">
          <h2 className="text-base font-bold text-slate-900">वर्तमान सक्रिय शीट</h2>

          {!dataset ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
              <p className="text-sm font-medium text-slate-700">अभी कोई Excel शीट अपलोड नहीं है।</p>
              <p className="text-xs text-slate-500 mt-1">
                बाईं ओर से अपनी फ़ाइल अपलोड करें या नमूना डाटा लोड करें।
              </p>
            </div>
          ) : (
            <>
              <dl className="divide-y divide-slate-100 text-sm">
                <div className="py-2.5 flex justify-between gap-4">
                  <dt className="text-slate-500">फ़ाइल का नाम</dt>
                  <dd className="font-semibold text-slate-900 text-right break-all">{dataset.fileName}</dd>
                </div>
                <div className="py-2.5 flex justify-between gap-4">
                  <dt className="text-slate-500">कुल रिकॉर्ड (पंक्तियाँ)</dt>
                  <dd className="font-mono-tabular font-semibold text-slate-900">
                    {dataset.rowCount.toLocaleString('hi-IN')}
                  </dd>
                </div>
                <div className="py-2.5 flex justify-between gap-4">
                  <dt className="text-slate-500">कुल कॉलम</dt>
                  <dd className="font-mono-tabular font-semibold text-slate-900">{dataset.headers.length}</dd>
                </div>
                <div className="py-2.5 flex justify-between gap-4">
                  <dt className="text-slate-500">कुल दर्ज रिमार्क</dt>
                  <dd className="font-mono-tabular font-semibold text-emerald-700">
                    {totalRemarks.toLocaleString('hi-IN')}
                  </dd>
                </div>
                <div className="py-2.5 flex justify-between gap-4">
                  <dt className="text-slate-500">अपलोड कर्ता</dt>
                  <dd className="font-medium text-slate-800 text-right">{dataset.uploadedByName}</dd>
                </div>
                <div className="py-2.5 flex justify-between gap-4">
                  <dt className="text-slate-500">अपलोड समय</dt>
                  <dd className="text-slate-700 tabular-nums text-right">
                    {formatHindiDateTime(dataset.uploadedAt)}
                  </dd>
                </div>
              </dl>

              <div className="pt-2 border-t border-slate-100">
                <p className="text-xs font-semibold text-slate-600 mb-2">कॉलम हेडर (पहली पंक्ति):</p>
                <p className="text-xs text-slate-600 leading-relaxed">
                  {dataset.headers.join(' · ')}
                </p>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
