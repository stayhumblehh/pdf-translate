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
$offlineAssetsPath = Join-Path $distPath "babeldoc-offline-assets.zip"
$legacyExePath = Join-Path $repoRoot "dist\pdf2zh-engine-server.exe"
if (Test-Path $exePath) {
  Remove-Item $exePath -Force
}
if (Test-Path $offlineAssetsPath) {
  Remove-Item $offlineAssetsPath -Force
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

Write-Host "Generating offline BabelDOC assets package..."
$env:PDF2ZH_ASSET_UPSTREAM = "modelscope"
& $venvPython -c "from pathlib import Path; from babeldoc.assets.assets import generate_offline_assets_package; output_dir = Path(r'$distPath'); generate_offline_assets_package(output_dir)"
$generatedOfflineAssets = Get-ChildItem -Path $distPath -Filter "offline_assets_*.zip" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($null -eq $generatedOfflineAssets) {
  throw "Failed to generate offline assets package"
}
Copy-Item -Path $generatedOfflineAssets.FullName -Destination $offlineAssetsPath -Force

& $venvPython -m PyInstaller `
  --name pdf2zh-engine-server `
  --onefile `
  --console `
  --collect-submodules pdf2zh_next.translator.translator_impl `
  --collect-data pdf2zh_next `
  --collect-data babeldoc `
  --collect-data rapidocr_onnxruntime `
  --hidden-import pdf2zh_next.translator.translator_impl.google `
  --hidden-import pdf2zh_next.translator.translator_impl.bing `
  --distpath $distPath `
  --workpath $workPath `
  --specpath $specPath `
  (Join-Path $repoRoot "engine\src\pdf2zh_engine\server.py")
