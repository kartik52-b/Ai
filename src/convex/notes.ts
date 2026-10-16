import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, internalQuery, query } from "./_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const notes = await ctx.db
      .query("notes")
      .withIndex("by_user_time", (q) => q.eq("userId", userId))
      .order("desc")
      .take(50);
    return notes;
  },
});

export const createForUser = internalMutation({
  args: {
    userId: v.id("users"),
    title: v.string(),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("notes", {
      userId: args.userId,
      title: args.title,
      content: args.content,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const listForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("notes")
      .withIndex("by_user_time", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(50);
  },
});

export const removeByTitle = internalMutation({
  args: { userId: v.id("users"), title: v.string() },
  handler: async (ctx, args) => {
    const notes = await ctx.db
      .query("notes")
      .withIndex("by_user_time", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(100);
    const target = args.title.trim().toLowerCase();
    const match =
      notes.find((n) => n.title.trim().toLowerCase() === target) ??
      notes.find((n) => n.title.trim().toLowerCase().includes(target));
    if (!match) return { deleted: false as const };
    await ctx.db.delete(match._id);
    return { deleted: true as const, title: match.title };
  },
});
