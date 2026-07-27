#!/usr/bin/env python3
"""Attach a PERSISTENT native zellij client (NOT under Porterminal) to a session
at a fixed winsize, to stand in for a laptop's GNOME Terminal. Writes its pid to
argv[4] and stays attached, draining output, until killed."""
import fcntl
import os
import pty
import select
import struct
import sys
import termios

session, cols, rows, pidfile = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]

pid, fd = pty.fork()
if pid == 0:
    os.environ.pop("ZELLIJ", None)
    os.environ.pop("ZELLIJ_SESSION_NAME", None)
    os.environ["TERM"] = "xterm-256color"
    os.chdir("/home/manoharkuse")
    os.execvp("zellij", ["zellij", "attach", session])
    os._exit(127)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
with open(pidfile, "w") as f:
    f.write(str(pid))
while True:
    r, _, _ = select.select([fd], [], [], 1.0)
    if r:
        try:
            if not os.read(fd, 65536):
                break
        except OSError:
            break
