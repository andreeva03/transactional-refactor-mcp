import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";

export type TransactionState = "ACTIVE" | "VERIFIED" | "COMMITTED" | "ABORTED" | "RECOVERY_REQUIRED";
export interface FileBuffer {
  readonly baselineContent: string | null;
  readonly currentContent: string | null;
  readonly version: number;
  readonly mode?: number;
}
interface Transaction {
  state: TransactionState;
  buffers: Map<string, FileBuffer>;
  recoveryDirectories?: string[];
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
 * UTF-8 regular files in a trusted workspace.
 * Operations within one manager are serialized. Staging writes only journals.
 * Commit provides per-file rename and compensating rollback, NOT a
 * crash-atomic multi-file transaction. Cooperating writers are required.
 */
export class TransactionManager {
  private readonly transactions = new Map<string, Transaction>();
  private queue: Promise<void> = Promise.resolve();
  private readonly baseDirectory: string;
  private readonly requestedDirectory: string;
  private readonly pathIdentities = new Map<string, string>();

  constructor(baseDirectory = process.cwd(), private readonly replaceFile: typeof rename = rename, private readonly journalDirectory?: string) {
    this.requestedDirectory = resolve(baseDirectory);
    this.baseDirectory = realpathSync.native(this.requestedDirectory);
    if (journalDirectory) {
      if (relative(this.requestedDirectory, resolve(journalDirectory)) !== ".transactional-refactor" && relative(this.baseDirectory, resolve(journalDirectory)) !== ".transactional-refactor") throw new Error("Journal must be the workspace .transactional-refactor directory.");
      this.journalDirectory = journalDirectory = join(this.baseDirectory, ".transactional-refactor");
      mkdirSync(journalDirectory, { recursive: true, mode: 0o700 });
      if (lstatSync(journalDirectory).isSymbolicLink()) throw new Error("Journal directory cannot be a symlink.");
      const schema = z.object({ state: z.enum(["ACTIVE", "VERIFIED", "COMMITTED", "ABORTED", "RECOVERY_REQUIRED"]), files: z.array(z.object({ filePath: z.string(), buffer: z.object({ baselineContent: z.string().nullable(), currentContent: z.string().nullable(), version: z.number().int().positive(), mode: z.number().int().optional() }) })), recoveryDirectories: z.array(z.string()).optional() });
      for (const name of readdirSync(journalDirectory).filter(name => /^[0-9a-f-]{36}\.json$/.test(name))) {
        const txId = z.string().uuid().parse(name.slice(0, -5));
        const data = schema.parse(JSON.parse(readFileSync(join(journalDirectory, name), "utf8")));
        const tx: Transaction = { state: data.state === "VERIFIED" ? "ACTIVE" : data.state, buffers: new Map(data.files.map(file => [this.resolvePath(file.filePath), file.buffer as FileBuffer])) };
        if (data.recoveryDirectories) tx.recoveryDirectories = data.recoveryDirectories.map(path => {
          const resolved = this.resolvePath(path);
          if (!resolved.split(sep).at(-1)?.startsWith(`.shadow-vfs-${txId}-`)) throw new Error("Invalid recovery directory.");
          return resolved;
        });
        this.transactions.set(txId, tx);
      }
    }
  }
  begin(): string {
    const txId = randomUUID();
    this.transactions.set(txId, { state: "ACTIVE", buffers: new Map() });
    this.persist(txId);
    return txId;
  }
  getState(txId: string): TransactionState { return this.requireTransaction(txId).state; }
  status(txId: string) {
    const tx = this.requireTransaction(txId);
    return { txId, state: tx.state, files: [...tx.buffers].map(([filePath, buffer]) => ({ filePath, ...buffer })), recoveryDirectories: tx.recoveryDirectories ?? [] };
  }
  list() { return [...this.transactions.keys()].map(txId => ({ txId, state: this.getState(txId), fileCount: this.requireTransaction(txId).buffers.size })); }
  getBuffer(txId: string, filePath: string): FileBuffer | undefined {
    const buffer = this.requireTransaction(txId).buffers.get(this.resolvePath(filePath));
    return buffer === undefined ? undefined : { ...buffer };
  }
  stageEdit(txId: string, filePath: string, newContent: string, expectedVersion?: number): Promise<number> {
    return this.serialized(async () => {
      const tx = this.requireOpen(txId);
      const target = this.resolvePath(filePath);
      const previous = tx.buffers.get(target);
      await this.validatePath(target);
      this.checkVersion(txId, previous, expectedVersion);
      if (previous?.currentContent === null) throw new TransactionError("File is staged for deletion.", txId);
      const baselineContent = previous ? previous.baselineContent : await this.readText(target);
      const version = (previous?.version ?? 0) + 1;
      tx.buffers.set(target, { ...previous, baselineContent, currentContent: newContent, version });
      tx.state = "ACTIVE";
      this.persist(txId);
      return version;
    });
  }
  stageReplace(txId: string, filePath: string, oldText: string, newText: string, expectedVersion: number): Promise<number> {
    return this.serialized(async () => {
      const tx = this.requireOpen(txId);
      const target = this.resolvePath(filePath);
      await this.validatePath(target);
      const previous = tx.buffers.get(target);
      this.checkVersion(txId, previous, expectedVersion);
      const content = previous ? previous.currentContent : await this.readText(target);
      if (content === null || !oldText || content.indexOf(oldText) < 0 || content.indexOf(oldText, content.indexOf(oldText) + 1) >= 0) throw new TransactionError("oldText must match exactly once in the current file.", txId);
      const version = (previous?.version ?? 0) + 1;
      tx.buffers.set(target, { ...previous, baselineContent: previous ? previous.baselineContent : content, currentContent: content.replace(oldText, () => newText), version });
      tx.state = "ACTIVE";
      this.persist(txId);
      return version;
    });
  }
  stageCreate(txId: string, filePath: string, content: string): Promise<number> {
    return this.serialized(async () => {
      const tx = this.requireOpen(txId);
      const target = this.resolvePath(filePath);
      await this.validatePath(target);
      if (tx.buffers.has(target) || await this.readOptional(target) !== null) throw new TransactionError("Creation destination already exists or is staged.", txId);
      tx.buffers.set(target, { baselineContent: null, currentContent: content, version: 1 });
      tx.state = "ACTIVE";
      this.persist(txId);
      return 1;
    });
  }
  stageDelete(txId: string, filePath: string, expectedVersion: number): Promise<number> {
    return this.serialized(async () => {
      const tx = this.requireOpen(txId);
      const target = this.resolvePath(filePath);
      await this.validatePath(target);
      const previous = tx.buffers.get(target);
      this.checkVersion(txId, previous, expectedVersion);
      if (previous?.currentContent === null) throw new TransactionError("File is already deleted.", txId);
      const version = (previous?.version ?? 0) + 1;
      tx.buffers.set(target, { ...previous, baselineContent: previous ? previous.baselineContent : await this.readText(target), currentContent: null, version });
      tx.state = "ACTIVE";
      this.persist(txId);
      return version;
    });
  }
  stageRename(txId: string, filePath: string, destination: string, expectedVersion: number): Promise<void> {
    return this.serialized(async () => {
      const tx = this.requireOpen(txId);
      const source = this.resolvePath(filePath), target = this.resolvePath(destination);
      await this.validatePath(source); await this.validatePath(target);
      const previous = tx.buffers.get(source);
      this.checkVersion(txId, previous, expectedVersion);
      if (source === target || tx.buffers.has(target) || await this.readOptional(target) !== null) throw new TransactionError("Rename destination already exists or is staged.", txId);
      const content = previous ? previous.currentContent : await this.readText(source);
      if (content === null) throw new TransactionError("Cannot rename a deleted file.", txId);
      const mode = previous?.mode ?? (previous?.baselineContent === null ? 0o644 : (await lstat(source)).mode & 0o777);
      tx.buffers.set(source, { ...previous, baselineContent: previous ? previous.baselineContent : content, currentContent: null, version: (previous?.version ?? 0) + 1 });
      tx.buffers.set(target, { baselineContent: null, currentContent: content, version: 1, mode });
      tx.state = "ACTIVE";
      this.persist(txId);
    });
  }
  readFile(txId: string, filePath: string): Promise<string> {
    return this.serialized(async () => {
      const tx = this.requireOpen(txId);
      const target = this.resolvePath(filePath);
      await this.validatePath(target);
      const buffer = tx.buffers.get(target);
      if (buffer?.currentContent === null) throw new TransactionError("File is staged for deletion.", txId);
      return buffer ? buffer.currentContent! : this.readText(target);
    });
  }
  rollback(txId: string): Promise<void> {
    return this.serialized(async () => {
      const tx = this.requireTransaction(txId);
      if (tx.state === "ABORTED") return;
      this.requireOpen(txId);
      tx.buffers.clear();
      tx.state = "ABORTED";
      this.persist(txId);
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
      this.persist(snapshot.txId);
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
          if (buffer.baselineContent === buffer.currentContent) continue;
          const metadata = buffer.baselineContent === null ? undefined : await lstat(target);
          if (metadata) this.assertRegular(target, metadata);
          const mode = metadata ? metadata.mode & 0o777 : buffer.mode ?? 0o644;
          tx.buffers.set(target, { ...buffer, mode });
          await mkdir(dirname(target), { recursive: true });
          const directory = await mkdtemp(join(dirname(target), `.shadow-vfs-${txId}-`));
          directories.push(directory);
          const file = { target, buffer, replacement: join(directory, "replacement"), backup: join(directory, "baseline") };
          if (buffer.baselineContent !== null) await this.writePrepared(file.backup, buffer.baselineContent, mode);
          if (buffer.currentContent !== null) await this.writePrepared(file.replacement, buffer.currentContent, mode);
          prepared.push(file);
        }
        for (const file of prepared) await this.assertBaseline(txId, file.target, file.buffer);
        tx.state = "RECOVERY_REQUIRED";
        tx.recoveryDirectories = directories;
        this.persist(txId);
        for (const file of prepared) {
          await this.assertBaseline(txId, file.target, file.buffer);
          if (file.buffer.currentContent === null) {
            if (file.buffer.baselineContent !== null) await unlink(file.target);
          } else await this.replaceFile(file.replacement, file.target);
          installed.push(file);
        }
      } catch (cause) {
        const recoveryErrors: unknown[] = [];
        for (const file of [...installed].reverse()) {
          try {
            if (await this.readOptional(file.target) !== file.buffer.currentContent) {
              throw new Error(`Cannot restore externally modified file: ${file.target}`);
            }
            if (file.buffer.baselineContent === null) {
              if (file.buffer.currentContent !== null) await unlink(file.target);
            } else await this.replaceFile(file.backup, file.target);
          } catch (error) {
            recoveryErrors.push(new Error(`Failed to restore ${file.target}`, { cause: error }));
          }
        }
        if (recoveryErrors.length) {
          tx.state = this.journalDirectory ? "RECOVERY_REQUIRED" : "ABORTED";
          tx.recoveryDirectories = directories;
          this.persist(txId);
          throw new CommitError(txId, cause, recoveryErrors, directories, []);
        }
        tx.state = "ACTIVE";
        delete tx.recoveryDirectories;
        this.persist(txId);
        throw new CommitError(txId, cause, [], [], await this.cleanup(directories));
      }
      tx.state = "COMMITTED";
      this.persist(txId);
      tx.buffers.clear();
      return { state: "COMMITTED", filesWritten: installed.length, cleanupIssues: await this.cleanup(directories) };
    });
  }
  /** Explicitly restore an interrupted commit; never overwrite unknown content. */
  recover(txId: string): Promise<void> {
    return this.serialized(async () => {
      const tx = this.requireTransaction(txId);
      if (tx.state !== "RECOVERY_REQUIRED") throw new TransactionError("Transaction does not require recovery.", txId);
      for (const [target, buffer] of tx.buffers) {
        await this.validatePath(target);
        const current = await this.readOptional(target);
        if (current !== buffer.baselineContent && current !== buffer.currentContent) throw new ConflictError(txId, target);
      }
      for (const [target, buffer] of [...tx.buffers].reverse()) {
        const current = await this.readOptional(target);
        if (current === buffer.baselineContent) continue;
        if (current !== buffer.currentContent) throw new ConflictError(txId, target);
        if (buffer.baselineContent === null) await unlink(target);
        else {
          const directory = await mkdtemp(join(dirname(target), `.shadow-vfs-${txId}-`));
          try {
            const replacement = join(directory, "restore");
            await this.writePrepared(replacement, buffer.baselineContent, buffer.mode ?? 0o644);
            await this.replaceFile(replacement, target);
          } finally { await this.cleanup([directory]); }
        }
      }
      const issues = await this.cleanup(tx.recoveryDirectories ?? []);
      if (issues.length) throw new TransactionError("Sources restored, but backup cleanup failed; retry recovery.", txId);
      delete tx.recoveryDirectories;
      tx.state = "ACTIVE";
      this.persist(txId);
    });
  }
  forget(txId: string): Promise<void> {
    return this.serialized(async () => {
      const tx = this.requireTransaction(txId);
      if (tx.state !== "COMMITTED" && tx.state !== "ABORTED") throw new TransactionError("Cannot forget an open transaction.", txId);
      this.transactions.delete(txId);
      if (this.journalDirectory) {
        const path = join(this.journalDirectory, `${txId}.json`);
        if (existsSync(path)) unlinkSync(path);
      }
    });
  }
  private resolvePath(path: string): string {
    if (!path || path.includes("\0")) throw new TypeError("Invalid file path.");
    const requested = resolve(this.requestedDirectory, path);
    const requestedRelative = relative(this.requestedDirectory, requested);
    const target = !isAbsolute(requestedRelative) && requestedRelative !== ".." && !requestedRelative.startsWith(`..${sep}`) ? resolve(this.baseDirectory, requestedRelative) : resolve(this.baseDirectory, path);
    const local = relative(this.baseDirectory, target);
    if (!local || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`) || local.split(sep).some(part => [".git", ".transactional-refactor"].includes(process.platform === "win32" ? part.toLowerCase() : part))) throw new Error("File is outside the allowed workspace.");
    const identity = process.platform === "win32" ? target.toLowerCase() : target;
    if (!this.pathIdentities.has(identity)) this.pathIdentities.set(identity, target);
    return this.pathIdentities.get(identity)!;
  }
  private async validatePath(target: string): Promise<void> {
    let current = target;
    while (relative(this.baseDirectory, current) !== "") {
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink()) throw new Error("Symbolic links are not supported.");
        const canonical = await realpath(current);
        this.resolvePath(canonical);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      current = dirname(current);
    }
  }
  private checkVersion(txId: string, buffer: FileBuffer | undefined, expected?: number): void {
    if (expected !== undefined && expected !== (buffer?.version ?? 0)) throw new TransactionError(`Version conflict: expected ${expected}, current ${buffer?.version ?? 0}.`, txId);
  }
  private persist(txId: string): void {
    if (!this.journalDirectory) return;
    const tx = this.requireTransaction(txId);
    const target = join(this.journalDirectory, `${txId}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ state: tx.state, files: [...tx.buffers].map(([filePath, buffer]) => ({ filePath, buffer })), recoveryDirectories: tx.recoveryDirectories }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, target);
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
    await this.validatePath(path);
    if (await this.readOptional(path) !== buffer.baselineContent) throw new ConflictError(txId, path);
  }
  private async readOptional(path: string): Promise<string | null> {
    try { return await this.readText(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
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
