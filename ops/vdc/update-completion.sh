#!/usr/bin/env bash
set -euo pipefail
umask 0077
if (( EUID == 0 )); then
  echo 'Запустите bash этого файла от admin-srv без sudo; права ограничены приложением.' >&2
  exit 1
fi
VDC_WORKSPACE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
VDC_ASSETS="$VDC_WORKSPACE/.local-tools/vdc"
VDC_FILES=(src/App.tsx server/service.ts server/mcp.ts server/service.test.ts server/transport.test.ts src/request-id.ts server/request-id.test.ts)
VDC_PHASE=preflight
VDC_CHANGED=false
VDC_BACKUP=''
VDC_LOG="$VDC_ASSETS/update-completion.log"
test ! -L "$VDC_LOG"
touch "$VDC_LOG"
chmod 600 "$VDC_LOG"
exec > >(tee -a "$VDC_LOG") 2>&1
as_vetvi() {
  sudo -n -u vetvi -- /bin/bash -c 'cd /opt/vetvi && exec "$@"' bash "$@"
}
services() {
  sudo -n /usr/bin/systemctl "$1" vetvi.service vetvi-tunnel.service
}
rollback_code() {
  services stop || return
  as_vetvi rm -rf -- /opt/vetvi/dist
  as_vetvi rm -f -- /opt/vetvi/src/request-id.ts /opt/vetvi/server/request-id.test.ts
  as_vetvi tar -xzf - -C /opt/vetvi --no-same-owner < "$VDC_BACKUP/code.tar.gz" || return
  services start
}
on_error() {
  local status=$?
  trap - ERR
  printf 'Ошибка этапа %s: строка %s, код %s. Журнал: %s\n' "$VDC_PHASE" "${BASH_LINENO[0]}" "$status" "$VDC_LOG" >&2
  if "$VDC_CHANGED"; then
    rollback_code || echo "Автооткат не завершён; прежний код: $VDC_BACKUP/code.tar.gz" >&2
  fi
  exit "$status"
}
trap on_error ERR
exec {VDC_UPDATE_LOCK}>"$VDC_ASSETS/update-completion.lock"
flock -n "$VDC_UPDATE_LOCK"
(cd "$VDC_WORKSPACE" && sha256sum -c "$VDC_ASSETS/completion-release.sha256")
if as_vetvi sha256sum --status -c - < "$VDC_ASSETS/completion-release.sha256" 2>/dev/null; then
  echo 'Этот код уже установлен; повторная установка не требуется.'
  systemctl is-active vetvi vetvi-tunnel
  exit 0
fi
as_vetvi sha256sum -c - < "$VDC_ASSETS/completion-original.sha256"
as_vetvi /bin/bash -c 'test ! -e src/request-id.ts && test ! -L src/request-id.ts && test ! -e server/request-id.test.ts && test ! -L server/request-id.test.ts'
systemctl is-active vetvi vetvi-tunnel
VDC_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
VDC_BACKUP="$VDC_ASSETS/completion-$VDC_STAMP"
install -d -m 700 "$VDC_BACKUP"
as_vetvi tar -czf - "${VDC_FILES[@]:0:5}" dist > "$VDC_BACKUP/code.tar.gz"
VDC_PHASE=sqlite-backup
as_vetvi env DATABASE_PATH=/var/lib/vetvi/data/tasks.sqlite \
  /opt/node24/bin/node --import /opt/vetvi/node_modules/tsx/dist/loader.mjs /opt/vetvi/server/backup.ts \
  "/var/lib/vetvi/backups/pre-completion-$VDC_STAMP.sqlite"
VDC_PHASE=code-update
VDC_CHANGED=true
services stop
tar -czf - -C "$VDC_WORKSPACE" "${VDC_FILES[@]}" | as_vetvi tar -xzf - -C /opt/vetvi --no-same-owner
as_vetvi chmod 600 "${VDC_FILES[@]}"
as_vetvi sha256sum -c - < "$VDC_ASSETS/completion-release.sha256"
VDC_PHASE=tests-and-build
as_vetvi env PATH=/opt/node24/bin:/usr/bin:/bin /opt/node24/bin/npm test
as_vetvi env PATH=/opt/node24/bin:/usr/bin:/bin /opt/node24/bin/npm run build -- --base=/vetvi/
VDC_PHASE=live-verification
services start
curl -fsS --retry 10 --retry-connrefused --retry-delay 1 --max-time 5 \
  -H 'Host: 92.46.191.252' http://127.0.0.1:3001/health
curl -fsS --retry 10 --retry-all-errors --retry-delay 1 --max-time 5 http://127.0.0.1:3002/readyz
systemctl is-active vetvi vetvi-tunnel
as_vetvi cat /etc/vetvi/app.env | python3 "$VDC_WORKSPACE/ops/vdc/verify-http.py" http://92.46.191.252/vetvi /dev/stdin
VDC_CHANGED=false
echo "Обновление завершено. Прежний код: $VDC_BACKUP/code.tar.gz"
echo 'Завершение требует только результата. Nginx, платформа, настройки и базы не заменялись.'
