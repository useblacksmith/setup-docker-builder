import { promises as fs } from "fs";
import * as path from "path";
import * as core from "@actions/core";

interface StepFailureCheck {
  hasFailures: boolean;
  failedCount: number;
  failedSteps?: Array<{
    action?: string;
    stepName?: string;
    result: string;
    errorMessages?: string[];
  }>;
  error?: string;
}

/**
 * Checks GitHub Actions runner logs for failed or cancelled steps
 * @param runnerBasePath - Base path to runner directory (default: current directory)
 * @returns Promise<StepFailureCheck> - Object containing failure status and details
 */
export async function checkPreviousStepFailures(
  runnerBasePath: string = process.cwd(),
): Promise<StepFailureCheck> {
  try {
    // Find the Worker log file in _diag directory
    const diagPath = path.join(runnerBasePath, "_diag");

    // Check if _diag directory exists
    try {
      await fs.access(diagPath);
    } catch {
      return {
        hasFailures: false,
        failedCount: 0,
        error: "_diag directory not found",
      };
    }

    // Find Worker log files (format: Worker_YYYYMMDD-HHMMSS-utc.log)
    const files = await fs.readdir(diagPath);
    const workerLogFiles = files.filter(
      (f) => f.startsWith("Worker_") && f.endsWith(".log"),
    );

    if (workerLogFiles.length === 0) {
      return {
        hasFailures: false,
        failedCount: 0,
        error: "No Worker log files found",
      };
    }

    // Use the most recent Worker log
    const workerLogPath = path.join(diagPath, workerLogFiles.sort().pop()!);
    const logContent = await fs.readFile(workerLogPath, "utf-8");

    // Patterns to match failed or cancelled steps
    const failurePatterns = [
      /"result":\s*"failed"/g,
      /"result":\s*"cancelled"/g,
      /Step result:\s*Failed/g,
      /Step result:\s*Cancelled/g,
    ];

    // Count total failures
    let failedCount = 0;
    for (const pattern of failurePatterns) {
      const matches = logContent.match(pattern);
      if (matches) {
        failedCount += matches.length;
      }
    }

    // Extract detailed failure information
    const failedSteps: StepFailureCheck["failedSteps"] = [];

    // Regex to extract JSON objects containing step information
    const jsonStepPattern =
      /\{[^{}]*"result":\s*"(?:failed|cancelled)"[^{}]*\}/g;
    const jsonMatches = logContent.match(jsonStepPattern);

    if (jsonMatches) {
      for (const match of jsonMatches) {
        try {
          // Try to find a larger JSON context that includes action name and error messages
          const startIndex = logContent.indexOf(match);
          const contextStart = Math.max(
            0,
            logContent.lastIndexOf("{", startIndex - 500),
          );
          const contextEnd = logContent.indexOf("}.", startIndex) + 1;

          if (contextEnd > contextStart) {
            const contextJson = logContent.substring(contextStart, contextEnd);
            const stepData = JSON.parse(contextJson);

            if (
              stepData.result === "failed" ||
              stepData.result === "cancelled"
            ) {
              failedSteps.push({
                action: stepData.action,
                stepName: stepData.stepName || stepData.displayName,
                result: stepData.result,
                errorMessages: stepData.errorMessages,
              });
            }
          }
        } catch {
          // If we can't parse the full context, at least record the failure
          try {
            const basicStep = JSON.parse(match);
            if (
              basicStep.result === "failed" ||
              basicStep.result === "cancelled"
            ) {
              failedSteps.push({
                result: basicStep.result,
              });
            }
          } catch {
            // Skip malformed JSON
            core.debug("Skipping malformed JSON in log parsing");
          }
        }
      }
    }

    return {
      hasFailures: failedCount > 0,
      failedCount,
      failedSteps: failedSteps.length > 0 ? failedSteps : undefined,
    };
  } catch (error) {
    return {
      hasFailures: false,
      failedCount: 0,
      error: `Error reading logs: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Simple boolean check for any failures
 * @param runnerBasePath - Base path to runner directory
 * @returns Promise<boolean> - true if any steps failed or were cancelled
 */
export async function hasAnyStepFailed(
  runnerBasePath?: string,
): Promise<boolean> {
  const result = await checkPreviousStepFailures(runnerBasePath);
  return result.hasFailures;
}
