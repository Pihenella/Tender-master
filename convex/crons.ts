import { cronJobs } from "convex/server";

const crons = cronJobs();

// No cron jobs needed — the local processor handles long-running AI work.

export default crons;
