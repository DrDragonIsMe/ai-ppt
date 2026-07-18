#!/bin/bash

# ai-ppt 服务器启动脚本
# 用于启动 ai-ppt Web 管理端

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🚀 正在启动 ai-ppt 服务器..."

# 检查是否已经有服务器在运行
if lsof -ti:3456 > /dev/null 2>&1; then
    echo "⚠️  端口 3456 已被占用，正在停止现有服务..."
    pkill -f "node.*server.mjs" 2>/dev/null
    sleep 2
fi

# 检查 node 命令是否可用
if ! command -v node &> /dev/null; then
    echo "❌ 错误: 未找到 node 命令，请先安装 Node.js"
    exit 1
fi

# 检查 server.mjs 是否存在
if [ ! -f "server.mjs" ]; then
    echo "❌ 错误: 未找到 server.mjs 文件"
    exit 1
fi

# 启动服务器
echo "✅ 启动服务器..."
echo ""
echo "========================================"
echo "  ai-ppt 管理端已启动！"
echo "  访问地址: http://localhost:3456"
echo "  按 Ctrl+C 停止服务器"
echo "========================================"
echo ""

# 直接运行服务器（前台模式）
node server.mjs
