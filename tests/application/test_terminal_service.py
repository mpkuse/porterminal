"""Tests for TerminalService."""

import asyncio
import contextlib

from porterminal.application.services import TerminalService
from porterminal.application.services import terminal_service as terminal_service_module
from porterminal.domain import TerminalDimensions


class ExitOnReadPTY:
    """PTY test double that exits after the read loop starts."""

    def __init__(self, dimensions):
        self._dimensions = dimensions
        self._alive = True

    def read(self, size: int = 4096) -> bytes:
        self._alive = False
        return b""

    def write(self, data: bytes) -> None:
        pass

    def resize(self, dimensions) -> None:
        self._dimensions = dimensions

    def is_alive(self) -> bool:
        return self._alive

    def is_echo_enabled(self) -> bool:
        return True

    def get_working_directory(self) -> str | None:
        return None

    @property
    def process_id(self) -> int | None:
        return 12345

    def close(self) -> None:
        self._alive = False

    @property
    def dimensions(self):
        return self._dimensions


class FakeConnection:
    """Connection test double that records terminal output."""

    def __init__(self):
        self.output: list[bytes] = []
        self.messages: list[dict] = []

    async def send_output(self, data: bytes) -> None:
        self.output.append(data)

    async def send_message(self, message: dict) -> None:
        self.messages.append(message)

    async def receive(self) -> dict | bytes:
        return {}

    async def close(self, code: int = 1000, reason: str = "") -> None:
        pass

    def is_connected(self) -> bool:
        return True


async def test_session_exit_callback_runs_when_pty_exits(sample_session, default_dimensions):
    """PTY exit should trigger session cleanup so associated tabs can close."""
    service = TerminalService()
    connection = FakeConnection()
    exited_sessions = []

    sample_session.pty_handle = ExitOnReadPTY(default_dimensions)

    async def on_session_exited(session):
        exited_sessions.append(session.id)

    service.set_on_session_exited(on_session_exited)
    service._register_connection(str(sample_session.id), connection)

    await service._read_pty_broadcast_loop(sample_session, str(sample_session.id))

    assert exited_sessions == [sample_session.id]
    assert connection.output == [b"\r\n[Shell exited]\r\n"]


async def test_printable_input_echoes_optimistically(sample_session):
    """Plain typing should show immediately when terminal echo is enabled."""
    service = TerminalService()
    connection = FakeConnection()
    service._register_connection(str(sample_session.id), connection)

    await service._optimistic_echo(sample_session, connection, b"abc")

    assert connection.output == [b"abc"]


async def test_pty_echo_is_suppressed_after_optimistic_echo(sample_session):
    """Real PTY echo should not duplicate characters already shown locally."""
    service = TerminalService()
    connection = FakeConnection()
    service._register_connection(str(sample_session.id), connection)

    await service._optimistic_echo(sample_session, connection, b"abc")
    await service._send_to_connections([connection], b"abc")

    assert connection.output == [b"abc"]


async def test_control_input_does_not_echo_optimistically(sample_session):
    """Enter, Tab, Ctrl keys, and similar input should stay server-driven."""
    service = TerminalService()
    connection = FakeConnection()
    service._register_connection(str(sample_session.id), connection)

    await service._optimistic_echo(sample_session, connection, b"\r")

    assert connection.output == []


class AllowAllRateLimiter:
    """Rate limiter test double that accepts every input."""

    def try_acquire(self, amount: int) -> bool:
        return True


async def test_submitted_line_raises_the_sweep_cadence(sample_session, fake_pty):
    """Whether a line was submitted is the only thing input is read for.

    Attach detection reads process and socket state, not keystrokes, so nothing
    about what was typed is parsed or retained - an Enter just means "the shell
    may have started or ended an attach, so look again soon".
    """
    service = TerminalService()
    connection = FakeConnection()
    service._register_connection(str(sample_session.id), connection)
    original_dimensions = sample_session.dimensions
    assert service._zellij_sweep_interval() == (
        terminal_service_module.ZELLIJ_SWEEP_INTERVAL_IDLE
    )

    await service._handle_binary_input(
        sample_session,
        b"zellij attach work\r",
        AllowAllRateLimiter(),
        connection,
    )

    assert service._zellij_sweep_interval() == (
        terminal_service_module.ZELLIJ_SWEEP_INTERVAL_ACTIVE
    )
    # Forwarded verbatim, and sizing is untouched until detection says otherwise.
    assert fake_pty.get_input() == [b"zellij attach work\r"]
    assert sample_session.dimensions == original_dimensions
    assert fake_pty.dimensions == original_dimensions
    assert connection.messages == []


async def test_unsubmitted_input_leaves_the_sweep_idle(sample_session):
    """A partial line cannot have started anything, so it must not wake the sweep."""
    service = TerminalService()
    connection = FakeConnection()
    service._register_connection(str(sample_session.id), connection)

    await service._handle_binary_input(
        sample_session,
        b"zellij attach work",
        AllowAllRateLimiter(),
        connection,
    )

    assert service._zellij_sweep_interval() == (
        terminal_service_module.ZELLIJ_SWEEP_INTERVAL_IDLE
    )


async def test_browser_cannot_release_zellij_size_lock(sample_session):
    service = TerminalService()
    connection = FakeConnection()
    session_id = str(sample_session.id)
    service._register_connection(session_id, connection)
    service._zellij_size_locks[session_id] = TerminalDimensions(cols=155, rows=42)

    await service._handle_json_message(
        sample_session,
        {"type": "zellij_size_unlock"},
        connection,
    )

    assert service.get_zellij_size_lock(session_id) == TerminalDimensions(cols=155, rows=42)
    assert connection.messages == []


async def test_resize_is_rejected_while_native_zellij_grid_is_locked(sample_session):
    service = TerminalService()
    connection = FakeConnection()
    session_id = str(sample_session.id)
    locked = TerminalDimensions(cols=155, rows=42)
    sample_session.update_dimensions(locked)
    sample_session.pty_handle.resize(locked)
    service._zellij_size_locks[session_id] = locked

    await service._handle_resize(
        sample_session,
        {"type": "resize", "cols": 80, "rows": 24},
        connection,
    )

    assert sample_session.dimensions == locked
    assert connection.messages == [
        {"type": "resize_sync", "cols": 155, "rows": 42}
    ]


async def test_process_monitor_releases_lock_after_zellij_client_exits(sample_session):
    running_states = iter([False, True, True, False])
    service = TerminalService(
        zellij_client_running_provider=lambda _pid: next(running_states),
    )
    connection = FakeConnection()
    session_id = str(sample_session.id)
    service._register_connection(session_id, connection)
    service._zellij_size_locks[session_id] = TerminalDimensions(cols=155, rows=42)

    await service._monitor_zellij_client(session_id, sample_session.pty_handle.process_id)

    assert service.get_zellij_size_lock(session_id) is None
    assert connection.messages == [{"type": "zellij_size_unlock"}]


async def test_last_browser_disconnect_signals_the_zellij_client(
    sample_session,
    fake_pty,
    monkeypatch,
):
    """Detaching ends the client process; it never types a keybinding.

    The detach keybinding is user-configurable, so writing one blind would send
    the keystrokes to whatever application is focused inside the session.
    """
    monkeypatch.setattr(terminal_service_module, "ZELLIJ_DISCONNECT_GRACE_SECONDS", 0)
    detached: list[int] = []
    service = TerminalService(
        zellij_detach_provider=lambda pid: detached.append(pid) or True,
    )
    session_id = str(sample_session.id)
    service._zellij_size_locks[session_id] = TerminalDimensions(cols=155, rows=42)

    service._schedule_zellij_detach_on_disconnect(sample_session, session_id)
    await service._zellij_disconnect_tasks[session_id]

    assert detached == [sample_session.pty_handle.process_id]
    assert fake_pty.get_input() == []


async def test_browser_reconnect_cancels_pending_zellij_detach(
    sample_session,
    fake_pty,
    monkeypatch,
):
    monkeypatch.setattr(terminal_service_module, "ZELLIJ_DISCONNECT_GRACE_SECONDS", 0.05)
    service = TerminalService()
    session_id = str(sample_session.id)
    service._zellij_size_locks[session_id] = TerminalDimensions(cols=155, rows=42)

    service._schedule_zellij_detach_on_disconnect(sample_session, session_id)
    service._register_connection(session_id, FakeConnection())
    await asyncio.sleep(0.06)

    assert fake_pty.get_input() == []


def _browser_session(sid: str, cols: int, rows: int):
    """Build a fake Porterminal session viewing at a given grid."""
    from datetime import UTC, datetime

    from porterminal.domain import Session, SessionId, UserId

    dims = TerminalDimensions(cols=cols, rows=rows)
    now = datetime.now(UTC)
    return Session(
        id=SessionId(sid),
        user_id=UserId("u"),
        shell_id="bash",
        dimensions=dims,
        created_at=now,
        last_activity=now,
        pty_handle=ExitOnReadPTY(dims),
        connected_clients=1,
    )


def _join_group(service, session, conn, zname="work"):
    sid = str(session.id)
    service._sessions[sid] = session
    service._session_connections[sid] = {conn}
    service._session_zellij_name[sid] = zname
    service._session_natural[sid] = session.dimensions


async def test_larger_browser_wins_and_smaller_locks_to_it():
    # No native client: the largest browser drives, the smaller one scales.
    service = TerminalService(zellij_native_sizes_provider=lambda _n: [])
    laptop, phone = _browser_session("laptop", 200, 50), _browser_session("phone", 90, 40)
    lc, pc = FakeConnection(), FakeConnection()
    _join_group(service, laptop, lc)
    _join_group(service, phone, pc)

    await service._reconcile_zellij_group("work")

    assert laptop.dimensions == TerminalDimensions(cols=200, rows=50)
    assert service.get_zellij_size_lock("laptop") is None          # driver, not resized
    assert lc.messages == []
    assert phone.dimensions == TerminalDimensions(cols=200, rows=50)
    assert service.get_zellij_size_lock("phone") == TerminalDimensions(cols=200, rows=50)
    assert pc.messages == [{"type": "zellij_size_lock", "cols": 200, "rows": 50}]


async def test_phone_started_session_grows_when_laptop_joins():
    # Reverse direction: phone drives alone, then the laptop attaches and the
    # shared grid grows to the laptop while the phone becomes a follower.
    service = TerminalService(zellij_native_sizes_provider=lambda _n: [])
    phone = _browser_session("phone", 90, 40)
    pc = FakeConnection()
    _join_group(service, phone, pc)

    await service._reconcile_zellij_group("work")
    assert phone.dimensions == TerminalDimensions(cols=90, rows=40)
    assert service.get_zellij_size_lock("phone") is None            # sole client -> driver

    laptop = _browser_session("laptop", 200, 50)
    lc = FakeConnection()
    _join_group(service, laptop, lc)
    await service._reconcile_zellij_group("work")

    assert laptop.dimensions == TerminalDimensions(cols=200, rows=50)
    assert service.get_zellij_size_lock("laptop") is None
    assert phone.dimensions == TerminalDimensions(cols=200, rows=50)  # grew
    assert service.get_zellij_size_lock("phone") == TerminalDimensions(cols=200, rows=50)
    assert {"type": "zellij_size_lock", "cols": 200, "rows": 50} in pc.messages


async def test_native_client_caps_the_shared_grid():
    # A native terminal is present: Zellij cannot grow past it, so every browser
    # locks to the native size (bigger browsers just render it at a larger font).
    native = TerminalDimensions(cols=100, rows=30)
    service = TerminalService(zellij_native_sizes_provider=lambda _n: [native])
    laptop = _browser_session("laptop", 200, 50)
    lc = FakeConnection()
    _join_group(service, laptop, lc)

    await service._reconcile_zellij_group("work")

    assert laptop.dimensions == native
    assert service.get_zellij_size_lock("laptop") == native
    assert lc.messages == [{"type": "zellij_size_lock", "cols": 100, "rows": 30}]


async def test_sweep_snapshot_cost_does_not_scale_with_tab_count():
    """Detection state is collected per pass, not per session.

    Each session used to trigger its own /proc walk and `ss` run, on the event
    loop, every tick — four tabs stalled it for ~100ms out of every 300ms.
    """
    refreshes: list[int] = []
    service = TerminalService(
        zellij_session_under_pty_provider=lambda _pid: "work",
        zellij_native_sizes_provider=lambda _n: [],
        zellij_snapshot_refresher=lambda: refreshes.append(1),
    )
    for name in ("a", "b", "c", "d"):
        session = _browser_session(name, 90, 40)
        sid = str(session.id)
        service._sessions[sid] = session
        service._session_connections[sid] = {FakeConnection()}

    await service._zellij_sweep_once()
    # A detection pass plus one reconcile for the single group they all joined —
    # flat in the number of sessions (this was 4+ before).
    assert len(refreshes) <= 2
    assert all(service._session_zellij_name[str(s)] == "work" for s in "abcd")

    # Steady state: membership is unchanged, so no group needs reconciling.
    refreshes.clear()
    await service._zellij_sweep_once()
    assert len(refreshes) == 1


async def test_detected_attach_starts_a_client_monitor():
    """The monitor is what releases the grid promptly once the client goes.

    Detaching from inside Zellij submits no line, so the sweep alone would sit at
    its idle cadence and leave the tab pinned to a grid nothing is using.
    """
    service = TerminalService(
        zellij_session_under_pty_provider=lambda _pid: "work",
        zellij_native_sizes_provider=lambda _n: [],
        zellij_client_running_provider=lambda _pid: True,
    )
    session = _browser_session("phone", 90, 40)
    sid = str(session.id)
    service._sessions[sid] = session
    service._session_connections[sid] = {FakeConnection()}

    await service._zellij_sweep_once()

    assert sid in service._zellij_monitor_tasks
    task = service._zellij_monitor_tasks[sid]
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
