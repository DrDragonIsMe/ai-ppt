#!/bin/bash
# 停止 AI PPT 服务

cd "$(dirname "$0")"

if [ -f .service.pid ]; then
    PID=$(cat .service.pid 2>/dev/null)
    if kill -0 $PID 2>/dev/null; then
        kill $PID
        echo "✅ 服务已停止 (PID: $PID)"
        rm -f .service.pid
        exit 0
    fi
fi

# 如果 PID 文件不存在或进程不存在，尝试通过端口查找
if lsof -ti :3456 > /dev/null; then
    PIDS=$(lsof -ti :3456)
    kill $PIDS
    echo "✅ 服务已停止"
    rm -f .service.pid 2>/dev/null
else
    echo "ℹ️ 服务未在运行"
fi