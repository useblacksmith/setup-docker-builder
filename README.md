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
- name: Setup Docker Builder
  uses: useblacksmith/setup-docker-builder@v1
  with:
    buildx-version: "v0.23.0" # optional, defaults to v0.23.0
    platforms: "linux/amd64,linux/arm64" # optional
    nofallback: "false" # optional, defaults to false
    github-token: ${{ secrets.GITHUB_TOKEN }} # optional
```

## Inputs

| Name             | Description                                                        | Required | Default   |
| ---------------- | ------------------------------------------------------------------ | -------- | --------- |
| `buildx-version` | Buildx version (e.g., v0.23.0, latest)                             | No       | `v0.23.0` |
| `platforms`      | List of target platforms for build (e.g., linux/amd64,linux/arm64) | No       |           |
| `nofallback`     | If true, fail the action if Blacksmith builder setup fails         | No       | `false`   |
| `github-token`   | GitHub token for GitHub API access                                 | No       |           |

## Example Workflows

### Basic usage with build-push-action

```yaml
- uses: useblacksmith/setup-docker-builder@v1
- uses: useblacksmith/build-push-action@v1
  with:
    push: true
    tags: user/app:latest
```

### Multiple builds in one job

```yaml
- uses: useblacksmith/setup-docker-builder@v1

- uses: useblacksmith/build-push-action@v1
  with:
    file: ./Dockerfile.app1
    tags: user/app1:latest

- uses: useblacksmith/build-push-action@v1
  with:
    file: ./Dockerfile.app2
    tags: user/app2:latest
```

### Custom Docker commands

```yaml
- uses: useblacksmith/setup-docker-builder@v1

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
