"""Tests for browser-tab user scoping in app helpers."""

from porterminal.app import _build_scoped_user_id


def test_build_scoped_user_id_without_client_id_uses_base_user() -> None:
    user_id = _build_scoped_user_id("user@example.com", None)

    assert str(user_id) == "user@example.com"


def test_build_scoped_user_id_with_client_id_is_tab_scoped() -> None:
    user_id = _build_scoped_user_id("user@example.com", "tab-123")

    assert str(user_id) == "user@example.com::tab:tab-123"


def test_build_scoped_user_id_ignores_blank_client_id() -> None:
    user_id = _build_scoped_user_id("user@example.com", "   ")

    assert str(user_id) == "user@example.com"
