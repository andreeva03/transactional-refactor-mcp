import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { Diagnostic } from "vscode-languageserver-types";
import { TransactionManager } from "../vfs/transaction-manager.js";
import { LspSupervisor } from "../lsp/lsp-supervisor.js";
import { calculateDelta } from "./delta-engine.js";

export interface VerificationResult {
  status: "VALID" | "BLOCKED";
  newErrors: Array<{ file: string; line: number; message: string; code: string | number }>;
  resolvedErrorsCount: number;
  canCommit: boolean;
}
export interface VerificationPipelineOptions {
  diagnosticTimeoutMs?: number;
  supervisor?: LspSupervisor;
}
function languageId(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".ts": case ".mts": case ".cts": return "typescript";
    case ".tsx": return "typescriptreact";
    case ".js": case ".mjs": case ".cjs": return "javascript";
    case ".jsx": return "javascriptreact";
    default: throw new Error(`Unsupported verification file: ${path}`);
  }
}

/** Verifies staged files against complete baseline and staged workspace views. */
export class VerificationPipeline {
  private operations: Promise<void> = Promise.resolve();
  private readonly supervisor: LspSupervisor;
  private readonly timeout: number;
  constructor(private readonly transactions: TransactionManager, workspaceRoot: string, options: VerificationPipelineOptions = {}) {
    this.supervisor = options.supervisor ?? new LspSupervisor({ workspaceRoot, diagnosticsMode: "process-isolated" });
    this.timeout = options.diagnosticTimeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeout) || this.timeout <= 0 || this.timeout > 2_147_483_647) throw new RangeError("Invalid diagnostic timeout.");
  }
  verifyTransaction(txId: string): Promise<VerificationResult> {
    const pending = this.operations.then(() => this.verify(txId));
    this.operations = pending.then(() => undefined, () => undefined);
    return pending;
  }
  private async verify(txId: string): Promise<VerificationResult> {
    const snapshot = await this.transactions.snapshotForVerification(txId);
    const result: VerificationResult = { status: "VALID", newErrors: [], resolvedErrorsCount: 0, canCommit: true };
    if (!snapshot.files.length) {
      await this.transactions.completeVerification(snapshot, true);
      return result;
    }
    const documents = snapshot.files.map(file => ({ ...file, uri: pathToFileURL(file.filePath).href, languageId: languageId(file.filePath) }));
    const supervisor = this.supervisor;
    try {
      await supervisor.start();
      for (const document of documents) await supervisor.openVirtualDocument(document.uri, document.languageId, 1, document.buffer.baselineContent);
      const baseline = new Map<string, Diagnostic[]>();
      for (const document of documents) baseline.set(document.filePath, await this.collect(document.uri, 1));
      for (const document of documents) await supervisor.updateVirtualDocument(document.uri, 2, document.buffer.currentContent);
      for (const document of documents) {
        const before = baseline.get(document.filePath);
        if (!before) throw new Error("Missing baseline diagnostics.");
        const delta = calculateDelta(before, await this.collect(document.uri, 2));
        result.resolvedErrorsCount += delta.resolvedErrors.length;
        for (const diagnostic of delta.newErrors) result.newErrors.push({
          file: document.filePath, line: diagnostic.range.start.line + 1,
          message: diagnostic.message, code: diagnostic.code ?? ""
        });
      }
      result.canCommit = result.newErrors.length === 0;
      result.status = result.canCommit ? "VALID" : "BLOCKED";
    } catch (error) {
      try { await supervisor.shutdown(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Verification and cleanup failed."); }
      throw error;
    }
    await supervisor.shutdown();
    await this.transactions.completeVerification(snapshot, result.canCommit);
    return result;
  }
  private async collect(uri: string, version: number): Promise<Diagnostic[]> {
    await this.supervisor.waitForDiagnostics(uri, version, this.timeout);
    return this.supervisor.collectCompleteDiagnostics(uri, version, this.timeout);
  }
}
