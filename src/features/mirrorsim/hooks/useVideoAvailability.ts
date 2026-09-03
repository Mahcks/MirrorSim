import { useCallback, useEffect, useRef, useState } from "react";

import {
  createVideoAvailabilityDetectorState,
  reduceVideoAvailability,
  type VideoAvailabilityNotice,
  type VideoAvailabilityObservation,
} from "../protectedVideo";

type ObservationWithoutClock = Omit<VideoAvailabilityObservation, "nowMs">;

export function useVideoAvailability(observation: ObservationWithoutClock) {
  const observationRef = useRef(observation);
  observationRef.current = observation;
  const detectorRef = useRef(createVideoAvailabilityDetectorState(observation.streamKey));
  const [notice, setNotice] = useState<VideoAvailabilityNotice>(null);

  const evaluate = useCallback(() => {
    const next = reduceVideoAvailability(detectorRef.current, {
      ...observationRef.current,
      nowMs: performance.now(),
    });
    detectorRef.current = next;
    setNotice((current) => current === next.notice ? current : next.notice);
  }, []);

  useEffect(() => {
    evaluate();
  }, [evaluate, observation]);

  useEffect(() => {
    if (!observation.isLive) return;
    const intervalId = window.setInterval(evaluate, 250);
    return () => window.clearInterval(intervalId);
  }, [evaluate, observation.isLive]);

  return notice;
}
