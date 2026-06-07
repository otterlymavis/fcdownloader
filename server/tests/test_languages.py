from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import languages


def test_accept_language_for_common_regional_domains():
    assert languages.accept_language_for_url("https://www.wwdjapan.com/articles/2323517").startswith("ja")
    assert languages.accept_language_for_url("https://tv.naver.com/v/123456").startswith("ko")
    assert languages.accept_language_for_url("https://mdpr.jp/news/detail/1234567").startswith("ja")
    assert languages.accept_language_for_url("https://www.bilibili.com/video/BV123").startswith("zh")
    assert languages.accept_language_for_url("https://example.fr/watch/1").startswith("fr")
    assert languages.accept_language_for_url("https://example.de/watch/1").startswith("de")
    assert languages.accept_language_for_url("https://example.br/watch/1").startswith("pt")
    assert languages.accept_language_for_url("https://example.in/watch/1").startswith("hi")
    assert languages.accept_language_for_url("https://example.ru/watch/1").startswith("ru")
    assert languages.accept_language_for_url("https://example.vn/watch/1").startswith("vi")


def test_accept_language_falls_back_for_unknown_domains():
    assert languages.accept_language_for_url("https://example.test/watch", "en-US,en;q=0.9") == "en-US,en;q=0.9"
    assert languages.accept_language_for_url("not-a-url", None) is None


def test_normalize_common_language_tags():
    assert languages.normalize_language_tag("es-MX") == "es"
    assert languages.normalize_language_tag("zh-TW") == "zh-hant"
    assert languages.normalize_language_tag("pt_BR") == "pt"
    assert languages.normalize_language_tag("ru-RU") == "ru"
    assert languages.normalize_language_tag("xx") is None
