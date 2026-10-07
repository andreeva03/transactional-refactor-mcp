import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("project verification blocks a changed signature that breaks an unstaged caller", async t => {
  const root = await mkdtemp(join(tmpdir(), "verify-dependent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true }, include: ["*.ts"] }));
  await writeFile(join(root, "api.ts"), "export function greet(name: string) { return name; }\n");
  await writeFile(join(root, "caller.ts"), "import { greet } from './api'; export const result = greet('Ada');\n");
  const manager = new TransactionManager(root);
  const verifier = new VerificationPipeline(manager, root);
  const tx = manager.begin();
  await manager.stageEdit(tx, "api.ts", "export function greet(name: number) { return name; }\n");
  const result = await verifier.verifyTransaction(tx);
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.newErrors.some(error => error.file.endsWith("caller.ts") && error.code === 2345));
  assert.match(await readFile(join(root, "api.ts"), "utf8"), /name: string/);
  await manager.stageEdit(tx, "caller.ts", "import { greet } from './api'; export const result = greet(1);\n");
  assert.equal((await verifier.verifyTransaction(tx)).status, "VALID");
});

test("virtual modules resolve, deleted imports fail, and config changes are checked", async t => {
  const root = await mkdtemp(join(tmpdir(), "verify-modules-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true }, include: ["**/*.ts"] }));
  await writeFile(join(root, "caller.ts"), "export const result = 1;\n");
  const manager = new TransactionManager(root);
  const verifier = new VerificationPipeline(manager, root);
  const tx = manager.begin();
  await manager.stageCreate(tx, "nested/api.ts", "export const value: number = 2;\n");
  await manager.stageEdit(tx, "caller.ts", "import { value } from './nested/api'; export const result: number = value;\n");
  assert.equal((await verifier.verifyTransaction(tx)).status, "VALID");
  await manager.stageRename(tx, "nested/api.ts", "nested/moved.ts", 1);
  assert.ok((await verifier.verifyTransaction(tx)).newErrors.some(error => error.code === 2307));
  await manager.stageReplace(tx, "caller.ts", "./nested/api", "./nested/moved", 1);
  assert.equal((await verifier.verifyTransaction(tx)).status, "VALID");
  await manager.stageEdit(tx, "tsconfig.json", '{"compilerOptions":{"target":"invalid"}}');
  assert.equal((await verifier.verifyTransaction(tx)).status, "BLOCKED");
  await assert.rejects(readFile(join(root, "nested/moved.ts")), { code: "ENOENT" });
});

test("project references check consumers against changed source without emitting", async t => {
  const root = await mkdtemp(join(tmpdir(), "verify-references-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "lib")); await mkdir(join(root, "app"));
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ files: [], references: [{ path: "./lib" }, { path: "./app" }] }));
  await writeFile(join(root, "lib/tsconfig.json"), JSON.stringify({ compilerOptions: { composite: true, skipLibCheck: true }, files: ["index.ts"] }));
  await writeFile(join(root, "app/tsconfig.json"), JSON.stringify({ compilerOptions: { composite: true, skipLibCheck: true }, references: [{ path: "../lib" }], files: ["index.ts"] }));
  await writeFile(join(root, "lib/index.ts"), "export const value = 1;\n");
  await writeFile(join(root, "app/index.ts"), "import { value } from '../lib'; export const result: number = value;\n");
  const manager = new TransactionManager(root);
  const tx = manager.begin();
  await manager.stageEdit(tx, "lib/index.ts", "export const value = 'oops';\n");
  const result = await new VerificationPipeline(manager, root).verifyTransaction(tx);
  assert.ok(result.newErrors.some(error => error.file.endsWith("index.ts") && error.code === 2322), JSON.stringify(result));
  await assert.rejects(readFile(join(root, "lib/index.js")), { code: "ENOENT" });
});

test("new unimported files obey project compiler options and pre-existing errors remain allowed", async t => {
  const root = await mkdtemp(join(tmpdir(), "verify-includes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true }, include: ["**/*.ts"] }));
  await writeFile(join(root, "existing.ts"), "export const invalid: number = 'old error';\n");
  const manager = new TransactionManager(root);
  const verifier = new VerificationPipeline(manager, root);
  const tx = manager.begin();
  await manager.stageCreate(tx, "nested/new.ts", "export function f(value) { return value; }\n");
  const blocked = await verifier.verifyTransaction(tx);
  assert.ok(blocked.newErrors.some(error => error.code === 7006), JSON.stringify(blocked));
  assert.ok(!blocked.newErrors.some(error => error.file.endsWith("existing.ts")));
  await manager.stageEdit(tx, "nested/new.ts", "export function f(value: number) { return value; }\n", 1);
  assert.equal((await verifier.verifyTransaction(tx)).status, "VALID");
});
