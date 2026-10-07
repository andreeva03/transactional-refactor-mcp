import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
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

test("exact replacements reject stale and ambiguous edits and preserve literal replacement text", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const tx = f.manager.begin();
  assert.equal(await f.manager.stageReplace(tx, "first.ts", "1", "2", 0), 1);
  await assert.rejects(f.manager.stageReplace(tx, "first.ts", "2", "3", 0), /Version conflict/);
  await f.manager.stageEdit(tx, "first.ts", "same same", 1);
  await assert.rejects(f.manager.stageReplace(tx, "first.ts", "same", "x", 2), /exactly once/);
  await assert.rejects(f.manager.stageReplace(tx, "first.ts", "missing", "x", 2), /exactly once/);
  await f.manager.stageReplace(tx, "first.ts", "same same", "$&", 2);
  assert.equal(await f.manager.readFile(tx, "first.ts"), "$&");
  assert.equal(await readFile(f.first, "utf8"), "export const first = 1;\n");
});

test("create, rename and delete are virtual until commit", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const tx = f.manager.begin();
  await f.manager.stageCreate(tx, "nested/created.ts", "export const created = 3;\n");
  await f.manager.stageRename(tx, "first.ts", "nested/moved.ts", 0);
  await f.manager.stageDelete(tx, "second.ts", 0);
  await assert.rejects(readFile(join(f.root, "nested/created.ts")), { code: "ENOENT" });
  assert.equal(await readFile(f.first, "utf8"), "export const first = 1;\n");
  await assert.rejects(f.manager.readFile(tx, "first.ts"), /deletion/);
  assert.equal(await f.manager.readFile(tx, "nested/moved.ts"), "export const first = 1;\n");
  await f.manager.commit(tx);
  assert.equal(await readFile(join(f.root, "nested/created.ts"), "utf8"), "export const created = 3;\n");
  assert.equal(await readFile(join(f.root, "nested/moved.ts"), "utf8"), "export const first = 1;\n");
  await assert.rejects(readFile(f.first), { code: "ENOENT" });
  await assert.rejects(readFile(f.second), { code: "ENOENT" });
});

test("creation collisions and invalid rename leave staging unchanged", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const tx = f.manager.begin();
  await assert.rejects(f.manager.stageCreate(tx, "first.ts", "x"), /exists/);
  await assert.rejects(f.manager.stageRename(tx, "first.ts", "second.ts", 0), /exists/);
  await assert.rejects(f.manager.stageCreate(tx, "../escape.ts", "x"), /workspace/);
  await assert.rejects(f.manager.stageCreate(tx, ".transactional-refactor/bad.ts", "x"), /workspace/);
  assert.equal(f.manager.status(tx).files.length, 0);
  await f.manager.stageCreate(tx, "created.ts", "staged");
  await writeFile(join(f.root, "created.ts"), "external");
  await assert.rejects(f.manager.commit(tx), CommitError);
  assert.equal(await readFile(join(f.root, "created.ts"), "utf8"), "external");
});

test("persistent staging resumes after restart and requires fresh verification", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const journal = join(f.root, ".transactional-refactor");
  const first = new TransactionManager(f.root, undefined, journal);
  const tx = first.begin();
  await first.stageEdit(tx, "first.ts", "staged");
  await first.stageCreate(tx, "new.ts", "new");
  await first.completeVerification(await first.snapshotForVerification(tx), true);
  const restarted = new TransactionManager(f.root, undefined, journal);
  assert.equal(restarted.getState(tx), "ACTIVE");
  assert.equal(await restarted.readFile(tx, "first.ts"), "staged");
  assert.equal(await restarted.readFile(tx, "new.ts"), "new");
  await restarted.rollback(tx);
  await restarted.forget(tx);
  assert.deepEqual(new TransactionManager(f.root, undefined, journal).list(), []);
});

test("a process crash mid-commit is recoverable without overwriting external edits", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const moduleUrl = new URL("../src/vfs/transaction-manager.js", import.meta.url).href;
  const script = `
    import { TransactionManager } from ${JSON.stringify(moduleUrl)};
    import { rename } from 'node:fs/promises';
    import { join } from 'node:path';
    const root = process.argv[1];
    const manager = new TransactionManager(root, async (from, to) => {
      await rename(from, to);
      process.exit(73);
    }, join(root, '.transactional-refactor'));
    const tx = manager.begin();
    await manager.stageEdit(tx, 'first.ts', 'changed');
    await manager.stageDelete(tx, 'second.ts', 0);
    await manager.commit(tx);
  `;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", script, f.root], { encoding: "utf8", timeout: 15_000 });
  assert.equal(crashed.status, 73, crashed.stderr);
  const restarted = new TransactionManager(f.root, undefined, join(f.root, ".transactional-refactor"));
  const tx = restarted.list()[0]!.txId;
  assert.equal(restarted.getState(tx), "RECOVERY_REQUIRED");
  await assert.rejects(restarted.rollback(tx), /RECOVERY_REQUIRED/);
  await writeFile(f.first, "external");
  await assert.rejects(restarted.recover(tx), ConflictError);
  assert.equal(await readFile(f.first, "utf8"), "external");
  await writeFile(f.first, "changed");
  await restarted.recover(tx);
  assert.equal(await readFile(f.first, "utf8"), "export const first = 1;\n");
  assert.equal(await readFile(f.second, "utf8"), "export const second = 2;\n");
  assert.equal(restarted.getState(tx), "ACTIVE");
  await restarted.commit(tx);
  assert.equal(await readFile(f.first, "utf8"), "changed");
  await assert.rejects(readFile(f.second), { code: "ENOENT" });
});

test("failed installation restores deletions and removes installed creations", async t => {
  const f = await fixture(); t.after(f.cleanup);
  let calls = 0;
  const manager = new TransactionManager(f.root, async (from, to) => {
    if (++calls === 2) throw new Error("Injected failure after create and delete");
    await rename(from, to);
  });
  const tx = manager.begin();
  await manager.stageCreate(tx, "new.ts", "created");
  await manager.stageDelete(tx, "first.ts", 0);
  await manager.stageEdit(tx, "second.ts", "changed");
  await assert.rejects(manager.commit(tx), CommitError);
  await assert.rejects(readFile(join(f.root, "new.ts")), { code: "ENOENT" });
  assert.equal(await readFile(f.first, "utf8"), "export const first = 1;\n");
  assert.equal(await readFile(f.second, "utf8"), "export const second = 2;\n");
  assert.equal(manager.getState(tx), "ACTIVE");
});

test("interrupted create and delete recover after restart", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const journal = join(f.root, ".transactional-refactor");
  let calls = 0;
  const manager = new TransactionManager(f.root, async (from, to) => {
    if (++calls >= 2) throw new Error("Injected installation and restoration failure");
    await rename(from, to);
  }, journal);
  const tx = manager.begin();
  await manager.stageDelete(tx, "first.ts", 0);
  await manager.stageCreate(tx, "new.ts", "new");
  await manager.stageEdit(tx, "second.ts", "changed");
  await assert.rejects(manager.commit(tx), CommitError);
  assert.equal(manager.getState(tx), "RECOVERY_REQUIRED");
  const restarted = new TransactionManager(f.root, undefined, journal);
  await restarted.recover(tx);
  assert.equal(await readFile(f.first, "utf8"), "export const first = 1;\n");
  assert.equal(await readFile(f.second, "utf8"), "export const second = 2;\n");
  await assert.rejects(readFile(join(f.root, "new.ts")), { code: "ENOENT" });
});
