export type RecordingFailureStage = "starting" | "stopping-backend" | "finalizing";

export function getRecordingFailureRecovery(
  stage: RecordingFailureStage,
  recorderCreated: boolean,
) {
  const abortWorkspace = stage === "starting" && !recorderCreated;
  return {
    abortWorkspace,
    preserveForRetry: !abortWorkspace,
  };
}
