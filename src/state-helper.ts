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

// Set when buildkitd was already running at setup time, so this step reused
// a builder (and sticky disk mount) owned by an earlier setup-docker-builder
// step in the same job. Only the owning step's post action cleans them up.
export function setReusedExistingBuilder(reused: boolean) {
  core.saveState("reusedExistingBuilder", reused.toString());
}

export function getReusedExistingBuilder(): boolean {
  return core.getState("reusedExistingBuilder") === "true";
}

export function setBuilderName(name: string) {
  core.saveState("builderName", name);
}

export function getBuilderName(): string {
  return core.getState("builderName");
}

let _sigkillUsed = false;

export function setSigkillUsed(used: boolean) {
  _sigkillUsed = used;
  core.saveState("sigkillUsed", used.toString());
}

export function getSigkillUsed(): boolean {
  return _sigkillUsed || core.getState("sigkillUsed") === "true";
}
