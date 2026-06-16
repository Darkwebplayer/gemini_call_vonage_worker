import { SignJWT, importPKCS8 } from "jose";
import type { Env } from "./env";

// Vonage Voice call-control requires a JWT signed with the application private
// key (RS256), NOT the api_key/secret. jose runs on Web Crypto in Workers.
async function mintJwt(env: Env): Promise<string> {
  const key = await importPKCS8(env.VONAGE_PRIVATE_KEY, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ application_id: env.VONAGE_APPLICATION_ID })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .setJti(crypto.randomUUID())
    .sign(key);
}

// Place an outbound call to the worker. Vonage hits `answerUrl` when they pick
// up, which returns the connect→websocket NCCO. Returns the created call (incl. uuid).
export async function createCall(env: Env, toNumber: string, answerUrl: string, eventUrl: string) {
  const jwt = await mintJwt(env);
  const res = await fetch("https://api.nexmo.com/v1/calls", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      to: [{ type: "phone", number: toNumber }],
      from: { type: "phone", number: env.VONAGE_NUMBER },
      answer_url: [answerUrl],
      answer_method: "GET",
      event_url: [eventUrl],
    }),
  });
  const body = (await res.json()) as { uuid?: string };
  if (!res.ok) throw new Error(`createCall failed: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

export async function hangup(env: Env, callUuid: string): Promise<void> {
  const jwt = await mintJwt(env);
  const res = await fetch(`https://api.nexmo.com/v1/calls/${callUuid}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "hangup" }),
  });
  if (!res.ok) console.error(`hangup ${callUuid} failed: ${res.status} ${await res.text()}`);
}
