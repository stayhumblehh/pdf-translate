// src/renderer/global.d.ts

export {};

declare global {
  interface Window {
    pdf2zh: {
      selectPdf: () => Promise<string | null>;
      start: (params: {
        filePath: string;
        service: string;
      }) => Promise<{ jobId: string | null }>;
      getResult: (
        jobId: string
      ) => Promise<{ ok: boolean; filename?: string; pdf_base64?: string } | null>;
      onProgress: (
        cb: (data: { jobId: string; pct: number; stage: string; message: string }) => void
      ) => void;
      onDone: (
        cb: (data: {
          jobId: string;
          ok: boolean;
          result?: { filename: string; pdf_base64: string };
        }) => void
      ) => void;
      onError: (
        cb: (data: { jobId: string | null; message: string; detail?: string }) => void
      ) => void;
      onOpenFile: (cb: (filePath: string) => void) => void;
    };
  }
}
