import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createProtocolConnection, StreamMessageReader, StreamMessageWriter,
  type InitializeResult, type ProtocolConnection, type PublishDiagnosticsParams
} from "vscode-languageserver-protocol/node";
import { DiagnosticSeverity, type Diagnostic, type TextDocumentItem } from "vscode-languageserver-types";
import { z } from "zod";

const require = createRequire(import.meta.url);
export interface LspSupervisorOptions {
  workspaceRoot: string;
  diagnosticsMode?: "process-isolated" | "versioned";
  initializeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  serverModulePath?: string;
  tsserverPath?: string;
}
interface Session {
  child: ChildProcessWithoutNullStreams;
  connection: ProtocolConnection;
  closed: Promise<void>;
  done: boolean;
  stopping: boolean;
  accepting: boolean;
  failure: Error | undefined;
  stderr: string;
  versions: Map<string, number>;
  seen: Set<string>;
}
interface Waiter {
  uri: string;
  version: number;
  resolve: (diagnostics: Diagnostic[]) => void;
  reject: (error: Error) => void;
}
const locationSchema = z.object({ line: z.number().int().positive(), offset: z.number().int().positive() });
const responseSchema = z.object({
  type: z.literal("response"), success: z.literal(true),
  body: z.array(z.object({
    message: z.string(), code: z.number().int(),
    category: z.enum(["error", "warning", "suggestion", "message"]),
    startLocation: locationSchema, endLocation: locationSchema
  }))
});
const severity = {
  error: DiagnosticSeverity.Error, warning: DiagnosticSeverity.Warning,
  suggestion: DiagnosticSeverity.Hint, message: DiagnosticSeverity.Information
} as const;
/** Normalize URI encoding and Windows casing without reading source files. */
function canonicalUri(uri: string): string {
  let path = resolve(fileURLToPath(uri));
  if (process.platform === "win32") path = path.toLowerCase();
  return pathToFileURL(path).href;
}
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
function validateTimeout(ms: number): void {
  if (!Number.isInteger(ms) || ms <= 0 || ms > 2_147_483_647) throw new RangeError("Invalid timeout.");
}
function deadline<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
    operation.then(value => { clearTimeout(timer); resolvePromise(value); },
      error => { clearTimeout(timer); reject(error); });
  });
}

/**
 * Stdio JSON-RPC host. Source buffers are never saved to disk.
 * Unversioned diagnostics require a fresh process after an update.
 * Push publications are not proof that semantic checking is complete;
 * verification uses collectCompleteDiagnostics as well.
 */
export class LspSupervisor {
  private readonly root: string;
  private readonly rootUri: string;
  private readonly mode: "process-isolated" | "versioned";
  private readonly initializeTimeout: number;
  private readonly shutdownTimeout: number;
  private session: Session | undefined;
  private operations: Promise<void> = Promise.resolve();
  private readonly documents = new Map<string, TextDocumentItem>();
  private readonly diagnostics = new Map<string, Diagnostic[]>();
  private readonly diagnosticVersions = new Map<string, number>();
  private readonly waiters = new Set<Waiter>();

  constructor(private readonly options: LspSupervisorOptions) {
    this.root = resolve(options.workspaceRoot);
    this.rootUri = pathToFileURL(this.root).href;
    this.mode = options.diagnosticsMode ?? "process-isolated";
    this.initializeTimeout = options.initializeTimeoutMs ?? 15_000;
    this.shutdownTimeout = options.shutdownTimeoutMs ?? 3_000;
    validateTimeout(this.initializeTimeout);
    validateTimeout(this.shutdownTimeout);
  }
  start(): Promise<void> {
    return this.serialized(async () => {
      if (this.session) { this.ready(); return; }
      await this.startInternal();
    });
  }
  restart(): Promise<void> {
    return this.serialized(async () => { await this.stopInternal(); await this.startInternal(); });
  }
  shutdown(): Promise<void> {
    return this.serialized(async () => { await this.stopInternal(); this.documents.clear(); });
  }
  openVirtualDocument(uri: string, languageId: string, version: number, text: string): Promise<void> {
    uri = canonicalUri(uri);
    return this.serialized(async () => {
      this.validateDocument(uri, version);
      const session = this.ready();
      if (this.documents.has(uri)) throw new Error(`Document already open: ${uri}`);
      if (!languageId) throw new TypeError("languageId must not be empty.");
      const document = { uri, languageId, version, text };
      this.documents.set(uri, document);
      this.invalidate(uri, new Error("Document reopened."));
      if (session.seen.has(uri)) {
        await this.stopInternal();
        await this.startInternal();
      } else {
        try { await this.sendOpen(session, document); }
        catch (error) {
          this.documents.delete(uri);
          this.fail(session, asError(error));
          throw error;
        }
      }
    });
  }
  updateVirtualDocument(uri: string, version: number, text: string): Promise<void> {
    uri = canonicalUri(uri);
    return this.serialized(async () => {
      this.validateDocument(uri, version);
      const session = this.ready();
      const previous = this.documents.get(uri);
      if (!previous) throw new Error(`Document not open: ${uri}`);
      if (version <= previous.version) throw new RangeError(`Version must exceed ${previous.version}.`);
      this.invalidate(uri, new Error("Diagnostic wait superseded by an edit."));
      this.documents.set(uri, { ...previous, version, text });
      session.versions.set(uri, version);
      if (this.mode === "process-isolated") session.accepting = false;
      try {
        await session.connection.sendNotification("textDocument/didChange", {
          textDocument: { uri, version }, contentChanges: [{ text }]
        });
        if (this.mode === "process-isolated") {
          await this.stopInternal();
          await this.startInternal();
        }
      } catch (error) { this.fail(session, asError(error)); throw error; }
    });
  }
  closeVirtualDocument(uri: string): Promise<void> {
    uri = canonicalUri(uri);
    return this.serialized(async () => {
      const session = this.ready();
      if (!this.documents.has(uri)) throw new Error(`Document not open: ${uri}`);
      this.documents.delete(uri);
      session.versions.delete(uri);
      this.invalidate(uri, new Error("Document closed."));
      try { await session.connection.sendNotification("textDocument/didClose", { textDocument: { uri } }); }
      catch (error) { this.fail(session, asError(error)); throw error; }
    });
  }
  getDiagnostics(uri: string): Diagnostic[] { return structuredClone(this.diagnostics.get(canonicalUri(uri)) ?? []); }
  async waitForDiagnostics(uri: string, expectedVersion: number, timeoutMs = 2_000): Promise<Diagnostic[]> {
    uri = canonicalUri(uri);
    validateTimeout(timeoutMs);
    await this.operations;
    this.ready();
    if (this.documents.get(uri)?.version !== expectedVersion) throw new Error("Document not open at expected version.");
    if (this.diagnosticVersions.get(uri) === expectedVersion) return this.getDiagnostics(uri);
    return new Promise((resolvePromise, reject) => {
      const finish = (): void => { clearTimeout(timer); this.waiters.delete(waiter); };
      const waiter: Waiter = {
        uri, version: expectedVersion,
        resolve: diagnostics => { finish(); resolvePromise(structuredClone(diagnostics)); },
        reject: error => { finish(); reject(error); }
      };
      const timer = setTimeout(() => waiter.reject(new Error(`No diagnostics for ${uri} at version ${expectedVersion}.`)), timeoutMs);
      this.waiters.add(waiter);
    });
  }
  collectCompleteDiagnostics(uri: string, expectedVersion: number, timeoutMs = 15_000): Promise<Diagnostic[]> {
    uri = canonicalUri(uri);
    return this.serialized(async () => {
      validateTimeout(timeoutMs);
      const session = this.ready();
      if (this.documents.get(uri)?.version !== expectedVersion || session.versions.get(uri) !== expectedVersion) {
        throw new Error("Document not open at expected version.");
      }
      const diagnostics: Diagnostic[] = [];
      try {
        for (const command of ["syntacticDiagnosticsSync", "semanticDiagnosticsSync"]) {
          const response = await deadline(session.connection.sendRequest<unknown>("workspace/executeCommand", {
            command: "typescript.tsserverRequest",
            arguments: [command, { file: fileURLToPath(uri), includeLinePosition: true }, { expectsResult: true, isAsync: false }]
          }), timeoutMs, command);
          for (const diagnostic of responseSchema.parse(response).body) {
            diagnostics.push({
              range: {
                start: { line: diagnostic.startLocation.line - 1, character: diagnostic.startLocation.offset - 1 },
                end: { line: diagnostic.endLocation.line - 1, character: diagnostic.endLocation.offset - 1 }
              },
              severity: severity[diagnostic.category], code: diagnostic.code,
              source: "typescript", message: diagnostic.message
            });
          }
        }
        this.ready();
        return diagnostics;
      } catch (error) { this.fail(session, asError(error)); throw error; }
    });
  }
  private async startInternal(): Promise<void> {
    if (this.session) throw new Error("Previous language server is still present.");
    const serverModule = this.options.serverModulePath ?? require.resolve("typescript-language-server/lib/cli.mjs");
    const tsserverPath = this.options.tsserverPath ?? require.resolve("typescript/lib/tsserver.js");
    const env = { ...process.env };
    delete env["TSS_LOG"];
    const child = spawn(process.execPath, [serverModule, "--stdio"], {
      cwd: this.root, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false
    });
    // Protocol transport implements Content-Length byte framing, including
    // fragmented headers, UTF-8 payloads, and multiple frames per chunk.
    const connection = createProtocolConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolvePromise => { resolveClosed = resolvePromise; });
    const session: Session = {
      child, connection, closed, done: false, stopping: false, accepting: false,
      failure: undefined, stderr: "", versions: new Map(), seen: new Set()
    };
    this.session = session;
    this.clearDiagnostics(new Error("Language server session changed."));
    child.stderr.on("data", (chunk: Buffer) => { session.stderr = (session.stderr + chunk.toString("utf8")).slice(-8192); });
    child.on("error", error => this.fail(session, error));
    child.stdin.on("error", error => this.fail(session, error));
    child.stdout.on("error", error => this.fail(session, error));
    child.stderr.on("error", error => this.fail(session, error));
    child.once("close", (code, signal) => {
      session.done = true;
      resolveClosed();
      if (!session.stopping) this.fail(session, new Error(`Language server exited: ${code}/${signal}\n${session.stderr}`));
    });
    connection.onError(([error]) => this.fail(session, error));
    connection.onClose(() => { if (!session.stopping) this.fail(session, new Error("Language server transport closed.")); });
    connection.onNotification("textDocument/publishDiagnostics", (params: PublishDiagnosticsParams) => this.receive(session, params));
    connection.onRequest("workspace/applyEdit", () => ({ applied: false, failureReason: "Stage edits through the transaction manager." }));
    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.onRequest("workspace/workspaceFolders", () => [{ uri: this.rootUri, name: basename(this.root) || "workspace" }]);
    connection.listen();
    try {
      const initialized = await deadline(connection.sendRequest<InitializeResult>("initialize", {
        processId: process.pid,
        clientInfo: { name: "transactional-refactor-mcp", version: "0.1.0" },
        rootUri: this.rootUri,
        workspaceFolders: [{ uri: this.rootUri, name: basename(this.root) || "workspace" }],
        capabilities: {
          workspace: { applyEdit: false },
          textDocument: {
            synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: false },
            publishDiagnostics: { versionSupport: true }
          }
        },
        initializationOptions: {
          hostInfo: "transactional-refactor-mcp", disableAutomaticTypingAcquisition: true,
          tsserver: { path: tsserverPath, logVerbosity: "off", trace: "off", useSyntaxServer: "never" }
        }
      }), this.initializeTimeout, "LSP initialize");
      if (!initialized || typeof initialized.capabilities !== "object") throw new Error("Invalid initialize response.");
      await deadline(connection.sendNotification("initialized", {}), this.initializeTimeout, "LSP initialized");
      session.accepting = true;
      for (const document of this.documents.values()) await this.sendOpen(session, document);
      this.ready();
    } catch (error) {
      try { await this.stopInternal(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "LSP initialization and cleanup failed."); }
      throw error;
    }
  }
  private async sendOpen(session: Session, document: TextDocumentItem): Promise<void> {
    session.versions.set(document.uri, document.version);
    session.seen.add(document.uri);
    await session.connection.sendNotification("textDocument/didOpen", { textDocument: { ...document } });
  }
  private receive(session: Session, params: PublishDiagnosticsParams): void {
    if (this.session !== session || !session.accepting || session.failure) return;
    if (!params || typeof params.uri !== "string" || !Array.isArray(params.diagnostics)) {
      this.fail(session, new Error("Malformed publishDiagnostics payload."));
      return;
    }
    try { params = { ...params, uri: canonicalUri(params.uri) }; }
    catch (error) { this.fail(session, asError(error)); return; }
    const document = this.documents.get(params.uri);
    const version = session.versions.get(params.uri);
    if (!document || version === undefined || version !== document.version) return;
    const publishedVersion = params.version ?? (this.mode === "process-isolated" ? version : undefined);
    if (publishedVersion !== document.version) return;
    this.diagnostics.set(params.uri, structuredClone(params.diagnostics));
    this.diagnosticVersions.set(params.uri, publishedVersion);
    for (const waiter of [...this.waiters]) {
      if (waiter.uri === params.uri && waiter.version === publishedVersion) waiter.resolve(params.diagnostics);
    }
  }
  private async stopInternal(): Promise<void> {
    const session = this.session;
    this.clearDiagnostics(new Error("Language server stopped or restarted."));
    if (!session) return;
    session.stopping = true;
    session.accepting = false;
    try {
      if (!session.done && !session.failure) {
        try {
          await deadline(session.connection.sendRequest("shutdown"), this.shutdownTimeout, "LSP shutdown");
          await deadline(session.connection.sendNotification("exit"), this.shutdownTimeout, "LSP exit");
          session.child.stdin.end();
          await deadline(session.closed, this.shutdownTimeout, "Language server exit");
        } catch { /* Proceed to bounded process termination. */ }
      }
      if (!session.done) {
        session.child.kill("SIGTERM");
        try { await deadline(session.closed, 1_000, "SIGTERM"); }
        catch {
          session.child.kill("SIGKILL");
          await deadline(session.closed, 2_000, "SIGKILL");
        }
      }
    } finally {
      session.connection.dispose();
      if (session.done && this.session === session) this.session = undefined;
    }
  }
  private fail(session: Session, error: Error): void {
    if (session.stopping || session.failure) return;
    session.failure = error;
    session.accepting = false;
    session.connection.dispose();
    if (this.session === session) this.clearDiagnostics(error);
    if (!session.done) session.child.kill("SIGTERM");
  }
  private ready(): Session {
    const session = this.session;
    if (!session || session.done || session.stopping || !session.accepting || session.failure) {
      throw session?.failure ?? new Error("Language server is not ready.");
    }
    return session;
  }
  private invalidate(uri: string, error: Error): void {
    this.diagnostics.delete(uri);
    this.diagnosticVersions.delete(uri);
    for (const waiter of [...this.waiters]) if (waiter.uri === uri) waiter.reject(error);
  }
  private clearDiagnostics(error: Error): void {
    this.diagnostics.clear();
    this.diagnosticVersions.clear();
    for (const waiter of [...this.waiters]) waiter.reject(error);
  }
  private validateDocument(uri: string, version: number): void {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:") throw new TypeError("Use a file: URI; the file need not exist.");
    fileURLToPath(parsed);
    if (!Number.isInteger(version) || version < 0 || version > 2_147_483_647) throw new RangeError("Invalid document version.");
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operations.then(operation);
    this.operations = pending.then(() => undefined, () => undefined);
    return pending;
  }
}
