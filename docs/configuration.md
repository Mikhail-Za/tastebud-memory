# Configuration

Configuration is read from `TASTEBUD_CONFIG`, otherwise from `tastebud.config.json` in the working directory or beside the engine. Relative paths resolve against the configuration directory.

```json
{
  "workspaceId": "team-workspace",
  "workspaceDir": "/private/workspace",
  "dataDir": "/private/workspace/tastebud-data",
  "memoryDb": "/private/workspace/tastebud-data/memory.sqlite",
  "logDirs": ["/private/workspace/memory/daily", "/private/workspace/memory/archive"],
  "projectsDir": "/private/workspace/memory/projects",
  "candidatesDir": "/private/workspace/memory/project-candidates",
  "memorySourceDirs": ["/private/workspace/memory"],
  "timezone": "America/Chicago",
  "dimensions": 4096,
  "localModel": null,
  "notifyArgs": null
}
```

| Field | Contract |
|---|---|
| `workspaceId` | Stable logical identity, independent of machine paths. Required by the lifecycle store. Do not reuse it for unrelated workspaces. |
| `workspaceDir` | Root containing captured Markdown sources. Source paths must resolve inside it. |
| `dataDir` | Existing directory containing `codebook.json` and `compositions.json`. |
| `memoryDb` | SQLite database; defaults to `<dataDir>/memory.sqlite`. |
| `logDirs` | Existing daily/archive directories; duplicate dates across directories are ambiguous and rejected. |
| `projectsDir`, `candidatesDir` | Existing directories required for candidate operations. |
| `memorySourceDirs` | Directories scanned recursively by `sync`; use only intended source directories, never the full home directory. |
| `timezone` | One IANA business timezone for day maturity, lookback, and decisions. Default UTC. |
| `dimensions` | Integer >=64; default4096. Only affects experimental fingerprints. |
| `inboxProducer` | Configured writer label; default `inbox-unverified`. Inbox self-labels are assertions, not proof of supervision. |
| `legacyRows` | Optional date-to-SHA256 map of individually reviewed legacy composition rows; exceptions remain visible. |
| `localModel` | Optional `{url, model, key?}` completion endpoint. Null disables fallback. Dry runs never call it. |
| `notifyArgs` | Executable and argv array; whole arguments `{message}` and `{id}` are substituted without a shell. |
| `notifyAckPattern` | Optional regex matching a delivery receipt on stdout. Default contract is successful process exit. |
| `gitCheckpoint` | Explicit opt-in to weekly path-limited Git commits; default off. |
| `backupPaths` | Additional workspace directories containing pending queues to include in portable backups. |
| `projectRoots` | Optional absolute working-directory-to-project map for capture hooks. |
| `captureDefaultProject` | Existing project receiving otherwise unmapped checkpoints; leave unset to skip them. |
| `transcriptRoots` | Explicit roots from which a hook may read a transcript when the host does not supply the last assistant message. |

`notifyCommand` is retired and rejected. Keep credentials in private configuration or host environment configuration. Do not commit them into this repository.

Codebook entries support `aliases`, `parent`, `class`, explicit `document_path`, and optional `canonical_slug`. A redirect must resolve to an existing project and cannot cycle. Alias names are Unicode-normalized, case-insensitive, and unique across logical projects. Historical vector keys remain intact after redirects. Run `sync` after changing the codebook to update the lifecycle identity registry.

Relevant environment variables:

- `TASTEBUD_CONFIG`: exact configuration path.
- `TASTEBUD_PRODUCER`: client/CLI writer attribution.
- `TASTEBUD_WRITES=1`: expose MCP write tools.
- `TASTEBUD_TOOL_PREFIX`: optional compatibility prefix for exact-query MCP names; lifecycle names remain `memory_*`.
- `TASTEBUD_NO_DIGEST=1`: suppress nightly digest delivery.
- `TASTEBUD_LOOKBACK_DAYS`: bounded nightly retry window (default10).
- `TASTEBUD_STALE_DAYS`: age before a missing log is called stale (default2).
- `TASTEBUD_CANDIDATE_COMPANION_MAX`: bounded candidate co-occurrence ceiling in [0,1], default0.30.

Keep fallback failure, storage integrity, source coverage, delivery receipts, and retrieval usefulness as separate health signals. A successful tag does not prove all five are healthy.
