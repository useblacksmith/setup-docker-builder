import * as core from "@actions/core";

// State variables needed for setup-docker-builder
export const tmpDir = process.env.STATE_tmpDir || "";
export const inputs = process.env.STATE_inputs
  ? JSON.parse(process.env.STATE_inputs)
  : undefined;

export function setTmpDir(tmpDir: string) {
  core.saveState("tmpDir", tmpDir);
}

export function setInputs(inputs: unknown) {
  core.saveState("inputs", JSON.stringify(inputs));
}

export function setExposeId(exposeId: string) {
  core.saveState("exposeId", exposeId);
}

export function getExposeId(): string {
  return core.getState("exposeId");
}

// Reason the host gave at mount time for denying this job's sticky disk
// commit (e.g. branch protection); empty when no denial was reported.
export function setCommitEarlyDenyReason(reason: string) {
  core.saveState("commitEarlyDenyReason", reason);
}

export function getCommitEarlyDenyReason(): string {
  return core.getState("commitEarlyDenyReason");
}

export function setBuildkitdAddr(addr: string) {
  core.saveState("buildkitdAddr", addr);
}

export function getBuildkitdAddr(): string {
  return core.getState("buildkitdAddr");
}

export function setBuilderName(name: string) {
  core.saveState("builderName", name);
}

export function getBuilderName(): string {
  return core.getState("builderName");
}

export function setCacheKey(key: string) {
  core.saveState("cacheKey", key);
}

export function getCacheKey(): string {
  return core.getState("cacheKey");
}

// Builder lifecycle facts recorded in the main step and read back in the
// post step for the docker-build teardown report.
export function setBuilderMode(mode: string) {
  core.saveState("builderMode", mode);
}

export function getBuilderMode(): string {
  return core.getState("builderMode");
}

export function setFallbackReason(reason: string) {
  core.saveState("fallbackReason", reason);
}

export function getFallbackReason(): string {
  return core.getState("fallbackReason");
}

export function setHotloadDurationMs(ms: number) {
  core.saveState("hotloadDurationMs", ms.toString());
}

export function getHotloadDurationMs(): number {
  return parseInt(core.getState("hotloadDurationMs"), 10) || 0;
}

export function setBuildkitdReadyDurationMs(ms: number) {
  core.saveState("buildkitdReadyDurationMs", ms.toString());
}

export function getBuildkitdReadyDurationMs(): number {
  return parseInt(core.getState("buildkitdReadyDurationMs"), 10) || 0;
}

let _sigkillUsed = false;

export function setSigkillUsed(used: boolean) {
  _sigkillUsed = used;
  core.saveState("sigkillUsed", used.toString());
}

export function getSigkillUsed(): boolean {
  return _sigkillUsed || core.getState("sigkillUsed") === "true";
}
