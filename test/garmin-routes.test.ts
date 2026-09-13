import assert from "node:assert/strict";
import test from "node:test";

import { GARMIN_ROUTE_MAP, GarminRoutes } from "../src/garmin-routes.js";

test("keeps Garmin operations in an explicit route map", () => {
  assert.equal(GARMIN_ROUTE_MAP.getProfile.path, GarminRoutes.profile);
  assert.equal(GARMIN_ROUTE_MAP.createWorkout.method, "POST");
  assert.equal(GARMIN_ROUTE_MAP.getActivities.path, GarminRoutes.activities);
  assert.match(GARMIN_ROUTE_MAP.getCalendar.path, /calendar-service\/year/);
  assert.equal(
    Object.keys(GARMIN_ROUTE_MAP).includes("arbitraryBrowserRoute"),
    false
  );
});
