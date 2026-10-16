import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_user_time", (q) => q.eq("userId", userId))
      .order("desc")
      .take(200);
    return messages.reverse();
  },
});

export const recentForAssistant = internalQuery({
  args: {
    userId: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_user_time", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(args.limit ?? 40);
    return messages.reverse();
  },
});

export const append = internalMutation({
  args: {
    userId: v.id("users"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    toolLog: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("messages", {
      userId: args.userId,
      role: args.role,
      content: args.content,
      toolLog: args.toolLog,
      createdAt: Date.now(),
    });
  },
});

export const clearAll = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_user_time", (q) => q.eq("userId", userId))
      .collect();
    for (const message of messages) {
      await ctx.db.delete(message._id);
    }
  },
});
