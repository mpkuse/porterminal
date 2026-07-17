"""Protocol definition for PTY backends."""

from typing import Protocol, runtime_checkable


@runtime_checkable
class PTYBackend(Protocol):
    """Protocol for platform-specific PTY implementations.

    This defines the interface that all PTY backends must implement.
    Using a Protocol allows for structural subtyping (duck typing with type hints).
    """

    @property
    def rows(self) -> int:
        """Current number of rows."""
        ...

    @property
    def cols(self) -> int:
        """Current number of columns."""
        ...

    def spawn(
        self,
        cmd: list[str],
        env: dict[str, str],
        cwd: str | None,
        rows: int,
        cols: int,
    ) -> None:
        """Spawn the PTY process.

        Args:
            cmd: Command and arguments to execute.
            env: Environment variables for the process.
            cwd: Working directory, or None for default.
            rows: Initial terminal rows.
            cols: Initial terminal columns.

        Raises:
            RuntimeError: If PTY is already spawned.
        """
        ...

    def read(self, size: int = 4096) -> bytes:
        """Read from the PTY (non-blocking).

        Args:
            size: Maximum bytes to read.

        Returns:
            Bytes read, or empty bytes if nothing available.
        """
        ...

    def write(self, data: bytes) -> None:
        """Write to the PTY.

        Args:
            data: Bytes to write.
        """
        ...

    def resize(self, rows: int, cols: int) -> None:
        """Resize the PTY window.

        Args:
            rows: New number of rows.
            cols: New number of columns.
        """
        ...

    def is_alive(self) -> bool:
        """Check if the PTY process is still alive.

        Returns:
            True if process is running, False otherwise.
        """
        ...

    def is_echo_enabled(self) -> bool:
        """Check if terminal echo is enabled."""
        ...

    def get_working_directory(self) -> str | None:
        """Return the shell process working directory when available."""
        ...

    def close(self) -> None:
        """Close the PTY and clean up resources."""
        ...
