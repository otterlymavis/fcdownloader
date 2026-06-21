from scripts.verify_download_contract import looks_like_media


def test_accepts_mp4_signature() -> None:
    assert looks_like_media("video/mp4", b"\x00\x00\x00\x18ftypmp42")


def test_rejects_json_even_when_labeled_video() -> None:
    assert not looks_like_media("video/mp4", b' {"code":-403,"message":"forbidden"}')


def test_rejects_html_even_when_labeled_octet_stream() -> None:
    assert not looks_like_media("application/octet-stream", b"<!doctype html><title>Denied</title>")


def test_rejects_empty_body_even_when_labeled_video() -> None:
    assert not looks_like_media("video/mp4", b"")
