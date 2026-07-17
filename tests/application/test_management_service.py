"""Tests for management requests spanning tabs and terminal sessions."""

from porterminal.application.services import ManagementService, SessionService, TabService
from porterminal.domain import ShellCommand, TerminalDimensions, UserId
from porterminal.infrastructure.repositories import (
    InMemorySessionRepository,
    InMemoryTabRepository,
)


class RecordingPTY:
    def __init__(self, dimensions: TerminalDimensions, cwd: str | None) -> None:
        self._dimensions = dimensions
        self._cwd = cwd

    def spawn(self) -> None:
        pass

    def read(self, size: int = 4096) -> bytes:
        return b""

    def write(self, data: bytes) -> None:
        pass

    def resize(self, dimensions: TerminalDimensions) -> None:
        self._dimensions = dimensions

    def is_alive(self) -> bool:
        return True

    def is_echo_enabled(self) -> bool:
        return True

    def get_working_directory(self) -> str | None:
        return self._cwd

    def close(self) -> None:
        pass

    @property
    def dimensions(self) -> TerminalDimensions:
        return self._dimensions


class RecordingConnection:
    def __init__(self) -> None:
        self.messages: list[dict] = []

    async def send_message(self, message: dict) -> None:
        self.messages.append(message)


class RecordingRegistry:
    async def broadcast(self, user_id, message, exclude=None) -> int:
        return 0


async def test_create_tab_inherits_source_tabs_current_working_directory():
    dimensions = TerminalDimensions.default()
    user_id = UserId("owner")
    shell = ShellCommand(id="bash", name="Bash", command="/bin/bash", args=())
    created_cwds: list[str | None] = []

    def pty_factory(shell, dimensions, cwd):
        created_cwds.append(cwd)
        return RecordingPTY(dimensions, cwd)

    session_service = SessionService(
        repository=InMemorySessionRepository(),
        pty_factory=pty_factory,
        working_directory="/server/default",
    )
    tab_service = TabService(repository=InMemoryTabRepository())

    source_session = await session_service.create_session(user_id, shell, dimensions)
    source_session.pty_handle._cwd = "/workspace/current"
    source_tab = tab_service.create_tab(user_id, source_session.id, shell.id)

    service = ManagementService(
        session_service=session_service,
        tab_service=tab_service,
        connection_registry=RecordingRegistry(),
        shell_provider=lambda shell_id: shell,
        default_dimensions=dimensions,
    )
    connection = RecordingConnection()

    await service.handle_message(
        user_id,
        connection,
        {
            "type": "create_tab",
            "request_id": "request-1",
            "shell_id": shell.id,
            "source_tab_id": source_tab.tab_id,
        },
    )

    assert created_cwds == ["/server/default", "/workspace/current"]
    assert connection.messages[-1]["success"] is True
