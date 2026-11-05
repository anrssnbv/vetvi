#!/usr/bin/env bash
set -euo pipefail
umask 0077
VDC_WORKSPACE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
VDC_ASSETS="$VDC_WORKSPACE/.local-tools/vdc"
VDC_FILES=(src/App.tsx src/style.css src/task-view.ts server/task-view.test.ts server/service.ts server/mcp.ts server/service.test.ts server/integration.test.ts)
VDC_CHANGED=false
VDC_PHASE=preflight
VDC_BACKUP=''
as_vetvi() { sudo -n -u vetvi -- /bin/bash -c 'cd /opt/vetvi && exec "$@"' bash "$@"; }
services() { sudo -n /usr/bin/systemctl "$1" vetvi.service vetvi-tunnel.service; }
rollback_code() {
  services stop || return
  as_vetvi tar -xzf - --no-same-owner < "$VDC_BACKUP/code.tar.gz" || return
  services start
}
on_error() {
  local status=$?
  trap - ERR
  printf 'Ошибка этапа %s, код %s; backup: %s\n' "$VDC_PHASE" "$status" "$VDC_BACKUP" >&2
  if "$VDC_CHANGED"; then rollback_code || echo 'Проверьте восстановление служб вручную.' >&2; fi
  exit "$status"
}
trap on_error ERR
exec {VDC_UPDATE_LOCK}>"$VDC_ASSETS/update-completion.lock"
flock -n "$VDC_UPDATE_LOCK"
exec {VDC_PLATFORM_LOCK}>>/home/admin-srv/.config/sk-ai-platform/operator.lock
flock -n "$VDC_PLATFORM_LOCK"
(cd "$VDC_WORKSPACE" && sha256sum -c "$VDC_ASSETS/project-delete-release.sha256")
as_vetvi sha256sum -c - < "$VDC_ASSETS/project-delete-original.sha256"
systemctl is-active vetvi vetvi-tunnel
VDC_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
VDC_BACKUP="$VDC_ASSETS/project-delete-$VDC_STAMP"
VDC_STAGE="/opt/vetvi/.local-tools/project-delete-$VDC_STAMP/stage"
install -d -m 700 "$VDC_BACKUP"
as_vetvi install -d -m 700 "$VDC_STAGE"
VDC_PHASE=stage
as_vetvi tar --exclude=node_modules --exclude=dist --exclude=.local-tools --exclude=.git --exclude=.env --exclude=data --exclude=backups -czf - . |
  as_vetvi tar -xzf - --no-same-owner -C "$VDC_STAGE"
as_vetvi ln -s /opt/vetvi/node_modules "$VDC_STAGE/node_modules"
tar -czf - -C "$VDC_WORKSPACE" "${VDC_FILES[@]}" | as_vetvi tar -xzf - --no-same-owner -C "$VDC_STAGE"
as_vetvi /bin/bash -c 'cd "$1" && sha256sum -c -' bash "$VDC_STAGE" < "$VDC_ASSETS/project-delete-release.sha256"
VDC_PHASE=stage-tests-and-build
as_vetvi /bin/bash -c 'cd "$1" && PATH=/opt/node24/bin:/usr/bin:/bin /opt/node24/bin/npm test && PATH=/opt/node24/bin:/usr/bin:/bin /opt/node24/bin/npm run build -- --base=/space/' bash "$VDC_STAGE"
VDC_PHASE=backup
as_vetvi sha256sum -c - < "$VDC_ASSETS/project-delete-original.sha256"
as_vetvi tar -czf - "${VDC_FILES[@]}" dist > "$VDC_BACKUP/code.tar.gz"
as_vetvi env DATABASE_PATH=/var/lib/vetvi/data/tasks.sqlite /opt/node24/bin/node --import /opt/vetvi/node_modules/tsx/dist/loader.mjs /opt/vetvi/server/backup.ts "/var/lib/vetvi/backups/pre-project-delete-$VDC_STAMP.sqlite"
VDC_PHASE=publish
VDC_CHANGED=true
services stop
tar -czf - -C "$VDC_WORKSPACE" "${VDC_FILES[@]}" | as_vetvi tar -xzf - --no-same-owner
as_vetvi chmod 600 "${VDC_FILES[@]}"
as_vetvi sha256sum -c - < "$VDC_ASSETS/project-delete-release.sha256"
as_vetvi cp -a "$VDC_STAGE/dist/assets/." dist/assets/
as_vetvi install -m 600 "$VDC_STAGE/dist/index.html" dist/index.next
as_vetvi mv -- dist/index.next dist/index.html
services start
VDC_PHASE=health
curl -fsS --retry 10 --retry-all-errors --retry-delay 1 --max-time 5 http://92.46.191.252/space/health
curl -fsS --retry 10 --retry-all-errors --retry-delay 1 --max-time 5 http://127.0.0.1:3002/readyz
systemctl is-active vetvi vetvi-tunnel
VDC_CHANGED=false
echo "Удаление проектов с подтверждением установлено. Backup: $VDC_BACKUP/code.tar.gz"
