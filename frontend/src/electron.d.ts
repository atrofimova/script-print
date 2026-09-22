export interface QueuedFileMeta {
  path: string;
  name: string;
  sizeBytes: number;
  pages: number | null;
  hasColor: boolean | null;
  ext: string;
}

export interface PrinterInfo {
  name: string;
  displayName: string;
  isDefault: boolean;
  status: number;
}

export interface PrintJobResult {
  success: boolean;
  results: { path: string; success: boolean; error?: string }[];
  error?: string;
}

export interface PrintPresetAPI {
  openFileDialog: () => Promise<QueuedFileMeta[]>;
  readDroppedFile: (file: File) => Promise<QueuedFileMeta>;
  listPrinters: () => Promise<PrinterInfo[]>;
  submitPrintJob: (payload: {
    files: { path: string }[];
    printerName: string;
    color: boolean;
    duplex: boolean;
    staple: boolean;
    staplePlacement: string;
  }) => Promise<PrintJobResult>;
}

declare global {
  interface Window {
    printPresetAPI: PrintPresetAPI;
  }
}
