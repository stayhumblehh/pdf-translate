import React, { useEffect, useRef, useState } from 'react';

export const App = () => {
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [sourceFileName, setSourceFileName] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [result, setResult] = useState<{ filename: string; pdfBase64: string } | null>(null);
  const [outputFilename, setOutputFilename] = useState('');
  const [service, setService] = useState<'google' | 'bing'>('google');
  const [jobId, setJobId] = useState<string | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const isTranslatingRef = useRef(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const applySelectedFile = (filePath: string) => {
    resetStateForNewFile();
    setSelectedFilePath(filePath);
    const parts = filePath.split(/[\\/]/);
    const name = parts[parts.length - 1] || filePath;
    setSourceFileName(name);
    const stem = name.replace(/\.pdf$/i, '');
    setOutputFilename(`${stem} (双语).pdf`);
  };

  const resetStateForNewFile = () => {
    setProgressPct(0);
    setStatusText('');
    setIsTranslating(false);
    setResult(null);
    setOutputFilename('');
    setError('');
  };

  useEffect(() => {
    isTranslatingRef.current = isTranslating;
  }, [isTranslating]);

  useEffect(() => {
    if (!window.pdf2zh) {
      setError('预加载脚本未加载，无法连接主进程');
      return;
    }

    window.pdf2zh.onProgress((data) => {
      if (data.jobId && data.jobId === jobIdRef.current) {
        setProgressPct(data.pct);
        setStatusText([data.stage, data.message].filter(Boolean).join(' '));
      }
    });
    window.pdf2zh.onDone((data) => {
      if (data.jobId && data.jobId === jobIdRef.current) {
        setIsTranslating(false);
        if (data.ok && data.result) {
          setResult({
            filename: data.result.filename,
            pdfBase64: data.result.pdf_base64
          });
          setOutputFilename(data.result.filename);
          setSelectedFilePath(null);
          setSourceFileName('');
          if (inputRef.current) inputRef.current.value = '';
          return;
        }
        if (data.ok && window.pdf2zh) {
          window.pdf2zh.getResult(data.jobId).then((result) => {
            if (result && result.ok && result.pdf_base64 && result.filename) {
              setResult({
                filename: result.filename,
                pdfBase64: result.pdf_base64
              });
              setOutputFilename(result.filename);
              setSelectedFilePath(null);
              setSourceFileName('');
              if (inputRef.current) inputRef.current.value = '';
            }
          });
        }
      }
    });
    window.pdf2zh.onError((data) => {
      if (!data.jobId || data.jobId === jobIdRef.current) {
        setIsTranslating(false);
        setResult(null);
        setError(data.message);
      }
    });
    window.pdf2zh.onOpenFile((filePath) => {
      if (!filePath || isTranslatingRef.current) return;
      applySelectedFile(filePath);
    });
  }, []);

  const selectPDF = async () => {
    if (!window.pdf2zh) return;
    if (isTranslating) return;
    const fp = await window.pdf2zh.selectPdf();
    if (fp) {
      applySelectedFile(fp);
    }
  };

  const start = async () => {
    if (!selectedFilePath) return alert('请选择 PDF');
    if (!window.pdf2zh) return;
    setIsTranslating(true);
    setError('');
    setProgressPct(0);
    setStatusText('');
    setResult(null);

    const result = await window.pdf2zh.start({
      filePath: selectedFilePath,
      service
    });
    setJobId(result.jobId);
    jobIdRef.current = result.jobId;
  };

  const download = async () => {
    if (!result) return;
    const bytes = Uint8Array.from(atob(result.pdfBase64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page">
      <div className="card">
        <div className="header">
          <h1>PDF 英译中助手</h1>
          <p>本地引擎翻译，支持进度与结果下载</p>
        </div>

        <div className="grid">
          <div className="panel">
            <div className="row">
              <button onClick={selectPDF} disabled={isTranslating}>选择 PDF</button>
              <input ref={inputRef} type="file" style={{ display: 'none' }} readOnly />
              <div className="path" title={sourceFileName || '未选择文件'}>
                {sourceFileName || '未选择文件'}
              </div>
            </div>

            <div className="row">
              <label>服务</label>
              <select value={service} onChange={(e) => setService(e.target.value as 'google' | 'bing')}>
                <option value="google">google</option>
                <option value="bing">bing</option>
              </select>
            </div>

            <div className="actions">
              <button onClick={start} disabled={!selectedFilePath || isTranslating}>开始翻译</button>
              <button onClick={download} disabled={!result || isTranslating}>下载双语 PDF</button>
            </div>
          </div>

          <div className="panel">
            <div className="row">
              <label>进度</label>
              <div className="progress">
                <progress value={progressPct} max={100}></progress>
                <span>{progressPct}%</span>
              </div>
            </div>
            <div className="row">
              <div className="path" title={statusText}>{statusText}</div>
            </div>
            <div className="row">
              <div className="meta" title={result?.filename || outputFilename}>
                {result?.filename || outputFilename}
              </div>
            </div>

            {error && <div className="row error">{error}</div>}
          </div>
        </div>
      </div>
    </div>
  );
};
