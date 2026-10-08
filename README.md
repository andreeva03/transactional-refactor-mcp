# Transactional Refactor MCP

Experimental TypeScript/JavaScript refactoring server for MCP coding agents.

Changes are staged in an isolated virtual filesystem and checked with the
TypeScript compiler against the whole project before commit. A local journal
preserves staged transactions and supports recovery after an interrupted commit.

## Quick start

Requires Node.js 20 or newer.

```sh
npm ci
npm run build
npm test
node dist/src/index.js --workspace "/absolute/path/to/project"
```

The server speaks MCP over stdio. Standard output is reserved for protocol
messages; logs go to standard error. Use the Inspector or an MCP client to
interact with it.

## Tools

| Tool | Purpose |
| --- | --- |
| `tx_begin` | Create a transaction and return its ID |
| `tx_stage_edit` | Stage complete replacement file content; return version and diff summary |
| `tx_stage_replace` | Replace one unique exact text match, guarded by the current version |
| `tx_stage_create` | Stage a new file, including in a new directory |
| `tx_stage_delete` | Stage deletion, guarded by the current version |
| `tx_stage_rename` | Stage a move to an unused destination, guarded by the source version |
| `tx_status` | Inspect state, file operations, versions, and recovery directories |
| `tx_diff` | Inspect unified diffs, including creations and deletions |
| `tx_list` | Discover transactions, including those restored after restart |
| `tx_verify` | Report new project-wide compiler errors relative to the original baseline |
| `tx_commit` | Reverify and commit only if valid |
| `tx_rollback` | Discard staging and its journal |
| `tx_recover` | Restore baseline files after an interrupted commit; retain staging for retry |

Suggested workflow: begin, stage, verify, fix new errors, then commit or
rollback. All schemas reject unknown arguments. Results include structured
JSON and an equivalent text response. Diagnostic lines are one-based.

`expectedVersion` is required for replace, delete, and rename, and optional for
full-file edits. Use `0` for an unstaged file, or the version from `tx_status` or
a staging response. Exact replacements must match once; missing or ambiguous
matches fail without changing staging. Rename moves content and does not rewrite
imports automatically. Update imports within the same transaction.

Example exact replacement after staging version 1:

```json
{
  "txId": "<transaction UUID>",
  "filePath": "src/example.ts",
  "oldText": "count = 1",
  "newText": "count = 2",
  "expectedVersion": 1
}
```

## Verification scope

The compiler checks discovered `tsconfig.json` and `jsconfig.json` projects and
their project references, including unstaged consumers, syntax, semantic, and
configuration diagnostics. Both passes use a shared disk view and virtual file
contents. New files participate in config include/exclude matching; deleted files
disappear from module resolution. Source files outside configured projects are
checked in an inferred project with JavaScript checking enabled. No compiler
output or build metadata is emitted.

For example, changing an exported function from a string parameter to a number
blocks commit if an unchanged caller still supplies a string. Existing errors
are allowed when their file, position, code, and message remain unchanged.

## Restart and recovery

### Workspace ownership

The MCP server acquires an exclusive workspace lock before loading journals and
holds it until queued operations finish and the server shuts down. A second
server for the same canonical workspace fails at startup with an ownership error.
Different workspaces can run independently. This lock coordinates cooperating
MCP servers on one machine; it does not lock out editors or other file writers.

Ownership is recorded in `.transactional-refactor/workspace.lock`. An atomic
`workspace.lock.guard` directory serializes acquisition, stale-owner replacement,
and release. After a process crash, a new server reclaims ownership only if the
recorded local PID no longer exists. A live or reused PID, uncertain process
status, a foreign hostname, or malformed ownership data blocks startup.

If a process dies while changing ownership, the short-lived guard may remain.
Retry first; if the guard persists, stop all servers using the workspace, inspect
the lock, and remove only `workspace.lock.guard` before restarting. For malformed
or otherwise ambiguous ownership, inspect `workspace.lock` and remove it only
after confirming all owners have stopped. Do not remove transaction journals.
Shared workspaces across hosts or PID namespaces are not supported.

The lower-level `TransactionManager` does not acquire this server-lifetime lock.
Applications embedding it must hold `acquireWorkspaceLock()` themselves when
sharing persistent journals.

### Pending transactions

The MCP server saves transaction records under `.transactional-refactor/` in the
workspace. Keep this directory out of version control: it contains full original
and staged file contents. Staging writes this metadata but does not change source
files. The lower-level `TransactionManager` enables journals with its third
constructor argument; the MCP server enables them by default.

After restarting, call `tx_list`, then `tx_status` and `tx_diff`. Active work can
be resumed with its original ID. Previously verified work returns to `ACTIVE`
and must be verified again. Graceful shutdown also preserves pending work.

An interrupted commit is marked `RECOVERY_REQUIRED`. Call `tx_recover` to restore
its original files before retrying or rolling back. Recovery checks every target
first and refuses to overwrite content that matches neither the original nor
the staged version. Successful recovery leaves the proposed edits staged in an
`ACTIVE` transaction. Recovery can be retried if it is interrupted. A surviving
`COMMITTED` journal indicates that source installation finished before shutdown;
inspect its status and any reported backup directories.

## Architecture

- `src/vfs/transaction-manager.ts`: copy-on-write buffers, snapshots,
  conflict detection, replacement and recovery.
- `src/verifier/verification-pipeline.ts`: compiler overlays, project discovery,
  project references, and baseline/staged diagnostic comparison.
- `src/lsp/lsp-supervisor.ts`: standalone language-server adapter, retained for
  LSP integration use; the MCP commit gate uses the compiler pipeline.
- `src/index.ts`: strict MCP tool schemas, workspace checks, and the commit gate.

See [CONFIGURATION.md](CONFIGURATION.md) for Inspector, Cursor,
Windsurf/Cascade, and Codex setup.

## Tests

```sh
npm run typecheck
npm test
npm run test:vfs
npm run test:lsp
npm run test:verify
npm run test:mcp
```

Integration tests launch real language-server and MCP subprocesses. Tests cover
unchanged dependents, project references, virtual module resolution, exact-edit
conflicts, file operations, restart persistence, and a child process exiting
mid-commit. Temporary source fixtures confirm that staging and verification do
not alter source files. CI runs on Windows and Linux with Node 20 and 24.

## Current limits

This is a v0.2 prototype, not a production durability or security boundary.

- Verification checks TypeScript diagnostics, not runtime behavior, lint rules,
  or tests. Nonstandard project config names must be reached through a project
  reference. Discovery skips dependencies, Git metadata, journals, and `dist`.
- UTF-8 regular files only. Symlinks and hard-linked files are rejected for
  mutation; case-only renames on Windows are not supported.
- A trusted workspace and cooperating writers are required. Path checks do
  not prevent hostile concurrent filesystem changes.
- Multi-file commits are not crash-atomic. Each file is replaced separately,
  with compensating rollback on ordinary failures and explicit journal recovery
  after a process crash. This is not a power-loss durability guarantee. Preserve
  reported recovery directories. Failed commits may leave empty new directories
  or preparation files if the process exits before recording their paths.
- Permission bits are preserved; ownership, ACLs, extended attributes, and
  inode identity are not guaranteed.
- Verification runs two compiler passes and can be slow on large workspaces.
  It uses the bundled TypeScript version, not a workspace-specific compiler.
- The workspace lock admits one cooperating MCP server per workspace on a local
  machine. External writers must remain idle during verification and commit.
- The raw VFS `commit()` is a lower-level primitive. The verification gate is
  enforced by the MCP `tx_commit` tool.

## License

No license has been selected. No open-source license grant is implied.
