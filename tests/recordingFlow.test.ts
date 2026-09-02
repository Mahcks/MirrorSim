import { describe, expect, test } from "bun:test";

import { getRecordingFailureRecovery } from "../src/features/mirrorsim/recordingFlow";

describe("recording failure recovery", () => {
  test("never aborts an established recording during stop or finalization", () => {
    expect(getRecordingFailureRecovery("stopping-backend", true)).toEqual({
      abortWorkspace: false,
      preserveForRetry: true,
    });
    expect(getRecordingFailureRecovery("finalizing", true)).toEqual({
      abortWorkspace: false,
      preserveForRetry: true,
    });
  });

  test("only an unstarted workspace can be aborted automatically", () => {
    expect(getRecordingFailureRecovery("starting", false).abortWorkspace).toBe(true);
    expect(getRecordingFailureRecovery("starting", true).abortWorkspace).toBe(false);
  });
});
