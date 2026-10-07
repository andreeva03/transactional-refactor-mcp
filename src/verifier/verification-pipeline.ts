import { readdirSync, realpathSync, type Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { TransactionManager, type VerificationSnapshot } from "../vfs/transaction-manager.js";

export interface VerificationResult {
  status: "VALID" | "BLOCKED";
  newErrors: Array<{ file: string; line: number; message: string; code: string | number }>;
  resolvedErrorsCount: number;
  canCommit: boolean;
}
export interface VerificationPipelineOptions { diagnosticTimeoutMs?: number }
const ignored = new Set(["node_modules", ".git", ".transactional-refactor"]);
const sourcePattern = /\.[cm]?[jt]sx?$/i;
const key = (path: string) => ts.sys.useCaseSensitiveFileNames ? resolve(path) : resolve(path).toLowerCase();

// TypeScript's runtime glob matcher preserves include/exclude rules for virtual
// files. It is covered by overlay tests; TypeScript is pinned to a minor release.
type MatchFiles = (path: string, extensions: readonly string[] | undefined, excludes: readonly string[] | undefined, includes: readonly string[] | undefined, caseSensitive: boolean, cwd: string, depth: number | undefined, entries: (path: string) => { files: string[]; directories: string[] }, realpath: (path: string) => string) => string[];
const matchFiles = (ts as unknown as { matchFiles: MatchFiles }).matchFiles;

/** One disk view shared by both compiler passes, with an overlay for staging. */
class WorkspaceView {
  readonly reads = new Map<string, { path: string; content: string | undefined }>();
  readonly listings = new Map<string, { path: string; files: string[]; directories: string[] }>();
  constructor(readonly root: string, readonly snapshot: VerificationSnapshot) {}
  diskRead = (path: string): string | undefined => {
    const id = key(path);
    if (!this.reads.has(id)) this.reads.set(id, { path, content: ts.sys.readFile(path) });
    return this.reads.get(id)!.content;
  };
  diskEntries(path: string): { files: string[]; directories: string[] } {
    let entries: Dirent[];
    try { entries = readdirSync(path, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error; entries = []; }
    return { files: entries.filter(e => e.isFile()).map(e => e.name).sort(), directories: entries.filter(e => e.isDirectory() && !ignored.has(e.name) && !e.name.startsWith(".shadow-vfs-")).map(e => e.name).sort() };
  }
  entries(path: string, staged: boolean): { files: string[]; directories: string[] } {
    const id = key(path);
    if (!this.listings.has(id)) this.listings.set(id, { path, ...this.diskEntries(path) });
    const original = this.listings.get(id)!;
    const files = new Set(original.files), directories = new Set(original.directories);
    for (const file of this.snapshot.files) {
      const content = staged ? file.buffer.currentContent : file.buffer.baselineContent;
      if (key(dirname(file.filePath)) === id) {
        const name = file.filePath.slice(dirname(file.filePath).length + 1);
        if (content === null) files.delete(name); else files.add(name);
      }
      if (content !== null) {
        let child = dirname(file.filePath);
        while (dirname(child) !== child) {
          if (key(dirname(child)) === id) directories.add(child.slice(dirname(child).length + 1));
          child = dirname(child);
        }
      }
    }
    return { files: [...files].sort(), directories: [...directories].sort() };
  }
  read(path: string, staged: boolean): string | undefined {
    const file = this.snapshot.files.find(file => key(file.filePath) === key(path));
    return file ? (staged ? file.buffer.currentContent : file.buffer.baselineContent) ?? undefined : this.diskRead(path);
  }
  directoryExists(path: string, staged: boolean): boolean {
    if (ts.sys.directoryExists(path)) return true;
    const prefix = key(path).replaceAll("\\", "/") + "/";
    return this.snapshot.files.some(file => (staged ? file.buffer.currentContent : file.buffer.baselineContent) !== null && key(file.filePath).replaceAll("\\", "/").startsWith(prefix));
  }
  readDirectory(path: string, extensions: readonly string[] | undefined, excludes: readonly string[] | undefined, includes: readonly string[] | undefined, depth: number | undefined, staged: boolean): string[] {
    return matchFiles(path, extensions, excludes, includes, ts.sys.useCaseSensitiveFileNames, this.root, depth, path => this.entries(path, staged), path => ts.sys.realpath?.(path) ?? path);
  }
  assertUnchanged(): void {
    for (const { path, content } of this.reads.values()) if (ts.sys.readFile(path) !== content) throw new Error(`Workspace changed during verification: ${path}`);
    for (const { path, files, directories } of this.listings.values()) {
      const now = this.diskEntries(path);
      if (JSON.stringify([files, directories]) !== JSON.stringify([now.files, now.directories])) throw new Error(`Workspace changed during verification: ${path}`);
    }
  }
}

export class VerificationPipeline {
  private operations: Promise<void> = Promise.resolve();
  private readonly timeout: number | undefined;
  constructor(private readonly transactions: TransactionManager, private readonly workspaceRoot: string, options: VerificationPipelineOptions = {}) {
    this.workspaceRoot = realpathSync.native(workspaceRoot);
    if (options.diagnosticTimeoutMs !== undefined && (!Number.isInteger(options.diagnosticTimeoutMs) || options.diagnosticTimeoutMs <= 0 || options.diagnosticTimeoutMs > 2_147_483_647)) throw new RangeError("Invalid diagnostic timeout.");
    this.timeout = options.diagnosticTimeoutMs;
  }
  verifyTransaction(txId: string): Promise<VerificationResult> {
    const pending = this.operations.then(() => this.verify(txId));
    this.operations = pending.then(() => undefined, () => undefined);
    return pending;
  }
  private async verify(txId: string): Promise<VerificationResult> {
    const snapshot = await this.transactions.snapshotForVerification(txId);
    const view = new WorkspaceView(this.workspaceRoot, snapshot);
    const deadline = Date.now() + (this.timeout ?? Infinity);
    const cancellation: ts.CancellationToken = {
      isCancellationRequested: () => Date.now() >= deadline,
      throwIfCancellationRequested: () => { if (Date.now() >= deadline) throw new Error("Project verification timed out."); }
    };
    const before = this.diagnostics(view, false, cancellation);
    const after = this.diagnostics(view, true, cancellation);
    view.assertUnchanged();
    const newErrors = [...after].filter(([id]) => !before.has(id)).map(([, diagnostic]) => diagnostic);
    const result: VerificationResult = { status: newErrors.length ? "BLOCKED" : "VALID", newErrors, resolvedErrorsCount: [...before.keys()].filter(id => !after.has(id)).length, canCommit: newErrors.length === 0 };
    await this.transactions.completeVerification(snapshot, result.canCommit);
    return result;
  }
  private diagnostics(view: WorkspaceView, staged: boolean, cancellation: ts.CancellationToken) {
    cancellation.throwIfCancellationRequested();
    const diagnostics = new Map<string, VerificationResult["newErrors"][number]>();
    const add = (diagnostic: ts.Diagnostic, fallback: string) => {
      if (diagnostic.category !== ts.DiagnosticCategory.Error) return;
      const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      const value = { file: diagnostic.file?.fileName ?? fallback, line: (position?.line ?? 0) + 1, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"), code: diagnostic.code };
      diagnostics.set(JSON.stringify([key(value.file), value.line, position?.character ?? 0, value.code, value.message]), value);
    };
    const readDirectory: ts.ParseConfigHost["readDirectory"] = (path, extensions, excludes, includes, depth) => view.readDirectory(path, extensions, excludes, includes, depth, staged);
    const parseHost: ts.ParseConfigHost = { useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames, readDirectory, fileExists: path => view.read(path, staged) !== undefined, readFile: path => view.read(path, staged) };
    const configs = readDirectory(this.workspaceRoot, [".json"], ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.transactional-refactor/**"], ["**/tsconfig.json", "**/jsconfig.json"]);
    const parsed = new Map<string, ts.ParsedCommandLine>();
    const loading = new Set<string>();
    const loadConfig = (path: string): ts.ParsedCommandLine | undefined => {
      const id = key(path);
      if (parsed.has(id)) return parsed.get(id);
      if (loading.has(id)) return undefined;
      loading.add(id);
      const config = ts.readConfigFile(path, parseHost.readFile);
      if (config.error) { add(config.error, path); return undefined; }
      const result = ts.parseJsonConfigFileContent(config.config, parseHost, dirname(path), {}, path);
      parsed.set(id, result);
      for (const diagnostic of result.errors) add(diagnostic, path);
      for (const reference of result.projectReferences ?? []) loadConfig(ts.resolveProjectReferencePath(reference));
      return result;
    };
    for (const config of configs) loadConfig(config);
    const covered = new Set<string>();
    const compile = (config: ts.ParsedCommandLine, fallback: string) => {
      cancellation.throwIfCancellationRequested();
      const options = { ...config.options, noEmit: true };
      const host: ts.CompilerHost & { useSourceOfProjectReferenceRedirect(): boolean } = {
        ...ts.createCompilerHost(options),
        readFile: parseHost.readFile, fileExists: parseHost.fileExists, readDirectory: (...args) => [...readDirectory(...args)],
        directoryExists: path => view.directoryExists(path, staged),
        getDirectories: path => view.entries(path, staged).directories.map(name => join(path, name)),
        getCurrentDirectory: () => this.workspaceRoot,
        getSourceFile: (path, languageVersion) => {
          cancellation.throwIfCancellationRequested();
          const content = view.read(path, staged);
          return content === undefined ? undefined : ts.createSourceFile(path, content, languageVersion, true);
        },
        writeFile: () => { throw new Error("Verification must never emit files."); },
        useSourceOfProjectReferenceRedirect: () => true
      };
      const program = ts.createProgram({ rootNames: config.fileNames, options, host, ...(config.projectReferences ? { projectReferences: config.projectReferences } : {}) });
      for (const source of program.getSourceFiles()) covered.add(key(source.fileName));
      for (const diagnostic of ts.getPreEmitDiagnostics(program, undefined, cancellation)) add(diagnostic, fallback);
    };
    for (const [path, config] of parsed) compile(config, path);
    // Check loose and excluded source files as an inferred project too.
    const loose = readDirectory(this.workspaceRoot, [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"], ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/.transactional-refactor/**"], ["**/*"])
      .filter(path => !covered.has(key(path)));
    for (const file of view.snapshot.files) if ((staged ? file.buffer.currentContent : file.buffer.baselineContent) !== null && sourcePattern.test(file.filePath) && !covered.has(key(file.filePath)) && !loose.some(path => key(path) === key(file.filePath))) loose.push(file.filePath);
    if (loose.length) compile({ fileNames: loose, options: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowJs: true, checkJs: true, jsx: ts.JsxEmit.ReactJSX, skipLibCheck: true }, errors: [] }, this.workspaceRoot);
    return diagnostics;
  }
}
