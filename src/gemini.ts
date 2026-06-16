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

const RULES = `Rules:

* Keep the opening to a single sentence.
* Do not explain why you are calling.
* Do not introduce yourself beyond "Giggle here".
* Do not use small talk or unnecessary pleasantries.
* Keep every response concise.
* Once the status is recorded, do not ask any additional questions.
* The entire call should typically take less than 20 seconds.`;

function systemPrompt(w: Worker, job: JobDetails | null, kind: CallKind, checkDays: string[], wholeWeek: boolean): string {
  if (kind === "availability") {
    let opening: string;
    let record: string;
    if (wholeWeek) {
      opening = "Are you available to work at all next week?";
      record = "If yes, call record_availability with all seven day names (monday..sunday); if no, an empty list. Do NOT go day by day.";
    } else if (checkDays.length) {
      opening = `Are you available to work next week on ${checkDays.join(", ")}?`;
      record = "Call record_availability with the lowercase day names they ARE available (only from the days you asked about); empty list if none.";
    } else {
      opening = "Which days next week are you available to work?";
      record = "Call record_availability with the lowercase day names they ARE available; empty list if none.";
    }
    return `You are Giggle's automated scheduling assistant calling ${w.name} about their availability to work next week.

Your only goal is to determine which days they are available.

Start with:

"Hi ${w.name}, Giggle here. ${opening}"

Interpret natural language responses and map them to specific days.

If the response is unclear, ask one short follow-up question. Ask at most one follow-up.

As soon as you know their availability, call the appropriate tool to record it. ${record}

After recording, say:

"Thanks, I've updated that."

Then end the call immediately.

${RULES}`;
  }
  const when = job?.shiftStart ? ` starting at ${job.shiftStart}${job.shiftEnd ? ` until ${job.shiftEnd}` : ""}` : "";
  const where = job?.location ? ` at ${job.location}` : "";
  return `You are Giggle's automated scheduling assistant calling ${w.name} about a job shift they previously signed up for.

Your only goal is to determine their arrival status.

Start with:

"Hi ${w.name}, Giggle here. Are you on your way to your shift${where}${when}?"

Determine one of the following statuses:

* On the way — already travelling to the shift
* Starting out — getting ready / about to leave soon
* Cancelled — not coming / cancelling the shift

Interpret natural language responses and map them to the closest status.

If the response is unclear, ask one short follow-up question. Ask at most one follow-up.

As soon as you know the status, call update_shift_status to record it.

After recording the status, say:

"Thanks, I've updated that."

Then end the call immediately.

${RULES}`;
}
