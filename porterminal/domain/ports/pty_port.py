"""PTY port - interface for PTY operations."""

from abc import ABC, abstractmethod

from ..values.terminal_dimensions import TerminalDimensions


class PTYPort(ABC):
    """Abstract interface for PTY operations.

    Infrastructure provides platform-specific implementations.
    """

    @abstractmethod
    def spawn(self) -> None:
        """Spawn the PTY process."""
        ...

    @abstractmethod
    def read(self, size: int = 4096) -> bytes:
        """Read from PTY (non-blocking).

        Returns empty bytes if no data available.
        """
        ...

    @abstractmethod
    def write(self, data: bytes) -> None:
        """Write to PTY."""
        ...

    @abstractmethod
    def resize(self, dimensions: TerminalDimensions) -> None:
        """Resize PTY to new dimensions."""
        ...

    @abstractmethod
    def is_alive(self) -> bool:
        """Check if PTY process is still running."""
        ...

    @abstractmethod
    def is_echo_enabled(self) -> bool:
        """Check if terminal echo is enabled."""
        ...

    @abstractmethod
    def get_working_directory(self) -> str | None:
        """Return the PTY shell's current working directory when available."""
        ...

    @abstractmethod
    def close(self) -> None:
        """Close PTY and cleanup resources."""
        ...

    @property
    @abstractmethod
    def dimensions(self) -> TerminalDimensions:
        """Get current terminal dimensions."""
        ...
