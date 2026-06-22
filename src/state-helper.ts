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

let _sigkillUsed = false;

export function setSigkillUsed(used: boolean) {
  _sigkillUsed = used;
  core.saveState("sigkillUsed", used.toString());
}

export function getSigkillUsed(): boolean {
  return _sigkillUsed || core.getState("sigkillUsed") === "true";
}
