# Lessons

- Direct Garmin API authentication is not a safe runtime assumption; use browser-originated requests.
- Never infer an undocumented profile-write route or payload from bundle strings. Invoke Garmin's model with unchanged values, intercept the request, and block it before delivery.
- Custom BPM cardio uses `targetValueOne` and `targetValueTwo`, never `zoneNumber`.
- Garmin web HR zones use one changed-sports `PUT`, `HR_RESERVE`, floor boundaries, and explicit scope states; prove these from the live app bundle before write.
- Approval freshness fingerprints only managed HR state; unrelated volatile profile fields must not invalidate an unchanged proposal.
- Garmin renumbers workout steps globally; ignore only numeric `stepOrder`, never semantic IDs or keys.
- Read `/workout-service/workout/types` before trusting upstream workout ID documentation. Current lap-button ID is `1`; ID `7` means iterations, and ID `4` means swimming.
- Distinguish Garmin activity types from structured-workout sports. `treadmill_running` is activity type `18` under Running; encode its workout as running-compatible and launch it from Treadmill on the watch.
- Resolve the first requested calendar date explicitly. A Sunday-starting preview for next week does not satisfy an added workout requested for the current week.
- Treat activity names as user text that may contain identity or location; exclude them from coaching output.
