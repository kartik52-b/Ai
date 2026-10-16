import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

const schema = defineSchema({
  ...authTables,

  messages: defineTable({
    userId: v.id("users"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    toolLog: v.optional(v.array(v.string())),
    createdAt: v.number(),
  }).index("by_user_time", ["userId", "createdAt"]),

  reminders: defineTable({
    userId: v.id("users"),
    title: v.string(),
    note: v.optional(v.string()),
    dueAt: v.number(),
    done: v.boolean(),
    firedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_due", ["userId", "dueAt"]),

  notes: defineTable({
    userId: v.id("users"),
    title: v.string(),
    content: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user_time", ["userId", "createdAt"]),
});

export default schema;
