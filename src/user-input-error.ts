/**
 * A misconfiguration in the user's workflow (e.g. a missing required input),
 * as opposed to a Blacksmith platform failure. These errors still fail or
 * degrade the action as usual, but are never reported to the Blacksmith
 * backend, so they cannot pollute platform failure metrics and alerts.
 */
export class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserInputError";
  }
}
