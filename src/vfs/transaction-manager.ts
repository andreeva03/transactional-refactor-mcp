import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

export type TransactionState = "ACTIVE" | "VERIFIED" | "COMMITTED" | "ABORTED";
export interface FileBuffer {
  readonly baselineContent: string;
  readonly currentContent: string;
  readonly version: number;
}
interface Transaction {
  state: TransactionState;
  buffers: Map<string, FileBuffer>;
}
export interface VerificationSnapshot {
  readonly txId: string;
  readonly files: ReadonlyArray<{ readonly filePath: string; readonly buffer: FileBuffer }>;
}
export interface CleanupIssue { readonly directory: string; readonly cause: unknown }
export interface CommitResult {
  readonly state: "COMMITTED";
  readonly filesWritten: number;
  readonly cleanupIssues: readonly CleanupIssue[];
}
interface PreparedFile {
  target: string;
  replacement: string;
  backup: string;
  buffer: FileBuffer;
}
export class TransactionError extends Error {
  constructor(message: string, readonly txId: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransactionError";
  }
}
export class ConflictError extends TransactionError {
  constructor(txId: string, readonly filePath: string) {
    super(`File changed on disk: ${filePath}`, txId);
    this.name = "ConflictError";
  }
}
export class CommitError extends TransactionError {
  constructor(
    txId: string, cause: unknown,
    readonly recoveryErrors: readonly unknown[],
    readonly recoveryDirectories: readonly string[],
    readonly cleanupIssues: readonly CleanupIssue[]
  ) {
    super(recoveryErrors.length
      ? "Commit and recovery failed; retained backups require recovery."
      : "Commit failed; installed changes were restored.", txId, { cause });
    this.name = "CommitError";
  }
}

/**
 * Existing UTF-8 regular files in a trusted workspace.
 * Operations within one manager are serialized. Staging never writes disk.
 * Commit provides per-file rename and compensating rollback, NOT a
 * crash-atomic multi-file transaction. Cooperating writers are required.
 */
export class TransactionManager {
  private readonly transactions = new Map<string, Transaction>();
  private queue: Promise<void> = Promise.resolve();
  private readonly baseDirectory: string;

  constructor(baseDirectory = process.cwd(), private readonly replaceFile: typeof rename = rename) {
    this.baseDirectory = resolve(baseDirectory);
  }
  begin(): string {
    const txId = randomUUID();
    this.transactions.set(txId, { state: "ACTIVE", buffers: new Map() });
    return txId;
  }
  getState(txId: string): TransactionState { return this.requireTransaction(txId).state; }
  getBuffer(txId: string, filePath: string): FileBuffer | undefined {
    const buffer = this.requireTransaction(txId).buffers.get(this.resolvePath(filePath));
    return buffer === undefined ? undefined : { ...buffer };
  }
  stageEdit(txId: string, filePath: string, newContent: string): Promise<number> {
    return this.serialized(async () => {
      const tx = this.requireOpen(txId);
      const target = this.resolvePath(filePath);
      const previous = tx.buffers.get(target);
      const baselineContent = previous?.baselineContent ?? await this.readText(target);
      const version = (previous?.version ?? 0) + 1;
      tx.buffers.set(target, { baselineContent, currentContent: newContent, version });
      tx.state = "ACTIVE";
      return version;
    });
  }
  readFile(txId: string, filePath: string): Promise<string> {
    return this.serialized(async () => {
      const tx = this.requireOpen(txId);
      const target = this.resolvePath(filePath);
      return tx.buffers.get(target)?.currentContent ?? this.readText(target);
    });
  }
  rollback(txId: string): Promise<void> {
    return this.serialized(async () => {
      const tx = this.requireTransaction(txId);
      if (tx.state === "ABORTED") return;
      this.requireOpen(txId);
      tx.buffers.clear();
      tx.state = "ABORTED";
    });
  }
  snapshotForVerification(txId: string): Promise<VerificationSnapshot> {
    return this.serialized(async () => {
      const tx = this.requireOpen(txId);
      tx.state = "ACTIVE";
      const files = [...tx.buffers].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([filePath, buffer]) => ({ filePath, buffer: { ...buffer } }));
      for (const file of files) await this.assertBaseline(txId, file.filePath, file.buffer);
      return { txId, files };
    });
  }
  completeVerification(snapshot: VerificationSnapshot, valid: boolean): Promise<void> {
    return this.serialized(async () => {
      const tx = this.requireOpen(snapshot.txId);
      tx.state = "ACTIVE";
      if (tx.buffers.size !== snapshot.files.length || snapshot.files.some(({ filePath, buffer }) => {
        const current = tx.buffers.get(filePath);
        return !current || current.version !== buffer.version ||
          current.baselineContent !== buffer.baselineContent ||
          current.currentContent !== buffer.currentContent;
      })) throw new TransactionError("Transaction changed during verification; verify again.", snapshot.txId);
      for (const file of snapshot.files) await this.assertBaseline(snapshot.txId, file.filePath, file.buffer);
      tx.state = valid ? "VERIFIED" : "ACTIVE";
    });
  }

  /** Raw VFS operation. MCP callers use the verification gate in src/index.ts. */
  commit(txId: string): Promise<CommitResult> {
    return this.serialized(async () => {
      const tx = this.requireOpen(txId);
      const directories: string[] = [];
      const prepared: PreparedFile[] = [];
      const installed: PreparedFile[] = [];
      try {
        for (const [target, buffer] of tx.buffers) await this.assertBaseline(txId, target, buffer);
        for (const [target, buffer] of tx.buffers) {
          const metadata = await lstat(target);
          this.assertRegular(target, metadata);
          const directory = await mkdtemp(join(dirname(target), `.shadow-vfs-${txId}-`));
          directories.push(directory);
          const file = { target, buffer, replacement: join(directory, "replacement"), backup: join(directory, "baseline") };
          await this.writePrepared(file.backup, buffer.baselineContent, metadata.mode & 0o777);
          await this.writePrepared(file.replacement, buffer.currentContent, metadata.mode & 0o777);
          prepared.push(file);
        }
        for (const file of prepared) await this.assertBaseline(txId, file.target, file.buffer);
        for (const file of prepared) {
          await this.assertBaseline(txId, file.target, file.buffer);
          await this.replaceFile(file.replacement, file.target);
          installed.push(file);
        }
      } catch (cause) {
        const recoveryErrors: unknown[] = [];
        for (const file of [...installed].reverse()) {
          try {
            if (await this.readText(file.target) !== file.buffer.currentContent) {
              throw new Error(`Cannot restore externally modified file: ${file.target}`);
            }
            await this.replaceFile(file.backup, file.target);
          } catch (error) {
            recoveryErrors.push(new Error(`Failed to restore ${file.target}`, { cause: error }));
          }
        }
        if (recoveryErrors.length) {
          tx.buffers.clear();
          tx.state = "ABORTED";
          throw new CommitError(txId, cause, recoveryErrors, directories, []);
        }
        tx.state = "ACTIVE";
        throw new CommitError(txId, cause, [], [], await this.cleanup(directories));
      }
      tx.buffers.clear();
      tx.state = "COMMITTED";
      return { state: "COMMITTED", filesWritten: installed.length, cleanupIssues: await this.cleanup(directories) };
    });
  }
  forget(txId: string): Promise<void> {
    return this.serialized(async () => {
      const tx = this.requireTransaction(txId);
      if (tx.state !== "COMMITTED" && tx.state !== "ABORTED") throw new TransactionError("Cannot forget an open transaction.", txId);
      this.transactions.delete(txId);
    });
  }
  private resolvePath(path: string): string {
    if (!path || path.includes("\0")) throw new TypeError("Invalid file path.");
    return resolve(this.baseDirectory, path);
  }
  private requireTransaction(txId: string): Transaction {
    const tx = this.transactions.get(txId);
    if (!tx) throw new TransactionError(`Unknown transaction: ${txId}`, txId);
    return tx;
  }
  private requireOpen(txId: string): Transaction {
    const tx = this.requireTransaction(txId);
    if (tx.state !== "ACTIVE" && tx.state !== "VERIFIED") throw new TransactionError(`Transaction is ${tx.state}.`, txId);
    return tx;
  }
  private assertRegular(path: string, metadata: { isFile(): boolean; nlink: number }): void {
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error(`Expected regular file with one hard link: ${path}`);
  }
  private async readText(path: string): Promise<string> {
    this.assertRegular(path, await lstat(path));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(path));
  }
  private async assertBaseline(txId: string, path: string, buffer: FileBuffer): Promise<void> {
    if (await this.readText(path) !== buffer.baselineContent) throw new ConflictError(txId, path);
  }
  private async writePrepared(path: string, text: string, mode: number): Promise<void> {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.chmod(mode);
      await handle.sync();
    } finally { await handle.close(); }
  }
  private async cleanup(directories: readonly string[]): Promise<CleanupIssue[]> {
    const issues: CleanupIssue[] = [];
    for (const directory of directories) {
      try { await rm(directory, { recursive: true, force: true }); }
      catch (cause) { issues.push({ directory, cause }); }
    }
    return issues;
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation);
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
}
