"""Tests for reading the current shell working directory."""

import os
import sys

import pytest

from porterminal.pty.unix import UnixPTYBackend


@pytest.mark.skipif(sys.platform == "win32", reason="Unix-only test")
def test_unix_backend_reads_shell_working_directory_from_procfs(monkeypatch):
    backend = UnixPTYBackend()
    backend._pid = 4321
    seen_paths: list[str] = []

    def fake_readlink(path: str) -> str:
        seen_paths.append(path)
        return "/workspace/current"

    monkeypatch.setattr(os, "readlink", fake_readlink)

    assert backend.get_working_directory() == "/workspace/current"
    assert seen_paths == ["/proc/4321/cwd"]
