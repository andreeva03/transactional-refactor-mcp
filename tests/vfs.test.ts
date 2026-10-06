import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CommitError, ConflictError, TransactionError, TransactionManager } from "../src/vfs/transaction-manager.js";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "shadow-vfs-"));
  const first = join(root, "first.ts");
  const second = join(root, "second.ts");
  await writeFile(first, "export const first = 1;\n");
  await writeFile(second, "export const second = 2;\n");
  return { root, first, second, manager: new TransactionManager(root), cleanup: () => rm(root, { recursive: true, force: true }) };
}
test("unstaged reads fall back to disk without caching", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const tx = f.manager.begin();
  assert.equal(await f.manager.readFile(tx, "first.ts"), "export const first = 1;\n");
  assert.equal(f.manager.getBuffer(tx, "first.ts"), undefined);
  await writeFile(f.first, "external edit");
  assert.equal(await f.manager.readFile(tx, "first.ts"), "external edit");
});
test("concurrent staging is ordered, isolated, and never writes disk", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const tx = f.manager.begin();
  const other = f.manager.begin();
  assert.deepEqual(await Promise.all([
    f.manager.stageEdit(tx, "first.ts", "first edit"),
    f.manager.stageEdit(tx, "first.ts", "")
  ]), [1, 2]);
  assert.deepEqual(f.manager.getBuffer(tx, "first.ts"), { baselineContent: "export const first = 1;\n", currentContent: "", version: 2 });
  assert.equal(await f.manager.readFile(tx, "first.ts"), "");
  assert.equal(await f.manager.readFile(other, "first.ts"), "export const first = 1;\n");
  assert.equal(await readFile(f.first, "utf8"), "export const first = 1;\n");
  assert.deepEqual((await readdir(f.root)).sort(), ["first.ts", "second.ts"]);
});
test("rollback clears buffers, preserves disk, and rejects terminal edits", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const tx = f.manager.begin();
  await f.manager.stageEdit(tx, "first.ts", "discard");
  await f.manager.rollback(tx);
  await f.manager.rollback(tx);
  assert.equal(f.manager.getState(tx), "ABORTED");
  assert.equal(f.manager.getBuffer(tx, "first.ts"), undefined);
  assert.equal(await readFile(f.first, "utf8"), "export const first = 1;\n");
  await assert.rejects(f.manager.commit(tx), TransactionError);
});
test("commit writes every staged buffer and removes temporary files", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const tx = f.manager.begin();
  await f.manager.stageEdit(tx, "first.ts", "updated first");
  await f.manager.stageEdit(tx, "second.ts", "updated second");
  assert.deepEqual(await f.manager.commit(tx), { state: "COMMITTED", filesWritten: 2, cleanupIssues: [] });
  assert.equal(await readFile(f.first, "utf8"), "updated first");
  assert.equal(await readFile(f.second, "utf8"), "updated second");
  assert.equal(f.manager.getBuffer(tx, "first.ts"), undefined);
  assert.deepEqual((await readdir(f.root)).sort(), ["first.ts", "second.ts"]);
});
test("baseline conflicts prevent any writes", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const tx = f.manager.begin();
  await f.manager.stageEdit(tx, "first.ts", "staged first");
  await f.manager.stageEdit(tx, "second.ts", "staged second");
  await writeFile(f.second, "external edit");
  await assert.rejects(f.manager.commit(tx), error => {
    assert.ok(error instanceof CommitError);
    assert.ok(error.cause instanceof ConflictError);
    return true;
  });
  assert.equal(await readFile(f.first, "utf8"), "export const first = 1;\n");
  assert.equal(await readFile(f.second, "utf8"), "external edit");
  assert.equal(f.manager.getState(tx), "ACTIVE");
});
test("a failed second replacement restores the first and permits retry", async t => {
  const f = await fixture(); t.after(f.cleanup);
  let calls = 0;
  const manager = new TransactionManager(f.root, async (from, to) => {
    if (++calls === 2) throw new Error("Injected rename failure");
    await rename(from, to);
  });
  const tx = manager.begin();
  await manager.stageEdit(tx, "first.ts", "new first");
  await manager.stageEdit(tx, "second.ts", "new second");
  await assert.rejects(manager.commit(tx), CommitError);
  assert.equal(await readFile(f.first, "utf8"), "export const first = 1;\n");
  assert.equal(manager.getState(tx), "ACTIVE");
  await manager.commit(tx);
  assert.equal(await readFile(f.second, "utf8"), "new second");
});
test("failed recovery preserves backup files and aborts", async t => {
  const f = await fixture(); t.after(f.cleanup);
  let calls = 0;
  const manager = new TransactionManager(f.root, async (from, to) => {
    if (++calls >= 2) throw new Error("Injected persistent failure");
    await rename(from, to);
  });
  const tx = manager.begin();
  await manager.stageEdit(tx, "first.ts", "new first");
  await manager.stageEdit(tx, "second.ts", "new second");
  let failure: CommitError | undefined;
  await assert.rejects(manager.commit(tx), error => {
    assert.ok(error instanceof CommitError); failure = error; return true;
  });
  assert.ok(failure);
  assert.equal(failure.recoveryErrors.length, 1);
  assert.equal(manager.getState(tx), "ABORTED");
  const backups = await Promise.all(failure.recoveryDirectories.map(directory => readFile(join(directory, "baseline"), "utf8")));
  assert.deepEqual(backups.sort(), ["export const first = 1;\n", "export const second = 2;\n"]);
});
test("missing baselines reject without poisoning the queue", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const tx = f.manager.begin();
  await assert.rejects(f.manager.stageEdit(tx, "missing.ts", "content"), { code: "ENOENT" });
  await f.manager.stageEdit(tx, "first.ts", "content");
  await f.manager.rollback(tx);
  await f.manager.forget(tx);
  assert.throws(() => f.manager.getState(tx), TransactionError);
});
