import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";

export const listActive = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const reminders = await ctx.db
      .query("reminders")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return reminders
      .filter((r) => !r.done)
      .sort((a, b) => a.dueAt - b.dueAt);
  },
});

export const listDue = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const now = Date.now();
    const reminders = await ctx.db
      .query("reminders")
      .withIndex("by_user_due", (q) => q.eq("userId", userId))
      .collect();
    return reminders.filter((r) => !r.done && r.firedAt === undefined && r.dueAt <= now);
  },
});

export const markFired = mutation({
  args: { id: v.id("reminders") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const reminder = await ctx.db.get(args.id);
    if (!reminder || reminder.userId !== userId) throw new Error("Reminder not found");
    await ctx.db.patch(args.id, { firedAt: Date.now() });
  },
});

export const complete = mutation({
  args: { id: v.id("reminders") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const reminder = await ctx.db.get(args.id);
    if (!reminder || reminder.userId !== userId) throw new Error("Reminder not found");
    await ctx.db.patch(args.id, { done: true, firedAt: reminder.firedAt ?? Date.now() });
  },
});

export const createForUser = internalMutation({
  args: {
    userId: v.id("users"),
    title: v.string(),
    note: v.optional(v.string()),
    dueAt: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("reminders", {
      userId: args.userId,
      title: args.title,
      note: args.note,
      dueAt: args.dueAt,
      done: false,
      createdAt: Date.now(),
    });
  },
});

export const listForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const reminders = await ctx.db
      .query("reminders")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    return reminders
      .filter((r) => !r.done)
      .sort((a, b) => a.dueAt - b.dueAt);
  },
});
