// One-time ElevenLabs setup for the Huddlr voice agent, driven by .env.
//
//   npm run setup:elevenlabs -- --dry-run   show what would be created (secrets masked), send nothing
//   npm run setup:elevenlabs                create everything and write the new ids into .env
//   npm run setup:elevenlabs -- --update    agent already exists: push the latest prompt and opener only
//
// Creates: a workspace secret holding HUDDLR_SECRET, the six finance tools (sending it as x-huddlr-secret),
// the post-call webhook, the agent, and the Photon SIP trunk number assigned to the agent.
// Ids and the webhook's HMAC secret are written straight into .env, never printed.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TOOL_AUTH_HEADER } from "../../contracts/src/tools";
import { buildTools } from "./tools";
import { FIRST_MESSAGE, SYSTEM_PROMPT } from "./prompt";
import { env } from "./env";

const API = "https://api.elevenlabs.io";
const ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));
const PHOTON_SIP_HOST = "sip.spectrum.photon.codes";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const UPDATE = args.has("--update");

/** Placeholders so the agent works in the ElevenLabs test console, before any webhook fills them. */
export const DYNAMIC_PLACEHOLDERS: Record<string, string> = {
  opener: "Hey, it's the Huddlr Coach. What can I help you with?",
  first_name: "there",
  local_date: "unknown",
  pending_proposal: "none",
  recent_events: "none",
  goals: "none",
  call_reason: "the caller called in",
};

/** Sets KEY=value lines in a .env file's text, replacing existing ones (keeping any # comment) or appending. */
export function setEnvValues(text: string, values: Record<string, string>): string {
  let out = text;
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^${key}=[^#\\r\\n]*(\\s*#.*)?$`, "m");
    if (re.test(out)) out = out.replace(re, (_m, comment = "") => `${key}=${value}${comment ? `  ${comment.trim()}` : ""}`);
    else out = `${out.replace(/\s*$/, "")}\n${key}=${value}\n`;
  }
  return out;
}

export function agentBody(opts: { baseUrl: string; toolIds: string[]; secretId: string; webhookId: string | null }) {
  return {
    name: "Huddlr Coach",
    tags: ["huddlr"],
    conversation_config: {
      agent: {
        first_message: FIRST_MESSAGE,
        language: "en",
        dynamic_variables: { dynamic_variable_placeholders: DYNAMIC_PLACEHOLDERS },
        prompt: {
          prompt: SYSTEM_PROMPT,
          llm: process.env.ELEVENLABS_LLM || "gemini-2.0-flash",
          tool_ids: opts.toolIds,
        },
      },
      ...(process.env.ELEVENLABS_VOICE_ID ? { tts: { voice_id: process.env.ELEVENLABS_VOICE_ID } } : {}),
    },
    platform_settings: {
      overrides: { enable_conversation_initiation_client_data_from_webhook: true },
      workspace_overrides: {
        conversation_initiation_client_data_webhook: {
          url: `${opts.baseUrl}/voice/context`,
          request_headers: { [TOOL_AUTH_HEADER]: { secret_id: opts.secretId } },
        },
        ...(opts.webhookId ? { webhooks: { post_call_webhook_id: opts.webhookId, events: ["transcript"], transcript_format: "json" } } : {}),
      },
    },
  };
}

export function phoneBody(opts: { phoneNumber: string; agentId: string; sipUser: string; sipPassword: string }) {
  return {
    provider: "sip_trunk",
    phone_number: opts.phoneNumber,
    label: "Huddlr (Photon)",
    agent_id: opts.agentId,
    inbound_trunk_config: { media_encryption: "allowed" },
    outbound_trunk_config: {
      address: PHOTON_SIP_HOST,
      transport: "tls",
      media_encryption: "allowed",
      credentials: { username: opts.sipUser, password: opts.sipPassword },
    },
  };
}

const mask = (s: string) => (s ? `${s.slice(0, 2)}…(${s.length} chars)` : "(empty)");

function maskDeep(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return secrets.includes(value) && value ? mask(value) : value;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v, secrets)]));
  return value;
}

async function main() {
  const apiKey = env.elevenLabsApiKey;
  const base = env.publicBaseUrl;
  const phoneNumber = process.env.VOICE_PHONE_NUMBER || "";
  const sipUser = process.env.PHOTON_PROJECT_ID || "";
  const sipPassword = process.env.PHOTON_PROJECT_SECRET || "";
  const secrets = [apiKey, env.huddlrSecret, sipPassword];

  const missing = Object.entries({
    ELEVENLABS_API_KEY: apiKey,
    PUBLIC_BASE_URL: base && !base.includes("example") ? base : "",
    HUDDLR_SECRET: env.huddlrSecret,
    VOICE_PHONE_NUMBER: phoneNumber,
    PHOTON_PROJECT_ID: sipUser,
    PHOTON_PROJECT_SECRET: sipPassword,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length && !DRY) {
    console.error(`Fill these in .env first: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (missing.length) console.warn(`[dry-run] still missing in .env: ${missing.join(", ")}\n`);

  let fakeId = 0;
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (DRY) {
      console.log(`[dry-run] ${method} ${path}\n${JSON.stringify(maskDeep(body, secrets), null, 2)}\n`);
      const id = `dry_${++fakeId}`;
      return { secret_id: id, id, webhook_id: id, agent_id: id, phone_number_id: id } as T;
    }
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 800)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  // Update mode: push the latest prompt/opener/placeholders to the existing agent.
  if (UPDATE) {
    if (!env.elevenLabsAgentId) throw new Error("ELEVENLABS_AGENT_ID is empty; run without --update first");
    await call("PATCH", `/v1/convai/agents/${env.elevenLabsAgentId}`, {
      conversation_config: {
        agent: {
          first_message: FIRST_MESSAGE,
          dynamic_variables: { dynamic_variable_placeholders: DYNAMIC_PLACEHOLDERS },
          prompt: { prompt: SYSTEM_PROMPT },
        },
      },
    });
    console.log("Agent prompt and opener updated.");
    return;
  }
  if (env.elevenLabsAgentId && !DRY) {
    console.error("ELEVENLABS_AGENT_ID is already set. Use --update to change the prompt, or clear it to create a new agent.");
    process.exit(1);
  }

  console.log("1/5 Storing HUDDLR_SECRET as an ElevenLabs workspace secret");
  const secret = await call<{ secret_id: string }>("POST", "/v1/convai/secrets", { type: "new", name: `huddlr_secret_${Date.now()}`, value: env.huddlrSecret });

  console.log("2/5 Creating the six finance tools");
  const toolIds: string[] = [];
  for (const t of buildTools(base, "__secret__")) {
    const tool = {
      ...t,
      response_timeout_secs: 10,
      api_schema: { ...t.api_schema, request_headers: { [TOOL_AUTH_HEADER]: { secret_id: secret.secret_id } } },
    };
    const created = await call<{ id: string }>("POST", "/v1/convai/tools", { tool_config: tool });
    toolIds.push(created.id);
  }

  console.log("3/5 Creating the post-call webhook");
  const hook = await call<{ webhook_id: string; webhook_secret?: string | null }>("POST", "/v1/workspace/webhooks", {
    settings: { auth_type: "hmac", name: "huddlr-post-call", webhook_url: `${base}/voice/post-call` },
  });

  console.log("4/5 Creating the agent");
  const agent = await call<{ agent_id: string }>("POST", "/v1/convai/agents/create", agentBody({ baseUrl: base, toolIds, secretId: secret.secret_id, webhookId: hook.webhook_id }));

  console.log(`5/5 Importing ${phoneNumber || "(VOICE_PHONE_NUMBER)"} as a SIP trunk on ${PHOTON_SIP_HOST} (TLS)`);
  const phone = await call<{ phone_number_id: string }>("POST", "/v1/convai/phone-numbers", phoneBody({ phoneNumber, agentId: agent.agent_id, sipUser, sipPassword }));

  const updates: Record<string, string> = { ELEVENLABS_AGENT_ID: agent.agent_id, ELEVENLABS_PHONE_NUMBER_ID: phone.phone_number_id };
  if (hook.webhook_secret) updates.ELEVENLABS_WEBHOOK_SECRET = hook.webhook_secret;
  if (DRY) {
    console.log(`[dry-run] would write to .env: ${Object.keys(updates).join(", ")}`);
  } else {
    writeFileSync(ENV_PATH, setEnvValues(readFileSync(ENV_PATH, "utf8"), updates));
  }

  console.log(`
Done. Wrote ${Object.keys(updates).join(", ")} to .env.
${hook.webhook_secret ? "" : "ElevenLabs did not return the webhook's HMAC secret: copy it from Settings > Webhooks into ELEVENLABS_WEBHOOK_SECRET.\n"}
Next:
  1. Photon > Voice > Default profile > destination: ElevenLabs' inbound SIP address for ${phoneNumber}.
     It's shown on the number's page in ElevenLabs (Phone Numbers). Use the TLS (sips:) form.
  2. Deploy the voice service so ${base}/voice/context and /voice/post-call answer.
  3. Call ${phoneNumber} from the demo phone.`);
}

if (process.argv[1]?.endsWith("setupElevenLabs.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
