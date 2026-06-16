import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// Source of truth for the D1 schema. Regenerate migrations with `npm run db:generate`.
export const workers = sqliteTable("workers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  status: text("status"),
  updatedAt: text("updated_at"),
});

export const jobDetails = sqliteTable("job_details", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(), // = workers.id
  shiftStart: text("shift_start"),
  shiftEnd: text("shift_end"),
  location: text("location"),
  status: text("status"), // on_the_way | not_on_the_way
  contactedAt: text("contacted_at"), // set when we place the call; gates re-contact
  updatedAt: text("updated_at"),
});

// Result of an availability check call. History kept: one row per completed call.
export const availability = sqliteTable("availability", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  checkedDays: text("checked_days"), // JSON array of days the admin asked about
  days: text("days").notNull(), // JSON array of days the worker confirmed available
  createdAt: text("created_at").notNull(),
});

export const checkInLog = sqliteTable("check_in_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workerId: text("worker_id").notNull(),
  callUuid: text("call_uuid").notNull(),
  status: text("status").notNull(),
  recordedAt: text("recorded_at").notNull(),
});
