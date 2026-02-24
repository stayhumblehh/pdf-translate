// electron-main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

let mainWindow;
let engineServerPort = null;
let engineServerProcess = null;
let engineServerReady = null;
let logsDir = null;
let electronLogStream = null;
let engineStdioLogStream = null;
let pendingOpenFilePath = null;
let isStoppingEngine = false;

const ENGINE_PORT = Number(process.env.PDF2ZH_ENGINE_PORT || 18080);
const HEALTH_CHECK_TIMEOUT_MS = 300;
const HEALTH_POLL_INTERVAL_MS = 200;
const HEALTH_POLL_TOTAL_MS = 10000;

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

function timestamp() {
  return new Date().toISOString();
}

function writeMainLog(level, message) {
  const line = `[${timestamp()}] [${level.toUpperCase()}] ${message}`;
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
  if (electronLogStream) {
    electronLogStream.write(`${line}\n`);
  }
}

function initLogFiles() {
  logsDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  electronLogStream = fs.createWriteStream(path.join(logsDir, 'electron-main.log'), { flags: 'a' });
  engineStdioLogStream = fs.createWriteStream(path.join(logsDir, 'engine-stdio.log'), { flags: 'a' });
  writeMainLog('info', `logs dir: ${logsDir}`);
}

function closeLogFiles() {
  if (electronLogStream) {
    electronLogStream.end();
    electronLogStream = null;
  }
  if (engineStdioLogStream) {
    engineStdioLogStream.end();
    engineStdioLogStream = null;
  }
}

function extractPdfPathFromArgv(argv) {
  for (const arg of argv) {
    if (!arg || arg.startsWith('-')) continue;
    if (!arg.toLowerCase().endsWith('.pdf')) continue;
    const candidate = path.resolve(arg);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function pushOpenFileToRenderer(filePath) {
  if (!filePath) return;
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('pdf2zh:open-file', filePath);
    writeMainLog('info', `forwarded open-file to renderer: ${filePath}`);
    return;
  }
  pendingOpenFilePath = filePath;
}

function sendEngineErrorToRenderer(message, detail) {
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('pdf2zh:error', {
      jobId: null,
      message,
      detail
    });
  }
}

function isEngineHealthyPayload(payload) {
  return payload && payload.status === 'ok' && typeof payload.pid === 'number';
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: abortController.signal });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    return { ok: response.ok, payload };
  } finally {
    clearTimeout(timer);
  }
}

async function checkEngineHealth(port, timeoutMs = HEALTH_CHECK_TIMEOUT_MS) {
  try {
    const { ok, payload } = await fetchJsonWithTimeout(`http://127.0.0.1:${port}/health`, timeoutMs);
    return ok && isEngineHealthyPayload(payload);
  } catch {
    return false;
  }
}

async function waitForEngineHealthy(port, timeoutMs = HEALTH_POLL_TOTAL_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const healthy = await checkEngineHealth(port, HEALTH_CHECK_TIMEOUT_MS);
    if (healthy) return true;
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

function createWindow() {
  const isDev = process.env.NODE_ENV === 'development';
  const iconPath = isDev
    ? path.join(process.cwd(), 'build', 'favicon.png')
    : path.join(process.resourcesPath, 'build', 'favicon.png');
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js')
    },
    icon: iconPath,
    title: 'PDF 英译中助手'
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingOpenFilePath) {
      pushOpenFileToRenderer(pendingOpenFilePath);
      pendingOpenFilePath = null;
    }
  });
}

if (gotSingleInstanceLock) {
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const openFile = extractPdfPathFromArgv(commandLine);
    if (openFile) {
      pushOpenFileToRenderer(openFile);
    }
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (filePath && filePath.toLowerCase().endsWith('.pdf') && fs.existsSync(filePath)) {
      pushOpenFileToRenderer(path.resolve(filePath));
    }
  });

  app.whenReady().then(async () => {
    initLogFiles();
    const launchOpenFile = extractPdfPathFromArgv(process.argv.slice(1));
    if (launchOpenFile) {
      pendingOpenFilePath = launchOpenFile;
    }
    createWindow();
    try {
      await startEngineServer();
    } catch (err) {
      const detail = err && err.message ? err.message : String(err);
      writeMainLog('error', `engine startup failed: ${detail}`);
      sendEngineErrorToRenderer(`引擎服务启动失败，请查看日志目录：${logsDir}`, detail);
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopEngineServer();
});

app.on('will-quit', () => {
  stopEngineServer();
  closeLogFiles();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

/**
 * 让渲染进程选择 PDF
 */
ipcMain.handle('select-pdf', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择需要翻译的 PDF 文献',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths.length) {
    return null;
  }
  return result.filePaths[0];
});

function isCommandAvailable(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  if (!result.error) return true;
  return result.error.code !== 'ENOENT';
}

function isUsableCommand(candidatePath, checkArgs) {
  if (!candidatePath) return false;
  const hasPathSeparator = candidatePath.includes(path.sep);
  if (path.isAbsolute(candidatePath) || hasPathSeparator) {
    return fs.existsSync(candidatePath);
  }
  return isCommandAvailable(candidatePath, checkArgs);
}

function resolvePythonCommand() {
  if (process.platform === 'win32') {
    return isCommandAvailable('python', ['-V']) ? 'python' : null;
  }
  if (isCommandAvailable('python3', ['-V'])) return 'python3';
  if (isCommandAvailable('python', ['-V'])) return 'python';
  return null;
}

function resolveEngineServerCommand(port, ppid, logDir) {
  const attempts = [];
  const appPath = app.getAppPath();
  const isDev = process.env.NODE_ENV === 'development';
  const baseArgs = ['--port', String(port), '--ppid', String(ppid), '--log-dir', logDir];

  if (!isDev) {
    const serverExe = path.join(process.resourcesPath, 'engine', 'pdf2zh-engine-server.exe');
    attempts.push(serverExe);
    if (fs.existsSync(serverExe)) {
      return { command: serverExe, args: baseArgs, attempts };
    }
    throw new Error(`未找到可用的 pdf2zh 服务命令。已尝试：${attempts.join(', ')}`);
  }

  const venvPython = process.platform === 'win32'
    ? path.join(appPath, 'engine', '.venv', 'Scripts', 'python.exe')
    : path.join(appPath, 'engine', '.venv', 'bin', 'python');
  const devPythonCmd = resolvePythonCommand();
  const devCandidates = [
    { path: venvPython, args: ['-m', 'pdf2zh_engine.server', ...baseArgs] },
    { path: devPythonCmd, args: ['-m', 'pdf2zh_engine.server', ...baseArgs] }
  ];

  for (const candidate of devCandidates) {
    if (!candidate.path) continue;
    attempts.push(candidate.path);
    if (isUsableCommand(candidate.path, ['-V'])) {
      return { command: candidate.path, args: candidate.args, attempts };
    }
  }

  throw new Error(`未找到可用的 pdf2zh 服务命令。已尝试：${attempts.join(', ')}`);
}

function stopEngineServer() {
  if (!engineServerProcess || isStoppingEngine) return;
  isStoppingEngine = true;
  const pid = engineServerProcess.pid;
  writeMainLog('info', `stopping engine process pid=${pid}`);

  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        process.kill(pid, 'SIGTERM');
      }
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // noop
          }
        }
      }, 1500);
    }
  } catch (err) {
    writeMainLog('error', `stop engine failed: ${err.message}`);
  } finally {
    isStoppingEngine = false;
    engineServerProcess = null;
    engineServerPort = null;
    engineServerReady = null;
  }
}

async function startEngineServer() {
  if (engineServerReady) return engineServerReady;
  engineServerReady = (async () => {
    const healthyBeforeStart = await checkEngineHealth(ENGINE_PORT, HEALTH_CHECK_TIMEOUT_MS);
    if (healthyBeforeStart) {
      engineServerPort = ENGINE_PORT;
      writeMainLog('info', `reusing existing engine on port ${ENGINE_PORT}`);
      return ENGINE_PORT;
    }

    const ppid = process.pid;
    const resolvedCommand = resolveEngineServerCommand(ENGINE_PORT, ppid, logsDir);
    writeMainLog('info', `starting engine command=${resolvedCommand.command} args=${resolvedCommand.args.join(' ')}`);

    engineServerProcess = spawn(resolvedCommand.command, resolvedCommand.args, {
      shell: false,
      detached: process.platform !== 'win32'
    });

    engineServerProcess.stdout.on('data', (buf) => {
      const text = buf.toString();
      if (engineStdioLogStream) {
        engineStdioLogStream.write(`[${timestamp()}] [STDOUT] ${text}`);
      }
    });

    engineServerProcess.stderr.on('data', (buf) => {
      const text = buf.toString();
      if (engineStdioLogStream) {
        engineStdioLogStream.write(`[${timestamp()}] [STDERR] ${text}`);
      }
    });

    engineServerProcess.on('error', (err) => {
      writeMainLog('error', `engine process error: ${err.message}`);
    });

    engineServerProcess.on('close', (code, signal) => {
      writeMainLog('info', `engine process closed code=${code} signal=${signal}`);
      engineServerPort = null;
      engineServerReady = null;
      engineServerProcess = null;
    });

    const healthyAfterStart = await waitForEngineHealthy(ENGINE_PORT, HEALTH_POLL_TOTAL_MS);
    if (!healthyAfterStart) {
      stopEngineServer();
      throw new Error(`引擎服务健康检查超时（10s），请查看日志目录：${logsDir}`);
    }

    engineServerPort = ENGINE_PORT;
    writeMainLog('info', `engine is healthy on port ${ENGINE_PORT}`);
    return ENGINE_PORT;
  })();

  try {
    return await engineServerReady;
  } catch (err) {
    engineServerReady = null;
    throw err;
  }
}

function fetchJson(url, options) {
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options && options.headers ? options.headers : {})
    }
  }).then(async (res) => {
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  });
}

function fetchResultWithRetry(jobId, retries = 10, delayMs = 500) {
  return fetchJson(
    `http://127.0.0.1:${engineServerPort}/result?jobId=${encodeURIComponent(jobId)}`
  ).then((result) => {
    console.log(`[engine] result payload for ${jobId}`, result);
    if (result && result.ok) return result;
    if (result && result.error === 'job not finished' && retries > 0) {
      return new Promise((resolve) =>
        setTimeout(() => resolve(fetchResultWithRetry(jobId, retries - 1, delayMs)), delayMs)
      );
    }
    return result;
  });
}

function openProgressStream(jobId) {
  if (!engineServerPort) return;
  const req = http.request({
    hostname: '127.0.0.1',
    port: engineServerPort,
    path: `/events?jobId=${encodeURIComponent(jobId)}`,
    headers: { Accept: 'text/event-stream' }
  });

  let buffer = '';
  req.on('response', (res) => {
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr) continue;
        try {
          const payload = JSON.parse(jsonStr);
          console.log(`[engine] event ${payload.type || 'unknown'}`, payload);
          if (payload.type === 'progress') {
            mainWindow.webContents.send('pdf2zh:progress', { jobId, ...payload });
          }
          if (payload.type === 'done') {
            fetchResultWithRetry(jobId)
              .then((result) => {
                console.log(`[engine] result for ${jobId}`, result && result.ok);
                if (result && result.ok) {
                  mainWindow.webContents.send('pdf2zh:done', { jobId, ok: true, result });
                } else {
                  mainWindow.webContents.send('pdf2zh:error', {
                    jobId,
                    message: result?.error || '引擎执行失败',
                    detail: result?.detail || ''
                  });
                  mainWindow.webContents.send('pdf2zh:done', { jobId, ok: false });
                }
              })
              .catch((err) => {
                mainWindow.webContents.send('pdf2zh:error', {
                  jobId,
                  message: '获取结果失败',
                  detail: err.message
                });
                mainWindow.webContents.send('pdf2zh:done', { jobId, ok: false });
              });
          }
          if (payload.type === 'error') {
            mainWindow.webContents.send('pdf2zh:error', { jobId, ...payload });
          }
        } catch {
          // ignore
        }
      }
    });
  });

  req.on('error', (err) => {
    mainWindow.webContents.send('pdf2zh:error', { jobId, message: err.message });
  });

  req.end();
}

ipcMain.handle('start-translate', async (_event, params) => {
  const { filePath, service } = params;

  if (!filePath) {
    mainWindow.webContents.send('pdf2zh:error', {
      jobId: null,
      message: '未选择 PDF 文件'
    });
    return { jobId: null };
  }

  await startEngineServer();
  if (service !== 'google' && service !== 'bing') {
    const message = `不支持的翻译服务: ${service}`;
    mainWindow.webContents.send('pdf2zh:error', { jobId: null, message });
    throw new Error(message);
  }
  const payload = {
    source_path: filePath,
    source_filename: path.basename(filePath),
    service,
    threads: 4
  };
  const response = await fetchJson(`http://127.0.0.1:${engineServerPort}/translate`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  const jobId = response.jobId;
  if (jobId) {
    openProgressStream(jobId);
  }
  return { jobId };
});

ipcMain.handle('download-result', async (_event, jobId) => {
  if (!jobId || !engineServerPort) {
    return null;
  }
  const result = await fetchJson(`http://127.0.0.1:${engineServerPort}/result?jobId=${encodeURIComponent(jobId)}`);
  return result;
});
