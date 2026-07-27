#!/usr/bin/env bash
# scripts/wuying.sh — 无影云电脑按需开关机脚本
#
# 用法:
#   bash scripts/wuying.sh configure   # 配置 AccessKey 和 Region
#   bash scripts/wuying.sh list        # 列出所有云电脑
#   bash scripts/wuying.sh start       # 开机并等待可连接
#   bash scripts/wuying.sh stop        # 关机
#   bash scripts/wuying.sh status      # 查看状态
#   bash scripts/wuying.sh reboot      # 重启
#
# 配置方式（优先级从高到低）:
#   1. 环境变量: WUYING_ACCESS_KEY_ID / WUYING_ACCESS_KEY_SECRET / WUYING_REGION / WUYING_DESKTOP_ID
#   2. 配置文件: .wuying.env（项目根目录，已 gitignore）
#   3. 交互式配置: bash scripts/wuying.sh configure
#
# 定时任务示例（crontab -e）:
#   0 9 * * 1-5  cd /path/to/ai-ppt && bash scripts/wuying.sh start  # 工作日 9:00 开机
#   0 18 * * 1-5 cd /path/to/ai-ppt && bash scripts/wuying.sh stop   # 工作日 18:00 关机
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/.wuying.env"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[wuying]${NC} $*"; }
warn() { echo -e "${YELLOW}[wuying]${NC} $*"; }
err()  { echo -e "${RED}[wuying]${NC} $*"; }

# ---- 加载凭证 ----
load_credentials() {
    # 1. 环境变量优先
    if [[ -n "${WUYING_ACCESS_KEY_ID:-}" ]]; then
        AK_ID="$WUYING_ACCESS_KEY_ID"
        AK_SECRET="$WUYING_ACCESS_KEY_SECRET"
        REGION="${WUYING_REGION:-cn-hangzhou}"
        DESKTOP_ID="${WUYING_DESKTOP_ID:-}"
        return
    fi

    # 2. .wuying.env 配置文件
    if [[ -f "$ENV_FILE" ]]; then
        source "$ENV_FILE"
        AK_ID="${WUYING_ACCESS_KEY_ID:-}"
        AK_SECRET="${WUYING_ACCESS_KEY_SECRET:-}"
        REGION="${WUYING_REGION:-cn-hangzhou}"
        DESKTOP_ID="${WUYING_DESKTOP_ID:-}"
        if [[ -n "$AK_ID" ]]; then return; fi
    fi

    err "未配置凭证，请先运行: bash scripts/wuying.sh configure"
    exit 1
}

# ---- 确保 aliyun CLI 已配置 ----
ensure_aliyun_configured() {
    local profile="${1:-default}"
    if ! aliyun configure list --profile "$profile" &>/dev/null; then
        aliyun configure set \
            --profile "$profile" \
            --access-key-id "$AK_ID" \
            --access-key-secret "$AK_SECRET" \
            --region "$REGION" \
            --language zh
        log "aliyun CLI 已配置 (profile: $profile, region: $REGION)"
    fi
}

# ---- 交互式配置 ----
cmd_configure() {
    echo ""
    echo -e "${CYAN}══════════════════════════════════════════${NC}"
    echo -e "${CYAN}  无影云电脑 CLI 配置向导${NC}"
    echo -e "${CYAN}══════════════════════════════════════════${NC}"
    echo ""
    echo "需要 RAM 子账号的 AccessKey，授权 AliyunECDFullAccess"
    echo "或最小权限: ecd:StartDesktop / ecd:StopDesktop / ecd:RebootDesktop / ecd:DescribeDesktops"
    echo ""

    read -r -p "AccessKey ID: " AK_ID
    read -r -s -p "AccessKey Secret: " AK_SECRET
    echo ""
    read -r -p "Region [cn-hangzhou]: " REGION
    REGION="${REGION:-cn-hangzhou}"

    # 配置 aliyun CLI
    aliyun configure set \
        --profile default \
        --access-key-id "$AK_ID" \
        --access-key-secret "$AK_SECRET" \
        --region "$REGION" \
        --language zh

    # 写入 .wuying.env
    cat > "$ENV_FILE" <<EOF
# 无影云电脑凭证（已 gitignore，不要提交到仓库）
WUYING_ACCESS_KEY_ID=$AK_ID
WUYING_ACCESS_KEY_SECRET=$AK_SECRET
WUYING_REGION=$REGION
# 运行 bash scripts/wuying.sh list 获取 DesktopId 后填在这里
WUYING_DESKTOP_ID=
EOF
    chmod 600 "$ENV_FILE"
    log "配置已保存到 $ENV_FILE 和 ~/.aliyun/config.json"

    echo ""
    echo -e "${YELLOW}下一步: 运行 'bash scripts/wuying.sh list' 查看云电脑列表，${NC}"
    echo -e "${YELLOW}然后把 DesktopId 填入 $ENV_FILE 的 WUYING_DESKTOP_ID 字段${NC}"
}

# ---- 列出云电脑 ----
cmd_list() {
    load_credentials
    ensure_aliyun_configured

    log "正在查询云电脑列表 (region: $REGION)..."
    local result
    result=$(aliyun ecd DescribeDesktops --RegionId "$REGION" 2>&1) || {
        err "查询失败: $result"
        exit 1
    }

    echo "$result" | python3 -c '
import sys, json
data = json.load(sys.stdin)
desktops = data.get("Desktops", [])
if not desktops:
    print("未找到云电脑实例")
    sys.exit(0)
print(f"\n找到 {len(desktops)} 台云电脑:\n")
for d in desktops:
    did = d.get("DesktopId", "?")
    name = d.get("DesktopName", "?")
    status = d.get("DesktopStatus", "?")
    status_cn = {"Running": "运行中", "Stopped": "已关机", "Starting": "开机中", "Stopping": "关机中"}.get(status, status)
    print(f"  {did}  {name}")
    print(f"  状态: {status_cn}  |  规格: {d.get('DesktopType','?')}  |  OS: {d.get('OsType','?')}")
    print()
' 2>/dev/null || echo "$result"
}

# ---- 查看状态 ----
cmd_status() {
    load_credentials
    ensure_aliyun_configured
    require_desktop_id

    local result
    result=$(aliyun ecd DescribeDesktops --RegionId "$REGION" --DesktopId.1 "$DESKTOP_ID" 2>&1) || {
        err "查询失败: $result"
        exit 1
    }

    echo "$result" | python3 -c '
import sys, json
data = json.load(sys.stdin)
desktops = data.get("Desktops", [])
if not desktops:
    print("未找到该云电脑")
    sys.exit(1)
d = desktops[0]
status = d.get("DesktopStatus", "?")
status_map = {"Running": "运行中 ✅", "Stopped": "已关机 ⏹", "Starting": "开机中 🔄", "Stopping": "关机中 🔄"}
print(f"名称: {d.get(\"DesktopName\",\"?\")}")
print(f"ID:   {d.get(\"DesktopId\",\"?\")}")
print(f"状态: {status_map.get(status, status)}")
print(f"规格: {d.get(\"DesktopType\",\"?\")}  |  OS: {d.get(\"OsType\",\"?\")}")
' 2>/dev/null || echo "$result"
}

# ---- 开机 ----
cmd_start() {
    load_credentials
    ensure_aliyun_configured
    require_desktop_id

    # 先查状态
    local status
    status=$(aliyun ecd DescribeDesktops --RegionId "$REGION" --DesktopId.1 "$DESKTOP_ID" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('Desktops',[{}])[0].get('DesktopStatus','Unknown'))" 2>/dev/null || echo "Unknown")

    case "$status" in
        Running)
            log "云电脑已在运行中，无需开机"
            return 0
            ;;
        Starting)
            log "云电脑正在开机中，等待完成..."
            wait_until_running
            return 0
            ;;
    esac

    log "正在发送开机指令..."
    local result
    result=$(aliyun ecd StartDesktop --RegionId "$REGION" --DesktopId.1 "$DESKTOP_ID" 2>&1) || {
        err "开机失败: $result"
        exit 1
    }

    log "开机指令已发送，等待云电脑进入「运行中」状态（通常需要 1-2 分钟）..."
    wait_until_running
}

wait_until_running() {
    local max_wait=180  # 最多等 3 分钟
    local elapsed=0
    local interval=10

    while [[ $elapsed -lt $max_wait ]]; do
        sleep "$interval"
        elapsed=$((elapsed + interval))

        local status
        status=$(aliyun ecd DescribeDesktops --RegionId "$REGION" --DesktopId.1 "$DESKTOP_ID" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('Desktops',[{}])[0].get('DesktopStatus','Unknown'))" 2>/dev/null || echo "Unknown")

        case "$status" in
            Running)
                log "云电脑已就绪，可以连接了 ✅ (耗时约 ${elapsed} 秒)"
                return 0
                ;;
            Starting)
                log "开机中... (已等待 ${elapsed}s)"
                ;;
            Stopped|Stopping)
                err "云电脑状态异常: $status"
                return 1
                ;;
            *)
                warn "未知状态: $status，继续等待..."
                ;;
        esac
    done

    err "等待超时（${max_wait} 秒），请手动检查状态"
    return 1
}

# ---- 关机 ----
cmd_stop() {
    load_credentials
    ensure_aliyun_configured
    require_desktop_id

    local status
    status=$(aliyun ecd DescribeDesktops --RegionId "$REGION" --DesktopId.1 "$DESKTOP_ID" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('Desktops',[{}])[0].get('DesktopStatus','Unknown'))" 2>/dev/null || echo "Unknown")

    case "$status" in
        Stopped)
            log "云电脑已关机，无需操作"
            return 0
            ;;
        Stopping)
            log "云电脑正在关机中..."
            return 0
            ;;
    esac

    log "正在发送关机指令..."
    local result
    result=$(aliyun ecd StopDesktop --RegionId "$REGION" --DesktopId.1 "$DESKTOP_ID" 2>&1) || {
        err "关机失败: $result"
        exit 1
    }

    log "关机指令已发送。关机后仅收取存储费用，不再计费 ✅"
}

# ---- 重启 ----
cmd_reboot() {
    load_credentials
    ensure_aliyun_configured
    require_desktop_id

    log "正在发送重启指令..."
    local result
    result=$(aliyun ecd RebootDesktop --RegionId "$REGION" --DesktopId.1 "$DESKTOP_ID" 2>&1) || {
        err "重启失败: $result"
        exit 1
    }

    log "重启指令已发送，等待 1-2 分钟后可重新连接"
}

# ---- 辅助函数 ----
require_desktop_id() {
    if [[ -z "${DESKTOP_ID:-}" ]]; then
        err "未设置 WUYING_DESKTOP_ID，请先运行 'bash scripts/wuying.sh list' 获取 DesktopId"
        err "然后填入 $ENV_FILE 的 WUYING_DESKTOP_ID 字段"
        exit 1
    fi
}

# ---- 主入口 ----
main() {
    local cmd="${1:-}"
    case "$cmd" in
        configure)  cmd_configure ;;
        list)       cmd_list ;;
        start)      cmd_start ;;
        stop)       cmd_stop ;;
        status)     cmd_status ;;
        reboot)     cmd_reboot ;;
        *)
            echo "用法: bash scripts/wuying.sh <command>"
            echo ""
            echo "命令:"
            echo "  configure   配置 AccessKey 和 Region"
            echo "  list        列出所有云电脑"
            echo "  start       开机并等待可连接"
            echo "  stop        关机"
            echo "  status      查看状态"
            echo "  reboot      重启"
            echo ""
            echo "环境变量（可选，优先级高于配置文件）:"
            echo "  WUYING_ACCESS_KEY_ID"
            echo "  WUYING_ACCESS_KEY_SECRET"
            echo "  WUYING_REGION         (默认 cn-hangzhou)"
            echo "  WUYING_DESKTOP_ID"
            echo ""
            echo "定时任务示例 (crontab -e):"
            echo "  0 9 * * 1-5  cd $(pwd) && bash scripts/wuying.sh start  # 工作日 9:00 开机"
            echo "  0 18 * * 1-5 cd $(pwd) && bash scripts/wuying.sh stop   # 工作日 18:00 关机"
            ;;
    esac
}

main "$@"