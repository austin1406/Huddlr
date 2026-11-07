// Places outbound calls through ElevenLabs on the Photon SIP number.
import type { Dialer } from "./outbound";
import { env } from "./env";

export const elevenLabsDialer: Dialer = {
  async call(toNumber, dynamicVariables) {
    if (!env.elevenLabsApiKey || !env.elevenLabsAgentId || !env.elevenLabsPhoneNumberId) {
      return { ok: false, error: "ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, or ELEVENLABS_PHONE_NUMBER_ID not set" };
    }
    try {
      const res = await fetch("https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call", {
        method: "POST",
        headers: { "xi-api-key": env.elevenLabsApiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: env.elevenLabsAgentId,
          agent_phone_number_id: env.elevenLabsPhoneNumberId,
          to_number: toNumber,
          conversation_initiation_client_data: { dynamic_variables: dynamicVariables },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string; conversation_id?: string };
      if (!res.ok || body.success === false || !body.conversation_id) {
        return { ok: false, error: `${res.status} ${body.message ?? "no conversation id"}` };
      }
      return { ok: true, conversationId: body.conversation_id };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
