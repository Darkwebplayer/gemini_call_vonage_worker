import type { Worker, JobDetails } from "./db";

const MODEL = "models/gemini-3.1-flash-live-preview"; // native audio; sync tool calls. Pinned (Preview).

export type CallKind = "shift" | "availability";
export const DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export function geminiUrl(apiKey: string): string {
  // Workers open outbound WebSockets via fetch() + Upgrade header on an https:// URL
  // (the wss:// scheme is NOT accepted by fetch()).
  return (
    "https://generativelanguage.googleapis.com/ws/" +
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
    `?key=${apiKey}`
  );
}

export function buildSetup(
  worker: Worker,
  job: JobDetails | null,
  kind: CallKind,
  checkDays: string[] = [],
  wholeWeek = false,
) {
  return {
    setup: {
      model: MODEL,
      generationConfig: { responseModalities: ["AUDIO"] },
      systemInstruction: { parts: [{ text: systemPrompt(worker, job, kind, checkDays, wholeWeek) }] },
      tools: [{ functionDeclarations: [kind === "availability" ? availabilityTool : shiftTool] }],
      // Cheap insurance so a longer-than-expected call doesn't get abruptly terminated.
      contextWindowCompression: { slidingWindow: {} },
    },
  };
}

const shiftTool = {
  name: "update_shift_status",
  description: "Record the worker's status for their shift. Call exactly once, as soon as they answer.",
  parameters: {
    type: "OBJECT",
    properties: {
      status: {
        type: "STRING",
        enum: ["on_the_way", "starting_out", "cancelled"],
        description:
          "on_the_way = already travelling to the shift; starting_out = getting ready / about to leave soon; cancelled = not coming / cancelling the shift",
      },
    },
    required: ["status"],
  },
};

const availabilityTool = {
  name: "record_availability",
  description: "Record which days next week the worker is available to work. Call exactly once, after they tell you.",
  parameters: {
    type: "OBJECT",
    properties: {
      days: {
        type: "ARRAY",
        items: { type: "STRING", enum: DAY_NAMES },
        description: "Lowercase day names the worker is available next week (empty if none)",
      },
    },
    required: ["days"],
  },
};

function systemPrompt(w: Worker, job: JobDetails | null, kind: CallKind, checkDays: string[], wholeWeek: boolean): string {
  if (kind === "availability") {
    let ask: string;
    let record: string;
    if (wholeWeek) {
      ask = "Ask whether they are available to work at all next week (a single yes or no — do NOT go day by day).";
      record = "If yes, call record_availability with all seven day names (monday..sunday); if no, an empty list.";
    } else if (checkDays.length) {
      ask = `Ask whether they are available to work next week on these specific days: ${checkDays.join(", ")}.`;
      record = "call record_availability with the lowercase day names they ARE available (only from the days you asked about); empty list if none.";
    } else {
      ask = "Ask which days next week they are available to work.";
      record = "call record_availability with the lowercase day names they ARE available; empty list if none.";
    }
    return `You are a friendly automated scheduling assistant phoning ${w.name}.
Your single goal: ${ask}
Ask once, clearly and warmly. The moment they tell you, ${record}
Then thank them in one short sentence and end the call. Keep the entire call under 30 seconds.`;
  }
  const when = job?.shiftStart ? ` starting at ${job.shiftStart}${job.shiftEnd ? ` until ${job.shiftEnd}` : ""}` : "";
  const where = job?.location ? ` at ${job.location}` : "";
  return `You are a friendly automated check-in assistant phoning ${w.name}.
Your single goal: find out their status for their shift${where}${when}.
Ask once, clearly and warmly whether they are on their way. Based on their answer, call update_shift_status with one of:
- "on_the_way" if they are already travelling to the shift,
- "starting_out" if they are getting ready or about to leave soon,
- "cancelled" if they are not coming / cancelling.
Then thank them in one short sentence and end the call. Keep the entire call under 30 seconds.`;
}
