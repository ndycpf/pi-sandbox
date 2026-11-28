# pi-sandbox

Sandbox for [pi](https://pi.dev/).

Sandboxes pi like this:
- read/write/edit: direct control using allow/deny lists
- bash: uses [`@carderne/sandbox-runtime`](https://www.npmjs.com/package/@carderne/sandbox-runtime) to control network and file system access

Blocked read/write/edit tool calls and detected network requests prompt for
temporary or permanent permission. Bash filesystem failures are returned without
automatically granting permissions or retrying the command.

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
The local config is loaded only when Pi trusts the project. Scalar settings in the local config take precedence over global settings, except `allowProcessSignals`, which is global-only. The
path and domain arrays from both files are combined and deduplicated, so a
project can add permissions without repeating the global configuration. Built-in
defaults are used for an array only when neither file configures it.

On Linux, glob patterns (`*`, `?`, `[...]`) in `allowWrite`/`denyWrite` cannot be
enforced for bash commands (bubblewrap binds concrete paths only), so they are
silently ignored there; use literal paths. A one-time warning is shown if your own
config adds such globs (built-in defaults are excluded). Direct read/write/edit
tools still honor globs on all platforms.

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
    // - ANY read is prompted unless the path is in allowRead or allowWrite
    // - Granting a prompt adds to allowRead, which overrides denyRead
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

**Read, write, and edit tool calls** are intercepted before execution and
checked against the same filesystem policy. The OS-level sandbox cannot cover
these tools because they run directly in the Node.js process rather than in a
subprocess.

When a block is triggered, a permission prompt with four options temporarily
replaces the input editor, like other Pi dialogs; the input draft is restored
afterwards. Concurrent requests are queued per extension instance. Operation
cancellation, sandbox disable, and session shutdown abort pending requests
without granting access.

While a prompt waits, Pi reports it as a blocked permission request: terminals
that support [program status (OSC 7501)](https://www.superlogical.com/rex/docs/build/program-status),
such as Rex, show the session as blocked, and status extensions receive Pi's
`ui_prompt_start` / `ui_prompt_end` events.

Permission prompts automatically select **Abort (keep blocked)** after 10 minutes
by default. Set
`permissionPromptTimeoutSeconds` to a positive number to use a different timeout,
or set it to `0` to wait indefinitely. A timeout never grants permission.

- Abort (keep blocked)
- Allow for this session only
- Allow for this project — written to `.pi/sandbox.json`
- Allow for all projects — written to Pi's global agent directory (by default, `~/.pi/agent/sandbox.json`; respects `PI_CODING_AGENT_DIR`)

In non-TUI hosts with a UI, such as RPC mode (`pi --mode rpc`, for example Orca's
chat view), the same choices are sent to the client as a select dialog. The rule
is the blocked value as shown; editing it needs the TUI. Hosts without a UI have
no dialog, so a blocked request stays blocked.

**Session allowances** are held in memory only. They are never written to disk
and the agent has no way to read or modify them. They are reset when the
extension reloads or pi restarts. Parent agents and subagents have separate
sandbox managers and session allowances; shutting down one does not affect another.

Saved project or global permission changes are not broadcast to other running
sessions' sandbox managers. Restart affected sessions to apply grants or revocations
consistently.

### Host Bash

`host_bash` lets an agent ask the human operator to run one
`command` outside the sandbox. It is off by default. Enable it in the **global**
config only (`~/.pi/agent/sandbox.json`); a `hostBash` entry in a project
`.pi/sandbox.json` is ignored. The tool is registered at session start, so
restart Pi after enabling it.

```jsonc
{
  "hostBash": {
    "enabled": true,
    // Execution limit for one command (1-3600, default 60).
    "timeoutSeconds": 300,
    // Tail of combined stdout/stderr returned to the agent (0-65536, default 16384).
    // 0 returns the exit status only.
    "outputBytes": 16384,
    // Pi modes that may answer the prompt (default ["tui", "rpc"]).
    // Remove "rpc" to refuse host_bash in RPC clients.
    "approvalModes": ["tui", "rpc"],
    // Let host_bash start long-running commands with background: true
    // (default false). See "Host background tasks" below.
    "allowBackground": false
  }
}
```

While the sandbox is active, ordinary `bash` still runs inside it. The
interactive Linux/macOS CLI shows the time limit, how much output the agent
will see, the shell, resolved working directory and JSON-quoted command
lines in Pi's standard selector. **Deny** is selected first. **Allow once** runs
the command once. The prompt is sized for an 80x24 terminal: its text, wrapped
at 80 columns, may take 11 rows, which leaves about 8 short command lines after
the header. A longer command never reaches you: the agent gets a
"command too long" error with the budget and is asked to shorten or split it, so
you do not approve text you could not see in such a terminal. A window smaller
than 80x24, or many extension widgets below the prompt, can still push the top
of the prompt off screen; keep the terminal at least that size. Escape cancels.

In RPC mode (`pi --mode rpc`, for example Orca's chat view) the same prompt is
sent to the client as a select dialog with the same two choices, and no TTY is
needed. Only an exact **Allow once** answer runs the command; a cancelled, timed
out or unexpected answer refuses it. Pi cannot tell whether a person picked the
answer, so this trusts the RPC client to show the prompt to you and relay only
your choice; remove `"rpc"` from `approvalModes` if that does not hold. Print
and JSON sessions, and a TUI without a terminal, cannot approve: the agent is
told that no approval prompt is available rather than that you denied it.

The command runs in a fresh `/bin/bash --noprofile --norc` with stdin closed,
the `PATH` Pi was started with and the operator's HOME, like a command typed in
your own terminal. It has the host user's filesystem and network access, and
nothing it starts is sandboxed. The returned output can include anything the
command prints, so it reaches the model. Approval has a 60-second limit. Changes
or detached processes can outlive the command. This action stores no approval
and does not retry a previous call or change the session's sandbox settings.

**What approval covers.** You approve the command text and working directory
only, not the files and programs it uses. The agent can write to the workspace
and other sandbox-writable locations before asking, so review what the command
will pick up from there, for example:

- programs found through a `PATH` entry the sandbox can write to, such as
  `./node_modules/.bin` or a directory inside the workspace;
- `.git/hooks`, `.git/config` and other repository configuration used by `git`;
- package manager scripts (`package.json`, `Makefile`, `pyproject.toml`, ...);
- scripts or configuration files the command runs or reads from the workspace.

Use a terminal you control with trusted Pi extensions.

#### Auto-review (optional)

With auto-review on, an LLM reviewer looks at each `host_bash` call first, so
routine host commands do not need a prompt every time. It is off by default and,
like the rest of `hostBash`, can only be turned on in the global config:

```jsonc
{
  "hostBash": {
    "enabled": true,
    "review": {
      // "human" (default) prompts for every call. "auto" asks the reviewer first.
      "mode": "auto",
      // Any model Pi can use, as "provider/model-id". Required for "auto".
      // Pi's own credentials are used.
      "model": "anthropic/claude-haiku-4-5",
      // Optional: extra policy text appended to the built-in one, as an
      // absolute path or one starting with ~/.
      "policyFile": "/Users/me/.pi/agent/host-review-policy.md",
      // Limit for one review, including its file checks (5-180, default 60);
      // on expiry you are prompted.
      "timeoutSeconds": 60,
      // The reviewer's thinking level: "off", "minimal", "low", "medium",
      // "high", "xhigh" or "max". Default "low", as in Codex's auto-review;
      // models without reasoning ignore it. Higher levels take longer and
      // count against timeoutSeconds.
      "thinking": "low",
      // Review log at ~/.pi/agent/host-bash-review.log. When a file passes
      // maxBytes (64 KiB-64 MiB, default 1 MiB) it is rotated, keeping `files`
      // files (1-20, default 3, about 3 MiB). "enabled": false writes nothing.
      "log": { "enabled": true, "maxBytes": 1048576, "files": 3 },
      // Optional: absolute paths of the programs the reviewer's read and ls
      // run. By default the first that exists of /bin/sh or /usr/bin/sh,
      // /usr/bin/head or /bin/head, /bin/ls or /usr/bin/ls (macOS and Linux).
      "binaries": { "sh": "/bin/sh", "head": "/usr/bin/head", "ls": "/bin/ls" }
    }
  }
}
```

The reviewer works like the auto-review ("Guardian") in OpenAI Codex, and its
instructions and context are adapted from Codex's open-source reviewer. Its
system prompt is Codex's reviewer template and default security policy
(risk taxonomy, user-authorization scoring, data exfiltration, credential
probing, security weakening, destructive actions), with your `policyFile`
in Codex's extra-policy slot. Its user message has:

- the session transcript as JSON records: your messages, the agent's text and
  tool calls, and tool results (reasoning is left out, and so are `!!`
  commands, which Pi keeps out of model requests). Like Codex, your
  messages are kept first, then the 40 most recent other entries, within
  token budgets; long entries are cut in the middle with a `<truncated ... />`
  marker. Only your messages count as trusted authorization;
- the planned action JSON: `tool`, the exact `command` argv, `cwd`, the
  agent's one-line `reason` as `justification`, `PATH` and `HOME`, the time
  limit and how much output the agent will see.

Like Codex's reviewer, it can check local state before deciding, but only with
two read-only tools: `read` (up to 16 KiB of a text file, with a line offset)
and `ls` (up to 200 entries). As in Codex, they run in a sandbox: `head -c`
and `ls`, by absolute path with a fixed `PATH`, so nothing in the agent's
`PATH` stands in for them. Writes are denied, and the reviewer's sandbox has a
network proxy of its own that allows no host, whatever the session allows.
Reads follow the session's `denyRead`/`allowRead` and `credentials.files`, so
a denied path fails or looks empty. On top of that, the reviewer never reads
secret files even where the sandbox could, because what it reads is sent to
the model provider: `/proc`, `/sys`, `/dev`, `~/.pi/agent/auth.json`,
`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.docker`, `~/.config/gh`,
`~/.config/gcloud`, keychains, `.env*`, `*.pem`/`*.key` and similar, `id_*`,
`.netrc`, `.npmrc`, credentials files. Each path is checked after resolving
symlinks, and the sandbox also denies the listed directories and the
secret-named files under the working directory, so a symlink swapped after
the check still cannot reach them. These rules are rebuilt for every call; if
the working directory has over 50,000 entries the reviewer cannot read
anything, since its secret files cannot all be covered. Only the first 1 MiB
of a file can be checked. Two gaps remain: secret-named files outside
the working directory and those directories are refused by the path check
only, and the sandbox mounts `/proc`, `/sys` and `/dev` itself (there the
reviewer sees only its own process, whose environment holds just `PATH`,
`HOME` and the proxy settings). A review gets at most 8 tool calls and 64 KiB of tool
output. The prompt tells it to look only when the result could change its
decision (for example the target of an `rm -rf` or a script a command runs) and
that what it reads is untrusted evidence. Its checks are listed in the review
log.

It answers with Codex's JSON contract (`outcome` `allow`/`deny`, `risk_level`,
`user_authorization`, `rationale`):

- **allow** runs the command without a prompt. It is the only answer that does.
  Codex's thresholds are also enforced outside the model: an allow rated `high`
  needs `user_authorization` `medium` or `high`, and an allow rated `critical`
  never runs. An allow that breaks them shows you the prompt.
- An error, a timeout, a missing model or credentials, or an answer without a
  valid `outcome` shows you the normal prompt.
- **deny** returns the rationale to the agent with Codex's rejection
  instructions (no workaround; use a safer alternative or ask you), without
  prompting you. If you then approve the action in the chat, the next review
  sees that in the transcript. After 3 denials in a row, auto-review pauses for
  the rest of the session and every call is prompted.

Auto-review is turned on and off only in the global config; restart Pi after
changing it. An `"auto"` config with a bad `model`, `policyFile`, `thinking` or `binaries` entry is not used:
every call is prompted, and Pi shows the error at session start and
`host_bash: human (review config error)` in the status bar.

Some commands always come to you whatever the reviewer would say: `sudo` and
similar, `rm` with `-r` or `-f`, piping into a shell, disk-level tools, paths
or commands that look like credentials (`~/.ssh`, `~/.aws`, keychain,
`gh auth token`, ...), and `eval`/`exec`/base64-decoding. This list is a speed
bump, not a boundary; it is easy to spell the same action another way.

All existing guards still apply: the 80x24 size limit (an oversized command is
refused before review), the working-directory re-check, the time limit and the
output cap. Auto-review runs only where manual approval could, because it can
fall back to you: the TUI on a terminal, or an RPC client when `approvalModes`
includes `"rpc"` (fallback prompts then go to the client's dialog). The status
bar shows `host_bash: auto-review (<model>)`, each auto-approved or denied run
is shown as a notification (in RPC mode, sent to the client), and every review is appended to
`~/.pi/agent/host-bash-review.log` as JSON lines. The log is bounded: past
`maxBytes` it is renamed to `.1` (older files shift to `.2`, ...) and the oldest
beyond `files` is deleted. Pi's own session history under
`~/.pi/agent/sessions/` has no automatic cleanup.

**What auto-review cannot catch.** The reviewer can read files, but it may not
look, and it cannot follow everything a command touches: a harmless-looking
`make test` or `git commit` can run code several files deep, from paths it
cannot read, or fetched at run time. Text in the command, the agent's reason,
tool output, files it reads (which the agent may have written) or your pasted
messages can try to talk it into `allow` (prompt injection). It can misjudge what a command does, especially an
unusual or obfuscated one. Commands it allows run with your full user rights,
and each review sends the command, working directory, `PATH`, the session
transcript (up to roughly 30k tokens) and the files it reads to the model
provider you configured. Use auto-review for convenience
on a machine and model you trust, not as a security boundary; keep `mode:
"human"` where a wrong `allow` would be costly.

### Background tasks

Ordinary `bash` waits for its command. On Linux, anything the command leaves
running with `&`, `nohup` or `setsid` is killed as soon as the command returns,
because bubblewrap ends the sandbox's PID namespace with it. On macOS such
processes survive and stay sandboxed, but Pi no longer tracks them. For dev
servers, watchers and long builds, enable `bash_background` instead:

```jsonc
{
  "backgroundBash": {
    "enabled": true,
    // Background tasks (sandboxed and host) running at once (1-32, default 4).
    "maxTasks": 4,
    // Combined output kept in memory per task (4 KiB-64 MiB, default 1 MiB).
    "bufferBytes": 1048576,
    // Tail of a task's output the agent sees by default (0-1 MiB, default 16 KiB).
    "outputBytes": 16384
  }
}
```

It can be set in the global or the project config, since the tasks run in the
same sandbox as `bash`. The tool is registered at session start, so restart Pi
after enabling it. The agent calls it with an `action`:

- `start` runs `command` in the sandbox and returns a task id at once. Domains
  in the command are checked and prompted for like a `bash` command.
- `list` shows the tasks, `logs` the tail of a task's combined stdout/stderr,
  and `stop` sends SIGTERM to the task's process group, then SIGKILL after 2
  seconds.
- `wait` watches a task until it exits, its new output matches `until` (a
  regular expression), or `timeoutSeconds` pass (default 60, at most 600). The
  task keeps running. `start` takes the same `until` and `timeoutSeconds`, for
  example to return once a dev server prints its ready line. While it waits,
  the call streams the task's output as tool progress, so the TUI and RPC
  clients that show tool calls (such as Orca's chat) show it live. This holds
  the agent's turn, so it suits waiting for readiness or a build, not watching
  a server for its whole life.

While tasks run, the footer shows their count, such as `bg: 2 running (1 host)`,
and a widget below the editor lists up to five of them, one line each
(`bg1 [sandbox] npm run dev`, with `HOST` for host tasks). Both are cleared when
no task runs. They are plain text, so RPC clients get them too, as `setStatus`
and `setWidget` (string lines) UI requests; whether they are shown is up to the
client. `/background` lists the tasks; `/background stop` asks which one to stop
(Pi's selector in the TUI, a select dialog in RPC clients), and
`/background stop <id|all>` stops without asking.

**RPC clients and Orca.** Orca's native chat (and any RPC client that does the
same) drops `notify`, `setStatus` and `setWidget` and shows only dialogs, tool
calls and assistant text. So in RPC mode `/background` lists the tasks in a
select dialog instead of a notification: pick a running task, confirm, and it
is stopped. The agent's `bash_background` calls appear as tool rows there too.
While any task runs, pi-sandbox also reports the session as busy through Pi's
shared session-liveness registry (`@agegr/pi-web/session-liveness/v1`), which
Orca and pi-web ask before stopping an idle Pi; without it, Orca's idle stop
(30 minutes by default) would end the session and its tasks.

When a task exits on its own, its status and output tail are added to the
conversation. Every task is stopped when the session ends (including `/new`
and Pi exiting) and whenever the sandbox is turned on or off, so a task never
outlives the sandbox it started in. Filesystem rules are fixed when a task
starts; domains granted later apply to it, since the network proxy is shared.
While the sandbox is off, `start` runs the command without a sandbox, like
`bash`, and `list` marks it as such. A process that leaves the task's process
group (for example with `setsid` on macOS) is not stopped by `stop`.

#### Host background tasks

With `hostBash.allowBackground: true` in the **global** config, `host_bash`
also takes `background: true`. The command is approved exactly like any other
`host_bash` call (by you, or by auto-review when that is on), and the prompt
says it will run in the background until stopped or Pi exits. It works in the
same Pi modes as `host_bash` itself (`hostBash.approvalModes`: the TUI on a
terminal, and RPC clients when `"rpc"` is listed). Once approved it runs
outside the sandbox until it exits, is stopped with `bash_background stop`, or
the session ends; `hostBash.timeoutSeconds` does not apply. The agent sees at
most `hostBash.outputBytes` of its output. `backgroundBash.maxTasks` counts
host tasks too, and the `bash_background` tool is registered for them even
when `backgroundBash.enabled` is false (then it can list, read and stop tasks,
but not start sandboxed ones).

```jsonc
{
  "hostBash": { "enabled": true, "allowBackground": true }
}
```

### What is prompted vs. hard-blocked

| Rule | Behaviour |
|------|-----------|
| Domain not in `allowedDomains` | Prompted (bash and `!cmd`, unless `sandboxUserShell` is disabled) |
| Path not in `allowRead` or `allowWrite` | Prompted (read tool); granting adds to `allowRead` |
| Path not in `allowWrite` | Prompted (write/edit tools) |
| Path in `denyWrite` | Hard-blocked, no prompt |
| Domain in `deniedDomains` | Hard-blocked at OS level, no prompt |

Bash filesystem errors do not identify whether a read, write, or execution was
blocked. In particular, `Operation not permitted` does not imply a write failure,
and `command not found` can mean an executable is unreadable inside the sandbox.
Use `/sandbox-allow read <path>` or `/sandbox-allow write <path>` after identifying
the required access, then rerun the command explicitly. Retrying automatically
could repeat side effects from commands that partially completed.

If a path is added to `allowWrite` via a prompt but is also present in
`denyWrite`, it remains blocked. A warning is shown explaining which config
files to check.

`allowedDomains` supports `*.example.com` wildcards. It also supports `"*"` to
allow all domains; pi-sandbox shows a warning when this is configured because it
removes per-domain prompts and can be easy to add accidentally. `allowWrite` uses prefix
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
cases, or local-network access. It is opt-in and reduces protection — `allowedDomains`
filtering no longer applies when set.

`allowSSHAgentSocket` is disabled by default. When enabled, pi-sandbox resolves
`SSH_AUTH_SOCK` to a real path when the sandbox is built and adds that path to
`allowUnixSockets` only if it is an existing Unix socket. This is intended for the
macOS system ssh-agent, whose path changes every boot and whose `/var` location is
a symlink to `/private/var`. Existing `allowUnixSockets` entries are kept. Prefer
this over allowing `/private/var/run` or setting `allowAllUnixSockets`. The option
has no effect when `SSH_AUTH_SOCK` is unset, missing, or not a socket. On Linux,
this setting alone does not make the SSH agent usable.

> **⚠️ Read and write have different precedence rules:**
>
> - **Read:** Every read is prompted unless the path is in `allowRead` or `allowWrite`.
>   `denyRead` is not a hard-block — it marks regions as denied by default, but
>   granting a prompt adds the path to `allowRead`, overriding `denyRead`.
> - **Write:** `denyWrite` takes precedence over `allowWrite` and is never
>   prompted. A path in `denyWrite` is always blocked, even if it matches
>   `allowWrite`.

If neither file configures an array, its built-in defaults apply (see above for
the defaults). Once an array is configured, only its combined global and local
entries are used, so an explicit empty array disables that default.

While the sandbox is being turned on or off (at session start, with Alt+S or
`/sandbox-enable`/`/sandbox-disable`), a `bash` call or `!` command waits for
the change to finish and then runs with the state it set, so a command started
during initialization never runs unsandboxed. Background starts are refused
during the change instead.

The footer shows a lock indicator while the sandbox is active.

## Ackowledgements
Based on code from
[badlogic/pi-mono](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts)
by Mario Zechner, used under the
[MIT License](https://github.com/badlogic/pi-mono/blob/main/LICENSE).

The `host_bash` auto-review instructions and context framing
(`src/host-review-prompt.ts`) are adapted from
[OpenAI Codex](https://github.com/openai/codex), Copyright 2025 OpenAI, used
under the Apache License 2.0; see `third-party/openai-codex/`.
