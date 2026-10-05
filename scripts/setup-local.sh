#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> docuverse 本机部署"
echo "    目录: $ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "错误: 未找到 node，请先安装 Node.js 18+"
  exit 1
fi

echo "==> Node $(node -v)"

if [[ ! -f .env.local && -f .env.example ]]; then
  cp .env.example .env.local
  echo "==> 已创建 .env.local（可按需填入 ZHIPU_API_KEY / LLM_API_KEY）"
fi

echo "==> npm install"
npm install

echo ""
echo "==> 启动 dev server: http://127.0.0.1:5173/"
echo "    在本机浏览器打开上述地址（不是 Cloud Preview）"
echo ""

exec npm run dev
