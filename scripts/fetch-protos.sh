#!/usr/bin/env bash
# Vendors third-party proto definitions VERBATIM from pinned upstream releases.
# These are the sources of truth for the BuildKit control API (build history
# export) and the containerd content API (history trace attachments) that
# buildkitd serves on its gRPC endpoint.
#
# Re-run this script to bump the pinned versions; never hand-edit the vendored
# files. google/protobuf/* and google/rpc/* imports resolve to buf's built-in
# well-known types at generation time.
set -euo pipefail

BUILDKIT_VERSION=v0.32.2
CONTAINERD_VERSION=v2.3.4
# googleapis has no releases; pin a commit for google/rpc/status.proto.
GOOGLEAPIS_COMMIT=e1a89e443e4c9cef3cf777299dfb246bed8993f6

cd "$(dirname "$0")/.."

fetch() {
  local url=$1 dest=$2
  mkdir -p "$(dirname "$dest")"
  curl -fsSL "$url" -o "$dest"
  echo "fetched $dest"
}

BK=https://raw.githubusercontent.com/moby/buildkit/$BUILDKIT_VERSION
fetch "$BK/api/services/control/control.proto" proto/github.com/moby/buildkit/api/services/control/control.proto
fetch "$BK/api/types/worker.proto" proto/github.com/moby/buildkit/api/types/worker.proto
fetch "$BK/solver/pb/ops.proto" proto/github.com/moby/buildkit/solver/pb/ops.proto
fetch "$BK/sourcepolicy/pb/policy.proto" proto/github.com/moby/buildkit/sourcepolicy/pb/policy.proto

CTRD=https://raw.githubusercontent.com/containerd/containerd/$CONTAINERD_VERSION
fetch "$CTRD/api/services/content/v1/content.proto" proto/containerd/services/content/v1/content.proto

GRPC=https://raw.githubusercontent.com/googleapis/googleapis/$GOOGLEAPIS_COMMIT
fetch "$GRPC/google/rpc/status.proto" proto/google/rpc/status.proto
