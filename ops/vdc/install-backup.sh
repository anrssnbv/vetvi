#!/usr/bin/env bash
set -euo pipefail
umask 0077

if (( EUID != 0 )); then
  echo 'Запустите этот файл через sudo bash.' >&2
  exit 1
fi

VDC_UNIT_SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
for name in vetvi-backup.service vetvi-backup.timer; do
  if [[ -e "/etc/systemd/system/$name" || -L "/etc/systemd/system/$name" ]]; then
    echo "Уже существует; проверьте установленный файл перед повтором: $name" >&2
    exit 1
  fi
done
systemd-analyze verify "$VDC_UNIT_SOURCE/vetvi-backup.service" "$VDC_UNIT_SOURCE/vetvi-backup.timer"
for name in vetvi-backup.service vetvi-backup.timer; do
  install -o root -g root -m 644 "$VDC_UNIT_SOURCE/$name" "/etc/systemd/system/$name"
done
systemctl daemon-reload
systemctl start vetvi-backup.service
systemctl enable --now vetvi-backup.timer
systemctl is-active vetvi-backup.timer
systemctl list-timers vetvi-backup.timer --no-pager
test "$(sqlite3 -readonly /var/lib/vetvi/data/tasks.sqlite 'PRAGMA integrity_check;')" = ok
echo 'Первая проверенная копия создана. Ежедневный backup: 02:00 UTC плюс до 5 минут; хранятся последние 14 tasks-*.sqlite. Исходный transfer-снимок сохраняется отдельно.'
echo 'Копирование вне VDC ещё не настроено.'
