import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import {
  getWorker,
  getJobDetails,
  recordShiftStatus,
  addAvailability,
  type Worker,
  type JobDetails,
} from "./db";
import { buildSetup, geminiUrl, type CallKind } from "./gemini";
import { hangup } from "./vonage";
import { Downsampler } from "./transcode";

// Holds the Vonage media WebSocket and the Gemini Live WebSocket open at the
// same time and pumps audio between them. Standard (in-memory) WS API — NOT
// hibernation: the call's whole life is a few seconds and we keep mutable
// state (barge-in flag, resampler buffer) that must not be evicted.
export class CallBridge extends DurableObject<Env> {
  private vonage?: WebSocket;
  private gemini?: WebSocket;
  private worker?: Worker;
  private job: JobDetails | null = null;
  private kind: CallKind = "shift";
  private checkDays: string[] = []; // availability calls: the days the admin wants verified
  private wholeWeek = false; // availability: ask one yes/no for the whole week
  private callUuid?: string;
  private bargeIn = false; // user is talking over the bot -> suppress outbound
  private pendingHangup = false; // tool fired; hang up once the goodbye finishes
  private closed = false;
  private readonly down = new Downsampler();

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const url = new URL(req.url);
    const id = url.pathname.split("/").pop()!;
    this.kind = url.searchParams.get("type") === "availability" ? "availability" : "shift";
    const daysParam = url.searchParams.get("days");
    this.wholeWeek = daysParam === "week";
    this.checkDays = this.wholeWeek
      ? ["whole_week"] // recorded as the "asked" value
      : daysParam
        ? daysParam.split(",").filter(Boolean)
        : [];
    const worker = await getWorker(this.env, id);
    if (!worker) return new Response("unknown worker", { status: 404 });
    this.worker = worker;
    this.job = await getJobDetails(this.env, id);

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    this.vonage = server;
    server.addEventListener("message", (e) => this.onVonage(e));
    server.addEventListener("close", () => this.shutdown());
    server.addEventListener("error", () => this.shutdown());

    await this.connectGemini();

    return new Response(null, { status: 101, webSocket: client });
  }

  private async connectGemini(): Promise<void> {
    const res = await fetch(geminiUrl(this.env.GEMINI_API_KEY), {
      headers: { Upgrade: "websocket" },
    });
    const ws = res.webSocket;
    if (!ws) throw new Error(`Gemini WS upgrade failed: ${res.status}`);
    ws.accept();
    this.gemini = ws;
    ws.addEventListener("message", (e) => this.onGemini(e));
    ws.addEventListener("close", (e) => {
      console.log(`gemini closed: ${e.code} ${e.reason}`);
      this.shutdown();
    });
    ws.addEventListener("error", (e) => {
      console.error("gemini ws error:", (e as ErrorEvent).message);
      this.shutdown();
    });
    ws.send(
      JSON.stringify(
        buildSetup(this.worker!, this.job, this.kind, this.wholeWeek ? [] : this.checkDays, this.wholeWeek),
      ),
    );
  }

  // Vonage -> Gemini. First frame is JSON metadata; the rest is raw 640-byte
  // PCM16 @ 16kHz, which is exactly what Gemini wants — no transcode inbound.
  private onVonage(e: MessageEvent): void {
    if (typeof e.data === "string") {
      try {
        const meta = JSON.parse(e.data) as { callUuid?: string };
        if (meta.callUuid) this.callUuid = meta.callUuid;
      } catch {
        /* ignore non-JSON control frames */
      }
      return;
    }
    const bytes = new Uint8Array(e.data as ArrayBuffer);
    this.gemini?.send(
      JSON.stringify({
        realtimeInput: { audio: { data: b64(bytes), mimeType: "audio/pcm;rate=16000" } },
      }),
    );
  }

  // Gemini -> Vonage. JSON frames; audio is base64 PCM16 @ 24kHz inside parts.
  private onGemini(e: MessageEvent): void {
    const text = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    // Outbound call: the worker is silent waiting for us, so prompt Gemini to
    // speak first as soon as the session is ready.
    if (msg.setupComplete) {
      console.log("gemini: setupComplete -> greeting");
      this.gemini?.send(
        JSON.stringify({
          clientContent: {
            turns: [
              {
                role: "user",
                parts: [
                  {
                    text: `The worker ${this.worker?.name} has just answered the phone. Greet them by name and ${
                      this.kind === "availability"
                        ? this.wholeWeek
                          ? "ask whether they are available to work next week"
                          : this.checkDays.length
                            ? `ask whether they are available to work next week on: ${this.checkDays.join(", ")}`
                            : "ask which days next week they are available to work"
                        : "ask whether they are on the way to their shift"
                    }.`,
                  },
                ],
              },
            ],
            turnComplete: true,
          },
        }),
      );
      return;
    }
    if (msg.error) console.error("gemini error:", JSON.stringify(msg.error));

    const sc = msg.serverContent;
    if (sc?.interrupted) {
      // Barge-in: no platform "clear buffer" event, so drop our own queue.
      this.bargeIn = true;
      this.down.reset();
      return;
    }

    if (sc?.modelTurn?.parts) {
      this.bargeIn = false; // a fresh turn is now the audio we want to play
      for (const part of sc.modelTurn.parts) {
        const data = part?.inlineData?.data;
        if (!data) continue;
        const pcm = b64decode(data);
        const frames = this.down.push(new Int16Array(pcm.buffer, 0, pcm.length >> 1));
        if (this.bargeIn) continue;
        for (const f of frames) this.vonage?.send(f);
      }
    }

    if (msg.toolCall) this.onToolCall(msg.toolCall);

    // Let the goodbye play, then hang up when the turn completes.
    if (sc?.turnComplete && this.pendingHangup) void this.hangupAndClose();

    // Lazy goAway handling: just end cleanly (calls are ~30s; no reconnect).
    if (msg.goAway) void this.hangupAndClose();
  }

  private onToolCall(toolCall: any): void {
    for (const fc of toolCall.functionCalls ?? []) {
      if (fc.name === "update_shift_status") {
        const valid = ["on_the_way", "starting_out", "cancelled"];
        const status = valid.includes(fc.args?.status) ? fc.args.status : "starting_out";
        if (this.callUuid && this.worker) {
          void recordShiftStatus(this.env, this.worker.id, this.callUuid, status);
        }
      } else if (fc.name === "record_availability") {
        const days = Array.isArray(fc.args?.days) ? fc.args.days.filter((d: unknown) => typeof d === "string") : [];
        if (this.worker) void addAvailability(this.env, this.worker.id, days, this.checkDays);
      } else {
        continue;
      }
      this.gemini?.send(
        JSON.stringify({
          toolResponse: {
            functionResponses: [{ id: fc.id, name: fc.name, response: { result: { ok: true } } }],
          },
        }),
      );
      this.pendingHangup = true;
    }
  }

  private async hangupAndClose(): Promise<void> {
    if (this.closed) return;
    const uuid = this.callUuid;
    this.shutdown();
    if (uuid) await hangup(this.env, uuid).catch(() => {});
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.gemini?.close();
    } catch {}
    try {
      this.vonage?.close();
    } catch {}
    this.gemini = this.vonage = undefined;
  }
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
