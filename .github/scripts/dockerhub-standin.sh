#!/usr/bin/env bash
# Stands in for Docker Hub on this machine: registry-1.docker.io resolves to a
# local registry that serves TLS on :443 and, like the real Hub, answers every
# plain-HTTP request on :80 with a 301 to HTTPS.
#
#   start      serve a certificate from a CA added to the system trust store
#   untrusted  re-serve with a certificate from a CA nothing trusts
#   http-log   print the requests received on :80
set -euo pipefail

DIR=/tmp/dockerhub-standin
HOST=registry-1.docker.io
HTTP_LOG="$DIR/http-requests.log"

make_cert() {
  local name=$1
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$name CA" \
    -keyout "$DIR/$name-ca.key" -out "$DIR/$name-ca.crt" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$HOST" \
    -keyout "$DIR/$name.key" -out "$DIR/$name.csr" 2>/dev/null
  openssl x509 -req -in "$DIR/$name.csr" -days 1 \
    -CA "$DIR/$name-ca.crt" -CAkey "$DIR/$name-ca.key" -CAcreateserial \
    -extfile <(echo "subjectAltName=DNS:$HOST") -out "$DIR/$name.crt" 2>/dev/null
}

serve() {
  local name=$1
  docker rm -f dockerhub-standin >/dev/null 2>&1 || true
  docker run -d --name dockerhub-standin -p 127.0.0.1:443:443 \
    -v "$DIR:/certs:ro" \
    -e REGISTRY_HTTP_ADDR=0.0.0.0:443 \
    -e "REGISTRY_HTTP_TLS_CERTIFICATE=/certs/$name.crt" \
    -e "REGISTRY_HTTP_TLS_KEY=/certs/$name.key" \
    registry:2 >/dev/null
  for _ in $(seq 30); do
    if curl -fsS --cacert "$DIR/$name-ca.crt" "https://$HOST/v2/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "stand-in registry did not come up" >&2
  docker logs dockerhub-standin >&2
  return 1
}

case "${1:-}" in
  start)
    mkdir -p "$DIR"
    # Pull while docker.io still resolves to the real Docker Hub.
    docker pull -q registry:2
    make_cert trusted
    make_cert untrusted
    chmod a+r "$DIR"/*.key
    sudo cp "$DIR/trusted-ca.crt" /usr/local/share/ca-certificates/dockerhub-standin.crt
    sudo update-ca-certificates >/dev/null

    cat >"$DIR/redirect.py" <<'PY'
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = sys.argv[1]


class Redirect(BaseHTTPRequestHandler):
    def redirect(self):
        with open(LOG, "a") as log:
            log.write(f"{self.command} {self.path}\n")
        self.send_response(301)
        self.send_header("Location", f"https://{self.headers['Host']}{self.path}")
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = redirect


ThreadingHTTPServer(("127.0.0.1", 80), Redirect).serve_forever()
PY
    : >"$HTTP_LOG"
    sudo nohup python3 "$DIR/redirect.py" "$HTTP_LOG" >"$DIR/redirect.out" 2>&1 &

    echo "127.0.0.1 $HOST" | sudo tee -a /etc/hosts >/dev/null
    serve trusted
    curl -sS -o /dev/null -w '%{http_code}' "http://$HOST/v2/" | grep -qx 301
    : >"$HTTP_LOG"
    ;;
  untrusted)
    serve untrusted
    ;;
  http-log)
    cat "$HTTP_LOG"
    ;;
  *)
    echo "usage: $0 start|untrusted|http-log" >&2
    exit 2
    ;;
esac
