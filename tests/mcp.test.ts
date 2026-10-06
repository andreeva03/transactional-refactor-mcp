import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("MCP strict tools, verified commit, and rollback", { timeout: 240_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "mcp-test-"));
  const file = join(root, "example.ts");
  const baseline = "export const count: number = 1;\n";
  await writeFile(file, baseline);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/index.js", import.meta.url)), "--workspace", root],
    stderr: "pipe"
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8192); });
  const client = new Client({ name: "integration-test", version: "0.1.0" });
  t.after(async () => { try { await client.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["tx_begin", "tx_commit", "tx_rollback", "tx_stage_edit", "tx_verify"]);
  for (const tool of listed.tools) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal((await client.callTool({ name: "tx_begin", arguments: { unexpected: true } })).isError, true);
  const begun = await client.callTool({ name: "tx_begin", arguments: {} });
  const txId = begun.structuredContent?.["txId"];
  assert.equal(typeof txId, "string");
  const staged = await client.callTool({ name: "tx_stage_edit", arguments: { txId, filePath: "example.ts", newContent: 'export const count: number = "wrong";\n' } });
  assert.notEqual(staged.isError, true, stderr);
  assert.equal(staged.structuredContent?.["version"], 1);
  assert.equal(await readFile(file, "utf8"), baseline);
  const blocked = await client.callTool({ name: "tx_commit", arguments: { txId } }, undefined, { timeout: 90_000 });
  assert.equal(blocked.isError, true, stderr);
  assert.equal(blocked.structuredContent?.["status"], "BLOCKED", stderr);
  assert.equal(await readFile(file, "utf8"), baseline);
  const fixed = "export const count: number = 2;\n";
  await client.callTool({ name: "tx_stage_edit", arguments: { txId, filePath: "example.ts", newContent: fixed } });
  const committed = await client.callTool({ name: "tx_commit", arguments: { txId } }, undefined, { timeout: 90_000 });
  assert.notEqual(committed.isError, true, stderr);
  assert.equal(committed.structuredContent?.["state"], "COMMITTED");
  assert.equal(await readFile(file, "utf8"), fixed);
  const next = await client.callTool({ name: "tx_begin", arguments: {} });
  const otherId = next.structuredContent?.["txId"];
  await client.callTool({ name: "tx_stage_edit", arguments: { txId: otherId, filePath: "example.ts", newContent: "" } });
  const rollback = await client.callTool({ name: "tx_rollback", arguments: { txId: otherId } });
  assert.equal(rollback.structuredContent?.["state"], "ABORTED");
  assert.equal(await readFile(file, "utf8"), fixed);
});
