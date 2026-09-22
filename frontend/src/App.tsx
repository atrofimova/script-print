import { useState, useCallback, useEffect } from 'react';
import type { QueuedFileMeta, PrinterInfo } from './electron';

const assetPathPrefix = './assets';
const imgPrinter = `${assetPathPrefix}/f8e4a.svg`;
const imgUploadCloud = `${assetPathPrefix}/33681.svg`;
const imgArrowUpDown = `${assetPathPrefix}/504f0.svg`;
const imgGripVertical = `${assetPathPrefix}/2d168.svg`;
const imgEllipse = `${assetPathPrefix}/efc51.svg`;
const imgChevronUp = `${assetPathPrefix}/ccc8e.svg`;
const imgChevronDown = `${assetPathPrefix}/45d62.svg`;
const imgTrash = `${assetPathPrefix}/bb916.svg`;
const imgChevronDown1 = `${assetPathPrefix}/e731e.svg`;
const imgPaperclip = `${assetPathPrefix}/8335e.svg`;

// Stapling is a single top-left staple, on or off — no placement choice.

// A queued row combines what we know from the OS (real path, size, page
// count, color detection where available) with UI-only bookkeeping (a
// stable id for drag-reorder).
interface DocFile extends QueuedFileMeta {
  id: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toDocFile(meta: QueuedFileMeta): DocFile {
  return { ...meta, id: `${meta.path}-${Date.now()}-${Math.random()}` };
}

export default function App() {
  const [files, setFiles] = useState<DocFile[]>([]);
  const [isColor, setIsColor] = useState(true);
  const [isDoubleSided, setIsDoubleSided] = useState(true);
  const [staplerOn, setStaplerOn] = useState(true);

  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printer, setPrinter] = useState<string>('');
  const [printerOpen, setPrinterOpen] = useState(false);

  const [isDragOver, setIsDragOver] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Dialogs
  const [showColorWarning, setShowColorWarning] = useState(false);
  const [colorDocCount, setColorDocCount] = useState(0);
  const [printResult, setPrintResult] = useState<{ success: boolean; count?: number; error?: string } | null>(null);
  const [isPrinting, setIsPrinting] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);

  // Load real printers from the OS on startup, preferring FollowMe-Colour
  // as the default over whatever the OS considers its default printer.
  useEffect(() => {
    window.printPresetAPI.listPrinters().then((list) => {
      setPrinters(list);
      const preferred = list.find((p) => p.name === 'FollowMe-Colour');
      const osDefault = list.find((p) => p.isDefault);
      const chosen = preferred ?? osDefault ?? list[0];
      if (chosen) setPrinter(chosen.name);
    });
  }, []);

  useEffect(() => {
    if (!queueError) return;
    const t = setTimeout(() => setQueueError(null), 5000);
    return () => clearTimeout(t);
  }, [queueError]);

  const totalPages = files.reduce((sum, f) => sum + (f.pages ?? 0), 0);

  const addFiles = (metas: QueuedFileMeta[]) => {
    setFiles((prev) => [...prev, ...metas.map(toDocFile)]);
  };

  // Native OS file picker (real dialog, real paths — used for both the
  // "Import from Folder" button and programmatic <input type=file> fallback
  // isn't needed since Electron gives us the dialog directly). The dialog
  // itself is filtered to *.pdf, so no rejection handling is needed here.
  const openPicker = async () => {
    const metas = await window.printPresetAPI.openFileDialog();
    if (metas.length) addFiles(metas);
  };

  // Drag-and-drop isn't filtered by the OS the way the picker dialog is, so
  // we validate each dropped file and surface a message for any non-PDFs
  // rather than silently dropping them or crashing the queue.
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const dropped = Array.from(e.dataTransfer.files);
    if (!dropped.length) return;

    const settled = await Promise.allSettled(
      dropped.map((f) => window.printPresetAPI.readDroppedFile(f))
    );
    const metas = settled
      .filter((r): r is PromiseFulfilledResult<QueuedFileMeta> => r.status === 'fulfilled')
      .map((r) => r.value);
    const rejectedCount = settled.length - metas.length;

    if (metas.length) addFiles(metas);
    setQueueError(
      rejectedCount > 0
        ? `${rejectedCount} file${rejectedCount !== 1 ? 's' : ''} skipped — only PDF files are supported.`
        : null
    );
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => setIsDragOver(false), []);

  const moveUp = (index: number) => {
    if (index === 0) return;
    setFiles((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  };

  const moveDown = (index: number) => {
    if (index === files.length - 1) return;
    setFiles((prev) => {
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  };

  const deleteFile = (id: string) => setFiles((prev) => prev.filter((f) => f.id !== id));

  // Row drag-and-drop reordering
  const handleRowDragStart = (id: string) => setDragId(id);
  const handleRowDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    setDragOverId(id);
  };
  const handleRowDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!dragId || dragId === targetId) { setDragId(null); setDragOverId(null); return; }
    setFiles((prev) => {
      const next = [...prev];
      const fromIdx = next.findIndex((f) => f.id === dragId);
      const toIdx = next.findIndex((f) => f.id === targetId);
      const [item] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, item);
      return next;
    });
    setDragId(null);
    setDragOverId(null);
  };
  const handleRowDragEnd = () => { setDragId(null); setDragOverId(null); };

  // Real color detection (from PDF content-stream analysis done in the
  // main process). Files we couldn't analyze (non-PDF, e.g. DOCX/XLSX)
  // have hasColor === null and are treated as "unknown" — we don't warn
  // on them since we can't be sure.
  const colorFiles = files.filter((f) => f.hasColor === true);

  const executePrint = useCallback(async () => {
    setShowColorWarning(false);
    setIsPrinting(true);
    try {
      const result = await window.printPresetAPI.submitPrintJob({
        files: files.map((f) => ({ path: f.path })),
        printerName: printer,
        color: isColor,
        duplex: isDoubleSided,
        staple: staplerOn,
        staplePlacement: 'Top-Left',
      });
      if (result.success) {
        setPrintResult({ success: true, count: files.length });
      } else {
        setPrintResult({ success: false, error: result.error || 'One or more files failed to print' });
      }
    } catch (err) {
      setPrintResult({ success: false, error: (err as Error).message });
    } finally {
      setIsPrinting(false);
    }
  }, [files, printer, isColor, isDoubleSided, staplerOn]);

  const handlePrint = () => {
    if (!isColor && colorFiles.length > 0) {
      setColorDocCount(colorFiles.length);
      setShowColorWarning(true);
      return;
    }
    executePrint();
  };

  return (
    <div className="bg-[#f8fafc] min-h-screen flex flex-col" data-node-id="1:2">
      {/* Header */}
      <div className="bg-[#0c0c48] flex h-16 items-center justify-between px-8 shrink-0">
        <div className="flex gap-3 items-center">
          <div className="bg-white flex items-center justify-center rounded-[6px] w-8 h-8 shrink-0">
            <img alt="printer" className="w-[18px] h-[18px]" src={imgPrinter} />
          </div>
          <div className="flex flex-col gap-0.5">
            <p className="font-bold text-white text-base leading-none">Script Print</p>
            <p className="font-normal text-[#94a3b8] text-[11px] leading-none">The University of Auckland</p>
          </div>
        </div>
      </div>

      {/* Main */}
      <div className="flex gap-6 items-start p-8 flex-1">
        {/* Left: Queue Column */}
        <div className="flex flex-1 flex-col gap-6 min-w-0">
          {/* Upload Zone */}
          <div
            className={`bg-white border-2 border-dashed flex flex-col gap-4 items-center p-8 rounded-xl transition-colors ${isDragOver ? 'border-blue-500 bg-blue-50' : 'border-blue-400'}`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <div className="bg-[#eff6ff] flex items-center justify-center rounded-3xl w-12 h-12 shrink-0">
              <img alt="upload" className="w-6 h-6" src={imgUploadCloud} />
            </div>
            <div className="flex flex-col gap-1.5 items-center text-center">
              <p className="font-semibold text-[#1e293b] text-base">Drag and drop your batch documents here</p>
              <p className="font-normal text-[#64748b] text-[13px]">Supports PDF files up to 50MB each</p>
            </div>
            <div className="flex gap-3">
              <button
                className="border border-[#e2e8f0] font-semibold text-[#1e293b] text-[13px] px-4 py-2 rounded-full hover:bg-gray-50 transition-colors cursor-pointer"
                onClick={openPicker}
              >
                Import from Folder
              </button>
            </div>
          </div>

          {queueError && (
            <div className="bg-amber-50 border border-amber-200 text-amber-800 text-[13px] font-medium px-4 py-2.5 rounded-lg">
              {queueError}
            </div>
          )}

          {/* Queue Card */}
          {files.length > 0 && (
            <div className="bg-white border border-[#e2e8f0] flex flex-col rounded-xl overflow-hidden">
              {/* Table Header */}
              <div className="bg-[#f8fafc] border-b border-[#e2e8f0] flex items-center justify-between px-5 py-4">
                <div className="flex gap-3 items-center">
                  <p className="font-bold text-[#1e293b] text-[15px]">Active Batch Queue</p>
                  <span className="bg-[#0c0c48] font-bold text-white text-[11px] px-2 py-0.5 rounded-[10px]">
                    {files.length} {files.length === 1 ? 'File' : 'Files'}
                  </span>
                </div>
                <div className="flex gap-3 items-center">
                  <div className="flex gap-1.5 items-center">
                    <img alt="" className="w-3.5 h-3.5" src={imgArrowUpDown} />
                    <p className="font-medium text-[#64748b] text-[13px]">Reorder Batch</p>
                  </div>
                  <div className="w-px h-4 bg-[#e2e8f0]" />
                  <button
                    className="font-semibold text-[#ef4444] text-[13px] hover:text-red-700 transition-colors"
                    onClick={() => setFiles([])}
                  >
                    Remove All
                  </button>
                </div>
              </div>

              {/* Queue Rows */}
              <div className="flex flex-col">
                {files.map((file, index) => (
                  <div
                    key={file.id}
                    draggable
                    onDragStart={() => handleRowDragStart(file.id)}
                    onDragOver={(e) => handleRowDragOver(e, file.id)}
                    onDrop={(e) => handleRowDrop(e, file.id)}
                    onDragEnd={handleRowDragEnd}
                    className={`border-b border-[#e2e8f0] last:border-b-0 flex gap-4 items-center p-4 transition-colors ${dragOverId === file.id && dragId !== file.id ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
                  >
                    <div className="w-4 h-4 shrink-0 cursor-grab active:cursor-grabbing">
                      <img alt="drag" className="w-full h-full" src={imgGripVertical} />
                    </div>
                    <div className="flex flex-1 flex-col gap-1 min-w-0">
                      <p className="font-semibold text-[#1e293b] text-sm truncate">{file.name}</p>
                      <div className="flex gap-3 items-center">
                        <p className="font-normal text-[#64748b] text-xs">{formatBytes(file.sizeBytes)}</p>
                        <img alt="" className="w-1 h-1" src={imgEllipse} />
                        <p className="font-normal text-[#64748b] text-xs">
                          {file.pages != null ? `${file.pages} Pages` : 'Pages unknown'}
                        </p>
                        {file.hasColor === true && (
                          <>
                            <img alt="" className="w-1 h-1" src={imgEllipse} />
                            <p className="font-normal text-amber-600 text-xs">Contains colour</p>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-4 items-center shrink-0">
                      <div className="flex flex-col gap-1">
                        <button
                          onClick={() => moveUp(index)}
                          disabled={index === 0}
                          className="w-3.5 h-3.5 disabled:opacity-30 hover:opacity-70 transition-opacity cursor-pointer disabled:cursor-default"
                        >
                          <img alt="move up" className="w-full h-full" src={imgChevronUp} />
                        </button>
                        <button
                          onClick={() => moveDown(index)}
                          disabled={index === files.length - 1}
                          className="w-3.5 h-3.5 disabled:opacity-30 hover:opacity-70 transition-opacity cursor-pointer disabled:cursor-default"
                        >
                          <img alt="move down" className="w-full h-full" src={imgChevronDown} />
                        </button>
                      </div>
                      <button
                        onClick={() => deleteFile(file.id)}
                        className="bg-[#fee2e2] flex items-center justify-center rounded-2xl w-8 h-8 hover:bg-red-200 transition-colors cursor-pointer"
                      >
                        <img alt="delete" className="w-3.5 h-3.5" src={imgTrash} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {files.length === 0 && (
            <div className="bg-white border border-[#e2e8f0] rounded-xl px-5 py-10 text-center text-[#64748b] text-sm">
              No documents in queue. Add files above to get started.
            </div>
          )}
        </div>

        {/* Right: Configuration Panel */}
        <div className="bg-white border border-[#e2e8f0] flex flex-col gap-6 p-6 rounded-xl w-[380px] shrink-0">
          {/* Panel Header */}
          <div className="flex flex-col gap-1">
            <p className="font-bold text-[#0c0c48] text-base">Global Job Settings</p>
            <p className="font-normal text-[#64748b] text-xs">Configuration applies to all selected queue files.</p>
          </div>

          <div className="h-px bg-[#e2e8f0]" />

          {/* Printer Select */}
          <div className="flex flex-col gap-2">
            <p className="font-semibold text-[#1e293b] text-[13px]">Select Printer Device</p>
            <div className="relative">
              <button
                className="border border-[#e2e8f0] flex h-11 items-center justify-between px-3 rounded-lg w-full hover:bg-slate-50 transition-colors disabled:opacity-50"
                onClick={() => setPrinterOpen((o) => !o)}
                disabled={printers.length === 0}
              >
                <div className="flex gap-2 items-center min-w-0">
                  <img alt="printer" className="w-[18px] h-[18px] shrink-0" src={imgPrinter} />
                  <p className="font-medium text-[#1e293b] text-sm truncate">
                    {printers.length === 0
                      ? 'No printers found'
                      : printers.find((p) => p.name === printer)?.displayName || printer}
                  </p>
                </div>
                <img alt="" className="w-4 h-4 shrink-0 ml-2" src={imgChevronDown1} />
              </button>
              {printerOpen && printers.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-[#e2e8f0] rounded-lg shadow-lg z-10 overflow-hidden">
                  {printers.map((p) => (
                    <button
                      key={p.name}
                      className={`w-full text-left px-3 py-2.5 text-sm hover:bg-slate-50 transition-colors ${p.name === printer ? 'font-semibold text-[#1e293b]' : 'font-normal text-[#64748b]'}`}
                      onClick={() => { setPrinter(p.name); setPrinterOpen(false); }}
                    >
                      {p.displayName}
                      {p.isDefault ? ' (Default)' : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Color Mode */}
          <div className="flex flex-col gap-2">
            <p className="font-semibold text-[#1e293b] text-[13px]">Color Mode</p>
            <div
              className={`flex gap-2 items-center p-3 rounded-lg border-2 transition-colors ${isColor ? 'bg-[#eff6ff] border-[#3b82f6]' : 'bg-[#f8fafc] border-[#e2e8f0]'}`}
            >
              <p className="font-semibold text-[#1e293b] text-[13px] flex-1">{isColor ? 'Full Color' : 'Grayscale'}</p>
              <Toggle checked={isColor} onChange={setIsColor} />
            </div>
          </div>

          {/* Duplex / Single Side */}
          <div className="flex flex-col gap-2">
            <p className="font-semibold text-[#1e293b] text-[13px]">Print Sides</p>
            <div
              className={`flex gap-2 items-center p-3 rounded-lg border-2 transition-colors ${isDoubleSided ? 'bg-[#eff6ff] border-[#3b82f6]' : 'bg-[#f8fafc] border-[#e2e8f0]'}`}
            >
              <p className="font-semibold text-[#1e293b] text-[13px] flex-1">{isDoubleSided ? 'Double-Sided' : 'Single-Sided'}</p>
              <Toggle checked={isDoubleSided} onChange={setIsDoubleSided} />
            </div>
          </div>

          {/* Stapling Config */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex gap-2 items-center">
                <img alt="staple" className="w-[18px] h-[18px]" src={imgPaperclip} />
                <div>
                  <p className="font-semibold text-[#1e293b] text-[13px]">Staple Finisher</p>
                  <p className="text-[10px] text-[#94a3b8]">Top-left corner staple</p>
                </div>
              </div>
              <Toggle checked={staplerOn} onChange={setStaplerOn} />
            </div>
          </div>

          {/* Print Button */}
          <button
            disabled={files.length === 0 || isPrinting || !printer}
            onClick={handlePrint}
            className="bg-[#0c0c48] text-white font-semibold text-sm py-3 rounded-lg hover:bg-[#1a1a6e] transition-colors disabled:opacity-40 disabled:cursor-not-allowed w-full flex items-center justify-center gap-2"
          >
            {isPrinting ? (
              <>
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Sending to Printer…
              </>
            ) : (
              'Send to Printer'
            )}
          </button>
        </div>
      </div>

      {/* Color Warning Dialog */}
      {showColorWarning && (
        <Modal onClose={() => setShowColorWarning(false)}>
          <div className="flex flex-col gap-5">
            <div className="flex gap-3 items-start">
              <div className="bg-amber-100 rounded-full w-10 h-10 flex items-center justify-center shrink-0 mt-0.5">
                <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                </svg>
              </div>
              <div>
                <p className="font-bold text-[#1e293b] text-base">Colour Content Detected</p>
                <p className="text-[#64748b] text-sm mt-1">
                  <span className="font-semibold text-[#1e293b]">{colorDocCount} document{colorDocCount !== 1 ? 's' : ''}</span> in your queue contain colour, but your print mode is set to <span className="font-semibold text-[#1e293b]">Grayscale</span>. Colours will be converted and may not appear as intended.
                </p>
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowColorWarning(false)}
                className="px-4 py-2 text-sm font-semibold text-[#64748b] border border-[#e2e8f0] rounded-lg hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={executePrint}
                className="px-4 py-2 text-sm font-semibold text-white bg-amber-500 rounded-lg hover:bg-amber-600 transition-colors"
              >
                Proceed with Grayscale
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Print Result Dialog */}
      {printResult && (
        <Modal onClose={() => setPrintResult(null)}>
          <div className="flex flex-col gap-5">
            <div className="flex gap-3 items-start">
              <div className={`rounded-full w-10 h-10 flex items-center justify-center shrink-0 mt-0.5 ${printResult.success ? 'bg-green-100' : 'bg-red-100'}`}>
                {printResult.success ? (
                  <svg className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                )}
              </div>
              <div>
                {printResult.success ? (
                  <>
                    <p className="font-bold text-[#1e293b] text-base">Sent to Printer</p>
                    <p className="text-[#64748b] text-sm mt-1">
                      <span className="font-semibold text-[#1e293b]">{printResult.count} document{printResult.count !== 1 ? 's' : ''}</span> ({totalPages} pages) have been queued on <span className="font-semibold text-[#1e293b]">{printers.find((p) => p.name === printer)?.displayName || printer}</span>.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-bold text-[#1e293b] text-base">Print Job Failed</p>
                    <p className="text-[#64748b] text-sm mt-1">
                      Could not complete the job on <span className="font-semibold text-[#1e293b]">{printer}</span>. {printResult.error}.
                    </p>
                  </>
                )}
              </div>
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => setPrintResult(null)}
                className={`px-4 py-2 text-sm font-semibold text-white rounded-lg transition-colors ${printResult.success ? 'bg-[#0c0c48] hover:bg-[#1a1a6e]' : 'bg-red-600 hover:bg-red-700'}`}
              >
                {printResult.success ? 'Done' : 'Dismiss'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />
      <div
        className="relative bg-white rounded-xl shadow-2xl w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex w-10 h-[22px] rounded-full transition-colors shrink-0 ${checked ? 'bg-[#3b82f6]' : 'bg-[#cbd5e1]'}`}
    >
      <span
        className={`absolute top-[3px] left-[3px] w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0'}`}
      />
    </button>
  );
}
