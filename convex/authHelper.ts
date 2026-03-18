"use node";

import { internalAction, internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const checkSecret = internalAction({
  args: { token: v.string() },
  handler: async (_ctx, args) => {
    const secret = process.env.CONVEX_LOCAL_PROCESSOR_SECRET;
    return secret === args.token;
  },
});

export const getSecret = internalAction({
  args: {},
  handler: async () => {
    return process.env.CONVEX_LOCAL_PROCESSOR_SECRET || "";
  },
});
