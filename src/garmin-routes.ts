export const GarminRoutes = {
  profile: "userprofile-service/userprofile/user-settings/",
  heartRateZones: "biometric-service/heartRateZones/",
  trainingReadiness: (date: string) =>
    `metrics-service/metrics/trainingreadiness/${date}`,
  trainingStatus: (date: string) =>
    `metrics-service/metrics/trainingstatus/aggregated/${date}`,
  sleep: "sleep-service/sleep/dailySleepData",
  bodyBattery: "wellness-service/wellness/bodyBattery/messagingToday",
  hrv: (date: string) => `hrv-service/hrv/${date}`,
  dailyHeartRate: "wellness-service/wellness/dailyHeartRate",
  activities: "activitylist-service/activities/search/activities",
  workouts: "workout-service/workouts",
  workout: "workout-service/workout",
  scheduleWorkout: (workoutId: number) =>
    `workout-service/schedule/${workoutId}`,
  calendar: (year: number, month: number) =>
    `calendar-service/year/${year}/month/${month}`,
} as const;

export const GARMIN_ROUTE_MAP = Object.freeze({
  getProfile: { method: "GET", path: GarminRoutes.profile },
  getHeartRateZones: { method: "GET", path: GarminRoutes.heartRateZones },
  getTrainingReadiness: {
    method: "GET",
    path: "metrics-service/metrics/trainingreadiness/:date",
  },
  getTrainingStatus: {
    method: "GET",
    path: "metrics-service/metrics/trainingstatus/aggregated/:date",
  },
  getSleep: { method: "GET", path: GarminRoutes.sleep },
  getBodyBattery: { method: "GET", path: GarminRoutes.bodyBattery },
  getHrv: { method: "GET", path: "hrv-service/hrv/:date" },
  getDailyHeartRate: { method: "GET", path: GarminRoutes.dailyHeartRate },
  getActivities: { method: "GET", path: GarminRoutes.activities },
  listWorkouts: { method: "GET", path: GarminRoutes.workouts },
  getWorkout: { method: "GET", path: "workout-service/workout/:id" },
  createWorkout: { method: "POST", path: GarminRoutes.workout },
  scheduleWorkout: { method: "POST", path: "workout-service/schedule/:id" },
  getCalendar: {
    method: "GET",
    path: "calendar-service/year/:year/month/:month",
  },
});
