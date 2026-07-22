# Setup Docker Builder Action

This GitHub Action sets up a Docker buildkitd builder with sticky disk cache for improved build performance.

## Features

- Sets up buildkitd with a persistent cache stored on a sticky disk
- Automatically mounts the cache at `/var/lib/buildkit`
- Handles builder lifecycle (start, configure, cleanup)
- Supports multi-platform builds
- Falls back to local builder if Blacksmith setup fails

## Usage

```yaml
- name: Checkout
  uses: actions/checkout@v4

- name: Setup Docker Builder
  uses: useblacksmith/setup-docker-builder@v2
  with:
    cache-key: my-repo/backend-image

- name: Build and push
  uses: useblacksmith/build-push-action@v2
  with:
    push: true
    tags: user/backend:latest
```

Builds with the same `cache-key` share cached layers across runs; use one key per build target, e.g. `<repo>/<build-target>`. All inputs are listed in the tables below.

### Version pinning

This action follows semantic versioning and supports multiple referencing patterns:

```yaml
# Recommended: Always get the latest compatible v2.x.x version (automatic updates for features/fixes)
- uses: useblacksmith/setup-docker-builder@v2

# Latest compatible v1.x.x version
- uses: useblacksmith/setup-docker-builder@v1

# Pin to exact version (no automatic updates)
- uses: useblacksmith/setup-docker-builder@v1.1.0

# Pin to specific commit SHA (maximum stability and security)
- uses: useblacksmith/setup-docker-builder@b7dbe18
```

**Which should you use?**

- **`@v2`** - Recommended for new setups. Automatically receives bug fixes and new features within v2.x.x
- **`@v1`** - For existing workflows on the v1 API. Automatically receives bug fixes within v1.x.x
- **`@v1.1.0`** - Use when you need to lock to a specific version for reproducibility
- **`@<sha>`** - Use for maximum security/stability in production environments

## Inputs

### v2

| Name                   | Description                                                                                                                                                                 | Required | Default        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------- |
| `cache-key`            | Unique identifier for this build's Docker layer cache. Builds with the same key share cached layers across runs. Set it to the build target (e.g., `my-repo/backend-image`) | Yes      |                |
| `buildx-version`       | Buildx version (e.g., v0.23.0, latest)                                                                                                                                      | No       | `v0.23.0`      |
| `buildkit-version`     | BuildKit version to install (e.g., v0.16.0, v0.18.0)                                                                                                                        | No       | System default |
| `platforms`            | List of target platforms for build (e.g., linux/amd64,linux/arm64)                                                                                                          | No       |                |
| `nofallback`           | If true, fail the action if Blacksmith builder setup fails                                                                                                                  | No       | `false`        |
| `github-token`         | GitHub token for GitHub API access                                                                                                                                          | No       |                |
| `skip-integrity-check` | Deprecated: the bbolt database integrity check has been removed; this input has no effect                                                                                   | No       | `false`        |
| `driver-opts`          | List of additional driver-specific options (e.g., env.VARIABLE=value)                                                                                                       | No       |                |
| `max-parallelism`      | Maximum number of concurrent BuildKit RUN steps. Defaults to the number of vCPUs on the runner                                                                              | No       |                |

### v1

| Name                   | Description                                                                                                   | Required | Default        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- | -------- | -------------- |
| `buildx-version`       | Buildx version (e.g., v0.23.0, latest)                                                                        | No       | `v0.23.0`      |
| `buildkit-version`     | BuildKit version to install (e.g., v0.16.0, v0.18.0)                                                          | No       | System default |
| `platforms`            | List of target platforms for build (e.g., linux/amd64,linux/arm64)                                            | No       |                |
| `nofallback`           | If true, fail the action if Blacksmith builder setup fails                                                    | No       | `false`        |
| `github-token`         | GitHub token for GitHub API access                                                                            | No       |                |
| `skip-integrity-check` | If true, skip the bbolt database integrity check                                                              | No       | `false`        |
| `driver-opts`          | List of additional driver-specific options (e.g., env.VARIABLE=value)                                         | No       |                |
| `max-parallelism`      | Maximum number of concurrent BuildKit RUN steps. Defaults to the number of vCPUs on the runner                | No       |                |
| `max-cache-size-mb`    | Amount of build cache to retain after pruning, in MB (e.g., 409600 for 400GB). If not set, pruning is skipped | No       |                |

## Example Workflows

### Basic usage with build-push-action

```yaml
- uses: useblacksmith/setup-docker-builder@v2
  with:
    cache-key: my-repo/app-image
- uses: useblacksmith/build-push-action@v2
  with:
    push: true
    tags: user/app:latest
```

### Multiple builds in one job

```yaml
- uses: useblacksmith/setup-docker-builder@v2
  with:
    cache-key: app-images # one builder and cache for both builds in this job

- uses: useblacksmith/build-push-action@v2
  with:
    file: ./Dockerfile.app1
    tags: user/app1:latest

- uses: useblacksmith/build-push-action@v2
  with:
    file: ./Dockerfile.app2
    tags: user/app2:latest
```

### Cache management

#### v2

No input is needed. BuildKit's native garbage collection runs with a time-based policy: layers that haven't been used for the retention period are cleaned up automatically, and actively used layers are kept regardless of total cache size.

#### v1

Use `max-cache-size-mb` to automatically prune the BuildKit cache after each build, retaining the specified amount in MB. This prevents the cache from growing unbounded while keeping the most recent layers available. The layers will be trimmed based off of the last accessed timestamp stored in the cache manager.

Caveats:

- Pruning runs at the end of the job, after the build completes. It is not a usage limit: the cache can grow well beyond the configured size during the build, and only the committed cache is trimmed back.
- If different build targets share the same cache, pruning done by one target's job can evict layers another target still needs, causing rebuilds on its next run.

```yaml
- uses: useblacksmith/setup-docker-builder@v1
  with:
    max-cache-size-mb: "409600" # retain up to 400 GB of build cache
- uses: useblacksmith/build-push-action@v2
  with:
    push: true
    tags: user/app:latest
```

### Custom Docker commands

```yaml
- uses: useblacksmith/setup-docker-builder@v2
  with:
    cache-key: myapp

- run: docker buildx bake

- run: |
    docker buildx build \
      --platform linux/amd64,linux/arm64 \
      --tag myapp:latest \
      .
```

## How it works

1. The action sets up buildkitd with a sticky disk mounted at `/var/lib/buildkit`
2. This provides a persistent cache across builds in the same repository
3. The builder is configured as the default for all subsequent Docker commands
4. In the post-action cleanup, the cache is committed and buildkitd is shut down

## Requirements

- GitHub Actions runner with Docker installed
- Blacksmith environment variables configured
