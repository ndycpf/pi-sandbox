# OpenSSH outer workspace (pending real-VM verification)

Use a separately provisioned **dedicated Linux development VM** with a unique
Ed25519 server host key and an unprivileged development account. Verify its
mounts, credentials and network policy through the provisioner. A successful
SSH login alone does not establish those properties. The extension neither
creates the VM nor configures the local executor. The SSH client must be
available at /usr/bin/ssh. The VM needs Python 3, systemd-detect-virt, procfs
and Bash. The guest helper rejects a root login.

Install ssh-guest.py from this directory as an administrator-owned file, for
example at /usr/local/libexec/pi-sandbox-guest.py. Restrict the dedicated
SSH credential to that forced command and disable all forwarding, PTY and
user startup hooks. Keep the access policy and helper outside the guest
account's write permissions. One example forced command for /work/project is
`/usr/bin/python3 -I /usr/local/libexec/pi-sandbox-guest.py /work/project`.
Configure sshd and the account shell/startup files so the account cannot
override the forced command. Keep the private key and trusted deployment
extension outside agent-readable/writable locations; enforce this in the
operator's ordinary Bash **and native file-tool policies**. Do not deploy the
adapter into a workspace that can retrieve the private key.

Obtain the VM host public key independently through the provisioning channel.
Use a dedicated, operator-managed known-hosts file containing exactly
`pi-guardian-vm ssh-ed25519 PUBLIC_KEY`. Do not learn keys on first connection.
Obtain the boot ID from /proc/sys/kernel/random/boot_id and the decimal
device:inode from `stat -Lc '%d:%i' /work/project` inside that same VM. The
combined identity is BOOT_UUID:DEVICE:INODE. Reprovision out of band after
a reboot or directory replacement. Never reuse the server key across clones.

Load an operator-owned Pi extension instead of the default entrypoint:

```ts
import { sshWorkspace, withOuterWorkspace } from "/trusted/pi-sandbox/index.ts";

export default withOuterWorkspace(sshWorkspace({
  host: "dev-vm.example", user: "pi_dev", port: 22,
  knownHosts: "/trusted/guardian/known_hosts",
  identityFile: "/trusted/guardian/id_ed25519",
  identity: "REPLACE_WITH_BOOT_UUID:DEVICE:INODE", cwd: "/work/project",
}));
```

Start Pi from the matching local path with `-e /trusted/vm-extension.ts`,
the offline review provider, your own
`--sandbox-review-prompt /trusted/reviewer.txt`, `--sandbox-review-model PROVIDER/MODEL` and
`--sandbox-review-workspace BOOT_UUID:DEVICE:INODE`. Host files and VM files
at the same path can have different contents. Reviewed commands see the VM
files. The guest opens and pins the configured directory, checks the boot
identity, and waits for a one-shot start message on the authenticated SSH
channel. Bash receives the reviewed argv, with PATH=/usr/bin:/bin and HOME
set to the configured directory. Output is capped at 64 KiB in total.

There are no SSH retries. Losing the connection after dispatch leaves the
operation's effects uncertain. Foreground jobs are supervised by process
group until exit, disconnect or a guest-enforced deadline. The adapter does
not reverse completed writes or recall detached jobs in other process groups.
Use a guest-level workload supervisor when detached jobs must also be killed.

For release validation, use disposable, separate local and VM fixtures. Drive
the registered Bash tool from real Pi, with a deterministic offline reviewer.
Use an append-only fixture marker to count exactly one approved invocation.
For denied, reviewer-error and pre-dispatch cancellation requests use separate
markers and check their absence inside the VM. Check a wrong boot ID and cwd
also fail before launch. Finally issue ordinary Bash and verify its OS policy
and local fixture independently. Mock transport tests do not satisfy this gate.
