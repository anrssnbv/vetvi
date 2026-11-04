#!/usr/bin/env bash
set -euo pipefail

if (( EUID != 0 )); then
  echo 'Запустите этот файл через sudo bash.' >&2
  exit 1
fi

test "$(uname -m)" = x86_64
VDC_ASSETS=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.local-tools/vdc" && pwd)

# Не заменять ранее установленные инструменты при повторном запуске.
for path in /opt/node24 /opt/vetvi-tunnel /usr/local/bin/tunnel-client; do
  if [[ -e "$path" || -L "$path" ]]; then
    echo "Уже существует; требуется проверка перед установкой: $path" >&2
    exit 1
  fi
done

cd "$VDC_ASSETS/node"
awk '$2 == "node-v24.22.2-linux-x64.tar.xz"' SHASUMS256.txt | sha256sum -c -
cd "$VDC_ASSETS/tunnel"
awk '$2 == "tunnel-client-v0.0.18-linux-amd64.zip"' SHA256SUMS.txt | sha256sum -c -

apt-get update
apt-get install -y ca-certificates curl xz-utils unzip python3 sqlite3

if ! id vetvi >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/vetvi --shell /usr/sbin/nologin vetvi
fi
install -d -o vetvi -g vetvi -m 750 /opt/vetvi /var/lib/vetvi/data /var/lib/vetvi/backups /var/lib/vetvi/tunnel-profile
install -d -o root -g vetvi -m 750 /etc/vetvi

install -d -m 755 /opt/node24 /opt/vetvi-tunnel
tar -xJf "$VDC_ASSETS/node/node-v24.22.2-linux-x64.tar.xz" -C /opt/node24 --strip-components=1 --no-same-owner
unzip -q "$VDC_ASSETS/tunnel/tunnel-client-v0.0.18-linux-amd64.zip" -d /opt/vetvi-tunnel
chmod 755 /opt/vetvi-tunnel/tunnel-client /opt/vetvi-tunnel/cloudflared
ln -s /opt/vetvi-tunnel/tunnel-client /usr/local/bin/tunnel-client

runuser -u vetvi -- /opt/node24/bin/node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major !== 24 || minor < 12) process.exit(1); require("node:sqlite"); console.log("SQLite OK")'
runuser -u vetvi -- /usr/local/bin/tunnel-client --version
echo 'Инструменты и каталоги подготовлены. Приложение и туннель ещё не настроены и не запущены.'
