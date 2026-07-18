#!/bin/bash

# ai-ppt 服务器后台启动脚本
# 用于在后台启动 ai-ppt Web 管理端

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOG_FILE="$SCRIPT_DIR/server.log"
PID_FILE="$SCRIPT_DIR/server.pid"

FORCE=0
if [ "$1" = "--force" ] || [ "$1" = "-f" ]; then
    FORCE=1
    echo "🚀 正在强制重启 ai-ppt 服务器..."
else
    echo "🚀 正在后台启动 ai-ppt 服务器..."
fi

# 检查是否已经有服务器在运行
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        if [ "$FORCE" -eq 1 ]; then
            echo "⚠️  发现旧进程 (PID: $PID)，正在强制停止..."
            kill "$PID" 2>/dev/null
            sleep 1
            if kill -0 "$PID" 2>/dev/null; then
                kill -9 "$PID" 2>/dev/null
                sleep 1
            fi
            rm -f "$PID_FILE"
            echo "✅ 旧进程已停止"
        else
            echo "⚠️  服务器已在运行 (PID: $PID)"
            echo "  访问地址: http://localhost:3456"
            echo "  日志文件: $LOG_FILE"
            echo ""
            echo "  使用 --force 参数强制重启: ./start_ai-ppt_server_bg.sh --force"
            exit 0
        fi
    else
        echo "⚠️  发现旧的 PID 文件，正在清理..."
        rm -f "$PID_FILE"
    fi
fi

# 即使没有 PID 文件，也检查端口
if [ "$FORCE" -eq 1 ]; then
    PORT_PID=$(lsof -ti:3456 2>/dev/null)
    if [ -n "$PORT_PID" ]; then
        echo "⚠️  发现端口 3456 被占用 (PID: $PORT_PID)，正在停止..."
        kill "$PORT_PID" 2>/dev/null
        sleep 1
        if lsof -ti:3456 >/dev/null 2>&1; then
            kill -9 "$PORT_PID" 2>/dev/null
            sleep 1
        fi
    fi
fi

# 清理旧的日志
if [ -f "$LOG_FILE" ]; then
    mv "$LOG_FILE" "$LOG_FILE.old" 2>/dev/null
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

# 启动服务器（后台模式）
node server.mjs > "$LOG_FILE" 2>&1 &
PID=$!

# 保存 PID
echo $PID > "$PID_FILE"

# 等待一下检查是否成功启动
sleep 2

if kill -0 "$PID" 2>/dev/null; then
    echo ""
    echo "✅ ai-ppt 管理端已在后台启动！"
    echo "  PID:      $PID"
    echo "  访问地址: http://localhost:3456"
    echo "  日志文件: $LOG_FILE"
    echo ""
    echo "  停止命令: ./stop_ai-ppt_server.sh"
else
    echo "❌ 服务器启动失败，请查看日志: $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
fi
