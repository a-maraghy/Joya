#!/bin/bash
# Install or update the JOYA Library service from this repo (run as root):
#   bash library/deploy/install.sh
# Copies the code to /opt/joya-library (the service user cannot read /root), installs the systemd
# unit and the nginx snippets, rebuilds the pages and restarts the service. nginx is only tested and
# reloaded when a snippet changed. Data (manifest, videos, database, secret) is never touched,
# except that its files are owned by the joyalib user.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
DST=/opt/joya-library
id joyalib >/dev/null 2>&1 || useradd --system --home-dir /var/lib/joya-library --no-create-home \
  --shell /usr/sbin/nologin joyalib
mkdir -p "$DST/library" "$DST/dashboard/public/fonts" "$DST/dashboard/public/brand/m"
rsync -a --delete --exclude '__pycache__' --exclude 'tests/' "$REPO/library/" "$DST/library/"
rsync -a "$REPO/dashboard/public/fonts/" "$DST/dashboard/public/fonts/"
rsync -a "$REPO/dashboard/public/brand/m/" "$DST/dashboard/public/brand/m/"
chown -R root:root "$DST"; chmod -R u=rwX,go=rX "$DST"

mkdir -p /var/lib/joya-library /var/www/library
chown -R joyalib:joyalib /var/lib/joya-library /var/www/library
chmod 0755 /var/lib/joya-library /var/www/library
[ -f /var/lib/joya-library/secret.key ] && chmod 0600 /var/lib/joya-library/secret.key
for f in library.db library.db-wal library.db-shm; do
  [ -f "/var/lib/joya-library/$f" ] && chmod 0600 "/var/lib/joya-library/$f"
done

install -m 0644 "$REPO/library/deploy/joya-library.service" /etc/systemd/system/joya-library.service
changed=0
for pair in "nginx-http.conf:/etc/nginx/conf.d/joya-library.conf" \
            "nginx-library-locations.conf:/etc/nginx/snippets/joya-library-locations.conf"; do
  src="$REPO/library/deploy/${pair%%:*}"; dst="${pair#*:}"
  if ! cmp -s "$src" "$dst"; then
    [ -f "$dst" ] && cp -a "$dst" "/root/backups/$(basename "$dst").pre_$(date +%Y%m%d_%H%M%S)"
    install -m 0644 "$src" "$dst"; changed=1
  fi
done
if [ $changed = 1 ]; then nginx -t && systemctl reload nginx; fi

python3 "$DST/library/build.py"
chown -R joyalib:joyalib /var/www/library /var/lib/joya-library
systemctl daemon-reload
systemctl enable --quiet joya-library
systemctl restart joya-library
for i in $(seq 1 30); do curl -sf http://127.0.0.1:8795/api/health >/dev/null && break; sleep 0.3; done
curl -sf http://127.0.0.1:8795/api/health && echo " joya-library is up"
