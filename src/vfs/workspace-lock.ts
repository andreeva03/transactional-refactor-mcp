import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const ownerSchema = z.object({ version: z.literal(1), pid: z.number().int().positive(), host: z.string(), token: z.string().uuid() }).strict();
export class WorkspaceLockedError extends Error {
  constructor(message: string) { super(message); this.name = "WorkspaceLockedError"; }
}
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** Local cooperating processes only. PID uncertainty always fails closed. */
export async function acquireWorkspaceLock(workspace: string): Promise<{ release(): Promise<void> }> {
  const root = await realpath(workspace);
  const directory = join(root, ".transactional-refactor");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new WorkspaceLockedError("Journal directory cannot be a symlink.");
  const ownerPath = join(directory, "workspace.lock");
  const guardPath = join(directory, "workspace.lock.guard");
  const owner = { version: 1 as const, pid: process.pid, host: hostname(), token: randomUUID() };

  // All ownership changes use this short-lived atomic guard. In particular,
  // two contenders must never both inspect and unlink the same stale owner.
  // A crash during this critical section leaves the guard for manual review;
  // guessing a stale timeout would permit a paused owner to lose its lock.
  async function guard<T>(operation: () => Promise<T>): Promise<T> {
    try { await mkdir(guardPath, { mode: 0o700 }); }
    catch (error) {
      if (code(error) !== "EEXIST") throw error;
      throw new WorkspaceLockedError(`Workspace lock acquisition or release is in progress: ${guardPath}. Retry shortly. If this persists after all servers have stopped, remove this guard directory and retry.`);
    }
    try { return await operation(); }
    finally { await rmdir(guardPath); }
  }
  async function readOwner() {
    try {
      const metadata = await lstat(ownerPath);
      if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("Lock must be a regular file with one link.");
      return ownerSchema.parse(JSON.parse(await readFile(ownerPath, "utf8")));
    } catch (error) {
      if (code(error) === "ENOENT") return undefined;
      throw new WorkspaceLockedError(`Cannot establish workspace lock ownership: ${ownerPath}. Inspect the lock after stopping all servers. ${String(error)}`);
    }
  }
  await guard(async () => {
    const previous = await readOwner();
    if (previous) {
      if (previous.host !== owner.host) throw new WorkspaceLockedError(`Workspace is locked by another host (${previous.host}): ${ownerPath}. Shared-host locking is not supported.`);
      let alive = true;
      try { process.kill(previous.pid, 0); }
      catch (error) { if (code(error) === "ESRCH") alive = false; }
      if (alive) throw new WorkspaceLockedError(`Workspace is already locked by process ${previous.pid}: ${root}. Stop that server before starting another.`);
    }
    const temporary = join(directory, `workspace.lock.${owner.token}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(owner), "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, ownerPath);
    } finally {
      await unlink(temporary).catch(error => { if (code(error) !== "ENOENT") throw error; });
    }
  });
  let released = false;
  return {
    async release() {
      if (released) return;
      await guard(async () => {
        const current = await readOwner();
        if (!current || current.token !== owner.token) throw new WorkspaceLockedError("Workspace lock ownership changed; refusing to remove another owner's lock.");
        await unlink(ownerPath);
        released = true;
      });
    }
  };
}
