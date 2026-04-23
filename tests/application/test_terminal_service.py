"""Tests for TerminalService."""

from porterminal.application.services import TerminalService


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

    def close(self) -> None:
        self._alive = False

    @property
    def dimensions(self):
        return self._dimensions


class FakeConnection:
    """Connection test double that records terminal output."""

    def __init__(self):
        self.output: list[bytes] = []

    async def send_output(self, data: bytes) -> None:
        self.output.append(data)

    async def send_message(self, message: dict) -> None:
        pass

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
