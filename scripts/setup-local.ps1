# docuverse 本机部署 (Windows PowerShell)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "==> docuverse 本机部署"
Write-Host "    目录: $Root"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "未找到 node，请先安装 Node.js 18+"
}

Write-Host "==> Node $(node -v)"

if (-not (Test-Path ".env.local") -and (Test-Path ".env.example")) {
  Copy-Item ".env.example" ".env.local"
  Write-Host "==> 已创建 .env.local（可按需填入 ZHIPU_API_KEY / LLM_API_KEY）"
}

Write-Host "==> npm install"
npm install

Write-Host ""
Write-Host "==> 启动 dev server: http://127.0.0.1:5173/"
Write-Host "    在本机浏览器打开上述地址（不是 Cloud Preview）"
Write-Host ""

npm run dev
