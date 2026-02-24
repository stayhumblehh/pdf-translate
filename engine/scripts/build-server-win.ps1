$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..\..")

$pythonCmd = "python"
$venvDir = Join-Path $repoRoot "engine\.venv"
if (-not (Test-Path $venvDir)) {
  & $pythonCmd -m venv $venvDir
}

$venvPython = Join-Path $venvDir "Scripts\python.exe"
& $venvPython -m pip install -U pip
& $venvPython -m pip install -e (Join-Path $repoRoot "engine")
& $venvPython -m pip install -U pyinstaller

$distPath = Join-Path $repoRoot "dist-engine"
$workPath = Join-Path $repoRoot ".pyinstaller\build"
$specPath = Join-Path $repoRoot ".pyinstaller\spec"

$exePath = Join-Path $distPath "pdf2zh-engine-server.exe"
$legacyExePath = Join-Path $repoRoot "dist\pdf2zh-engine-server.exe"
if (Test-Path $exePath) {
  Remove-Item $exePath -Force
}
if (Test-Path $legacyExePath) {
  Remove-Item $legacyExePath -Force
}
if (Test-Path $workPath) {
  Remove-Item $workPath -Recurse -Force
}
if (Test-Path $specPath) {
  Remove-Item $specPath -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $workPath | Out-Null
New-Item -ItemType Directory -Force -Path $specPath | Out-Null

& $venvPython -m PyInstaller `
  --name pdf2zh-engine-server `
  --onefile `
  --console `
  --distpath $distPath `
  --workpath $workPath `
  --specpath $specPath `
  (Join-Path $repoRoot "engine\src\pdf2zh_engine\server.py")
