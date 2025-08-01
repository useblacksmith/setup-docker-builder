import * as core from "@actions/core";

// State variables needed for setup-docker-builder
export const tmpDir = process.env.STATE_tmpDir || "";
export const inputs = process.env.STATE_inputs
  ? JSON.parse(process.env.STATE_inputs)
  : undefined;

export function setTmpDir(tmpDir: string) {
  core.saveState("tmpDir", tmpDir);
}

export function setInputs(inputs: any) {
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
