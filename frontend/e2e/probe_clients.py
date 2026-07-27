#!/usr/bin/env python3
"""Ground-truth probe: list every zellij *client* process and its controlling-tty
winsize, marking which are descendants of the Porterminal server listening on a
given port. Zellij renders every attached client at the min(rows) x min(cols),
so comparing these winsizes shows exactly who is shrinking whom."""
import fcntl
import os
import re
import struct
import subprocess
import sys
import termios

port = sys.argv[1] if len(sys.argv) > 1 else "9455"

ss = subprocess.run(["ss", "-ltnp"], capture_output=True, text=True).stdout
srv = None
for line in ss.splitlines():
    if f":{port} " in line:
        m = re.search(r"pid=(\d+)", line)
        srv = int(m.group(1)) if m else None
        break

procs = {}
for e in os.listdir("/proc"):
    if not e.isdigit():
        continue
    pid = int(e)
    try:
        stat = open(f"/proc/{pid}/stat").read()
        ppid = int(stat[stat.rfind(")") + 2:].split()[1])
        raw = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
        cmd = [c.decode("utf-8", "replace") for c in raw if c]
    except Exception:
        continue
    procs[pid] = (ppid, cmd)


def is_desc(pid, anc):
    seen = set()
    while pid > 1 and pid not in seen:
        seen.add(pid)
        if pid == anc:
            return True
        pid = procs.get(pid, (1, []))[0]
    return pid == anc


def winsize(pid):
    try:
        fd = os.open(f"/proc/{pid}/fd/0", os.O_RDONLY | os.O_NONBLOCK | os.O_NOCTTY)
        try:
            r, c, _, _ = struct.unpack("HHHH", fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8))
        finally:
            os.close(fd)
        return f"{c}x{r}"
    except Exception:
        return "?"


rows = []
for pid, (ppid, cmd) in procs.items():
    if cmd and os.path.basename(cmd[0]) == "zellij" and "--server" not in cmd[1:]:
        rows.append((pid, winsize(pid), srv is not None and is_desc(pid, srv), " ".join(cmd)[:34]))

print(f"    [probe] e2e_server_pid={srv}  zellij_clients={len(rows)}")
for pid, ws, under, c in sorted(rows):
    tag = "E2E" if under else "other"
    print(f"      pid={pid:<8} winsize={ws:<8} [{tag}] {c}")
