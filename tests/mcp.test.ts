import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { z } from "zod";
function payload(value: unknown): Record<string, unknown> { return z.record(z.unknown()).parse(value); }
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { acquireWorkspaceLock } from "../src/vfs/workspace-lock.js";
import { TransactionManager } from "../src/vfs/transaction-manager.js";
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

test("simultaneous MCP servers admit one owner and release on shutdown", { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "mcp-lock-"));
  const clients: Client[] = [];
  t.after(async () => { for (const client of clients) await client.close(); await rm(root, { recursive: true, force: true }); });
  function connection() {
    const client = new Client({ name: "lock-test", version: "0.2.0" });
    clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../src/index.js", import.meta.url)), "--workspace", root], stderr: "pipe" });
    const output = { stderr: "" };
    transport.stderr?.on("data", chunk => { output.stderr += String(chunk); });
    return { client, output, connect: () => client.connect(transport) };
  }
  const first = connection(), second = connection();
  const results = await Promise.allSettled([first.connect(), second.connect()]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const winner = results[0]!.status === "fulfilled" ? first : second;
  const loser = winner === first ? second : first;
  assert.match(loser.output.stderr, /already locked|lock acquisition or release is in progress/);
  const begun = await winner.client.callTool({ name: "tx_begin", arguments: {} });
  const txId = payload(begun.structuredContent)["txId"];
  const before = await readFile(join(root, ".transactional-refactor", `${txId}.json`), "utf8");
  const third = connection();
  await assert.rejects(third.connect());
  assert.match(third.output.stderr, /already locked/);
  assert.equal(await readFile(join(root, ".transactional-refactor", `${txId}.json`), "utf8"), before);
  await winner.client.close();
  const next = connection();
  await next.connect();
  assert.match(JSON.stringify((await next.client.callTool({ name: "tx_list", arguments: {} })).structuredContent), new RegExp(String(txId)));
});

test("workspace locks reclaim an exited owner and protect replacement ownership", async t => {
  const root = await mkdtemp(join(tmpdir(), "lock-crash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleUrl = new URL("../src/vfs/workspace-lock.js", import.meta.url).href;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", `import { acquireWorkspaceLock } from ${JSON.stringify(moduleUrl)}; await acquireWorkspaceLock(process.argv[1]); process.exit(73);`, root], { encoding: "utf8", timeout: 15_000 });
  assert.equal(crashed.status, 73, crashed.stderr);
  const contenders = await Promise.allSettled([acquireWorkspaceLock(root), acquireWorkspaceLock(root)]);
  const winners = contenders.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireWorkspaceLock>>> => result.status === "fulfilled");
  assert.equal(winners.length, 1);
  const lock = winners[0]!.value;
  await assert.rejects(acquireWorkspaceLock(root), /already locked/);
  await lock.release();
  const next = await acquireWorkspaceLock(root);
  await lock.release(); // Idempotent old release cannot delete the new lock.
  await assert.rejects(acquireWorkspaceLock(root), /already locked/);
  await next.release();
  const otherRoot = await mkdtemp(join(tmpdir(), "lock-independent-"));
  t.after(() => rm(otherRoot, { recursive: true, force: true }));
  const one = await acquireWorkspaceLock(root);
  const other = await acquireWorkspaceLock(otherRoot);
  await one.release(); await other.release();
});

test("ambiguous lock metadata and abandoned guards fail closed", async t => {
  const root = await mkdtemp(join(tmpdir(), "lock-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = await acquireWorkspaceLock(root);
  await lock.release();
  const ownerPath = join(root, ".transactional-refactor/workspace.lock");
  await writeFile(ownerPath, "invalid JSON");
  await assert.rejects(acquireWorkspaceLock(root), /Cannot establish workspace lock ownership/);
  assert.equal(await readFile(ownerPath, "utf8"), "invalid JSON");
  await rm(ownerPath);
  const guard = join(root, ".transactional-refactor/workspace.lock.guard");
  await mkdir(guard);
  await assert.rejects(acquireWorkspaceLock(root), /remove this guard directory/);
  await rmdir(guard);
  const recovered = await acquireWorkspaceLock(root);
  await recovered.release();
});

test("a damaged journal is reported while valid transactions remain available", async t => {
  const root = await mkdtemp(join(tmpdir(), "journal-damaged-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, ".transactional-refactor");
  await mkdir(directory);
  const brokenPath = join(directory, "00000000-0000-4000-8000-000000000000.json");
  await writeFile(brokenPath, "broken journal");
  const client = new Client({ name: "damaged-journal-test", version: "0.2.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../src/index.js", import.meta.url)), "--workspace", root], stderr: "pipe" });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  const listed = payload((await client.callTool({ name: "tx_list", arguments: {} })).structuredContent);
  assert.equal((listed["transactions"] as unknown[]).length, 0);
  assert.equal((listed["journalIssues"] as Array<Record<string, unknown>>)[0]?.["txId"], "00000000-0000-4000-8000-000000000000");
  assert.equal(await readFile(brokenPath, "utf8"), "broken journal");
  const begun = await client.callTool({ name: "tx_begin", arguments: {} });
  assert.equal(typeof payload(begun.structuredContent)["txId"], "string");
});

test("legacy journals are upgraded to checksummed versioned records", async t => {
  const root = await mkdtemp(join(tmpdir(), "journal-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "example.ts"), "export const value = 1;\n");
  const directory = join(root, ".transactional-refactor");
  await mkdir(directory);
  const txId = "00000000-0000-4000-8000-000000000001";
  await writeFile(join(directory, `${txId}.json`), JSON.stringify({ state: "VERIFIED", files: [{ filePath: join(root, "example.ts"), buffer: { baselineContent: "export const value = 1;\n", currentContent: "export const value = 2;\n", version: 1 } }] }));
  const manager = new TransactionManager(root, undefined, directory);
  assert.equal(manager.getState(txId), "ACTIVE");
  const envelope = JSON.parse(await readFile(join(directory, `${txId}.json`), "utf8"));
  assert.equal(envelope.formatVersion, 1);
  assert.equal(typeof envelope.checksum, "string");
  assert.equal(JSON.parse(envelope.payload).version, 1);
});

test("a journal checksum failure preserves its record and reports a recovery issue", async t => {
  const root = await mkdtemp(join(tmpdir(), "journal-checksum-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, ".transactional-refactor");
  await mkdir(directory);
  const txId = "00000000-0000-4000-8000-000000000002";
  await writeFile(join(directory, `${txId}.json`), JSON.stringify({ formatVersion: 1, checksum: "0".repeat(64), payload: JSON.stringify({ version: 1, state: "ACTIVE", files: [] }) }));
  const manager = new TransactionManager(root, undefined, directory);
  assert.equal(manager.list().length, 0);
  assert.match(manager.journalIssues()[0]!.message, /checksum/);
  assert.equal((await readFile(join(directory, `${txId}.json`), "utf8")).includes("checksum"), true);
  assert.ok(manager.begin());
});

test("startup cleanup removes only stale owned temporaries and orphan commit directories", async t => {
  const f = await mkdtemp(join(tmpdir(), "journal-cleanup-")); t.after(() => rm(f, { recursive: true, force: true }));
  const directory = join(f, ".transactional-refactor"); await mkdir(directory);
  const staleTemp = join(directory, `00000000-0000-4000-8000-000000000003.json.00000000-0000-4000-8000-000000000004.tmp`);
  await writeFile(staleTemp, "incomplete journal write");
  const staleLockTemp = join(directory, "workspace.lock.00000000-0000-4000-8000-000000000005.tmp");
  await writeFile(staleLockTemp, "incomplete lock write");
  const orphan = join(f, ".shadow-vfs-00000000-0000-4000-8000-000000000006-abcd"); await mkdir(orphan);
  const manager = new TransactionManager(f, undefined, directory);
  assert.equal(manager.journalIssues().length, 0);
  await assert.rejects(readFile(staleTemp), { code: "ENOENT" });
  await assert.rejects(readFile(staleLockTemp), { code: "ENOENT" });
  assert.equal(existsSync(orphan), false);
});
