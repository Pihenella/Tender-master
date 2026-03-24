import { cronJobs } from "convex/server";

const crons = cronJobs();

// No cron jobs needed — all processing is direct via Opus API

export default crons;
