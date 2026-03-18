import { ConvexClient } from "./convex-client.js";
import { processAnalysis } from "./process-analysis.js";
import { processFill } from "./process-fill.js";

const CONVEX_URL = process.env.CONVEX_URL;
const CONVEX_SECRET = process.env.CONVEX_SECRET;
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL) || 30_000;

if (!CONVEX_URL || !CONVEX_SECRET) {
  console.error("Error: CONVEX_URL and CONVEX_SECRET env vars required");
  process.exit(1);
}

const client = new ConvexClient(CONVEX_URL, CONVEX_SECRET);

async function checkHealth(): Promise<boolean> {
  try {
    await client.getPendingTasks();
    return true;
  } catch (err) {
    console.error("Health check failed:", err);
    return false;
  }
}

async function loop() {
  console.log(`Tender Master Local Processor started`);
  console.log(`Polling ${CONVEX_URL} every ${POLL_INTERVAL / 1000}s`);

  if (!(await checkHealth())) {
    console.error("Initial health check failed. Check CONVEX_URL and CONVEX_SECRET.");
    process.exit(1);
  }

  while (true) {
    try {
      const tasks = await client.getPendingTasks();

      if (tasks.length > 0) {
        console.log(`Found ${tasks.length} pending task(s)`);
      }

      for (const task of tasks) {
        try {
          console.log(`Processing task ${task._id} (status: ${task.status})`);

          if (task.status === "pending_local_analysis") {
            await processAnalysis(client, task);
          } else if (task.status === "pending_local_fill") {
            await processFill(client, task);
          }
        } catch (err: any) {
          console.error(`Task ${task._id} failed:`, err.message);
          const rollbackStatus = task.status === "pending_local_analysis"
            ? "uploaded"
            : "calculation_uploaded";
          try {
            await client.updateStatus(
              task._id,
              rollbackStatus,
              `Ошибка локальной обработки: ${err.message}`.slice(0, 500)
            );
          } catch (updateErr) {
            console.error("Failed to update error status:", updateErr);
          }
        }
      }
    } catch (err) {
      console.error("Polling error:", err);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

process.on("SIGINT", () => {
  console.log("Shutting down...");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("Shutting down...");
  process.exit(0);
});

loop();
