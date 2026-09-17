# pi-subagent-permission-compat

English | [简体中文](./README.zh-CN.md)

A [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) compatibility patch package for third-party subagent extensions. It provides two independent capabilities:

1. **Parent-session environment compatibility** — publishes `PI_SUBAGENT_PARENT_SESSION` for root Pi processes, so subagent child processes that inherit the environment can route their permission asks back to the parent session.
2. **Subagent cwd guard** — reviews the `cwd` values in subagent tool-call input and asks for a one-shot approval whenever a value does not match the current working directory.

**Permission-extension compatibility**

- This extension exists for compatibility with [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system): it sets the `PI_SUBAGENT_PARENT_SESSION` variable described above. See its [subagent integration guide](https://github.com/gotgenes/pi-packages/blob/main/packages/pi-permission-system/docs/subagent-integration.md).
- In short, it is a compatibility patch for subagent extensions that do not follow this convention themselves.
- This package does not install, import, or query that permission extension, and the cwd guard does not depend on it.
- The compatibility only takes effect once the permission extension is installed and enabled.

Both capabilities are always on and need no configuration: the package adds no commands, tools, config files, or persistent rules.

## Features

### 1. Parent-Session Environment Compatibility

At `session_start`, when the current process is a root session, the extension publishes:

```text
PI_SUBAGENT_PARENT_SESSION=<current session ID>
```

Child processes started with the inherited environment can then locate the parent session.

Publication is skipped when either condition holds:

- The environment already contains a third-party subagent marker, meaning the current process is itself a subagent child.
- The environment already declares a parent session.

The value is removed again on `session_shutdown` (for example `/new`, `/resume`, fork, or `/reload`), so a stale session ID never survives a session switch. Only a value that this extension wrote is removed; a value set or changed by anything else is left untouched.

See [Recognized Environment Variables](#recognized-environment-variables) for the constants that define them.

### 2. Subagent cwd Guard

Tool calls whose name contains `subagent`, `delegate`, `spawn`, or `agent` (case-insensitive) are inspected. Every `cwd` field found anywhere in the input tree is evaluated:

| `cwd` value                                           | Result                                       |
|-------------------------------------------------------|----------------------------------------------|
| missing, `null`, or `""`                              | allowed silently                             |
| non-empty string identical to the current directory   | allowed silently                             |
| non-empty string different from the current directory | approval prompt (`Deny` / `Allow once`)      |
| any other type (number, boolean, object, array, …)    | approval prompt (`Deny` / `Allow once`)      |
| input that cannot be scanned safely                   | hard block, cannot be overridden by the user |

Behavior details:

- Comparison is strict equality of the raw strings: neither the tool input nor the current directory is trimmed, normalized, or rewritten. See [Notes and Limitations](#notes-and-limitations).
- One prompt covers the whole tool call and lists every discovered `cwd`, including nested occurrences such as `$["tasks"][0]["cwd"]`.
- Approval applies to that single call only. Nothing is persisted and no rule is written, so an identical call asks again next time.
- Only the exact `Allow once` answer approves. `Deny`, cancelling the prompt, a closed prompt, an unknown response, or a prompt failure all block the call.
- Without an interactive UI (print and JSON modes, or a headless subagent), every ask blocks instead of prompting.
- Batch and chained subagent parameters are decided as one call: if any `cwd` is not approved, the entire call is blocked.

## Installation

Install as a Pi package:

```bash
# From npm
pi install npm:pi-subagent-permission-compat

# From this GitHub repository
pi install git:github.com/gszj2018/pi-subagent-permission-compat
```

## Usage

Both features are active as soon as the package is installed; there is nothing to enable per session, and no configuration is required.

- **Parent-session environment compatibility** — nothing to configure. See the compatibility note above if you also use a permission extension.
- **Subagent cwd guard** — nothing to configure. In an interactive session, a subagent tool call that uses a different working directory asks you once per call, and you answer with `Allow once` or `Deny`.

### Recognized Environment Variables

The exact variables are defined by the exported constants in [`extensions/parent-session-env.ts`](./extensions/parent-session-env.ts):

- `THIRD_PARTY_SUBAGENT_ENV_HINTS` — markers published by third-party subagent extensions inside child processes; any of them marks the current process as a subagent child and skips publication.
- `SUBAGENT_PARENT_SESSION_ENV_CANDIDATES` — variables that already carry a parent-session declaration; any of them makes this extension leave the environment untouched.
- `PARENT_SESSION_ENV_VAR` — the single variable this extension writes.

"Present" means the variable is defined at all: empty strings, whitespace, `"0"`, and `"false"` all count as already set, so an existing declaration always wins and is never rewritten by this extension.

If the host hands over an unusable (blank) session ID, the extension shows a warning notification, publishes nothing, and the cwd guard keeps working normally.

## Notes and Limitations

- The cwd guard is **not a sandbox**. It only reviews `cwd` fields that are visible in the current tool-call input, and it cannot restrict what a subagent does afterwards.
- Tool names are matched loosely. Unrelated tools whose name merely contains `agent` may also be inspected, while subagent launchers with other names are not inspected at all.
- Agent-config default working directories, worktrees created inside a tool, later directory changes, and calls made by a wrapper are not covered.
- Comparison is strict raw-string equality, not "the same real directory". Case differences, trailing or repeated separators, `.`/`..` segments, backslash versus slash, surrounding whitespace, and relative-versus-absolute spellings all trigger a prompt instead of being auto-approved; a path such as `link/..` is never silently accepted. When both sides are byte-identical, even a non-canonical string is allowed.
- `cwd` values that are missing, `null`, or `""` are allowed by design. That is a convenience, not proof that the caller really uses the current directory.
- Inputs that cannot be safely scanned — nesting beyond 10 container levels, containers that are not plain JSON objects or arrays, unusual array keys, or unreadable members — are hard blocked and the user cannot approve them.
- Without an interactive UI (print and JSON modes, or a headless subagent), asks are blocked instead of prompting; this extension has no other approval path.
- Approvals are one-shot and stay inside this extension: they are not cached for the session and not shared with other extensions. Another extension may still reject the same call.
- Environment publication only reaches child processes that inherit the environment (for example direct `spawn`/`fork`). Processes with a replaced environment, long-running daemons, remote launches, and in-process subagents sharing one `process.env` are not covered.

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Type-check
npm run typecheck
```

To load the extension locally without packaging, run pi from the repository root:

```bash
pi -e ./extensions/index.ts
```

The project is written in TypeScript and uses the Node.js built-in test runner.

## Project Structure

```text
pi-subagent-permission-compat/
├── extensions/
│   ├── index.ts                   # Extension entry point (composition only)
│   ├── extension-meta.ts          # Shared extension label
│   ├── feature-parent-session.ts  # Parent-session lifecycle registration
│   ├── feature-cwd-guard.ts       # Tool-call registration and approval flow
│   ├── parent-session-env.ts      # Environment detection and owned-value cleanup
│   ├── cwd-ident.ts               # Tool-name matching
│   ├── cwd-inspection.ts          # cwd collection
│   ├── cwd-guard.ts               # Per-value evaluation and blocking decision
│   ├── cwd-prompt.ts              # Prompt formatting and select-based approval
│   └── diagnostics.ts             # Safe value and error display helpers
└── tests/                         # Unit and integration tests
```

## License

[MIT](./LICENSE)
