"""Tests for native Zellij client dimension detection."""

from pathlib import Path

from porterminal.domain import TerminalDimensions
from porterminal.infrastructure.zellij import NativeZellijClientDetector


def _add_process(
    proc_root: Path,
    pid: int,
    parent_pid: int,
    arguments: list[str],
) -> None:
    process_dir = proc_root / str(pid)
    process_dir.mkdir()
    (process_dir / "cmdline").write_bytes(b"\0".join(arg.encode() for arg in arguments) + b"\0")
    (process_dir / "stat").write_text(
        f"{pid} ({Path(arguments[0]).name}) S {parent_pid} 0 0 0 0\n"
    )


def test_detector_ignores_porterminal_descendants_and_uses_native_minimum(
    tmp_path,
    monkeypatch,
):
    proc_root = tmp_path / "proc"
    proc_root.mkdir()

    _add_process(proc_root, 100, 1, ["python", "-m", "porterminal"])
    _add_process(proc_root, 200, 100, ["bash"])
    _add_process(proc_root, 201, 200, ["zellij", "attach", "work"])
    _add_process(proc_root, 300, 1, ["bash"])
    _add_process(proc_root, 301, 300, ["zellij"])
    _add_process(proc_root, 302, 300, ["/usr/local/bin/zellij", "attach", "work"])
    _add_process(
        proc_root,
        400,
        1,
        ["zellij", "--server", "/run/user/1000/zellij/contract_version_1/work"],
    )

    dimensions = {
        201: TerminalDimensions(cols=70, rows=20),
        301: TerminalDimensions(cols=155, rows=42),
        302: TerminalDimensions(cols=140, rows=50),
    }
    detector = NativeZellijClientDetector(proc_root=proc_root, server_pid=100)
    monkeypatch.setattr(detector, "_read_terminal_dimensions", dimensions.get)

    assert detector("work") == TerminalDimensions(cols=140, rows=42)
    assert detector("wor") == TerminalDimensions(cols=140, rows=42)
    assert detector.has_descendant_client(200)
    assert not detector.has_descendant_client(999)


def test_detector_returns_none_for_nonexistent_explicit_session(tmp_path, monkeypatch):
    proc_root = tmp_path / "proc"
    proc_root.mkdir()
    _add_process(proc_root, 300, 1, ["bash"])
    _add_process(proc_root, 301, 300, ["zellij"])

    detector = NativeZellijClientDetector(proc_root=proc_root, server_pid=100)
    monkeypatch.setattr(
        detector,
        "_read_terminal_dimensions",
        lambda _pid: TerminalDimensions(cols=155, rows=42),
    )

    assert detector("new-browser-session") is None


def _count_process_scans(detector, monkeypatch) -> list[int]:
    """Record every real /proc walk the detector performs."""
    scans: list[int] = []
    original = detector._scan_processes

    def counting_scan():
        scans.append(1)
        return original()

    monkeypatch.setattr(detector, "_scan_processes", counting_scan)
    return scans


def test_one_refresh_serves_every_query_in_the_snapshot_window(tmp_path, monkeypatch):
    """A reconciliation pass asks many overlapping questions about one moment.

    Each answer used to re-walk /proc (and re-run ``ss``), so cost scaled with the
    number of attached tabs. After ``refresh()`` they must all read one snapshot.
    """
    proc_root = tmp_path / "proc"
    proc_root.mkdir()
    _add_process(proc_root, 300, 1, ["bash"])
    _add_process(proc_root, 301, 300, ["zellij", "attach", "work"])

    detector = NativeZellijClientDetector(proc_root=proc_root, server_pid=100)
    scans = _count_process_scans(detector, monkeypatch)
    monkeypatch.setattr(detector, "_scan_ss_unix", lambda: [])

    detector.refresh()
    for _ in range(5):
        detector.has_descendant_client(300)
        detector.pty_zellij_client_pid(300)

    assert scans == [1]


def test_zero_ttl_disables_the_snapshot_cache(tmp_path, monkeypatch):
    """Tests that mutate /proc between queries need the cache out of the way."""
    proc_root = tmp_path / "proc"
    proc_root.mkdir()
    _add_process(proc_root, 300, 1, ["bash"])

    detector = NativeZellijClientDetector(
        proc_root=proc_root, server_pid=100, snapshot_ttl=0
    )
    scans = _count_process_scans(detector, monkeypatch)

    for _ in range(3):
        detector.has_descendant_client(300)

    assert len(scans) == 3


def test_refresh_skips_the_socket_scan_when_no_zellij_client_is_running(
    tmp_path,
    monkeypatch,
):
    """`ss -xp` is the expensive half; it cannot change any answer with no client."""
    proc_root = tmp_path / "proc"
    proc_root.mkdir()
    _add_process(proc_root, 300, 1, ["bash"])

    detector = NativeZellijClientDetector(proc_root=proc_root, server_pid=100)
    ss_scans: list[int] = []
    monkeypatch.setattr(detector, "_scan_ss_unix", lambda: ss_scans.append(1) or [])

    detector.refresh()
    assert ss_scans == []

    _add_process(proc_root, 301, 300, ["zellij", "attach", "work"])
    detector._process_cache = None  # force a re-scan; the client now exists
    detector.refresh()
    assert ss_scans == [1]
