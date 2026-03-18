import { cronJobs } from "convex/server";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

const STALE_THRESHOLD_MS = 15 * 60 * 1000;
const MAX_RETRIES = 3;

export const recoverStaleTasks = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    const procurements = await ctx.db
      .query("procurements")
      .filter((q) =>
        q.and(
          q.eq(q.field("processingMode"), "local"),
          q.or(
            q.eq(q.field("status"), "analyzing"),
            q.eq(q.field("status"), "filling_forms")
          )
        )
      )
      .collect();

    for (const p of procurements) {
      const updatedAt = p.localStatusUpdatedAt || p._creationTime;
      if (now - updatedAt < STALE_THRESHOLD_MS) continue;

      const retryCount = (p.localRetryCount || 0) + 1;

      if (retryCount > MAX_RETRIES) {
        await ctx.db.patch(p._id, {
          status: "error",
          statusMessage: `Локальная обработка не завершилась после ${MAX_RETRIES} попыток`,
          localRetryCount: retryCount,
        });
      } else {
        const resetStatus = p.status === "analyzing"
          ? "pending_local_analysis" as const
          : "pending_local_fill" as const;
        await ctx.db.patch(p._id, {
          status: resetStatus,
          statusMessage: `Автоматический перезапуск (попытка ${retryCount}/${MAX_RETRIES})`,
          localRetryCount: retryCount,
          localStatusUpdatedAt: now,
        });
      }
    }
  },
});

const crons = cronJobs();

crons.interval(
  "recover stale local tasks",
  { minutes: 5 },
  internal.crons.recoverStaleTasks,
);

export default crons;
