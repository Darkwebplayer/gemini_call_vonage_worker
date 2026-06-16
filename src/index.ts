import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import type { Env } from "./env";
import {
  getWorker,
  getJobDetails,
  markContacted,
  lookupWorkerByPhone,
  listWorkers,
  createWorker,
  updateWorker,
  deleteWorker,
  listAvailability,
} from "./db";
import { createCall } from "./vonage";
import { PAGE } from "./ui";

export { CallBridge } from "./bridge";

const app = new Hono<{ Bindings: Env }>();

// Basic-auth gate on the admin surface (UI, CRUD, call trigger). Vonage webhooks
// (/answer, /event, /bridge) stay open — Vonage can't supply the key.
const admin = basicAuth({ verifyUser: (_user, pass, c) => pass === c.env.ADMIN_KEY });
app.use("/", admin);
app.use("/api/*", admin);
app.use("/call/*", admin);

// Admin UI + JSON CRUD.
app.get("/", (c) => c.html(PAGE));
app.get("/api/workers", async (c) => c.json(await listWorkers(c.env)));
app.post("/api/workers", async (c) => c.json({ id: await createWorker(c.env, await c.req.json()) }, 201));
app.put("/api/workers/:id", async (c) => {
  await updateWorker(c.env, c.req.param("id"), await c.req.json());
  return c.body(null, 204);
});
app.delete("/api/workers/:id", async (c) => {
  await deleteWorker(c.env, c.req.param("id"));
  return c.body(null, 204);
});
app.get("/api/availability/:userId", async (c) => c.json(await listAvailability(c.env, c.req.param("userId"))));

// Trigger an outbound check-in call: we ring the worker.
app.post("/call/:workerId", async (c) => {
  const worker = await getWorker(c.env, c.req.param("workerId"));
  if (!worker) return c.json({ error: "unknown worker" }, 404);

  const type = c.req.query("type") === "availability" ? "availability" : "shift";

  // The "already contacted" gate only applies to the daily shift check-in.
  if (type === "shift") {
    const job = await getJobDetails(c.env, worker.id);
    if (job?.contactedAt && c.req.query("force") !== "true") {
      return c.json({ skipped: true, reason: "already contacted", contactedAt: job.contactedAt }, 409);
    }
  }

  // Availability calls carry the days the admin wants the worker asked about.
  const days = type === "availability" ? (c.req.query("days") ?? "") : "";
  const daysQ = days ? `&days=${encodeURIComponent(days)}` : "";

  const base = `https://${c.env.PUBLIC_HOST ?? new URL(c.req.url).host}`;
  const call = await createCall(
    c.env,
    worker.phone,
    `${base}/answer?workerId=${worker.id}&type=${type}${daysQ}`,
    `${base}/event`,
  );
  if (type === "shift") await markContacted(c.env, worker.id);
  return c.json({ uuid: call.uuid, to: worker.phone, type });
});

// Vonage answer webhook (GET). Outbound: ?workerId=... ; inbound: look up by caller.
app.get("/answer", async (c) => {
  const uuid = c.req.query("uuid") ?? "";
  const workerId = c.req.query("workerId");
  const worker = workerId
    ? await getWorker(c.env, workerId)
    : await lookupWorkerByPhone(c.env, c.req.query("from") ?? "");

  if (!worker) {
    return c.json([{ action: "talk", text: "Sorry, this number isn't recognised. Goodbye." }]);
  }

  const host = c.env.PUBLIC_HOST ?? new URL(c.req.url).host;
  const type = c.req.query("type") === "availability" ? "availability" : "shift";
  const days = c.req.query("days") ?? "";
  const daysQ = days ? `&days=${encodeURIComponent(days)}` : "";
  return c.json([
    {
      action: "connect",
      from: c.env.VONAGE_NUMBER || c.req.query("to") || undefined,
      endpoint: [
        {
          type: "websocket",
          uri: `wss://${host}/bridge/${worker.id}?type=${type}${daysQ}`,
          "content-type": "audio/l16;rate=16000",
          headers: { callUuid: uuid }, // echoed back in Vonage's first WS frame
        },
      ],
    },
  ]);
});

// Vonage call-lifecycle events (answered, completed, ...). Ack and ignore for now.
app.post("/event", (c) => c.body(null, 204));

// Vonage opens the media WebSocket here; hand it to the per-worker Durable Object.
app.get("/bridge/:workerId", (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.text("expected websocket", 426);
  return c.env.CALL_BRIDGE.getByName(c.req.param("workerId")).fetch(c.req.raw);
});

export default app;
