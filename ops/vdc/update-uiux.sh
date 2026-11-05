#!/usr/bin/env bash
set -euo pipefail
umask 0077
VDC_WORKSPACE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
VDC_ASSETS="$VDC_WORKSPACE/.local-tools/vdc"
VDC_FILES=(src/App.tsx src/style.css src/task-view.ts server/task-view.test.ts)
VDC_CHANGED=false
VDC_PHASE=preflight
VDC_BACKUP=''
as_vetvi() {
  sudo -n -u vetvi -- /bin/bash -c 'cd /opt/vetvi && exec "$@"' bash "$@"
}
rollback_ui() {
  as_vetvi tar -xzf - --no-same-owner < "$VDC_BACKUP/ui.tar.gz" || return
  as_vetvi rm -- src/task-view.ts server/task-view.test.ts
}
on_error() {
  local status=$?
  trap - ERR
  printf 'Ошибка обновления UI: этап %s, код %s.\n' "$VDC_PHASE" "$status" >&2
  if "$VDC_CHANGED"; then
    rollback_ui || echo "Проверьте откат UI: $VDC_BACKUP/ui.tar.gz" >&2
  fi
  exit "$status"
}
trap on_error ERR
exec {VDC_UPDATE_LOCK}>"$VDC_ASSETS/update-completion.lock"
flock -n "$VDC_UPDATE_LOCK"
(cd "$VDC_WORKSPACE" && sha256sum -c "$VDC_ASSETS/uiux-release.sha256")
if as_vetvi sha256sum --status -c - < "$VDC_ASSETS/uiux-release.sha256" 2>/dev/null; then
  echo 'Эта версия UI уже установлена.'
  exit 0
fi
as_vetvi sha256sum -c - < "$VDC_ASSETS/uiux-original.sha256"
as_vetvi /bin/bash -c 'test ! -e src/task-view.ts && test ! -L src/task-view.ts && test ! -e server/task-view.test.ts && test ! -L server/task-view.test.ts'
systemctl is-active vetvi vetvi-tunnel
VDC_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
VDC_BACKUP="$VDC_ASSETS/uiux-$VDC_STAMP"
VDC_STAGE="/opt/vetvi/.local-tools/uiux-$VDC_STAMP"
install -d -m 700 "$VDC_BACKUP"
as_vetvi install -d -m 700 "$VDC_STAGE"
as_vetvi tar -czf - src/App.tsx src/style.css dist > "$VDC_BACKUP/ui.tar.gz"
VDC_PHASE=sqlite-backup
as_vetvi env DATABASE_PATH=/var/lib/vetvi/data/tasks.sqlite \
  /opt/node24/bin/node --import /opt/vetvi/node_modules/tsx/dist/loader.mjs /opt/vetvi/server/backup.ts \
  "/var/lib/vetvi/backups/pre-uiux-$VDC_STAMP.sqlite"
VDC_PHASE=source-update
VDC_CHANGED=true
tar -czf - -C "$VDC_WORKSPACE" "${VDC_FILES[@]}" | as_vetvi tar -xzf - --no-same-owner
as_vetvi chmod 600 "${VDC_FILES[@]}"
as_vetvi sha256sum -c - < "$VDC_ASSETS/uiux-release.sha256"
VDC_PHASE=tests-and-build
as_vetvi env PATH=/opt/node24/bin:/usr/bin:/bin /opt/node24/bin/npm test
as_vetvi env PATH=/opt/node24/bin:/usr/bin:/bin /opt/node24/bin/npm run build -- --base=/space/ --outDir "$VDC_STAGE/dist"
VDC_PHASE=publish-ui
# Publish assets before index; keep old hashes valid for already opened pages.
as_vetvi cmp dist/favicon.svg "$VDC_STAGE/dist/favicon.svg"
as_vetvi cp -a "$VDC_STAGE/dist/assets/." dist/assets/
as_vetvi install -m 600 "$VDC_STAGE/dist/index.html" dist/index.next
as_vetvi mv -- dist/index.next dist/index.html
curl -fsS --max-time 10 http://92.46.191.252/space/health
systemctl is-active vetvi vetvi-tunnel
VDC_CHANGED=false
echo "UI установлен без остановки служб. Прежний код и сборка: $VDC_BACKUP/ui.tar.gz"
