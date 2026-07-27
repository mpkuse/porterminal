"""Terminal service - terminal I/O coordination."""

import asyncio
import logging
import re
import shlex
import time
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from porterminal.domain import (
    PTYPort,
    RateLimitConfig,
    Session,
    TerminalDimensions,
    TokenBucketRateLimiter,
)

from ..ports.connection_port import ConnectionPort

logger = logging.getLogger(__name__)


@dataclass
class ConnectionFlowState:
    """Per-connection flow control state.

    Implements xterm.js recommended watermark-based flow control.
    When client sends 'pause', we stop sending to that connection.
    When client sends 'ack', we resume sending.
    """

    paused: bool = False
    pause_time: float | None = None
    echo_suppression: bytearray = field(default_factory=bytearray)
    command_buffer: bytearray = field(default_factory=bytearray)
    command_tracking_valid: bool = True
    last_input_was_cr: bool = False


# Terminal response sequences that should NOT be written to PTY.
# These are responses from the terminal emulator to queries from applications.
# If written to PTY, they get echoed back and displayed as garbage.
#
# Note: We only filter DA responses. CPR responses (\x1b[...R) are needed by
# some shells like Nushell that query cursor position during startup.
#
# Patterns:
#   \x1b[?...c  - Device Attributes (DA) response
TERMINAL_RESPONSE_PATTERN = re.compile(rb"\x1b\[\?[\d;]*c")

# Constants
HEARTBEAT_INTERVAL = 30  # seconds
HEARTBEAT_TIMEOUT = 300  # 5 minutes

# Adaptive PTY read interval: fast when data flowing, slow when idle
PTY_READ_INTERVAL_MIN = 0.001  # 1ms when data is flowing (high throughput)
PTY_READ_INTERVAL_MAX = 0.003  # 3ms when idle (keeps remote typing responsive)
PTY_READ_BURST_THRESHOLD = 5  # Consecutive reads with data before going fast

# Tiered batch intervals: faster for interactive, slower for bulk
OUTPUT_BATCH_INTERVAL_INTERACTIVE = 0.004  # 4ms for small data (<256 bytes)
OUTPUT_BATCH_INTERVAL_BULK = 0.016  # 16ms for larger data
OUTPUT_BATCH_SIZE_THRESHOLD = 256  # Bytes - threshold for interactive vs bulk
OUTPUT_BATCH_MAX_SIZE = 16384  # Flush if batch exceeds 16KB
INTERACTIVE_THRESHOLD = 64  # Bytes - flush immediately for very small data
MAX_INPUT_SIZE = 4096
FLOW_PAUSE_TIMEOUT = 5.0  # seconds - auto-resume if client stops sending ACKs (was 15s)
LOCAL_ECHO_MAX_BYTES = 128
MAX_TRACKED_COMMAND_BYTES = 1024
ZELLIJ_MONITOR_INTERVAL = 0.1
ZELLIJ_CLIENT_START_TIMEOUT = 5.0
ZELLIJ_DISCONNECT_GRACE_SECONDS = 2.0
ZELLIJ_DETACH_SEQUENCE = b"\x0fd"
# How often to detect which Zellij session each live PTY is attached to, so the
# size authority reconciles however zellij was started (not just typed attach).
# Only a fallback: a typed attach is picked up immediately by
# _prepare_zellij_attach_if_needed, so this only has to catch the indirect routes
# (tab completion, paste, snippets, shell rc). Each tick costs a process scan, so
# it is kept well above the interactive path's cadence.
ZELLIJ_SWEEP_INTERVAL = 1.0


def _parse_zellij_attach(command: str) -> tuple[bool, str | None]:
    """Return whether a shell command is a Zellij attach and its target name."""
    try:
        arguments = shlex.split(command, posix=True)
    except ValueError:
        return False, None

    if arguments[:1] == ["command"]:
        arguments = arguments[1:]
    if len(arguments) < 2 or arguments[0].rsplit("/", 1)[-1] != "zellij":
        return False, None
    if arguments[1] not in {"a", "attach"}:
        return False, None

    # Options whose following value is not a session name.
    value_options = {"--ca-cert", "--index", "-t", "--token"}
    index = 2
    while index < len(arguments):
        argument = arguments[index]
        if argument == "--":
            index += 1
            break
        if argument in value_options:
            index += 2
            continue
        if argument.startswith("-"):
            index += 1
            continue
        return True, argument

    target = arguments[index] if index < len(arguments) else None
    return True, target


class AsyncioClock:
    """Clock implementation using asyncio event loop time."""

    def now(self) -> float:
        return asyncio.get_running_loop().time()


class TerminalService:
    """Service for handling terminal I/O.

    Coordinates PTY reads, WebSocket writes, and message handling.
    Supports multiple clients connected to the same session.
    """

    def __init__(
        self,
        rate_limit_config: RateLimitConfig | None = None,
        max_input_size: int = MAX_INPUT_SIZE,
        zellij_attach_size_provider: (
            Callable[[str | None], TerminalDimensions | None] | None
        ) = None,
        zellij_client_running_provider: Callable[[int], bool] | None = None,
        zellij_native_sizes_provider: (
            Callable[[str], list[TerminalDimensions]] | None
        ) = None,
        zellij_session_under_pty_provider: (
            Callable[[int], str | None] | None
        ) = None,
        zellij_snapshot_refresher: Callable[[], None] | None = None,
    ) -> None:
        self._rate_limit_config = rate_limit_config or RateLimitConfig()
        self._max_input_size = max_input_size
        self._zellij_attach_size_provider = zellij_attach_size_provider
        self._zellij_client_running_provider = zellij_client_running_provider
        # Session-scoped sizes of native (non-Porterminal) clients on a Zellij
        # session; drives the "largest client wins" authority below.
        self._zellij_native_sizes_provider = zellij_native_sizes_provider
        # Resolves which Zellij session a PTY's shell has actually attached to
        # (by client presence, not by parsing typed input) — this is what makes
        # the size authority robust to tab-completion, paste, snippets, and
        # shell-rc auto-attach.
        self._zellij_session_under_pty_provider = zellij_session_under_pty_provider
        # The providers above answer from a snapshot of the process table and open
        # sockets. Collecting that snapshot is blocking and costs tens of
        # milliseconds, so it is refreshed once per pass in a worker thread rather
        # than being re-collected inline by every provider call.
        self._zellij_snapshot_refresher = zellij_snapshot_refresher
        self._zellij_sweep_task: asyncio.Task[None] | None = None

        # Multi-client support: track connections and read loops per session
        self._session_connections: dict[str, set[ConnectionPort]] = {}
        self._session_read_tasks: dict[str, asyncio.Task[None]] = {}
        # Per-session locks to prevent race between buffer replay and broadcast
        self._session_locks: dict[str, asyncio.Lock] = {}
        # Per-connection flow control state (watermark-based backpressure)
        self._flow_state: dict[ConnectionPort, ConnectionFlowState] = {}
        self._zellij_size_locks: dict[str, TerminalDimensions] = {}
        self._zellij_monitor_tasks: dict[str, asyncio.Task[None]] = {}
        self._zellij_disconnect_tasks: dict[str, asyncio.Task[None]] = {}
        # Live session objects (needed to reconcile the size of OTHER tabs that
        # share one Zellij session), the Zellij session name each PTY attached
        # to, and each browser's natural (unconstrained) grid.
        self._sessions: dict[str, Session[PTYPort]] = {}
        self._session_zellij_name: dict[str, str] = {}
        self._session_natural: dict[str, TerminalDimensions] = {}
        self._on_session_exited: Callable[[Session], Awaitable[None]] | None = None

    def get_zellij_size_lock(self, session_id: str) -> TerminalDimensions | None:
        """Return the native-client grid currently protecting a session."""
        return self._zellij_size_locks.get(session_id)

    def set_on_session_exited(
        self,
        callback: Callable[[Session], Awaitable[None]],
    ) -> None:
        """Set callback invoked when the PTY process exits."""
        self._on_session_exited = callback

    # -------------------------------------------------------------------------
    # Multi-client connection tracking
    # -------------------------------------------------------------------------

    def _get_session_lock(self, session_id: str) -> asyncio.Lock:
        """Get or create a lock for a session."""
        return self._session_locks.setdefault(session_id, asyncio.Lock())

    def _cleanup_session_lock(self, session_id: str) -> None:
        """Remove session lock when no longer needed."""
        self._session_locks.pop(session_id, None)

    def _register_connection(self, session_id: str, connection: ConnectionPort) -> int:
        """Register a connection for a session. Returns connection count."""
        pending_detach = self._zellij_disconnect_tasks.pop(session_id, None)
        if pending_detach and not pending_detach.done():
            pending_detach.cancel()
        connections = self._session_connections.setdefault(session_id, set())
        connections.add(connection)
        # Initialize flow control state for this connection
        self._flow_state[connection] = ConnectionFlowState()
        return len(connections)

    def _unregister_connection(self, session_id: str, connection: ConnectionPort) -> int:
        """Unregister a connection. Returns remaining count."""
        # Clean up flow control state
        self._flow_state.pop(connection, None)

        if session_id not in self._session_connections:
            return 0
        self._session_connections[session_id].discard(connection)
        count = len(self._session_connections[session_id])
        if count == 0:
            del self._session_connections[session_id]
        return count

    def _strip_optimistic_echo(
        self,
        connection: ConnectionPort,
        data: bytes,
    ) -> bytes:
        """Remove PTY echo already shown optimistically on this connection."""
        flow = self._flow_state.get(connection)
        if not flow or not flow.echo_suppression:
            return data

        pending = flow.echo_suppression
        match_len = 0
        max_match = min(len(data), len(pending))
        while match_len < max_match and data[match_len] == pending[match_len]:
            match_len += 1

        if match_len == 0:
            pending.clear()
            return data

        del pending[:match_len]
        return data[match_len:]

    async def _send_to_connections(self, connections: list[ConnectionPort], data: bytes) -> None:
        """Send data to connections, respecting flow control.

        Skips paused connections (client overwhelmed) but auto-resumes
        after FLOW_PAUSE_TIMEOUT to prevent permanent pause from dead clients.
        """
        current_time = time.time()
        for conn in connections:
            flow = self._flow_state.get(conn)
            if flow and flow.paused:
                # Check timeout - auto-resume if client stopped responding
                if flow.pause_time and (current_time - flow.pause_time) > FLOW_PAUSE_TIMEOUT:
                    flow.paused = False
                    flow.pause_time = None
                    logger.debug("Auto-resumed paused connection after timeout")
                else:
                    continue  # Skip paused connection

            output = self._strip_optimistic_echo(conn, data)
            if not output:
                continue

            try:
                await conn.send_output(output)
            except Exception as e:
                logger.debug("Failed to send output to connection: %s", e)

    async def _broadcast_output(self, session_id: str, data: bytes) -> None:
        """Broadcast PTY output to all connections for a session.

        Note: This is only used for error/status messages where the race
        condition doesn't matter. For PTY data, use _send_to_connections
        with a lock-protected snapshot.
        """
        connections = self._session_connections.get(session_id, set())
        dead: list[ConnectionPort] = []
        for conn in list(connections):  # Copy to avoid mutation during iteration
            try:
                await conn.send_output(data)
            except Exception:
                dead.append(conn)
        for conn in dead:
            connections.discard(conn)

    async def _broadcast_message(self, session_id: str, message: dict[str, Any]) -> None:
        """Broadcast JSON message to all connections for a session."""
        connections = self._session_connections.get(session_id, set())
        dead: list[ConnectionPort] = []
        for conn in list(connections):
            try:
                await conn.send_message(message)
            except Exception:
                dead.append(conn)
        for conn in dead:
            connections.discard(conn)

    async def handle_session(
        self,
        session: Session[PTYPort],
        connection: ConnectionPort,
        skip_buffer: bool = False,
    ) -> None:
        """Handle terminal session I/O with multi-client support.

        Multiple clients can connect to the same session simultaneously.
        The first client starts the PTY read loop; the last client stops it.

        Args:
            session: Terminal session to handle.
            connection: Network connection to client.
            skip_buffer: Whether to skip sending buffered output.
        """
        session_id = str(session.id)
        clock = AsyncioClock()
        rate_limiter = TokenBucketRateLimiter(self._rate_limit_config, clock)
        lock = self._get_session_lock(session_id)

        # Register atomically to prevent race with broadcast.
        # Without this lock, a new client could register between add_output and
        # broadcast, receiving the same data twice (once from buffer, once broadcast).
        #
        # Buffer snapshot and read loop start are also under lock to ensure:
        # - Buffer is captured before any new data arrives
        # - Only one read loop starts per session (prevents duplicate PTY reads)
        # - I/O (send_output) happens OUTSIDE lock to avoid blocking other clients
        buffered = None
        async with lock:
            connection_count = self._register_connection(session_id, connection)
            is_first_client = connection_count == 1
            # Remember the session object so we can reconcile the size of other
            # tabs sharing the same Zellij session, and make sure the attach
            # sweep is running.
            self._sessions[session_id] = session
            self._ensure_zellij_sweep()

            logger.info(
                "Client connected session_id=%s connection_count=%d",
                session_id,
                connection_count,
            )

            # First client starts the shared PTY read loop (under lock to prevent duplicates)
            if is_first_client:
                self._start_broadcast_read_loop(session, session_id)

            # Snapshot buffer while under lock (ensures consistency with broadcast)
            # Note: session_info is sent by the caller (app.py) to include tab_id
            if not skip_buffer and not session.output_buffer.is_empty:
                buffered = session.get_buffered_output()

        # Replay buffer OUTSIDE lock to avoid blocking other clients during I/O
        if buffered:
            await connection.send_output(buffered)

        try:
            # Start heartbeat for this connection
            heartbeat_task = asyncio.create_task(self._heartbeat_loop(connection))

            try:
                await self._handle_input_loop(session, connection, rate_limiter)
            finally:
                heartbeat_task.cancel()
                with suppress(asyncio.CancelledError):
                    await heartbeat_task

        finally:
            # Unregister this connection
            remaining = self._unregister_connection(session_id, connection)

            logger.info(
                "Client disconnected session_id=%s remaining_connections=%d",
                session_id,
                remaining,
            )

            # Last client: stop the read loop and cleanup lock
            if remaining == 0:
                zname = self._session_zellij_name.get(session_id)
                self._schedule_zellij_detach_on_disconnect(session, session_id)
                await self._stop_broadcast_read_loop(session_id)
                self._cleanup_session_lock(session_id)
                # No longer an active viewer; drop from the sweep set.
                self._sessions.pop(session_id, None)
                # Recompute authority for the remaining viewers of this Zellij
                # session (e.g. the laptop left -> the phone becomes the driver).
                if zname is not None:
                    await self._reconcile_zellij_group(zname)

    def _start_broadcast_read_loop(
        self,
        session: Session[PTYPort],
        session_id: str,
    ) -> None:
        """Start the PTY read loop that broadcasts to all clients."""
        if session_id in self._session_read_tasks:
            return  # Already running

        task = asyncio.create_task(self._read_pty_broadcast_loop(session, session_id))
        self._session_read_tasks[session_id] = task
        logger.debug("Started broadcast read loop session_id=%s", session_id)

    async def _stop_broadcast_read_loop(self, session_id: str) -> None:
        """Stop the PTY read loop for a session."""
        task = self._session_read_tasks.pop(session_id, None)
        if task and not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        logger.debug("Stopped broadcast read loop session_id=%s", session_id)

    async def _read_pty_broadcast_loop(
        self,
        session: Session[PTYPort],
        session_id: str,
    ) -> None:
        """Read from PTY and broadcast to all connected clients.

        Single loop per session, regardless of client count.

        Batching strategy:
        - Small data (<64 bytes): flush immediately for interactive responsiveness
        - Large data: batch for ~16ms to reduce WebSocket message frequency
        - Flush if batch exceeds 16KB to prevent memory buildup

        Thread safety:
        - Uses session lock to prevent race between add_output/broadcast and
          new client registration/buffer replay. Lock is held briefly during
          buffer update and connection snapshot, not during actual I/O.
        """
        # Check if PTY is alive at start
        if not session.pty_handle.is_alive():
            logger.error("PTY not alive at start session_id=%s", session.id)
            await self._broadcast_output(session_id, b"\r\n[PTY failed to start]\r\n")
            return

        lock = self._get_session_lock(session_id)
        batch_buffer: list[bytes] = []
        batch_size = 0
        last_flush_time = asyncio.get_running_loop().time()
        consecutive_data_reads = 0  # Track consecutive reads with data for adaptive sleep

        async def flush_batch() -> None:
            """Flush batched data with lock protection."""
            nonlocal batch_buffer, batch_size, last_flush_time
            if not batch_buffer:
                return

            combined = b"".join(batch_buffer)
            batch_buffer = []
            batch_size = 0
            last_flush_time = asyncio.get_running_loop().time()

            # Acquire lock, add to buffer, snapshot connections, release lock
            async with lock:
                session.add_output(combined)
                connections = list(self._session_connections.get(session_id, set()))

            # Broadcast outside lock (I/O can be slow)
            await self._send_to_connections(connections, combined)

        def has_connections() -> bool:
            return (
                session_id in self._session_connections
                and len(self._session_connections[session_id]) > 0
            )

        while has_connections() and session.pty_handle.is_alive():
            try:
                data = session.pty_handle.read(4096)
                if data:
                    session.touch(datetime.now(UTC))
                    # Track consecutive reads with data for adaptive sleep
                    consecutive_data_reads = min(
                        consecutive_data_reads + 1, PTY_READ_BURST_THRESHOLD
                    )

                    # Small data (interactive): flush immediately for responsiveness
                    if len(data) < INTERACTIVE_THRESHOLD and not batch_buffer:
                        # Acquire lock, add to buffer, snapshot connections
                        async with lock:
                            session.add_output(data)
                            connections = list(self._session_connections.get(session_id, set()))
                        # Broadcast outside lock
                        await self._send_to_connections(connections, data)
                    else:
                        # Batch larger data
                        batch_buffer.append(data)
                        batch_size += len(data)

                        # Flush if batch is large enough
                        if batch_size >= OUTPUT_BATCH_MAX_SIZE:
                            await flush_batch()
                else:
                    # No data - reset burst counter
                    consecutive_data_reads = 0

            except Exception as e:
                logger.error("PTY read error session_id=%s: %s", session.id, e)
                await flush_batch()  # Flush any pending data
                await self._broadcast_output(session_id, f"\r\n[PTY error: {e}]\r\n".encode())
                break

            # Tiered batch interval: faster for small batches, slower for large
            batch_interval = (
                OUTPUT_BATCH_INTERVAL_INTERACTIVE
                if batch_size < OUTPUT_BATCH_SIZE_THRESHOLD
                else OUTPUT_BATCH_INTERVAL_BULK
            )

            # Check if we should flush based on time
            current_time = asyncio.get_running_loop().time()
            if batch_buffer and (current_time - last_flush_time) >= batch_interval:
                await flush_batch()

            # Adaptive sleep: fast when data flowing, slow when idle
            sleep_time = (
                PTY_READ_INTERVAL_MIN
                if consecutive_data_reads >= PTY_READ_BURST_THRESHOLD
                else PTY_READ_INTERVAL_MAX
            )
            await asyncio.sleep(sleep_time)

        # Flush any remaining data
        await flush_batch()

        # Notify all clients if PTY died
        if not session.pty_handle.is_alive():
            zname = self._session_zellij_name.pop(session_id, None)
            self._session_natural.pop(session_id, None)
            self._sessions.pop(session_id, None)
            await self._release_zellij_size_lock(session_id)
            if zname is not None:
                await self._reconcile_zellij_group(zname)
            if has_connections():
                await self._broadcast_output(session_id, b"\r\n[Shell exited]\r\n")
            if self._on_session_exited:
                await self._on_session_exited(session)

    async def _heartbeat_loop(self, connection: ConnectionPort) -> None:
        """Send periodic heartbeat pings."""
        while connection.is_connected():
            await asyncio.sleep(HEARTBEAT_INTERVAL)
            try:
                await connection.send_message({"type": "ping"})
            except Exception:
                break

    async def _handle_input_loop(
        self,
        session: Session[PTYPort],
        connection: ConnectionPort,
        rate_limiter: TokenBucketRateLimiter,
    ) -> None:
        """Handle input from client."""
        while connection.is_connected():
            try:
                message = await connection.receive()
            except Exception:
                break

            if isinstance(message, bytes):
                await self._handle_binary_input(session, message, rate_limiter, connection)
            elif isinstance(message, dict):
                await self._handle_json_message(session, message, connection)

    async def _handle_binary_input(
        self,
        session: Session[PTYPort],
        data: bytes,
        rate_limiter: TokenBucketRateLimiter,
        connection: ConnectionPort,
    ) -> None:
        """Handle binary terminal input."""
        if len(data) > self._max_input_size:
            await connection.send_message(
                {
                    "type": "error",
                    "message": "Input too large",
                }
            )
            return

        # Filter terminal response sequences before writing to PTY.
        # xterm.js generates these in response to DA/CPR queries.
        # If written back to PTY, they get echoed and displayed as garbage.
        filtered = TERMINAL_RESPONSE_PATTERN.sub(b"", data)
        if not filtered:
            return

        if rate_limiter.try_acquire(len(filtered)):
            await self._prepare_zellij_attach_if_needed(
                session,
                connection,
                filtered,
            )
            await self._optimistic_echo(session, connection, filtered)
            session.pty_handle.write(filtered)
            session.touch(datetime.now(UTC))
        else:
            await connection.send_message(
                {
                    "type": "error",
                    "message": "Rate limit exceeded",
                }
            )
            logger.warning("Rate limit exceeded session_id=%s", session.id)

    def _completed_input_lines(
        self,
        connection: ConnectionPort,
        data: bytes,
    ) -> list[str]:
        """Track simple shell input and return lines completed by Enter."""
        flow = self._flow_state.get(connection)
        if flow is None:
            return []

        completed: list[str] = []
        for byte in data:
            if byte in {0x0D, 0x0A}:  # CR / LF
                # Treat CRLF as one Enter.
                if byte == 0x0A and flow.last_input_was_cr:
                    flow.last_input_was_cr = False
                    continue
                if flow.command_tracking_valid:
                    completed.append(flow.command_buffer.decode(errors="ignore"))
                flow.command_buffer.clear()
                flow.command_tracking_valid = True
                flow.last_input_was_cr = byte == 0x0D
                continue

            flow.last_input_was_cr = False
            if byte in {0x08, 0x7F}:  # Backspace
                if flow.command_buffer:
                    flow.command_buffer.pop()
                continue
            if byte in {0x03, 0x15}:  # Ctrl-C / Ctrl-U
                flow.command_buffer.clear()
                flow.command_tracking_valid = True
                continue
            if byte == 0x09:  # Tab-completed commands cannot be reconstructed reliably.
                flow.command_tracking_valid = False
                continue
            if 0x20 <= byte < 0x7F and flow.command_tracking_valid:
                if len(flow.command_buffer) < MAX_TRACKED_COMMAND_BYTES:
                    flow.command_buffer.append(byte)
                else:
                    flow.command_tracking_valid = False
                continue

            # Cursor movement, control sequences, and non-ASCII editing make the
            # shell's final line unknowable. Fall back to ordinary sizing.
            flow.command_tracking_valid = False

        return completed

    async def _prepare_zellij_attach_if_needed(
        self,
        session: Session[PTYPort],
        connection: ConnectionPort,
        data: bytes,
    ) -> None:
        completed_lines = self._completed_input_lines(connection, data)
        session_id = str(session.id)

        for command in completed_lines:
            is_attach, session_name = _parse_zellij_attach(command)
            if not is_attach:
                continue
            if session_name is None:
                # Bare `zellij a` gives no name to scope the shared-size
                # authority on; keep the legacy native-only behaviour.
                await self._legacy_attach_lock(session)
                return
            # Register this PTY as a viewer of `session_name`, seed its natural
            # grid, and let the "largest client wins" authority reconcile.
            self._sessions[session_id] = session
            self._session_zellij_name[session_id] = session_name
            self._session_natural.setdefault(session_id, session.dimensions)
            self._start_zellij_client_monitor(session, session_id)
            await self._reconcile_zellij_group(session_name)
            return

    async def _legacy_attach_lock(self, session: Session[PTYPort]) -> None:
        """Fallback for un-named ``zellij a``: lock to the min of the native
        clients found system-wide (the pre-existing single-tab behaviour)."""
        session_id = str(session.id)
        if session_id in self._zellij_size_locks or self._zellij_attach_size_provider is None:
            return
        await self._refresh_zellij_snapshot()
        try:
            dimensions = self._zellij_attach_size_provider(None)
        except Exception:
            logger.exception("Failed to inspect native Zellij client dimensions")
            return
        if dimensions is None:
            return
        session.update_dimensions(dimensions)
        session.pty_handle.resize(dimensions)
        session.touch(datetime.now(UTC))
        self._zellij_size_locks[session_id] = dimensions
        self._start_zellij_client_monitor(session, session_id)
        await self._broadcast_message(
            session_id,
            {"type": "zellij_size_lock", "cols": dimensions.cols, "rows": dimensions.rows},
        )

    def _zellij_members(self, zname: str) -> list[str]:
        """Session ids actively viewing ``zname`` (alive PTY + a live browser)."""
        members = []
        for sid, name in self._session_zellij_name.items():
            if name != zname:
                continue
            sess = self._sessions.get(sid)
            if sess is None or not sess.pty_handle.is_alive():
                continue
            if not self._session_connections.get(sid):
                continue
            members.append(sid)
        return members

    def _zellij_authority(self, zname: str, members: list[str]) -> TerminalDimensions | None:
        """The grid every viewer of ``zname`` should use.

        A native (non-Porterminal) client caps the grid at the native minimum —
        Zellij renders the min across all clients and we cannot grow someone
        else's terminal. With no native client, the largest browser wins and the
        smaller browsers scale locally.
        """
        natives: list[TerminalDimensions] = []
        if self._zellij_native_sizes_provider is not None:
            try:
                natives = self._zellij_native_sizes_provider(zname)
            except Exception:
                logger.exception("Failed to read native Zellij client sizes zname=%s", zname)
                natives = []
        if natives:
            # Zellij renders the independent min across all clients; match it so
            # our browsers stay consistent with the native terminal.
            return TerminalDimensions.clamped(
                min(d.cols for d in natives), min(d.rows for d in natives)
            )
        # No native client: the largest browser (by area) wins and keeps its
        # EXACT grid. Adopting one client's rectangle (rather than the per-axis
        # max) guarantees that client is an unlocked "driver" whose terminal is
        # never resized — the others lock to it and scale locally.
        def natural_of(sid: str) -> TerminalDimensions:
            return self._session_natural.get(sid) or self._sessions[sid].dimensions

        if not members:
            return None
        driver = max(members, key=lambda s: (natural_of(s).cols * natural_of(s).rows))
        chosen = natural_of(driver)
        return TerminalDimensions.clamped(chosen.cols, chosen.rows)

    async def _refresh_zellij_snapshot(self) -> None:
        """Bring the providers' view of processes and sockets up to date.

        The collection is blocking, so it runs in a worker thread; the providers
        then answer from that snapshot without touching the event loop. Callers
        within one snapshot window share a single collection.
        """
        refresher = self._zellij_snapshot_refresher
        if refresher is None:
            return
        try:
            await asyncio.to_thread(refresher)
        except Exception:
            # A stale snapshot degrades detection but must never break I/O.
            logger.exception("Failed to refresh Zellij process snapshot")

    async def _reconcile_zellij_group(self, zname: str) -> None:
        """Pin every viewer of ``zname`` to the authoritative grid; lock the ones
        smaller than it so they scale/pan locally instead of shrinking Zellij."""
        members = self._zellij_members(zname)
        if not members:
            return
        await self._refresh_zellij_snapshot()
        authority = self._zellij_authority(zname, members)
        if authority is None:
            return
        for sid in members:
            session = self._sessions[sid]
            if session.dimensions != authority:
                session.update_dimensions(authority)
                session.pty_handle.resize(authority)
                session.touch(datetime.now(UTC))
            natural = self._session_natural.get(sid) or authority
            # Anyone whose own grid differs from the authority renders it in
            # fixed-grid mode (smaller screens scale/pan; larger screens just
            # use a bigger font). Only an exact-size client is an unlocked driver.
            is_follower = natural != authority
            if is_follower:
                if self._zellij_size_locks.get(sid) != authority:
                    self._zellij_size_locks[sid] = authority
                    await self._broadcast_message(
                        sid,
                        {"type": "zellij_size_lock", "cols": authority.cols, "rows": authority.rows},
                    )
            elif sid in self._zellij_size_locks:
                del self._zellij_size_locks[sid]
                await self._broadcast_message(sid, {"type": "zellij_size_unlock"})
        logger.info(
            "Reconciled Zellij group zname=%s authority=%dx%d members=%d",
            zname,
            authority.cols,
            authority.rows,
            len(members),
        )

    def _ensure_zellij_sweep(self) -> None:
        """Start the background attach-detection sweep if it is not running."""
        if self._zellij_session_under_pty_provider is None:
            return
        task = self._zellij_sweep_task
        if task is not None and not task.done():
            return
        self._zellij_sweep_task = asyncio.create_task(self._zellij_sweep_loop())

    async def _zellij_sweep_loop(self) -> None:
        try:
            while self._sessions:
                try:
                    await self._zellij_sweep_once()
                except Exception:
                    logger.exception("Zellij attach sweep tick failed")
                await asyncio.sleep(ZELLIJ_SWEEP_INTERVAL)
        finally:
            self._zellij_sweep_task = None

    async def _zellij_sweep_once(self) -> None:
        """Detect which Zellij session each live PTY is attached to and keep the
        group membership (and thus the size authority) in sync — regardless of
        how zellij was launched in that tab."""
        provider = self._zellij_session_under_pty_provider
        if provider is None:
            return
        # One collection for the whole tick: without this each session below would
        # re-scan /proc and re-run `ss` on the event loop.
        await self._refresh_zellij_snapshot()
        affected: set[str] = set()
        for sid, session in list(self._sessions.items()):
            if not self._session_connections.get(sid) or not session.pty_handle.is_alive():
                continue
            root_pid = session.pty_handle.process_id
            if root_pid is None:
                continue
            try:
                actual = provider(root_pid)
            except Exception:
                logger.exception("Failed to resolve Zellij session for pty sid=%s", sid)
                continue
            current = self._session_zellij_name.get(sid)
            if actual == current:
                continue
            if actual is not None:
                # Attached (or moved to a different session) by any means.
                self._session_zellij_name[sid] = actual
                self._session_natural.setdefault(sid, session.dimensions)
                affected.add(actual)
            else:
                # The tab's Zellij client is gone: drop it from the group.
                self._session_zellij_name.pop(sid, None)
                await self._release_zellij_size_lock(sid)
            if current is not None:
                affected.add(current)
        for zname in affected:
            await self._reconcile_zellij_group(zname)

    def _start_zellij_client_monitor(
        self,
        session: Session[PTYPort],
        session_id: str,
    ) -> None:
        if self._zellij_client_running_provider is None:
            return
        root_pid = session.pty_handle.process_id
        if root_pid is None:
            return

        previous = self._zellij_monitor_tasks.pop(session_id, None)
        if previous and not previous.done():
            previous.cancel()

        task = asyncio.create_task(self._monitor_zellij_client(session_id, root_pid))
        self._zellij_monitor_tasks[session_id] = task

    async def _monitor_zellij_client(self, session_id: str, root_pid: int) -> None:
        """Ungroup + release the lock when this PTY's attached Zellij client exits.

        Runs for a locked (legacy) session OR a grouped one (a grouped *driver*
        holds no lock, so we cannot key the loop on the lock alone).
        """
        running_provider = self._zellij_client_running_provider
        if running_provider is None:
            return
        saw_client = False
        started_at = asyncio.get_running_loop().time()
        current_task = asyncio.current_task()
        try:
            while (
                session_id in self._zellij_size_locks
                or session_id in self._session_zellij_name
            ):
                # Keep the process scan off the event loop. Monitors for other
                # sessions polling in the same window reuse this snapshot, so the
                # cost does not grow with the number of attached tabs.
                await self._refresh_zellij_snapshot()
                try:
                    client_running = bool(running_provider(root_pid))
                except Exception:
                    logger.exception(
                        "Failed to monitor Zellij client process session_id=%s",
                        session_id,
                    )
                    return

                if client_running:
                    saw_client = True
                elif saw_client:
                    await self._on_zellij_client_exited(session_id)
                    return
                elif (
                    asyncio.get_running_loop().time() - started_at
                    >= ZELLIJ_CLIENT_START_TIMEOUT
                ):
                    # The attach command failed or never launched; do not leave
                    # a stale fixed grid on the ordinary shell.
                    await self._on_zellij_client_exited(session_id)
                    return

                await asyncio.sleep(ZELLIJ_MONITOR_INTERVAL)
        finally:
            if self._zellij_monitor_tasks.get(session_id) is current_task:
                self._zellij_monitor_tasks.pop(session_id, None)

    async def _on_zellij_client_exited(self, session_id: str) -> None:
        """This PTY's Zellij client is gone: drop it from its group, release any
        lock, and recompute authority for the tabs that remain."""
        zname = self._session_zellij_name.pop(session_id, None)
        self._session_natural.pop(session_id, None)
        await self._release_zellij_size_lock(session_id)
        if zname is not None:
            await self._reconcile_zellij_group(zname)

    def _schedule_zellij_detach_on_disconnect(
        self,
        session: Session[PTYPort],
        session_id: str,
    ) -> None:
        """Detach a Zellij attach after its last browser viewer leaves."""
        if (
            session_id not in self._zellij_size_locks
            and session_id not in self._session_zellij_name
        ):
            return

        previous = self._zellij_disconnect_tasks.pop(session_id, None)
        if previous and not previous.done():
            previous.cancel()
        self._zellij_disconnect_tasks[session_id] = asyncio.create_task(
            self._detach_zellij_after_disconnect(session, session_id)
        )

    async def _detach_zellij_after_disconnect(
        self,
        session: Session[PTYPort],
        session_id: str,
    ) -> None:
        """Allow brief network reconnects, then detach an unviewed native session."""
        current_task = asyncio.current_task()
        try:
            await asyncio.sleep(ZELLIJ_DISCONNECT_GRACE_SECONDS)
            if self._session_connections.get(session_id):
                return
            if (
                session_id not in self._zellij_size_locks
                and session_id not in self._session_zellij_name
            ):
                return
            if not session.pty_handle.is_alive():
                return

            session.pty_handle.write(ZELLIJ_DETACH_SEQUENCE)
            session.touch(datetime.now(UTC))
            logger.info(
                "Detached native Zellij client after last browser disconnected "
                "session_id=%s",
                session_id,
            )
        finally:
            if self._zellij_disconnect_tasks.get(session_id) is current_task:
                self._zellij_disconnect_tasks.pop(session_id, None)

    async def _release_zellij_size_lock(self, session_id: str) -> None:
        if self._zellij_size_locks.pop(session_id, None) is None:
            return
        disconnect_task = self._zellij_disconnect_tasks.pop(session_id, None)
        if (
            disconnect_task
            and disconnect_task is not asyncio.current_task()
            and not disconnect_task.done()
        ):
            disconnect_task.cancel()
        monitor_task = self._zellij_monitor_tasks.pop(session_id, None)
        if monitor_task and monitor_task is not asyncio.current_task() and not monitor_task.done():
            monitor_task.cancel()
        await self._broadcast_message(session_id, {"type": "zellij_size_unlock"})
        logger.info("Released native Zellij dimension lock session_id=%s", session_id)

    async def _optimistic_echo(
        self,
        session: Session[PTYPort],
        connection: ConnectionPort,
        data: bytes,
    ) -> None:
        """Immediately show safe printable input while waiting for PTY echo."""
        if len(data) > LOCAL_ECHO_MAX_BYTES:
            return
        if not data or any(byte < 0x20 or byte >= 0x7F for byte in data):
            return
        if not session.pty_handle.is_echo_enabled():
            return

        flow = self._flow_state.get(connection)
        if not flow:
            return

        flow.echo_suppression.extend(data)
        await connection.send_output(data)

    async def _handle_json_message(
        self,
        session: Session[PTYPort],
        message: dict[str, Any],
        connection: ConnectionPort,
    ) -> None:
        """Handle JSON control message."""
        msg_type = message.get("type")

        if msg_type == "resize":
            await self._handle_resize(session, message, connection)
        elif msg_type == "ping":
            await connection.send_message({"type": "pong"})
            session.touch(datetime.now(UTC))
        elif msg_type == "pong":
            session.touch(datetime.now(UTC))
        elif msg_type == "pause":
            # Client is overwhelmed - stop sending data to this connection
            flow = self._flow_state.get(connection)
            if flow:
                flow.paused = True
                flow.pause_time = time.time()
                # Send confirmation so client knows pause was received
                await connection.send_message({"type": "pause_ack"})
                logger.debug("Connection paused (client overwhelmed) session_id=%s", session.id)
        elif msg_type == "ack":
            # Client caught up - resume sending data
            flow = self._flow_state.get(connection)
            if flow and flow.paused:
                flow.paused = False
                flow.pause_time = None
                logger.debug("Connection resumed (client caught up) session_id=%s", session.id)
        elif msg_type == "zellij_size_unlock":
            # Browser buffer transitions are not authoritative. In particular,
            # mobile rendering changes can transiently switch xterm buffers.
            # The process monitor releases the lock only after the attached
            # Zellij client actually exits.
            logger.debug(
                "Ignoring browser Zellij unlock request session_id=%s",
                session.id,
            )
        else:
            logger.warning("Unknown message type session_id=%s type=%s", session.id, msg_type)

    async def _handle_resize(
        self,
        session: Session[PTYPort],
        message: dict[str, Any],
        connection: ConnectionPort,
    ) -> None:
        """Handle terminal resize message.

        Multi-client strategy:
        - When multiple clients share a session, PTY dimensions are locked
        - Only the first client (or when all clients agree) can resize
        - New clients receive current dimensions and must adapt locally
        - This prevents rendering artifacts from dimension mismatches
        """
        session_id = str(session.id)
        cols = int(message.get("cols", 120))
        rows = int(message.get("rows", 30))

        new_dims = TerminalDimensions.clamped(cols, rows)

        # A resize always reports the browser's natural (unconstrained) grid.
        # For a tab sharing a Zellij session, the group authority decides the
        # real grid — the browser never resizes Zellij directly — so record the
        # natural size and reconcile.
        self._session_natural[session_id] = new_dims
        zname = self._session_zellij_name.get(session_id)
        if zname is not None:
            await self._reconcile_zellij_group(zname)
            return

        # Legacy native size lock (un-named `zellij a`): reject changes.
        locked_dimensions = self._zellij_size_locks.get(session_id)
        if locked_dimensions is not None and new_dims != locked_dimensions:
            logger.info(
                "Resize rejected (native Zellij size lock) session_id=%s requested=%dx%d "
                "locked=%dx%d",
                session.id,
                new_dims.cols,
                new_dims.rows,
                locked_dimensions.cols,
                locked_dimensions.rows,
            )
            await connection.send_message(
                {
                    "type": "resize_sync",
                    "cols": locked_dimensions.cols,
                    "rows": locked_dimensions.rows,
                }
            )
            return

        # Skip if same as current
        if session.dimensions == new_dims:
            return

        # Check if multiple clients are connected
        connections = self._session_connections.get(session_id, set())
        if len(connections) > 1:
            # Multiple clients: reject resize, tell client to use current dimensions
            logger.info(
                "Resize rejected (multi-client) session_id=%s requested=%dx%d current=%dx%d",
                session.id,
                new_dims.cols,
                new_dims.rows,
                session.dimensions.cols,
                session.dimensions.rows,
            )
            # Send current dimensions back so client can adapt
            await connection.send_message(
                {
                    "type": "resize_sync",
                    "cols": session.dimensions.cols,
                    "rows": session.dimensions.rows,
                }
            )
            return

        # Single client: allow resize
        session.update_dimensions(new_dims)
        session.pty_handle.resize(new_dims)
        session.touch(datetime.now(UTC))

        logger.info(
            "Terminal resized session_id=%s cols=%d rows=%d",
            session.id,
            new_dims.cols,
            new_dims.rows,
        )
