#!/bin/sh
set -eu

fail() {
    printf '%s\n' "$1" >&2
    exit 1
}

usage='用法：./reset-local-data.sh restaurant-reconciliation 或 ./reset-local-data.sh restaurant-reconciliation-t04-browser'
[ "$#" -eq 1 ] || fail "$usage"
project=$1
case "$project" in
    restaurant-reconciliation|restaurant-reconciliation-t04-browser) ;;
    *) fail "$usage" ;;
esac

project_root=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P) || fail '無法辨識專案目錄。'
[ -z "${DOCKER_HOST:-}" ] || fail '請先取消 DOCKER_HOST，並選用本機 Docker context。'
context=$(docker context show) || fail '無法辨識 Docker context。'
docker_socket=$(docker context inspect --format '{{(index .Endpoints "docker").Host}}' "$context") ||
    fail '無法辨識 Docker context 的連線位置。'
case "$docker_socket" in
    unix:///*) ;;
    *) fail '重設僅允許使用本機 Unix socket 的 Docker context。' ;;
esac

local_docker() (
    unset DOCKER_CONTEXT
    docker --host "$docker_socket" "$@"
)

service_id() {
    local_docker compose --project-directory "$project_root" -f "$project_root/compose.yaml" \
        -p "$project" ps --all --quiet "$1"
}

# 只接受單一容器的完整 ID，避免後續依名稱誤用已替換的容器。
full_id() {
    case "$1" in
        *[!0123456789abcdef]*) return 1 ;;
    esac
    [ "${#1}" -eq 64 ]
}

app_id=$(service_id app) && full_id "$app_id" || fail '找不到唯一的 app 容器。'
db_id=$(service_id db) && full_id "$db_id" || fail '找不到唯一的 db 容器。'
volume=${project}_pgdata

verify_target() (
    current_app_id=$(service_id app) && current_db_id=$(service_id db) &&
        [ "$current_app_id" = "$app_id" ] && [ "$current_db_id" = "$db_id" ] ||
        fail 'Compose 容器已變動，請重新確認目標。'
    volume_users=$(local_docker ps -aq --no-trunc --filter "volume=$volume") && [ "$volume_users" = "$db_id" ] ||
        fail '只有預期的 db 容器可以使用資料卷。'

    volume_info=$(local_docker volume inspect --format \
        '{{.Name}}|{{.Driver}}|{{.Scope}}|{{len .Options}}|{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}|{{.Mountpoint}}' "$volume") ||
        fail '無法檢查資料卷。'
    volume_prefix="$volume|local|local|0|$project|pgdata|"
    case "$volume_info" in
        "$volume_prefix"/*) volume_path=${volume_info#"$volume_prefix"} ;;
        *) fail '資料卷的建立來源或掛載設定不符。' ;;
    esac

    labels='{{.Id}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}'
    app_info=$(local_docker container inspect --format \
        "$labels"'|{{json .Config.Cmd}}|{{.State.Status}}' "$app_id") || fail '無法檢查 app 容器。'
    app_prefix="$app_id|$project|$project_root|app|False|[\"bin/container-start\"]|"
    case "$app_info" in
        "$app_prefix"running|"$app_prefix"created|"$app_prefix"exited) ;;
        *) fail 'app 容器的身分或狀態不符。' ;;
    esac

    db_info=$(local_docker container inspect --format \
        "$labels"'
{{.State.Status}}|{{with .State.Health}}{{.Status}}{{end}}
{{.HostConfig.NetworkMode}}|{{len .NetworkSettings.Networks}}|{{len .HostConfig.PortBindings}}|{{.HostConfig.PublishAllPorts}}
{{len .Mounts}}{{range .Mounts}}|{{.Type}}|{{.Driver}}|{{.Name}}|{{.Source}}|{{.Destination}}|{{.RW}}{{end}}' "$db_id") ||
        fail '無法檢查 db 容器。'
    [ "$db_info" = "$db_id|$project|$project_root|db|False
running|healthy
${project}_default|1|0|false
1|volume|local|$volume|$volume_path|/var/lib/postgresql|true" ] ||
        fail 'db 容器的身分、健康狀態、網路或資料卷不符。'

    printf '%s\n' "${app_info#"$app_prefix"}"
)

reset_failed() {
    printf '重設未確認完成，app 可能已停止。請核對目標並處理上方錯誤，再執行 ./reset-local-data.sh %s 並重新確認；重設成功後再啟動 app。\n' "$project" >&2
    exit 1
}

verify_target >/dev/null || exit 1
confirmation="RESET $project"
printf 'Compose 專案：%s\nDocker context：%s (%s)\n資料卷：%s\n資料庫：restaurant_reconciliation\n' \
    "$project" "$context" "$docker_socket" "$volume"
printf '重設會停止 app，永久清空對帳批次、來源紀錄、對帳結果與處理紀錄。\n請輸入 %s 後按 Enter：' "$confirmation"
if ! IFS= read -r answer || [ "$answer" != "$confirmation" ]; then
    fail '已取消重設。'
fi

app_status=$(verify_target) || exit 1
trap 'reset_failed' HUP INT TERM
if [ "$app_status" = running ]; then
    local_docker stop "$app_id" >/dev/null || reset_failed
fi
app_status=$(verify_target) || reset_failed
[ "$app_status" != running ] || reset_failed

local_docker exec -i "$db_id" psql -X --no-password --set=ON_ERROR_STOP=1 \
    --host=/var/run/postgresql --port=5432 --username=reconciliation --dbname=restaurant_reconciliation <<'SQL' || reset_failed
BEGIN;
LOCK TABLE ONLY public.import_batches, ONLY public.source_events,
           ONLY public.reconciliation_results, ONLY public.investigation_records
    IN ACCESS EXCLUSIVE MODE NOWAIT;
TRUNCATE TABLE ONLY public.import_batches, ONLY public.source_events,
               ONLY public.reconciliation_results, ONLY public.investigation_records
    CONTINUE IDENTITY RESTRICT;
COMMIT;
SQL

printf '重設完成。對帳資料已清空。請另外正常啟動 app，再手動匯入範例；啟動時不會自動匯入。\n'
