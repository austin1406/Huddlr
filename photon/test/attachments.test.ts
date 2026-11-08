import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { migrate, type Db } from "../src/db.js";
import { saveInbound } from "../src/inbound.js";
import { getAttachment, storeInboundAttachments } from "../src/attachments.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

test("downloads once, then serves from the local copy", async () => {
  rmSync("data/attachments/pho_att_test1", { force: true });
  rmSync("data/attachments/pho_att_test1.mime", { force: true });
  let calls = 0;
  const download = async () => (calls++, new Blob([PNG]));
  const first = await getAttachment("pho_att_test1", download);
  const second = await getAttachment("pho_att_test1", download);
  assert.equal(calls, 1);
  assert.equal(first?.mime, "image/png");
  assert.deepEqual(second?.bytes, PNG);
});

test("rejects ids that aren't Photon attachment ids (no path tricks)", async () => {
  assert.equal(await getAttachment("../../.env", async () => new Blob([PNG])), null);
});

test("records local paths on the inbound row for P2", async () => {
  const db = new PGlite() as unknown as Db;
  await migrate(db);
  const id = await saveInbound(db, {
    id: "pho_msg_photo",
    status: "received",
    sentBy: { id: "h", kind: "human", handle: "+15550001111" },
    receivedBy: { id: "a", kind: "agent" },
    space: { id: "s" },
    content: { type: "attachment", attachmentId: "pho_att_test2" },
  });
  await storeInboundAttachments(db, id!, ["pho_att_test2"], async () => new Blob([PNG], { type: "image/png" }));
  const row = (await db.query(`SELECT attachment_ids, attachment_paths FROM inbound_messages WHERE id = $1`, [id])).rows[0];
  assert.deepEqual(row, { attachment_ids: ["pho_att_test2"], attachment_paths: ["data/attachments/pho_att_test2"] });
});
