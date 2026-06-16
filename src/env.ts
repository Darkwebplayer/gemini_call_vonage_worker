import type { CallBridge } from "./bridge";

export interface Env {
  CALL_BRIDGE: DurableObjectNamespace<CallBridge>;
  callworker: D1Database;
  GEMINI_API_KEY: string;
  VONAGE_PRIVATE_KEY: string;
  VONAGE_APPLICATION_ID: string;
  VONAGE_NUMBER: string; // the Vonage number we place outbound calls from (E.164, no +)
  ADMIN_KEY: string; // Basic-auth password for the admin UI / trigger routes
  PUBLIC_HOST?: string;
}
