# pi-sandbox

Sandbox for [pi](https://pi.dev/).

Sandboxes pi like this:
- read/write/edit: checked by a bundled permission provider, with an optional external provider
- bash: uses [`@carderne/sandbox-runtime`](https://www.npmjs.com/package/@carderne/sandbox-runtime) to control network and file system access

A blocked operation returns a refusal immediately. The extension does not open an
approval dialog, change permissions or rerun the command on denial. The agent can
make a new sandboxed call, which is evaluated against the policy in effect then.

![demo](./demo/demo.gif)

## Notes
There is an example config at [sandbox.json](./sandbox.json). It was quite a few things added to get this extension to work with [agent-browser](https://agent-browser.dev/) and other common tools.

These open significant security loopholes, so shouldn't be used in a sensitive context or when you don't need browser support.

You may need to trial and error to find additional things you need to allow.

## Quickstart

#### Prerequisites

`pi-sandbox` delegates the OS-level bash sandbox to
[`@carderne/sandbox-runtime`](https://www.npmjs.com/package/@carderne/sandbox-runtime),
published from the fork at <https://github.com/carderne/sandbox-runtime>,
which is forked from Anthropic's
[`anthropic-experimental/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime).
The sandbox runtime checks for [`ripgrep`](https://github.com/BurntSushi/ripgrep) (the
`rg` binary) on **both macOS and Linux** at sandbox-init time. If `rg`
is not on the `PATH` that pi was launched with, sandbox initialization
fails with:

```
Sandbox initialization failed: Sandbox dependencies not available: ripgrep (rg) not found
```

Install ripgrep before enabling the extension:

| Platform | Install |
|---|---|
| macOS (Homebrew) | `brew install ripgrep` |
| macOS (MacPorts) | `sudo port install ripgrep` |
| Linux (Debian/Ubuntu) | `sudo apt install ripgrep` |
| Linux (Fedora/RHEL) | `sudo dnf install ripgrep` |
| Linux (Arch) | `sudo pacman -S ripgrep` |
| From source / other | <https://github.com/BurntSushi/ripgrep#installation> |

Experimental Android/Termux support uses the Linux backend and requires `ripgrep`,
`which`, `socat`, and a [compatible `bwrap`](https://gist.github.com/spurreiter/caa34d367b7ebbd82806a640bf41157a).
Support depends on the device's kernel and isolation capabilities.

If `which rg` succeeds in your shell but pi still reports `rg not
found`, pi is being launched from a parent process whose `PATH` does
not include the directory containing `rg` (common when GUI launchers
inherit a minimal non-login `PATH`). On macOS, `/opt/homebrew/bin` and
`/usr/local/bin` are the usual culprits — make sure your launcher's
environment includes whichever one your install uses.

#### Install
```bash
pi install npm:pi-sandbox
```

#### Configure
Add a config like this either to Pi's global agent directory (by default, `~/.pi/agent/sandbox.json`; respects `PI_CODING_AGENT_DIR`) or to `.pi/sandbox.json` (local).
The global agent configuration is the trust anchor and must be managed by the
human outside the agent's write authority. For a trusted project, review
`.pi/sandbox.json` and place its exact byte digest in the global file, e.g.

```json
{"approvedProjectFiles":{"/absolute/project/.pi/sandbox.json":"<64 lowercase SHA-256 hex digits>"}}
```

Use `sha256sum` (Linux) or `shasum -a 256` (macOS) on the reviewed file.
Project `.pi/settings.json` also needs its own entry when it supplies
`shellPath` or `shellCommandPrefix`. A changed, missing pinned, or unapproved
policy file prevents that session from starting its sandbox policy. Reload
checks the digest again. The digest does not establish who wrote the file.
Pi itself loads extensions, settings and context through its own lifecycle;
this check only authorizes configuration consumed by pi-sandbox.

The session keeps the accepted policy, provider selection and shell settings
in memory. An approved manual grant adds the selected value to the session.
Saving a grant refuses a changed configuration file; a saved project file
needs human review and a new pin before another session accepts it.
`allowProcessSignals`, provider selection and project approval pins are global-only.
Project and global allow/deny lists are combined after approval.

Native file policy supports `*` (including path separators). `?` and bracket
expressions are literal characters there. Linux shell write rules need concrete
paths; the runtime drops general globs. Use literal write rules when both
shells and native tools must enforce the same restriction.

Note below that the order of precedence for filesystem read and write are opposite.

```json
{
  "enabled": true,
  "enableAccessRequestTool": false, // Enable sandbox_status and sandbox_request_access
  "sandboxUserShell": false,       // Sandbox commands entered with `!`. Defaults to true
  "permissionPromptTimeoutSeconds": 600, // Defaults to 10 minutes; 0 waits indefinitely
  "allowBrowserProcess": true,     // If you want to use agent-browser or similar Chrome setup
  "network": {
    "allowLocalBinding": true,     // ditto
    "allowAllUnixSockets": true,   // ditto
    "allowUnauthenticatedSocksProxy": true, // Enables Git-over-SSH on macOS
    "disabled": false,             // Set true for direct network access (no proxy/--unshare-net) while keeping filesystem sandboxing
    "allowSSHAgentSocket": true, // Allow the current SSH agent socket (macOS SSH commit signing)
    "allowedDomains": ["github.com", "*.github.com"],
    "deniedDomains": []
  },
  "filesystem": {
    // For READS:
    // - Shell reads use the runtime deny list with read exceptions
    // - Explicit allowRead entries override denyRead
    // - denyRead is not a hard-block; it just marks regions as denied by default
    "denyRead": ["/Users", "/home"],
    "allowRead": [".", "~/.config", "~/.local", "Library"],

    // For WRITES:
    // - allowWrite also grants read access to the same paths
    // - empty ALLOW means no write access at all
    // - DENY takes precedence and is never prompted
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

#### Usage

```
pi --no-sandbox                  disable sandboxing for the session
Alt+S                            toggle sandboxing on/off for the session
/sandbox                         show current configuration and session allowances
/sandbox-history                 show recent session execution and policy outcomes
/sandbox-enable                  enable the sandbox for this session
/sandbox-disable                 disable the sandbox for this session
/sandbox-allow domain <url>      prompt to add a domain to allowedDomains
/sandbox-allow read <path>       prompt to add a path to allowRead
/sandbox-allow write <path>      prompt to add a path to allowWrite
```

With `enableAccessRequestTool: true`, the agent can use `sandbox_status` to inspect
current rules, including session-only grants, and `sandbox_request_access` to ask
for additional access with a reason. Already-allowed requests do not prompt.
Approvals return the actual rule and scope to the agent, including any edits you
make in the permission prompt.

## What it does

**Bash commands** are wrapped with `sandbox-exec` (macOS) or `bubblewrap`
(Linux) to enforce network and filesystem restrictions at the OS level. Commands
entered with `!` are sandboxed by default; set `sandboxUserShell` to `false` to
leave those commands unsandboxed.

### Approving a single host command

An agent can explicitly call `unsandbox_bash` with one `command` while the
ordinary sandbox is active. Pi's standard selector shows the shell, the resolved
working directory and the command with each line JSON-quoted. Titles longer
than 32 lines or 2,200 characters are shortened with a visible omission notice.
**Allow once** approves the entire original command, including any omitted text.
**Deny** is selected initially. Use the down arrow to select **Allow once**,
Enter to confirm, or Escape to cancel.
RPC, JSON, print and non-TTY sessions refuse the request.

Approval starts a fresh `/bin/bash` in that directory with a system PATH and
the operator's HOME. It runs without Pi's filesystem or network restrictions,
including its human-managed path rules. Host changes and detached descendants
can outlive the command. Only the exit status is returned. Approval and
execution each have a 60-second limit. Other requests cannot share an approval.
Ordinary Bash and file tools keep their policy throughout.

This assumes the operator controls the interactive terminal and trusts its
host and installed Pi extensions. A party able to drive that terminal or
modify the CLI can act as the operator. Review shell expansions, scripts and
other files a command invokes; approval fixes the command text and directory,
not the contents of referenced files. Sandbox history stores bounded metadata
and a context hash. Pi's own conversation can retain tool arguments.

### Human-managed files

The workspace root's `.pi`, `.agents`, `.skills`, instruction files and
`SKILL.md` are human-managed. The same applies to the active Pi agent
directory, ancestor context entrypoints Pi searches, discovered context and
skill files, literal skill paths in active settings, and Pi's user and trusted
project `.agents/skills` search locations. For example, `examples/.pi/settings.json`
and `test/fixtures/AGENTS.md` follow ordinary workspace write rules unless
they are themselves active resources. Native write/edit also check resolved
targets and refuse multiply linked files. Ordinary grants never exempt managed
paths. External providers must declare the absolute `target` of each write/edit
allow plan (the request includes `mutationPath`) and confine their work to
that target. All extensions share the process. A provider's implementation
is part of the trust boundary.

Sandboxed Bash receives literal write denies for those session paths. The
filesystem runtime must stay enabled. Linux runtime 0.0.80 builds read-only bind mounts for
existing protected paths inside writable roots. For a missing literal it can
mask the leaf with `/dev/null`, or the first missing ancestor with an empty
directory. These mounts can require temporary host placeholders. Known symlink
destinations are included. Other hard-link names and alternate mounts can fall outside these path-based rules. A Linux fixture confirmed read-only mount flags on an existing managed directory,
a known symlink destination and a missing leaf, with its ordinary working directory
still writable. The macOS profile was not exercised on a native host. Explicitly unsandboxed shells have no such OS
restriction. For mandatory protection across all shells, keep the global
trust anchor and human-managed files on a host-enforced read-only mount, or
use an agent OS identity without write access to their files and parent
directories. Pi can load unapproved instructions independently of this extension.

### Native file permissions

With no provider configured, Pi can read, edit and create regular files in the
session working directory under the default rules. The bundled provider checks
Pi's selected path and its resolved target. Reads need an effective read or
write grant. Writes and edits need a write grant; explicit write denies take
precedence. Each new parent directory must also be allowed. Denial ends the call.

These checks run in the Pi process. Pi can probe filename candidates and mutation
queue keys before its public operations hooks. An ancestor can change between a
path check and the actual I/O, and cancellation can leave a partial write.
Bash keeps its separate OS sandbox. If sandbox initialization fails, protected
native tools also refuse to run.

To replace the bundled provider:

1. Install or develop a trusted Pi **user-scope** extension outside the repository.
2. Set `filePermissionProvider` in the global agent directory's `sandbox.json`
   to its exact absolute extension entry path, for example
   `{"filePermissionProvider":"/home/me/.pi/agent/extensions/file-permissions.ts"}`.
3. Load both extensions and reload Pi. Both must be ready in the current session.
   If the SDK filters registered tools, include the provider marker
   `sandbox_file_provider` in its registry. A project setting cannot select a provider. Project-only sandbox disable
   keeps native tools blocked. Explicit user disable restores local Pi execution.

A compatible extension can import the registration helper from this checkout.
This minimal provider serves one virtual file and declines all other operations:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFilePermissionProvider } from "/absolute/path/to/pi-sandbox/index.ts";

export default function (pi: ExtensionAPI) {
  registerFilePermissionProvider(pi, async ({ kind, input, signal }) => {
    if (kind !== "read" || input.path !== "policy-demo.txt" ||
        input.offset !== undefined || input.limit !== undefined) return { decision: "deny" };
    return {
      decision: "allow",
      execute: async () => {
        signal.throwIfAborted();
        return { content: [{ type: "text", text: "Provider is ready." }], details: undefined };
      },
    };
  });
}
```

Prepare the decision without performing I/O on the requested file. Return an
explicit allow plan only when the provider's own policy is active; its execute
function performs the authorized operation once and must honor cancellation.
The adapter checks the winning tool schema, loader-assigned user scope and
entry path, and session identity before dispatch. It rechecks after preparation.
An invalid global selection, missing or stale external provider, refusal, or malformed response ends the call without invoking the bundled provider.
There is no cached grant or fallback to Pi's local file operations.

Pi 0.80.10 exposes tool provenance and schemas through `getAllTools()`.
Its shared event bus has no authenticated sender, and a `tool_call` hook may
return nothing for an unhandled operation. The bundled `permission-gate` and
`protected-paths` examples do not implement this protocol. Existing extensions
need an adapter. All loaded Pi extensions share one process and must be trusted;
this protocol cannot isolate hostile extension code.

When you use `/sandbox-allow` or the optional access-request tool asks for permission, a widget appears above the input editor with
four options. Concurrent requests are queued per extension instance. The widget
accepts input while the main Pi editor (including `CustomEditor` subclasses) has
focus; other dialogs keep their own keyboard input, and permission selection
resumes when they close. Operation cancellation, sandbox disable, and session
shutdown abort pending requests without granting access. The input draft is left
untouched.

Focus inspection uses Pi's `getFocusedComponent()` when available and the
`focusedComponent` instance field on Pi 0.80. If neither is available, the request
fails rather than intercepting input without knowing which dialog owns it.

Permission prompts automatically select **Abort (keep blocked)** after 10 minutes
by default. Set
`permissionPromptTimeoutSeconds` to a positive number to use a different timeout,
or set it to `0` to wait indefinitely. A timeout never grants permission.

- Abort (keep blocked)
- Allow for this session only
- Allow for this project — written to `.pi/sandbox.json`
- Allow for all projects — written to Pi's global agent directory (by default, `~/.pi/agent/sandbox.json`; respects `PI_CODING_AGENT_DIR`)

**Session allowances** are held in memory only. They are never written to disk
and the agent has no way to read or modify them. They are reset when the
extension reloads or pi restarts. Parent agents and subagents have separate
sandbox managers and session allowances; shutting down one does not affect another.

Other running sessions keep their accepted snapshots. Review saved changes
and update any project pin before starting a session with the revised policy.

### Policy decisions

| Rule | Behaviour |
|------|-----------|
| Domain not in `allowedDomains` | Actual connection rejected by the runtime proxy when filtering is enabled |
| Native file call while protected | Bundled file policy, or the explicitly configured external provider |
| Domain in `deniedDomains` | Denied by the runtime proxy before allow rules when filtering is enabled |

Bash filesystem errors do not identify whether a read, write, or execution was
blocked. In particular, `Operation not permitted` does not imply a write failure,
and `command not found` can mean an executable is unreadable inside the sandbox.
Use `/sandbox-allow read <path>` or `/sandbox-allow write <path>` after identifying
the required access, then rerun the command explicitly. Retrying automatically
could repeat side effects from commands that partially completed.

If a path is added to `allowWrite` via a prompt but is also present in
`denyWrite`, it remains blocked. Explicit deny rules take precedence.

`allowedDomains` supports `*.example.com` wildcards. It also supports `"*"` to
allow all domains; pi-sandbox shows a warning when this is configured because it
allows destinations outside the usual allowlist and can be easy to add accidentally. `allowWrite` uses prefix
matching, so `.` covers the entire current working directory. Write access also
implies read access; paths do not need to be repeated in `allowRead`.

`allowUnauthenticatedSocksProxy` is enabled by default on macOS so Git-over-SSH
works with the built-in `nc`. Domain filtering still applies, but another local process
that discovers the temporary proxy port can use it while the sandbox is running.

On macOS, set `"allowProcessSignals": true` in your **global** `sandbox.json`
(by default `~/.pi/agent/sandbox.json`) to let commands signal processes outside
their own sandbox, such as stopping a dev server started by an earlier command.
It is disabled by default and ignored in project-local configuration.
**Security warning:** this also permits signaling unrelated processes the user
has permission to signal, including terminating or suspending other applications
and agents. It is not limited to processes started by Pi. Linux and Windows
behavior is unchanged. Restart Pi after changing this setting; newly wrapped
commands get the permission, while existing processes keep their original policy.

`network.disabled` turns off network sandboxing entirely: no `--unshare-net` and
no proxy, so the sandboxed process gets direct network access via the host's
routing, DNS, and VPN. Filesystem sandboxing is unaffected. This is useful for
tools that don't honour `HTTP(S)_PROXY`/`ALL_PROXY`, mTLS/gRPC/WebSocket edge
cases, or local-network access. It is opt-in and reduces protection — neither `allowedDomains` nor `deniedDomains` filters direct connections in this mode. The extension does not scan shell text for URLs.

`allowSSHAgentSocket` is disabled by default. When enabled, pi-sandbox resolves
`SSH_AUTH_SOCK` to a real path when the sandbox is built and adds that path to
`allowUnixSockets` only if it is an existing Unix socket. This is intended for the
macOS system ssh-agent, whose path changes every boot and whose `/var` location is
a symlink to `/private/var`. Existing `allowUnixSockets` entries are kept. Prefer
this over allowing `/private/var/run` or setting `allowAllUnixSockets`. The option
has no effect when `SSH_AUTH_SOCK` is unset, missing, or not a socket. On Linux,
this setting alone does not make the SSH agent usable.

If neither file configures an array, its built-in defaults apply (see above for
the defaults). Once an array is configured, only its combined global and local
entries are used, so an explicit empty array disables that default.

The footer shows a lock indicator while the sandbox is active.

## Execution history

On Linux and macOS, `/sandbox-history` shows up to 128 observations from the
current session. Each expires after ten minutes. Sandboxed bash and user-shell
records include an execution ID, a digest of the command and context, whether
the wrapper spawned, and its outcome. A nonzero exit or stderr message alone
does not establish an OS policy denial. For read, write and edit, the history
records the tool result reported by Pi.
The history retains no raw command output, file contents or environment.

## Ackowledgements
Based on code from
[badlogic/pi-mono](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts)
by Mario Zechner, used under the
[MIT License](https://github.com/badlogic/pi-mono/blob/main/LICENSE).
