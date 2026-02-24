# pdf2zh-engine (Engine v1)

Standalone server for Electron:

```
python -m pdf2zh_engine.server --port 18080 --ppid <electron_pid> --log-dir <log_dir>
```

## Local run

From repo root:

```bash
python3 -m venv engine/.venv
source engine/.venv/bin/activate
python -m pip install -U pip
python -m pip install -e engine
python -m pdf2zh_engine.server --port 18080 --ppid $$ --log-dir ./logs
```

## Server protocol

- STDOUT first line: {"type":"ready","port":12345}
- STDERR: progress/error logs and tracebacks
- GET /health -> {"status":"ok","pid":12345}
- POST /translate -> {jobId}
- GET /events?jobId=... -> SSE progress/done/error
- GET /result?jobId=... -> {ok, filename, pdf_base64}

## Parent process guard

- `--ppid <pid>`: check parent pid every second.
- If parent process disappears, server logs and exits.
- Windows uses `psutil.pid_exists` first; other systems fall back to `os.kill(pid, 0)`.

## Logging

- Use `--log-dir <path>` (or env `PDF2ZH_LOG_DIR`) to write `engine.log`.
- Electron also pipes server stdout/stderr to `engine-stdio.log` in the same logs directory.

## Build on macOS / Windows 11

From repo root:

```bash
npm run engine:build:mac
```

```powershell
npm run engine:build:win
```

Binary output:

```
dist/pdf2zh-engine
dist/pdf2zh-engine.exe
```
