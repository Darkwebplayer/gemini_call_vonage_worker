import { drizzle } from "drizzle-orm/d1";
import { eq, desc } from "drizzle-orm";
import type { Env } from "./env";
import { workers, jobDetails, availability, checkInLog } from "./schema";

export type Worker = typeof workers.$inferSelect;
export type JobDetails = typeof jobDetails.$inferSelect;

export async function lookupWorkerByPhone(env: Env, phone: string): Promise<Worker | null> {
  const rows = await drizzle(env.callworker).select().from(workers).where(eq(workers.phone, phone)).limit(1);
  return rows[0] ?? null;
}

export async function getWorker(env: Env, id: string): Promise<Worker | null> {
  const rows = await drizzle(env.callworker).select().from(workers).where(eq(workers.id, id)).limit(1);
  return rows[0] ?? null;
}

export interface WorkerRow {
  id: string;
  name: string;
  phone: string;
  shiftStart?: string | null;
  shiftEnd?: string | null;
  location?: string | null;
  shiftStatus?: string | null;
  contactedAt?: string | null;
}

export async function listWorkers(env: Env): Promise<WorkerRow[]> {
  const rows = await drizzle(env.callworker)
    .select()
    .from(workers)
    .leftJoin(jobDetails, eq(jobDetails.userId, workers.id));
  return rows.map((r) => ({
    id: r.workers.id,
    name: r.workers.name,
    phone: r.workers.phone,
    shiftStart: r.job_details?.shiftStart,
    shiftEnd: r.job_details?.shiftEnd,
    location: r.job_details?.location,
    shiftStatus: r.job_details?.status,
    contactedAt: r.job_details?.contactedAt,
  }));
}

export async function createWorker(env: Env, w: Omit<WorkerRow, "id" | "shiftStatus" | "contactedAt">) {
  const db = drizzle(env.callworker);
  const id = crypto.randomUUID();
  await db.batch([
    db.insert(workers).values({ id, name: w.name, phone: w.phone, status: "active" }),
    db.insert(jobDetails).values({
      userId: id,
      shiftStart: w.shiftStart,
      shiftEnd: w.shiftEnd,
      location: w.location,
      status: "pending",
    }),
  ]);
  return id;
}

export async function updateWorker(env: Env, id: string, w: Omit<WorkerRow, "id" | "shiftStatus" | "contactedAt">) {
  const db = drizzle(env.callworker);
  await db.batch([
    db.update(workers).set({ name: w.name, phone: w.phone }).where(eq(workers.id, id)),
    db
      .update(jobDetails)
      .set({ shiftStart: w.shiftStart, shiftEnd: w.shiftEnd, location: w.location })
      .where(eq(jobDetails.userId, id)),
  ]);
}

export async function deleteWorker(env: Env, id: string) {
  const db = drizzle(env.callworker);
  await db.batch([
    db.delete(availability).where(eq(availability.userId, id)),
    db.delete(checkInLog).where(eq(checkInLog.workerId, id)),
    db.delete(jobDetails).where(eq(jobDetails.userId, id)),
    db.delete(workers).where(eq(workers.id, id)),
  ]);
}

export async function addAvailability(env: Env, userId: string, availableDays: string[], checkedDays: string[] = []) {
  await drizzle(env.callworker).insert(availability).values({
    userId,
    days: JSON.stringify(availableDays),
    checkedDays: JSON.stringify(checkedDays),
    createdAt: new Date().toISOString(),
  });
}

export async function listAvailability(env: Env, userId: string) {
  const rows = await drizzle(env.callworker)
    .select()
    .from(availability)
    .where(eq(availability.userId, userId))
    .orderBy(desc(availability.createdAt));
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    available: JSON.parse(r.days) as string[],
    checked: (r.checkedDays ? JSON.parse(r.checkedDays) : []) as string[],
  }));
}

export async function getJobDetails(env: Env, userId: string): Promise<JobDetails | null> {
  const rows = await drizzle(env.callworker).select().from(jobDetails).where(eq(jobDetails.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export async function markContacted(env: Env, userId: string) {
  // Optimistically mark unreachable; recordShiftStatus overwrites this if the
  // worker answers and the assistant records a real status.
  await drizzle(env.callworker)
    .update(jobDetails)
    .set({ contactedAt: new Date().toISOString(), status: "call_unreachable" })
    .where(eq(jobDetails.userId, userId));
}

export async function recordShiftStatus(env: Env, userId: string, callUuid: string, status: string) {
  const db = drizzle(env.callworker);
  const now = new Date().toISOString();
  await db.batch([
    db.insert(checkInLog).values({ workerId: userId, callUuid, status, recordedAt: now }),
    db.update(jobDetails).set({ status, updatedAt: now }).where(eq(jobDetails.userId, userId)),
  ]);
}
