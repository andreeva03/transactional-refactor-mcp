import assert from "node:assert/strict";
import { z } from "zod";
function payload(value: unknown): Record<string, unknown> { return z.record(z.unknown()).parse(value); }
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
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["tx_begin", "tx_commit", "tx_diff", "tx_list", "tx_recover", "tx_rollback", "tx_stage_create", "tx_stage_delete", "tx_stage_edit", "tx_stage_rename", "tx_stage_replace", "tx_status", "tx_verify"]);
  for (const tool of listed.tools) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal((await client.callTool({ name: "tx_begin", arguments: { unexpected: true } })).isError, true);
  const begun = await client.callTool({ name: "tx_begin", arguments: {} });
  const txId = payload(begun.structuredContent)["txId"];
  assert.equal(typeof txId, "string");
  const staged = await client.callTool({ name: "tx_stage_edit", arguments: { txId, filePath: "example.ts", newContent: 'export const count: number = "wrong";\n' } });
  assert.notEqual(staged.isError, true, stderr);
  assert.equal(payload(staged.structuredContent)["version"], 1);
  const status = await client.callTool({ name: "tx_status", arguments: { txId } });
  assert.equal(payload(status.structuredContent)["state"], "ACTIVE");
  const diff = await client.callTool({ name: "tx_diff", arguments: { txId } });
  assert.match(JSON.stringify(diff.structuredContent), /wrong/);
  assert.equal((await client.callTool({ name: "tx_stage_replace", arguments: { txId, filePath: "example.ts", oldText: "wrong", newText: "bad", expectedVersion: 0 } })).isError, true);
  assert.equal(await readFile(file, "utf8"), baseline);
  const blocked = await client.callTool({ name: "tx_commit", arguments: { txId } }, undefined, { timeout: 90_000 });
  assert.equal(blocked.isError, true, stderr);
  assert.equal(payload(blocked.structuredContent)["status"], "BLOCKED", stderr);
  assert.equal(await readFile(file, "utf8"), baseline);
  const fixed = "export const count: number = 2;\n";
  await client.callTool({ name: "tx_stage_edit", arguments: { txId, filePath: "example.ts", newContent: fixed } });
  const committed = await client.callTool({ name: "tx_commit", arguments: { txId } }, undefined, { timeout: 90_000 });
  assert.notEqual(committed.isError, true, stderr);
  assert.equal(payload(committed.structuredContent)["state"], "COMMITTED");
  assert.equal(await readFile(file, "utf8"), fixed);
  const next = await client.callTool({ name: "tx_begin", arguments: {} });
  const otherId = payload(next.structuredContent)["txId"];
  await client.callTool({ name: "tx_stage_edit", arguments: { txId: otherId, filePath: "example.ts", newContent: "" } });
  const rollback = await client.callTool({ name: "tx_rollback", arguments: { txId: otherId } });
  assert.equal(payload(rollback.structuredContent)["state"], "ABORTED");
  assert.equal(await readFile(file, "utf8"), fixed);
  const operations = await client.callTool({ name: "tx_begin", arguments: {} });
  const operationsId = payload(operations.structuredContent)["txId"];
  assert.notEqual((await client.callTool({ name: "tx_stage_create", arguments: { txId: operationsId, filePath: "nested/new.ts", newContent: "export const value = 1;\n" } })).isError, true);
  assert.notEqual((await client.callTool({ name: "tx_stage_replace", arguments: { txId: operationsId, filePath: "nested/new.ts", oldText: "= 1", newText: "= 2", expectedVersion: 1 } })).isError, true);
  assert.notEqual((await client.callTool({ name: "tx_stage_rename", arguments: { txId: operationsId, filePath: "nested/new.ts", destination: "nested/moved.ts", expectedVersion: 2 } })).isError, true);
  assert.notEqual((await client.callTool({ name: "tx_stage_delete", arguments: { txId: operationsId, filePath: "example.ts", expectedVersion: 0 } })).isError, true);
  assert.notEqual((await client.callTool({ name: "tx_commit", arguments: { txId: operationsId } })).isError, true);
  assert.equal(await readFile(join(root, "nested/moved.ts"), "utf8"), "export const value = 2;\n");
  await assert.rejects(readFile(file), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "nested/new.ts")), { code: "ENOENT" });
});

test("MCP restart exposes persisted work and preserves source files", { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "mcp-restart-"));
  await writeFile(join(root, "example.ts"), "export const value = 1;\n");
  const clients: Client[] = [];
  t.after(async () => { for (const client of clients) await client.close(); await rm(root, { recursive: true, force: true }); });
  async function connect() {
    const client = new Client({ name: "restart-test", version: "0.2.0" });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../src/index.js", import.meta.url)), "--workspace", root], stderr: "pipe" }));
    return client;
  }
  const first = await connect();
  const txId = payload((await first.callTool({ name: "tx_begin", arguments: {} })).structuredContent)["txId"];
  await first.callTool({ name: "tx_stage_edit", arguments: { txId, filePath: "example.ts", newContent: "export const value = 2;\n" } });
  assert.notEqual((await first.callTool({ name: "tx_verify", arguments: { txId } })).isError, true);
  await first.close();
  const restarted = await connect();
  assert.match(JSON.stringify((await restarted.callTool({ name: "tx_list", arguments: {} })).structuredContent), new RegExp(String(txId)));
  assert.equal(payload((await restarted.callTool({ name: "tx_status", arguments: { txId } })).structuredContent)["state"], "ACTIVE");
  assert.equal(await readFile(join(root, "example.ts"), "utf8"), "export const value = 1;\n");
  assert.notEqual((await restarted.callTool({ name: "tx_commit", arguments: { txId } })).isError, true);
  assert.equal(await readFile(join(root, "example.ts"), "utf8"), "export const value = 2;\n");
});
