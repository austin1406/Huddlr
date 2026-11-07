// Prints the ElevenLabs agent config (prompt, first message, tools, webhook URLs) to paste or import.
// The output contains the shared secret: don't commit it or paste it in chat.
import { env } from "./env";
import { FIRST_MESSAGE, SYSTEM_PROMPT } from "./prompt";
import { buildTools } from "./tools";

const base = env.publicBaseUrl || "https://your-fixed-domain.example";
console.log(
  JSON.stringify(
    {
      first_message: FIRST_MESSAGE,
      system_prompt: SYSTEM_PROMPT,
      tools: buildTools(base, env.huddlrSecret || "<HUDDLR_SECRET>"),
      webhooks: {
        conversation_initiation: `${base}/voice/context`,
        post_call: `${base}/voice/post-call`,
      },
    },
    null,
    2,
  ),
);
