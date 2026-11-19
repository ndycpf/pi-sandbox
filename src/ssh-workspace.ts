import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import type { OuterWorkspace } from "./review-boundary.ts";

/** All values are supplied by the operator's trusted deployment extension. */
export function sshWorkspace(
  config: Readonly<{
    host: string;
    port?: number;
    user: string;
    knownHosts: string;
    identityFile: string;
    identity: string;
    cwd: string;
  }>,
): OuterWorkspace {
  const { host, port = 22, user, knownHosts, identityFile, identity, cwd } = config;
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host) ||
    !/^[a-z_][a-z0-9_-]*$/.test(user) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !isAbsolute(cwd) ||
    ![knownHosts, identityFile].every((path) => /^\/[a-zA-Z0-9_./-]+$/.test(path)) ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:[0-9]+:[0-9]+$/.test(identity)
  )
    throw Error("Invalid provisioned SSH workspace configuration.");
  const args = [
    "-T",
    "-F",
    "/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "UserKnownHostsFile=" + knownHosts,
    "-o",
    "HostKeyAlias=pi-guardian-vm",
    "-o",
    "HostKeyAlgorithms=ssh-ed25519",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ConnectTimeout=5",
    "-i",
    identityFile,
    "-p",
    String(port),
    "-l",
    user,
    "--",
    host,
    "pi-sandbox-reviewed-bash-v1",
  ];
  return Object.freeze<OuterWorkspace>({
    identity,
    async execute(action, signal) {
      signal.throwIfAborted();
      if (action.cwd !== cwd || action.boundary.identity !== identity)
        throw Error("SSH workspace changed.");
      const child = spawn("/usr/bin/ssh", args, {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "ignore"],
      });
      return new Promise((resolve, reject) => {
        let ready = false;
        let data = Buffer.alloc(0);
        function stop() {
          child.kill("SIGKILL");
        }
        signal.addEventListener("abort", stop, { once: true });
        child.once("error", reject);
        child.stdin.on("error", stop);
        child.stdout.on("data", (chunk: Buffer) => {
          if (data.length + chunk.length > 96000) {
            stop();
            return;
          }
          data = Buffer.concat([data, chunk]);
          if (!ready && data.includes(10)) {
            if (data.toString() !== "READY\n" || signal.aborted) {
              stop();
              return;
            }
            ready = true;
            data = Buffer.alloc(0);
            child.stdin.write("RUN\n");
          }
        });
        child.once("close", (code) => {
          signal.removeEventListener("abort", stop);
          try {
            signal.throwIfAborted();
            if (code !== 0 || !ready)
              throw Error("SSH guest unavailable or interrupted; no retry.");
            const result = JSON.parse(data.toString());
            if (!Number.isInteger(result.exitCode) || typeof result.output !== "string")
              throw Error("Invalid guest result.");
            resolve({
              exitCode: result.exitCode,
              output:
                Buffer.from(result.output, "base64").toString("utf8") +
                (result.truncated ? "\n[output truncated]" : ""),
            });
          } catch (err) {
            reject(err);
          }
        });
        child.stdin.write(JSON.stringify(action) + "\n");
      });
    },
  });
}
