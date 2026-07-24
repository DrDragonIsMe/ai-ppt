#!/bin/bash
# 重启 AI PPT 服务

cd "$(dirname "$0")"

echo "正在重启服务..."
./stop-service.sh
echo
./start-service.sh