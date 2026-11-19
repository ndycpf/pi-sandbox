"""Install as an operator-owned OpenSSH forced command on a dedicated Linux VM."""
import base64
import json
import os
import selectors
import signal
import subprocess
import sys
import time


def main():
    if os.geteuid() == 0 or os.environ.get("SSH_ORIGINAL_COMMAND") != "pi-sandbox-reviewed-bash-v1":
        raise ValueError("expected a restricted non-root SSH key")
    # A hypervisor check supplements the operator-authenticated unique VM host key.
    subprocess.run(["/usr/bin/systemd-detect-virt", "--vm", "--quiet"], check=True)
    cwd = sys.argv[1]
    fd = os.open(cwd, os.O_DIRECTORY | os.O_NOFOLLOW | os.O_RDONLY)
    directory = os.fstat(fd)
    with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as f:
        identity = f"{f.read().strip()}:{directory.st_dev}:{directory.st_ino}"
    signal.alarm(10)
    request = json.loads(sys.stdin.buffer.readline(65537))
    boundary = request["boundary"]
    argv = request["command"]
    timeout = boundary["timeoutSeconds"]
    if (boundary["identity"] != identity or boundary["kind"] != "outer-workspace"
            or request["cwd"] != cwd or not os.path.isabs(cwd)
            or type(timeout) is not int or not 1 <= timeout <= 60
            or len(argv) != 5 or argv[:4] != ["/bin/bash", "--noprofile", "--norc", "-c"]
            or not isinstance(argv[4], str) or not 0 < len(argv[4].encode()) <= 8192):
        raise ValueError("workspace or action mismatch")
    print("READY", flush=True)
    if sys.stdin.buffer.readline(5) != b"RUN\n":
        return
    signal.alarm(0)
    # Closing the SSH channel cancels a running foreground command. The guest
    # deadline is independent of network connectivity.
    signal.signal(signal.SIGHUP, lambda *_: sys.exit(1))
    run(argv, fd, cwd, timeout)


def run(argv, fd, cwd, timeout):
    output = bytearray()
    truncated = False
    child = subprocess.Popen(argv, cwd=f"/proc/self/fd/{fd}", start_new_session=True,
                             env={"PATH": "/usr/bin:/bin", "HOME": cwd}, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + timeout
        with selectors.DefaultSelector() as poll:
            poll.register(sys.stdin.buffer, selectors.EVENT_READ)
            poll.register(child.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                # After both output streams close, still supervise the process.
                for key, _ in poll.select(min(remaining, 0.1)):
                    if key.fileobj is sys.stdin.buffer:
                        raise ConnectionError("channel closed")
                    chunk = os.read(child.stdout.fileno(), 8192)
                    if not chunk:
                        poll.unregister(child.stdout)
                    else:
                        room = 65536 - len(output)
                        output.extend(chunk[:room])
                        truncated |= len(chunk) > room
                if (child.stdout.fileno() not in poll.get_map() and
                        os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)):
                    break
    finally:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
    print(json.dumps({"exitCode": child.returncode, "output": base64.b64encode(output).decode(),
                      "truncated": truncated}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(1)
