# Transactional Refactor MCP

Experimental TypeScript/JavaScript refactoring server for MCP coding agents.

Changes are staged in an isolated in-memory filesystem, checked through
typescript-language-server, and written only by the MCP commit tool after
successful verification.

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
| `tx_verify` | Report new compiler errors relative to the original baseline |
| `tx_commit` | Reverify and commit only if valid |
| `tx_rollback` | Discard in-memory staging |

Suggested workflow: begin, stage, verify, fix new errors, then commit or
rollback. All schemas reject unknown arguments. Results include structured
JSON and an equivalent text response. Diagnostic lines are one-based.

## Architecture

- `src/vfs/transaction-manager.ts`: copy-on-write buffers, snapshots,
  conflict detection, replacement and recovery.
- `src/lsp/lsp-supervisor.ts`: language-server lifecycle, stdio framing,
  virtual documents, and version-aware diagnostic collection.
- `src/verifier/`: diagnostic set comparison and baseline/staged verification.
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

Integration tests launch a real language server and MCP subprocess. They use
temporary source fixtures and confirm that staging and verification do not
alter disk files. CI runs the suite on Windows and Linux with Node 20 and 24.

## Current limits

This is a v0.1 prototype, not a production durability or security boundary.

- Verification checks staged files, not all unstaged dependents or project
  configuration diagnostics. Unchanged pre-existing errors are allowed.
- Existing UTF-8 regular files only; no file creation, deletion, or rename.
- A trusted workspace and cooperating writers are required. Path checks do
  not prevent hostile concurrent filesystem changes.
- Multi-file commits are not crash-atomic. Each file is replaced separately,
  with compensating rollback on ordinary failures. Preserve any reported
  recovery directories when rollback fails.
- Permission bits are preserved; ownership, ACLs, extended attributes, and
  inode identity are not guaranteed.
- The pinned Node 20-compatible language server emits unversioned push
  diagnostics. Updates restart and replay buffers to prevent stale
  attribution. Verification additionally requests completed syntax and
  semantic passes, so large transactions can be slow.
- Transactions are session-local and disappear after server exit. An MCP
  operation is serialized through verification and commit; this is not a
  cross-process lock.
- The raw VFS `commit()` is a lower-level primitive. The verification gate is
  enforced by the MCP `tx_commit` tool.

## License

No license has been selected. No open-source license grant is implied.
