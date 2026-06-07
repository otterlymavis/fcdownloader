"""Common language profiles for locale-sensitive extraction requests."""
from __future__ import annotations

import urllib.parse


COMMON_LANGUAGE_PROFILES: dict[str, str] = {
    "en": "en-US,en;q=0.9",
    "es": "es-ES,es;q=0.9,en-US;q=0.6,en;q=0.5",
    "fr": "fr-FR,fr;q=0.9,en-US;q=0.6,en;q=0.5",
    "de": "de-DE,de;q=0.9,en-US;q=0.6,en;q=0.5",
    "pt": "pt-BR,pt;q=0.9,en-US;q=0.6,en;q=0.5",
    "it": "it-IT,it;q=0.9,en-US;q=0.6,en;q=0.5",
    "ja": "ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5",
    "ko": "ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.5",
    "zh": "zh-CN,zh;q=0.9,en-US;q=0.6,en;q=0.5",
    "zh-hant": "zh-TW,zh;q=0.9,en-US;q=0.6,en;q=0.5",
    "hi": "hi-IN,hi;q=0.9,en-US;q=0.7,en;q=0.6",
    "ar": "ar-SA,ar;q=0.9,en-US;q=0.6,en;q=0.5",
    "id": "id-ID,id;q=0.9,en-US;q=0.6,en;q=0.5",
    "ru": "ru-RU,ru;q=0.9,en-US;q=0.6,en;q=0.5",
    "tr": "tr-TR,tr;q=0.9,en-US;q=0.6,en;q=0.5",
    "vi": "vi-VN,vi;q=0.9,en-US;q=0.6,en;q=0.5",
    "th": "th-TH,th;q=0.9,en-US;q=0.6,en;q=0.5",
}


_TLD_LANGUAGE: dict[str, str] = {
    "jp": "ja",
    "kr": "ko",
    "cn": "zh",
    "tw": "zh-hant",
    "hk": "zh-hant",
    "mo": "zh-hant",
    "in": "hi",
    "id": "id",
    "br": "pt",
    "pt": "pt",
    "es": "es",
    "mx": "es",
    "co": "es",
    "ar": "es",
    "cl": "es",
    "pe": "es",
    "fr": "fr",
    "de": "de",
    "it": "it",
    "sa": "ar",
    "ae": "ar",
    "eg": "ar",
    "qa": "ar",
    "kw": "ar",
    "bh": "ar",
    "om": "ar",
    "jo": "ar",
    "ma": "ar",
    "dz": "ar",
    "tn": "ar",
    "ru": "ru",
    "tr": "tr",
    "vn": "vi",
    "th": "th",
}


_HOST_LANGUAGE: dict[str, str] = {
    "bilibili.com": "zh",
    "b23.tv": "zh",
    "weibo.com": "zh",
    "weibo.cn": "zh",
    "xiaohongshu.com": "zh",
    "xhslink.com": "zh",
    "nicovideo.jp": "ja",
    "nico.ms": "ja",
    "niconico.com": "ja",
    "nicochannel.jp": "ja",
    "tver.jp": "ja",
    "abema.tv": "ja",
    "naver.com": "ko",
    "naver.me": "ko",
    "nhk.or.jp": "ja",
    "nhk.jp": "ja",
    "mdpr.jp": "ja",
    "modelpress.jp": "ja",
    "wwdjapan.com": "ja",
    "wwd.co.jp": "ja",
    "openrec.tv": "ja",
    "twitcasting.tv": "ja",
    "mildom.com": "ja",
    "ameba.jp": "ja",
    "ameblo.jp": "ja",
    "fc2.com": "ja",
    "fujitv.co.jp": "ja",
    "tbs.co.jp": "ja",
    "tbs.jp": "ja",
    "natalie.mu": "ja",
    "oricon.co.jp": "ja",
    "kstyle.com": "ja",
    "blog.livedoor.jp": "ja",
    "livedoor.blog": "ja",
    "bunshun.jp": "ja",
    "dailyshincho.jp": "ja",
    "news-postseven.com": "ja",
    "josei7.com": "ja",
    "friday.kodansha.co.jp": "ja",
    "gendai.media": "ja",
    "withonline.jp": "ja",
    "vivi.tv": "ja",
    "cancam.jp": "ja",
    "classy-online.jp": "ja",
    "jj-jj.net": "ja",
    "gingerweb.jp": "ja",
    "ar-mag.jp": "ja",
    "bisweb.jp": "ja",
    "ray-web.jp": "ja",
    "hpplus.jp": "ja",
    "fashion-press.net": "ja",
    "fashionsnap.com": "ja",
    "thetv.jp": "ja",
    "mantan-web.jp": "ja",
    "crank-in.net": "ja",
    "cinematoday.jp": "ja",
    "eiga.com": "ja",
    "realsound.jp": "ja",
    "jprime.jp": "ja",
    "smart-flash.jp": "ja",
    "pixiv.net": "ja",
    "fanbox.cc": "ja",
    "tistory.com": "ko",
    "daum.net": "ko",
    "kakao.com": "ko",
}


def normalize_language_tag(tag: str | None) -> str | None:
    """Return a supported common language code from a BCP-47-ish tag."""
    if not tag:
        return None
    normalized = tag.strip().replace("_", "-").lower()
    if not normalized:
        return None
    if normalized.startswith(("zh-tw", "zh-hk", "zh-mo", "zh-hant")):
        return "zh-hant"
    primary = normalized.split("-", 1)[0]
    if primary in COMMON_LANGUAGE_PROFILES:
        return primary
    return None


def accept_language_for_code(code: str | None) -> str | None:
    normalized = normalize_language_tag(code)
    if not normalized:
        return None
    return COMMON_LANGUAGE_PROFILES.get(normalized)


def accept_language_for_url(url: str, fallback: str | None = None) -> str | None:
    """Infer an Accept-Language header for common locale-specific sites."""
    try:
        host = urllib.parse.urlsplit(url).hostname or ""
    except Exception:
        return fallback

    host = host.lower().strip(".")
    if not host:
        return fallback

    for suffix, code in _HOST_LANGUAGE.items():
        if host == suffix or host.endswith(f".{suffix}"):
            return COMMON_LANGUAGE_PROFILES[code]

    tld = host.rsplit(".", 1)[-1]
    code = _TLD_LANGUAGE.get(tld)
    if not code:
        return fallback
    return COMMON_LANGUAGE_PROFILES[code]
