/** Print a private Huddle link: npm run link -- [+15551234567] [hours] (defaults: DEMO_USER_PHONE, 168 hours). */
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { signLink } from "./huddle.js";

config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });
const phone = process.argv[2] || process.env.DEMO_USER_PHONE || "";
const hours = Number(process.argv[3] || 168);
const secret = process.env.HUDDLR_SECRET || "";
if (!phone || !secret) {
  console.error("Need a phone (argument or DEMO_USER_PHONE) and HUDDLR_SECRET in /opt/huddlr/.env");
  process.exit(1);
}
const base = (process.env.PUBLIC_BASE_URL || "http://localhost:3001").replace(/\/$/, "");
console.log(`${base}/me/${signLink(secret, phone, hours * 3600)}`);
