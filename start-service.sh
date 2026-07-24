#!/bin/bash
# 启动 AI PPT 服务

cd "$(dirname "$0")"

# 检查是否已在运行
if lsof -ti :3456 > /dev/null; then
    echo "服务已在运行中！"
    echo "访问地址: http://localhost:3456"
    exit 0
fi

# 启动服务
echo "正在启动 AI PPT 服务..."
nohup node server.mjs > server.log 2>&1 &
PID=$!
echo $PID > .service.pid

# 等待服务启动
sleep 2

if lsof -ti :3456 > /dev/null; then
    echo "✅ 服务启动成功！"
    echo "📍 访问地址: http://localhost:3456"
    echo "📝 日志文件: server.log"
    echo "🔍 进程 ID: $PID"
else
    echo "❌ 服务启动失败，请查看日志"
    cat server.log
    exit 1
fi