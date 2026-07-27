"""Inspect Zellij clients on Linux: which session, what grid, still alive."""

from __future__ import annotations

import os
import re
import signal
import struct
import subprocess
import sys
import time
from pathlib import Path

from porterminal.domain import TerminalDimensions

if sys.platform != "win32":
    import fcntl
    import termios

# Scanning /proc and shelling out to `ss` is the whole cost of detection
# (~25ms together on a typical desktop). Within one reconciliation pass several
# callers ask overlapping questions about the same moment, so the two raw views
# are collected once and shared for this long rather than per call. Pass
# ``snapshot_ttl=0`` to disable the cache.
SNAPSHOT_TTL_SECONDS = 0.2


class NativeZellijClientDetector:
    """Inspect the Zellij clients running on this machine.

    Answers the three questions the size authority asks: which session a tab's
    shell has attached to, what grids the clients Porterminal does not own are
    using, and whether a tab's client is still alive. It can also end one.

    Zellij renders every attached client at the minimum rows and columns across
    all of them, so a native client (a real terminal, an SSH session) caps the
    grid and must never be shrunk by a browser joining.

    Clients descended from the Porterminal server are excluded throughout: their
    winsize is whatever we pinned it to, not a real device size. Detection needs
    Linux procfs and degrades to "no client found" elsewhere, which leaves
    ordinary browser sizing in effect.
    """

    def __init__(
        self,
        proc_root: Path | str = "/proc",
        server_pid: int | None = None,
        snapshot_ttl: float = SNAPSHOT_TTL_SECONDS,
    ) -> None:
        self._proc_root = Path(proc_root)
        self._server_pid = server_pid if server_pid is not None else os.getpid()
        self._snapshot_ttl = snapshot_ttl
        self._process_cache: list[tuple[int, list[str]]] | None = None
        self._process_cache_at = 0.0
        self._ss_cache: list[tuple[str, str, str, set[int]]] | None = None
        self._ss_cache_at = 0.0

    def refresh(self) -> None:
        """Collect the process and socket views up front, sharing one snapshot.

        Blocking — call this from a worker thread. Every query below then answers
        from the cache for ``snapshot_ttl`` seconds, so a reconciliation pass
        costs one collection no matter how many sessions it inspects.
        """
        processes = self._iter_processes()
        # With no Zellij client anywhere the socket view cannot change any
        # answer, so skip the (comparatively expensive) `ss` call entirely.
        if any(self._is_zellij_client(arguments) for _, arguments in processes):
            self._parse_ss_unix()

    def _is_cache_fresh(self, captured_at: float) -> bool:
        return (time.monotonic() - captured_at) < self._snapshot_ttl

    def has_descendant_client(self, root_pid: int) -> bool:
        """Return whether a Zellij client is running below a PTY shell process."""
        if not sys.platform.startswith("linux") or not self._proc_root.is_dir():
            return False
        return any(
            self._is_zellij_client(arguments) and self._has_ancestor(pid, root_pid)
            for pid, arguments in self._iter_processes()
        )

    def native_client_sizes(self, session_name: str) -> list[TerminalDimensions]:
        """Grids of Zellij clients on ``session_name`` that Porterminal does NOT
        own (native terminals such as GNOME Terminal / SSH sessions).

        Session-scoped: clients are matched to the session by the Unix socket
        they hold open to that session's server, so a native client on a
        *different* session never leaks in. Clients descended from this
        Porterminal server are excluded — their PTY winsize is whatever we
        pinned it to, not a real device size. Returns ``[]`` when there are no
        such clients or the platform/tooling makes detection impossible.
        """
        if not sys.platform.startswith("linux") or not self._proc_root.is_dir():
            return []
        sizes: list[TerminalDimensions] = []
        for pid in self._session_client_pids(session_name):
            if self._has_ancestor(pid, self._server_pid):
                continue
            dimensions = self._read_terminal_dimensions(pid)
            if dimensions is not None:
                sizes.append(dimensions)
        return sizes

    def _parse_ss_unix(self) -> list[tuple[str, str, str, set[int]]]:
        """Cached ``ss -xp`` rows. See :meth:`refresh` for the caching contract."""
        if self._ss_cache is not None and self._is_cache_fresh(self._ss_cache_at):
            return self._ss_cache
        self._ss_cache = self._scan_ss_unix()
        self._ss_cache_at = time.monotonic()
        return self._ss_cache

    def _scan_ss_unix(self) -> list[tuple[str, str, str, set[int]]]:
        """Parse ``ss -xp`` into (local_addr, local_cookie, peer_cookie, pids)
        rows. Returns [] if ss is unavailable."""
        try:
            proc = subprocess.run(
                ["ss", "-xp"], capture_output=True, text=True, timeout=2.0
            )
        except (OSError, subprocess.SubprocessError):
            return []
        rows: list[tuple[str, str, str, set[int]]] = []
        for line in proc.stdout.splitlines():
            fields = line.split()
            if len(fields) < 6 or not fields[0].startswith("u_str"):
                continue
            # u_str STATE recvq sendq LOCAL_ADDR LOCAL_COOKIE PEER_ADDR PEER_COOKIE users:(...)
            local_addr, local_cookie = fields[4], fields[5]
            peer_cookie = fields[7] if len(fields) > 7 else "0"
            pids = {int(m) for m in re.findall(r"pid=(\d+)", line)}
            rows.append((local_addr, local_cookie, peer_cookie, pids))
        return rows

    def _is_session_socket(self, addr: str) -> bool:
        return "zellij" in addr and addr not in ("*", "")

    def _session_client_pids(self, session_name: str) -> set[int]:
        """PIDs of processes holding a client connection to ``session_name``'s
        Zellij server socket, resolved via ``ss -xp`` peer matching."""
        rows = self._parse_ss_unix()
        cookie_pids: dict[str, set[int]] = {}
        server_peer_cookies: set[str] = set()
        for local_addr, local_cookie, peer_cookie, pids in rows:
            if pids:
                cookie_pids.setdefault(local_cookie, set()).update(pids)
            # A server-side socket carries the session socket path; its peer
            # cookie identifies the connected client's socket.
            if Path(local_addr).name == session_name and peer_cookie not in ("0", "*"):
                server_peer_cookies.add(peer_cookie)
        clients: set[int] = set()
        for cookie in server_peer_cookies:
            clients.update(cookie_pids.get(cookie, set()))
        return clients

    def zellij_session_of_pid(self, client_pid: int) -> str | None:
        """The Zellij session name a client process is connected to (via ss)."""
        if not sys.platform.startswith("linux"):
            return None
        rows = self._parse_ss_unix()
        # Cookies of sockets owned by this client, and the server path per cookie.
        client_peer_cookies: set[str] = set()
        path_by_cookie: dict[str, str] = {}
        for local_addr, local_cookie, peer_cookie, pids in rows:
            if self._is_session_socket(local_addr):
                path_by_cookie[local_cookie] = local_addr
            if client_pid in pids and peer_cookie not in ("0", "*"):
                client_peer_cookies.add(peer_cookie)
        for cookie in client_peer_cookies:
            addr = path_by_cookie.get(cookie)
            if addr:
                return Path(addr).name
        return None

    def pty_zellij_client_pid(self, root_pid: int) -> int | None:
        """The Zellij client process running below a PTY shell, if any."""
        if not sys.platform.startswith("linux") or not self._proc_root.is_dir():
            return None
        for pid, arguments in self._iter_processes():
            if self._is_zellij_client(arguments) and self._has_ancestor(pid, root_pid):
                return pid
        return None

    def zellij_session_under_pty(self, root_pid: int) -> str | None:
        """Which Zellij session (if any) a PTY's shell has attached to — however
        it was started (typed, tab-completed, pasted, snippet, shell rc)."""
        client_pid = self.pty_zellij_client_pid(root_pid)
        return self.zellij_session_of_pid(client_pid) if client_pid else None

    def detach_client(self, root_pid: int) -> bool:
        """Detach the Zellij client running under a PTY shell.

        Signals that one client process to exit, which is what detaching is: the
        session's server process is separate and keeps running, so the session and
        its panes survive. Returns whether a client was found and signalled.

        Preferred over writing a detach keybinding to the PTY, which assumes the
        user has not rebound it — a wrong guess types the keystrokes straight into
        whatever application is focused inside the session.
        """
        client_pid = self.pty_zellij_client_pid(root_pid)
        if client_pid is None:
            return False
        try:
            os.kill(client_pid, signal.SIGTERM)
        except OSError:
            return False
        return True

    def _iter_processes(self) -> list[tuple[int, list[str]]]:
        """Cached process table. See :meth:`refresh` for the caching contract."""
        if self._process_cache is not None and self._is_cache_fresh(self._process_cache_at):
            return self._process_cache
        self._process_cache = self._scan_processes()
        self._process_cache_at = time.monotonic()
        return self._process_cache

    def _scan_processes(self) -> list[tuple[int, list[str]]]:
        processes: list[tuple[int, list[str]]] = []
        try:
            entries = self._proc_root.iterdir()
        except OSError:
            return processes

        for entry in entries:
            if not entry.name.isdigit():
                continue
            try:
                raw = (entry / "cmdline").read_bytes()
            except OSError:
                continue
            arguments = [
                part.decode(errors="replace")
                for part in raw.split(b"\0")
                if part
            ]
            if arguments:
                processes.append((int(entry.name), arguments))
        return processes

    @staticmethod
    def _is_zellij_client(arguments: list[str]) -> bool:
        if not arguments or Path(arguments[0]).name != "zellij":
            return False
        return "--server" not in arguments[1:]

    def _has_ancestor(self, pid: int, ancestor_pid: int) -> bool:
        seen: set[int] = set()
        current_pid = pid

        while current_pid > 1 and current_pid not in seen:
            if current_pid == ancestor_pid:
                return True
            seen.add(current_pid)
            parent_pid = self._read_parent_pid(current_pid)
            if parent_pid is None or parent_pid == current_pid:
                return False
            current_pid = parent_pid

        return current_pid == ancestor_pid

    def _read_parent_pid(self, pid: int) -> int | None:
        try:
            stat = (self._proc_root / str(pid) / "stat").read_text()
            # The command name in parentheses may itself contain spaces or ')'.
            fields_after_name = stat[stat.rfind(")") + 2 :].split()
            return int(fields_after_name[1])
        except (OSError, ValueError, IndexError):
            return None

    def _read_terminal_dimensions(self, pid: int) -> TerminalDimensions | None:
        fd_path = self._proc_root / str(pid) / "fd" / "0"
        try:
            fd = os.open(fd_path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOCTTY)
        except OSError:
            return None

        try:
            packed = fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8)
            rows, cols, _, _ = struct.unpack("HHHH", packed)
        except (OSError, struct.error):
            return None
        finally:
            os.close(fd)

        if rows <= 0 or cols <= 0:
            return None
        return TerminalDimensions.clamped(cols, rows)
