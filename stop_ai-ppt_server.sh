#!/bin/bash

# ai-ppt 服务器停止脚本
# 用于停止后台运行的 ai-ppt Web 管理端

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/server.pid"

echo "🛑 正在停止 ai-ppt 服务器..."

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$PID" ]; then
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID" 2>/dev/null
            sleep 1
            # 强制杀死如果还在
            if kill -0 "$PID" 2>/dev/null; then
                kill -9 "$PID" 2>/dev/null
                sleep 1
            fi
            echo "✅ 服务器已停止 (PID: $PID)"
        else
            echo "⚠️  PID $PID 不存在，进程可能已经停止"
        fi
    fi
    rm -f "$PID_FILE"
else
    # 尝试通过端口查找
    PID=$(lsof -ti:3456 2>/dev/null)
    if [ -n "$PID" ]; then
        kill $PID 2>/dev/null
        sleep 1
        if kill -0 $PID 2>/dev/null; then
            kill -9 $PID 2>/dev/null
        fi
        echo "✅ 通过端口 3456 停止了服务器 (PID: $PID)"
    else
        # 尝试通过进程名查找
        PID=$(pgrep -f "node.*server.mjs" 2>/dev/null)
        if [ -n "$PID" ]; then
            kill $PID 2>/dev/null
            sleep 1
            if kill -0 $PID 2>/dev/null 2>/dev/null; then
                kill -9 $PID 2>/dev/null
            fi
            echo "✅ 通过进程名停止了服务器 (PID: $PID)"
        else
            echo "ℹ️  未发现运行中的 ai-ppt 服务器"
        fi
    fi
fi
