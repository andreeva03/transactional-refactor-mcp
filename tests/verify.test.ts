import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-types";
import { TransactionManager } from "../src/vfs/transaction-manager.js";
import { calculateDelta } from "../src/verifier/delta-engine.js";
import { VerificationPipeline } from "../src/verifier/verification-pipeline.js";
function diagnostic(message: string, code: number, line = 0): Diagnostic {
  return { range: { start: { line, character: 0 }, end: { line, character: 1 } }, severity: DiagnosticSeverity.Error, code, message };
}
test("delta classifies errors, ignores warnings, and deduplicates", () => {
  const existing = diagnostic("existing", 1001);
  const resolved = diagnostic("resolved", 1002, 1);
  const introduced = diagnostic("new", 1003, 2);
  const warning = { ...diagnostic("warning", 1004), severity: DiagnosticSeverity.Warning };
  assert.deepEqual(calculateDelta([existing, resolved], [structuredClone(existing), introduced, introduced, warning]), {
    newErrors: [introduced], resolvedErrors: [resolved], unchanged: [existing]
  });
});
test("type mismatch blocks; in-memory fix passes without writing disk", { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "verify-tx-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "example.ts");
  const baseline = "export const count: number = 1;\n";
  await writeFile(file, baseline);
  const manager = new TransactionManager(root);
  const verifier = new VerificationPipeline(manager, root, { diagnosticTimeoutMs: 20_000 });
  const tx = manager.begin();
  await manager.stageEdit(tx, file, 'export const count: number = "wrong";\n');
  const blocked = await verifier.verifyTransaction(tx);
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.canCommit, false);
  assert.ok(blocked.newErrors.some(error => error.code === 2322 && error.line === 1));
  assert.equal(manager.getState(tx), "ACTIVE");
  assert.equal(await readFile(file, "utf8"), baseline);
  await manager.stageEdit(tx, file, "export const count: number = 2;\n");
  assert.deepEqual(await verifier.verifyTransaction(tx), { status: "VALID", newErrors: [], resolvedErrorsCount: 0, canCommit: true });
  assert.equal(manager.getState(tx), "VERIFIED");
  assert.equal(await readFile(file, "utf8"), baseline);
  await manager.stageEdit(tx, file, "export const count: number = 3;\n");
  assert.equal(manager.getState(tx), "ACTIVE");
});
test("a stale verification snapshot cannot approve later edits", async t => {
  const root = await mkdtemp(join(tmpdir(), "verify-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "example.ts"), "export const value = 1;\n");
  const manager = new TransactionManager(root);
  const tx = manager.begin();
  await manager.stageEdit(tx, "example.ts", "export const value = 2;\n");
  const snapshot = await manager.snapshotForVerification(tx);
  await manager.stageEdit(tx, "example.ts", "export const value = 3;\n");
  await assert.rejects(manager.completeVerification(snapshot, true), /changed during verification/);
  assert.equal(manager.getState(tx), "ACTIVE");
});
