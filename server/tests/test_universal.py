from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import universal


PAGE_URL = "https://example.com/articles/post"


def test_extracts_strong_html_candidates_as_playlist():
    html = """
    <html>
      <head>
        <script type="application/ld+json">
          {
            "@type": "VideoObject",
            "name": "Launch clip",
            "contentUrl": "https:\\/\\/stream.example.com\\/master.m3u8",
            "thumbnailUrl": "https://cdn.example.com/poster.jpg"
          }
        </script>
      </head>
      <body>
        <video src="/media/clip.mp4"></video>
        <img src="https://cdn.example.com/gallery/fullsize.webp">
        <img src="https://cdn.example.com/favicon.png">
      </body>
    </html>
    """

    info = universal.extract_universal_from_html(PAGE_URL, html)

    assert info is not None
    assert info["_type"] == "playlist"
    urls = [entry["url"] for entry in info["entries"]]
    assert "https://stream.example.com/master.m3u8" in urls
    assert "https://example.com/media/clip.mp4" in urls
    assert "https://cdn.example.com/gallery/fullsize.webp" in urls
    assert "https://cdn.example.com/favicon.png" not in urls

    hls = next(entry for entry in info["entries"] if entry["url"].endswith("master.m3u8"))
    assert hls["protocol"] == "m3u8"
    assert hls["extractor"] == "universal-html"


def test_single_candidate_returns_single_info_dict():
    html = '<video src="https://cdn.example.com/video.mp4"></video>'

    info = universal.extract_universal_from_html(PAGE_URL, html)

    assert info is not None
    assert info.get("_type") is None
    assert info["url"] == "https://cdn.example.com/video.mp4"
    assert info["protocol"] == "https"


def test_open_graph_image_can_be_selected_when_image_only():
    html = '<meta property="og:image" content="https://cdn.example.com/share-card.jpg">'

    info = universal.extract_universal_from_html(PAGE_URL, html)

    assert info is not None
    assert info["url"] == "https://cdn.example.com/share-card.jpg"


def test_open_graph_type_pairs_with_extensionless_media_url():
    html = """
    <meta property="og:video" content="https://stream.example.com/og/master">
    <meta property="og:video:type" content="application/vnd.apple.mpegurl">
    <meta property="og:audio" content="https://audio.example.com/podcast/episode">
    <meta property="og:audio:type" content="audio/mpeg">
    """

    info = universal.extract_universal_from_html(PAGE_URL, html)

    assert info is not None
    assert info["_type"] == "playlist"
    hls = next(entry for entry in info["entries"] if entry["url"].endswith("/master"))
    audio = next(entry for entry in info["entries"] if entry["url"].endswith("/episode"))
    assert hls["protocol"] == "m3u8"
    assert hls["ext"] == "m3u8"
    assert audio["protocol"] == "https"
    assert audio["ext"] == "m4a"


def test_microdata_media_tags_are_extracted():
    html = """
    <div itemscope itemtype="https://schema.org/VideoObject">
      <meta itemprop="contentUrl" content="/schema/clip.mp4">
      <link itemprop="contentUrl" href="https://stream.example.com/schema/master" type="application/vnd.apple.mpegurl">
      <a itemprop="downloadUrl" href="https://cdn.example.com/schema/download.webm">Download</a>
      <img itemprop="thumbnailUrl" src="https://cdn.example.com/schema/thumb.webp">
      <meta itemprop="url" content="https://example.com/articles/canonical">
    </div>
    """

    info = universal.extract_universal_from_html(PAGE_URL, html)

    assert info is not None
    assert info["_type"] == "playlist"
    urls = [entry["url"] for entry in info["entries"]]
    assert "https://example.com/schema/clip.mp4" in urls
    assert "https://stream.example.com/schema/master" in urls
    assert "https://cdn.example.com/schema/download.webm" in urls
    assert "https://cdn.example.com/schema/thumb.webp" in urls
    assert "https://example.com/articles/canonical" not in urls

    hls = next(entry for entry in info["entries"] if entry["url"].endswith("/master"))
    thumb = next(entry for entry in info["entries"] if entry["url"].endswith("/thumb.webp"))
    assert hls["protocol"] == "m3u8"
    assert thumb["ext"] == "webp"


def test_low_confidence_generic_image_is_not_auto_selected():
    html = '<script>window.image = "https://cdn.example.com/share-card.jpg";</script>'

    assert universal.extract_universal_from_html(PAGE_URL, html) is None


def test_dash_manifest_is_extracted_as_dash_info():
    html = """
    <script type="application/ld+json">
      {"@type":"VideoObject","contentUrl":"https://media.example.com/video.mpd"}
    </script>
    """

    info = universal.extract_universal_from_html(PAGE_URL, html)

    assert info is not None
    assert info["url"] == "https://media.example.com/video.mpd"
    assert info["ext"] == "mpd"
    assert info["protocol"] == "http_dash_segments"


def test_typed_media_element_extracts_extensionless_source():
    html = """
    <video>
      <source src="https://cdn.example.com/playback/clip" type="video/mp4">
      <source src="https://cdn.example.com/playback/manifest" type="application/dash+xml">
    </video>
    """

    info = universal.extract_universal_from_html(PAGE_URL, html)

    assert info is not None
    assert info["_type"] == "playlist"
    video = next(entry for entry in info["entries"] if entry["url"].endswith("/clip"))
    dash = next(entry for entry in info["entries"] if entry["url"].endswith("/manifest"))
    assert video["protocol"] == "https"
    assert video["ext"] == "mp4"
    assert dash["protocol"] == "http_dash_segments"
    assert dash["ext"] == "mpd"


def test_resource_and_download_links_are_extracted():
    html = """
    <link rel="preload" as="video" href="https://cdn.example.com/preload/clip" type="video/mp4">
    <link rel="preload" as="fetch" href="https://stream.example.com/preload/master" type="application/vnd.apple.mpegurl">
    <link rel="preload" as="fetch" href="https://api.example.com/data.json" type="application/json">
    <a download="original.mp4" href="https://cdn.example.com/download/original.mp4">Download</a>
    """

    info = universal.extract_universal_from_html(PAGE_URL, html)

    assert info is not None
    assert info["_type"] == "playlist"
    urls = [entry["url"] for entry in info["entries"]]
    assert "https://cdn.example.com/preload/clip" in urls
    assert "https://stream.example.com/preload/master" in urls
    assert "https://cdn.example.com/download/original.mp4" in urls
    assert "https://api.example.com/data.json" not in urls

    preloaded = next(entry for entry in info["entries"] if entry["url"].endswith("/clip"))
    hls = next(entry for entry in info["entries"] if entry["url"].endswith("/master"))
    assert preloaded["ext"] == "mp4"
    assert preloaded["protocol"] == "https"
    assert hls["ext"] == "m3u8"
    assert hls["protocol"] == "m3u8"


def test_srcset_uses_largest_responsive_image_candidate():
    html = """
    <picture>
      <source type="image/webp" srcset="https://cdn.example.com/responsive/small.webp 480w, https://cdn.example.com/responsive/large.webp 1600w">
      <img srcset="/responsive/fallback-small.jpg 1x, /responsive/fallback-large.jpg 2x">
    </picture>
    <link rel="preload" as="image" imagesrcset="https://cdn.example.com/preload/small.jpg 400w, https://cdn.example.com/preload/large.jpg 1200w" type="image/jpeg">
    """

    info = universal.extract_universal_from_html(PAGE_URL, html)

    assert info is not None
    assert info["_type"] == "playlist"
    urls = [entry["url"] for entry in info["entries"]]
    assert "https://cdn.example.com/responsive/large.webp" in urls
    assert "https://example.com/responsive/fallback-large.jpg" in urls
    assert "https://cdn.example.com/preload/large.jpg" in urls
    assert "https://cdn.example.com/responsive/small.webp" not in urls


def test_data_attributes_extract_media_urls():
    html = """
    <div data-hls-url="https://stream.example.com/data/master"></div>
    <button data-video-url="https://cdn.example.com/data/clip.mp4"></button>
    <img data-original="https://cdn.example.com/data/original.webp">
    <div data-srcset="https://cdn.example.com/data/small.jpg 480w, https://cdn.example.com/data/large.jpg 1440w"></div>
    <div data-api-url="https://api.example.com/media/config"></div>
    """

    info = universal.extract_universal_from_html(PAGE_URL, html)

    assert info is not None
    assert info["_type"] == "playlist"
    urls = [entry["url"] for entry in info["entries"]]
    assert "https://stream.example.com/data/master" in urls
    assert "https://cdn.example.com/data/clip.mp4" in urls
    assert "https://cdn.example.com/data/original.webp" in urls
    assert "https://cdn.example.com/data/large.jpg" in urls
    assert "https://api.example.com/media/config" not in urls
    hls = next(entry for entry in info["entries"] if entry["url"].endswith("/master"))
    assert hls["protocol"] == "m3u8"
    assert hls["ext"] == "m3u8"


def test_css_background_images_are_extracted():
    html = """
    <div style="background-image: url('/assets/hero-large.webp')"></div>
    <style>
      .gallery { background: url("https://cdn.example.com/css/gallery.jpg") center / cover; }
      @font-face { src: url("https://cdn.example.com/fonts/site.woff2"); }
    </style>
    """

    info = universal.extract_universal_from_html(PAGE_URL, html)

    assert info is not None
    assert info["_type"] == "playlist"
    urls = [entry["url"] for entry in info["entries"]]
    assert "https://example.com/assets/hero-large.webp" in urls
    assert "https://cdn.example.com/css/gallery.jpg" in urls
    assert "https://cdn.example.com/fonts/site.woff2" not in urls


def test_player_configs_extract_relative_and_typed_media_urls():
    html = """
    <script>
      jwplayer("player").setup({
        playlist: [{
          sources: [
            { file: "/relative/live/master.m3u8", type: "application/vnd.apple.mpegurl" },
            { file: "../relative/movie.mpd", type: "application/dash+xml" },
            { file: "https://cdn.example.com/video/fallback.mp4", type: "video/mp4" }
          ],
          media_url: "/relative/typed-clip",
          type: "video/mp4"
        }],
        api: "https://api.example.com/player/config"
      });
    </script>
    """

    info = universal.extract_universal_from_html(PAGE_URL, html)

    assert info is not None
    assert info["_type"] == "playlist"
    urls = [entry["url"] for entry in info["entries"]]
    assert "https://example.com/relative/live/master.m3u8" in urls
    assert "https://example.com/relative/movie.mpd" in urls
    assert "https://example.com/relative/typed-clip" in urls
    assert "https://cdn.example.com/video/fallback.mp4" in urls
    assert "https://api.example.com/player/config" not in urls

    hls = next(entry for entry in info["entries"] if entry["url"].endswith("/master.m3u8"))
    dash = next(entry for entry in info["entries"] if entry["url"].endswith("/movie.mpd"))
    typed = next(entry for entry in info["entries"] if entry["url"].endswith("/typed-clip"))
    assert hls["protocol"] == "m3u8"
    assert dash["protocol"] == "http_dash_segments"
    assert typed["ext"] == "mp4"


def test_hydration_data_extracts_extensionless_hls_and_dash():
    html = """
    <script id="__NEXT_DATA__" type="application/json">
      {
        "props": {
          "pageProps": {
            "video": {
              "hlsUrl": "https:\\/\\/stream.example.com\\/playback\\/primary",
              "contentType": "application/vnd.apple.mpegurl",
              "dashUrl": "https:\\/\\/stream.example.com\\/playback\\/manifest",
              "mimeType": "application/dash+xml",
              "videoUrl": "https:\\/\\/cdn.example.com\\/hydrated\\/clip.mp4"
            },
            "api": "https:\\/\\/api.example.com\\/content\\/config"
          }
        }
      }
    </script>
    """

    info = universal.extract_universal_from_html(PAGE_URL, html)

    assert info is not None
    assert info["_type"] == "playlist"
    urls = [entry["url"] for entry in info["entries"]]
    assert "https://stream.example.com/playback/primary" in urls
    assert "https://stream.example.com/playback/manifest" in urls
    assert "https://cdn.example.com/hydrated/clip.mp4" in urls
    assert "https://api.example.com/content/config" not in urls

    hls = next(entry for entry in info["entries"] if entry["url"].endswith("/primary"))
    dash = next(entry for entry in info["entries"] if entry["url"].endswith("/manifest"))
    assert hls["protocol"] == "m3u8"
    assert hls["ext"] == "m3u8"
    assert dash["protocol"] == "http_dash_segments"
    assert dash["ext"] == "mpd"


def test_hydration_data_extracts_relative_media_urls_with_base_href():
    html = """
    <base href="https://cdn.example.com/assets/">
    <script id="__NEXT_DATA__" type="application/json">
      {
        "props": {
          "pageProps": {
            "video": {
              "hlsUrl": "streams/master.m3u8",
              "dashUrl": "./dash/manifest.mpd",
              "videoUrl": "../video/clip.mp4",
              "poster": "/posters/frame.webp"
            },
            "api": "/api/content/config"
          }
        }
      }
    </script>
    """

    info = universal.extract_universal_from_html("https://example.com/articles/story", html)

    assert info is not None
    assert info["_type"] == "playlist"
    urls = [entry["url"] for entry in info["entries"]]
    assert "https://cdn.example.com/assets/streams/master.m3u8" in urls
    assert "https://cdn.example.com/assets/dash/manifest.mpd" in urls
    assert "https://cdn.example.com/video/clip.mp4" in urls
    assert "https://cdn.example.com/posters/frame.webp" not in urls
    assert "https://cdn.example.com/api/content/config" not in urls

    hls = next(entry for entry in info["entries"] if entry["url"].endswith("/master.m3u8"))
    dash = next(entry for entry in info["entries"] if entry["url"].endswith("/manifest.mpd"))
    video = next(entry for entry in info["entries"] if entry["url"].endswith("/clip.mp4"))
    assert hls["protocol"] == "m3u8"
    assert dash["protocol"] == "http_dash_segments"
    assert video["ext"] == "mp4"


def test_server_fetch_response_extracts_universal_html():
    body = b'<video src="https://cdn.example.com/fetched.mp4"></video>'

    info = universal.extract_universal_from_response(PAGE_URL, body, "text/html; charset=utf-8")

    assert info is not None
    assert info["url"] == "https://cdn.example.com/fetched.mp4"
    assert info["extractor"] == "universal-html"


def test_base_href_resolves_relative_media_urls():
    html = """
    <base href="https://cdn.example.com/assets/">
    <video src="clips/main.mp4"></video>
    <img srcset="thumb-small.jpg 320w, thumb-large.webp 1280w">
    <link rel="preload" as="video" href="streams/live.m3u8" type="application/vnd.apple.mpegurl">
    <style>.hero { background-image: url("images/hero.webp"); }</style>
    <script type="application/ld+json">
      {"@type":"VideoObject","contentUrl":"json/video.mp4","thumbnailUrl":"json/poster.jpg"}
    </script>
    """

    info = universal.extract_universal_from_html("https://example.com/articles/story", html)

    assert info is not None
    assert info["_type"] == "playlist"
    urls = [entry["url"] for entry in info["entries"]]
    assert "https://cdn.example.com/assets/clips/main.mp4" in urls
    assert "https://cdn.example.com/assets/thumb-large.webp" in urls
    assert "https://cdn.example.com/assets/streams/live.m3u8" in urls
    assert "https://cdn.example.com/assets/images/hero.webp" in urls
    assert "https://cdn.example.com/assets/json/video.mp4" in urls
    entry = next(item for item in info["entries"] if item["url"] == "https://cdn.example.com/assets/clips/main.mp4")
    assert entry["webpage_url"] == "https://example.com/articles/story"


def test_server_fetch_response_skips_non_html_response():
    body = b'{"contentUrl":"https://cdn.example.com/video.mp4"}'

    assert universal.extract_universal_from_response(PAGE_URL, body, "application/json") is None


def test_server_fetch_response_skips_oversized_html():
    body = b"x" * (universal.PAGE_FETCH_MAX_BYTES + 1)

    assert universal.extract_universal_from_response(PAGE_URL, body, "text/html") is None


def test_server_fetch_policy_skips_obvious_direct_media_url():
    assert not universal.should_fetch_page_html("https://cdn.example.com/video.mp4")
    assert not universal.should_fetch_page_html("https://cdn.example.com/video.m3u8")
    assert not universal.should_fetch_page_html("https://cdn.example.com/video.mpd")


def test_scan_iframe_embed_urls_finds_known_players():
    html = """
    <html><body>
      <iframe src="https://player.vimeo.com/video/123456789"></iframe>
      <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>
      <iframe src="https://players.brightcove.net/1234/default_/index.html"></iframe>
      <iframe src="https://www.example.com/article"></iframe>
      <iframe data-src="https://cdn.jwplayer.com/players/AAAA-BBBB.html"></iframe>
    </body></html>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert "https://player.vimeo.com/video/123456789" in urls
    assert "https://www.youtube.com/embed/dQw4w9WgXcQ" in urls
    assert "https://players.brightcove.net/1234/default_/index.html" in urls
    assert "https://cdn.jwplayer.com/players/AAAA-BBBB.html" in urls
    # generic page URL should not be included
    assert "https://www.example.com/article" not in urls


def test_scan_iframe_embed_urls_returns_empty_for_no_embeds():
    html = "<html><body><p>No video here.</p></body></html>"
    assert universal.scan_iframe_embed_urls(PAGE_URL, html) == []


def test_scan_iframe_embed_urls_deduplicates():
    html = """
    <iframe src="https://player.vimeo.com/video/111"></iframe>
    <iframe src="https://player.vimeo.com/video/111"></iframe>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert urls.count("https://player.vimeo.com/video/111") == 1


def test_feed_extractor_rss_podcast():
    feed = """<?xml version="1.0"?>
    <rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
      <channel>
        <title>My Podcast</title>
        <item>
          <title>Episode 1</title>
          <enclosure url="https://cdn.example.com/ep1.mp3" type="audio/mpeg" length="12345"/>
          <itunes:image href="https://cdn.example.com/cover.jpg"/>
        </item>
        <item>
          <title>Episode 2</title>
          <enclosure url="https://cdn.example.com/ep2.m4a" type="audio/mp4" length="67890"/>
        </item>
      </channel>
    </rss>"""

    info = universal.extract_universal_from_feed(PAGE_URL, feed)

    assert info is not None
    assert info["_type"] == "playlist"
    assert info["title"] == "My Podcast"
    urls = [e["url"] for e in info["entries"]]
    assert "https://cdn.example.com/ep1.mp3" in urls
    assert "https://cdn.example.com/ep2.m4a" in urls
    ep1 = next(e for e in info["entries"] if e["url"].endswith("ep1.mp3"))
    assert ep1["ext"] == "mp3"
    assert ep1["thumbnail"] == "https://cdn.example.com/cover.jpg"


def test_feed_extractor_atom():
    feed = """<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>My Video Feed</title>
      <entry>
        <title>Clip 1</title>
        <link rel="enclosure" href="https://cdn.example.com/clip1.mp4" type="video/mp4" length="99999"/>
      </entry>
    </feed>"""

    info = universal.extract_universal_from_feed(PAGE_URL, feed)

    assert info is not None
    assert info["url"] == "https://cdn.example.com/clip1.mp4"
    assert info["ext"] == "mp4"
    assert info["title"] == "Clip 1"


def test_feed_extractor_returns_none_for_non_feed():
    info = universal.extract_universal_from_feed(PAGE_URL, "<html><body>Not a feed</body></html>")
    assert info is None


def test_is_feed_content_type():
    assert universal.is_feed_content_type("application/rss+xml")
    assert universal.is_feed_content_type("application/atom+xml; charset=utf-8")
    assert universal.is_feed_content_type("text/xml")
    assert universal.is_feed_content_type("application/xml")
    assert universal.is_feed_content_type("application/feed+json")
    assert not universal.is_feed_content_type("text/html")
    assert not universal.is_feed_content_type("application/json")


def test_json_feed_podcast():
    feed = """{
        "version": "https://jsonfeed.org/version/1.1",
        "title": "My JSON Podcast",
        "items": [
            {
                "id": "1",
                "title": "Episode One",
                "attachments": [
                    {"url": "https://cdn.example.com/ep1.mp3", "mime_type": "audio/mpeg"}
                ]
            },
            {
                "id": "2",
                "title": "Episode Two",
                "attachments": [
                    {"url": "https://cdn.example.com/ep2.m4a", "mime_type": "audio/mp4"}
                ]
            }
        ]
    }"""

    info = universal.extract_universal_from_json_feed(PAGE_URL, feed)

    assert info is not None
    assert info["_type"] == "playlist"
    assert info["title"] == "My JSON Podcast"
    urls = [e["url"] for e in info["entries"]]
    assert "https://cdn.example.com/ep1.mp3" in urls
    assert "https://cdn.example.com/ep2.m4a" in urls
    ep1 = next(e for e in info["entries"] if e["url"].endswith("ep1.mp3"))
    assert ep1["ext"] == "mp3"
    assert ep1["title"] == "Episode One"


def test_json_feed_single_item_returns_flat_dict():
    feed = """{
        "version": "https://jsonfeed.org/version/1",
        "title": "Video Blog",
        "items": [
            {
                "id": "clip1",
                "title": "My Clip",
                "attachments": [
                    {"url": "https://cdn.example.com/clip.mp4", "mime_type": "video/mp4"}
                ]
            }
        ]
    }"""

    info = universal.extract_universal_from_json_feed(PAGE_URL, feed)

    assert info is not None
    assert info.get("_type") is None
    assert info["url"] == "https://cdn.example.com/clip.mp4"
    assert info["ext"] == "mp4"


def test_json_feed_ignores_non_media_attachments():
    feed = """{
        "version": "https://jsonfeed.org/version/1.1",
        "title": "Blog",
        "items": [
            {
                "id": "post1",
                "title": "Post",
                "attachments": [
                    {"url": "https://example.com/image.jpg", "mime_type": "image/jpeg"},
                    {"url": "https://cdn.example.com/audio.mp3", "mime_type": "audio/mpeg"}
                ]
            }
        ]
    }"""

    info = universal.extract_universal_from_json_feed(PAGE_URL, feed)

    assert info is not None
    assert info["url"] == "https://cdn.example.com/audio.mp3"


def test_json_feed_returns_none_for_non_feed_json():
    info = universal.extract_universal_from_json_feed(PAGE_URL, '{"key": "value"}')
    assert info is None

    info = universal.extract_universal_from_json_feed(PAGE_URL, "not json at all")
    assert info is None


def test_scan_iframe_embed_urls_finds_json_ld_embed_url():
    html = """
    <html><head>
    <script type="application/ld+json">
    {
      "@type": "VideoObject",
      "name": "Demo",
      "embedUrl": "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "contentUrl": "https://stream.example.com/clip.mp4"
    }
    </script>
    </head></html>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("youtube.com/embed" in u for u in urls)


def test_scan_iframe_embed_urls_finds_player_url_in_script():
    html = """
    <script>
    var config = {
      "playerUrl": "https://player.vimeo.com/video/123456789",
      "title": "My Video"
    };
    </script>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("vimeo.com/video" in u for u in urls)


def test_scan_iframe_embed_urls_ignores_unknown_hosts_in_json_ld():
    html = """
    <script type="application/ld+json">
    {"embedUrl": "https://example-unknown-player.com/embed/abc"}
    </script>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert len(urls) == 0


def test_scan_iframe_embed_urls_includes_new_video_hosts():
    html = """
    <iframe src="https://embed.vidyard.com/share/abc123"></iframe>
    <iframe src="https://dai.ly/x8abc123"></iframe>
    <iframe src="https://iframe.bunny.net/embed/library/video"></iframe>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("vidyard.com" in u for u in urls)
    assert any("dai.ly" in u for u in urls)
    assert any("bunny.net" in u for u in urls)


def test_scan_iframe_embed_urls_includes_podcast_players():
    html = """
    <iframe src="https://player.simplecast.com/abc?dark=true"></iframe>
    <iframe src="https://share.transistor.fm/e/abc123"></iframe>
    <iframe src="https://embed.acast.com/feedid/episode-id"></iframe>
    <iframe src="https://embed.megaphone.fm/PC1234567890"></iframe>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("simplecast.com" in u for u in urls)
    assert any("transistor.fm" in u for u in urls)
    assert any("acast.com" in u for u in urls)
    assert any("megaphone.fm" in u for u in urls)


def test_scan_iframe_embed_urls_includes_kaltura_and_panopto():
    html = """
    <iframe src="https://cdnapisec.kaltura.com/p/1234/sp/123400/embedIframeJs/uiconf_id/56/partner_id/1234?iframeembed=true&entry_id=abc"></iframe>
    <iframe src="https://university.panopto.com/Panopto/Pages/Embed.aspx?id=VIDEO-GUID"></iframe>
    <iframe src="https://w.soundcloud.com/player/?url=https%3A//soundcloud.com/track/1234"></iframe>
    <iframe src="https://widget.spreaker.com/player?episode_id=12345&theme=light"></iframe>
    <iframe src="https://www.podbean.com/player-v2/?i=abc&from=pb6admin"></iframe>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("kaltura.com" in u for u in urls)
    assert any("panopto.com" in u for u in urls)
    assert any("soundcloud.com" in u for u in urls)
    assert any("spreaker.com" in u for u in urls)
    assert any("podbean.com" in u for u in urls)


def test_scan_feed_link_url_finds_rss():
    html = """
    <html><head>
      <link rel="alternate" type="application/rss+xml"
            title="My Podcast Feed" href="/feed/podcast.rss">
    </head></html>
    """
    url = universal.scan_feed_link_url(PAGE_URL, html)
    assert url == "https://example.com/feed/podcast.rss"


def test_scan_feed_link_url_finds_atom():
    html = """
    <html><head>
      <link rel="alternate" type="application/atom+xml" href="https://example.com/atom.xml">
    </head></html>
    """
    url = universal.scan_feed_link_url(PAGE_URL, html)
    assert url == "https://example.com/atom.xml"


def test_scan_feed_link_url_returns_none_when_absent():
    html = "<html><head><title>No feed here</title></head></html>"
    assert universal.scan_feed_link_url(PAGE_URL, html) is None


def test_scan_feed_link_url_ignores_non_alternate_rel():
    html = """
    <link rel="stylesheet" type="application/rss+xml" href="https://example.com/feed.rss">
    """
    assert universal.scan_feed_link_url(PAGE_URL, html) is None


def test_scan_oembed_endpoint_url_finds_json_link():
    html = """
    <html><head>
      <link rel="alternate" type="application/json+oembed"
            href="https://www.youtube.com/oembed?url=https%3A//www.youtube.com/watch%3Fv%3DdQw4w9WgXcQ&format=json"
            title="Never Gonna Give You Up">
    </head></html>
    """
    url = universal.scan_oembed_endpoint_url(PAGE_URL, html)
    assert url is not None
    assert "youtube.com/oembed" in url


def test_scan_oembed_endpoint_url_returns_none_when_absent():
    html = "<html><head><title>No oEmbed here</title></head></html>"
    assert universal.scan_oembed_endpoint_url(PAGE_URL, html) is None


def test_scan_oembed_endpoint_url_ignores_xml_oembed():
    html = """
    <link type="text/xml+oembed" href="https://example.com/oembed.xml">
    <link type="application/json+oembed" href="https://example.com/oembed.json">
    """
    url = universal.scan_oembed_endpoint_url(PAGE_URL, html)
    assert url == "https://example.com/oembed.json"


# ── has_video_or_audio ────────────────────────────────────────────────────────

def test_scan_iframe_embed_urls_finds_og_video_embed():
    html = """
    <html><head>
      <meta property="og:video" content="https://www.youtube.com/embed/dQw4w9WgXcQ">
      <meta property="og:video:type" content="text/html">
    </head></html>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("youtube.com/embed" in u for u in urls)


def test_scan_iframe_embed_urls_finds_twitter_player():
    html = """
    <html><head>
      <meta name="twitter:player" content="https://player.vimeo.com/video/123456789">
    </head></html>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("vimeo.com/video" in u for u in urls)


def test_scan_iframe_embed_urls_ignores_og_video_direct_mp4():
    # Direct .mp4 og:video URLs are NOT known player hosts — the HTML parser
    # handles them; the iframe scanner should not duplicate them.
    html = """
    <html><head>
      <meta property="og:video" content="https://cdn.example.com/video.mp4">
    </head></html>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert len(urls) == 0


def test_looks_like_json_feed_text():
    valid = '{"version": "https://jsonfeed.org/version/1.1", "title": "My Podcast", "items": []}'
    assert universal.looks_like_json_feed_text(valid) is True
    assert universal.looks_like_json_feed_text('{"key": "value"}') is False
    assert universal.looks_like_json_feed_text("not json") is False
    assert universal.looks_like_json_feed_text("") is False


def test_player_config_finds_manifest_url_without_jwplayer_marker():
    html = """
    <script>
    var playerConfig = {
      manifest_url: "https://live.example.com/stream/index.m3u8",
      title: "Live Stream"
    };
    </script>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("index.m3u8" in u for u in urls)


def test_looks_like_feed_text_rss():
    assert universal.looks_like_feed_text('<?xml version="1.0"?><rss version="2.0">') is True
    assert universal.looks_like_feed_text("<rss version=\"2.0\">") is True
    assert universal.looks_like_feed_text("<feed xmlns=\"http://www.w3.org/2005/Atom\">") is True
    assert universal.looks_like_feed_text("<html><body>Not a feed</body></html>") is False
    assert universal.looks_like_feed_text("{}") is False
    assert universal.looks_like_feed_text("") is False


def test_hydration_data_extracts_manifest_url():
    html = """
    <script id="__NEXT_DATA__" type="application/json">
    {
      "props": {
        "pageProps": {
          "manifest_url": "https://cdn.example.com/stream/master.m3u8",
          "title": "Episode 1"
        }
      }
    }
    </script>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("master.m3u8" in u for u in urls)


def test_hydration_data_extracts_playback_url():
    html = """
    <script id="__NEXT_DATA__" type="application/json">
    {"props": {"pageProps": {"playback_url": "https://cdn.example.com/video/clip.mp4"}}}
    </script>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("clip.mp4" in u for u in urls)


def test_has_video_or_audio_single_video():
    info = {"url": "https://cdn.example.com/video.mp4", "ext": "mp4", "protocol": "https"}
    assert universal.has_video_or_audio(info) is True


def test_has_video_or_audio_single_hls():
    info = {"url": "https://cdn.example.com/master.m3u8", "ext": "m3u8", "protocol": "m3u8"}
    assert universal.has_video_or_audio(info) is True


def test_has_video_or_audio_single_image():
    info = {"url": "https://cdn.example.com/poster.jpg", "ext": "jpg", "protocol": "https"}
    assert universal.has_video_or_audio(info) is False


def test_has_video_or_audio_playlist_mixed():
    info = {
        "_type": "playlist",
        "entries": [
            {"url": "https://cdn.example.com/thumb.jpg", "ext": "jpg", "protocol": "https"},
            {"url": "https://cdn.example.com/clip.mp4", "ext": "mp4", "protocol": "https"},
        ],
    }
    assert universal.has_video_or_audio(info) is True


def test_has_video_or_audio_playlist_images_only():
    info = {
        "_type": "playlist",
        "entries": [
            {"url": "https://cdn.example.com/a.jpg", "ext": "jpg", "protocol": "https"},
            {"url": "https://cdn.example.com/b.webp", "ext": "webp", "protocol": "https"},
        ],
    }
    assert universal.has_video_or_audio(info) is False


def test_has_video_or_audio_dash_protocol():
    # DASH streams have ext "mpd" — not in IMAGE_EXTS, so counts as video
    info = {"url": "https://cdn.example.com/manifest.mpd", "ext": "mpd", "protocol": "http_dash_segments"}
    assert universal.has_video_or_audio(info) is True


def test_has_video_or_audio_audio_only():
    info = {"url": "https://cdn.example.com/episode.mp3", "ext": "mp3", "protocol": "https"}
    assert universal.has_video_or_audio(info) is True


# ── extract_universal_from_json_api ──────────────────────────────────────────

def test_json_api_extracts_hls_from_manifest_url():
    json_text = '{"manifest_url": "https://cdn.example.com/live/master.m3u8", "title": "Live stream"}'
    info = universal.extract_universal_from_json_api(PAGE_URL, json_text)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("master.m3u8" in u for u in urls)


def test_json_api_extracts_mp4_from_playback_url():
    json_text = '{"data": {"playback_url": "https://cdn.example.com/clip.mp4"}}'
    info = universal.extract_universal_from_json_api(PAGE_URL, json_text)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("clip.mp4" in u for u in urls)


def test_json_api_returns_none_for_no_media():
    json_text = '{"status": "ok", "message": "no video here"}'
    info = universal.extract_universal_from_json_api(PAGE_URL, json_text)
    assert info is None


def test_json_api_handles_invalid_json():
    info = universal.extract_universal_from_json_api(PAGE_URL, "not-json-at-all")
    assert info is None


# ── scan_meta_refresh_url ─────────────────────────────────────────────────────

def test_scan_meta_refresh_url_finds_redirect():
    html = '<html><head><meta http-equiv="refresh" content="0;url=https://example.com/real-page"></head></html>'
    result = universal.scan_meta_refresh_url(PAGE_URL, html)
    assert result == "https://example.com/real-page"


def test_scan_meta_refresh_url_ignores_same_url():
    html = f'<html><head><meta http-equiv="refresh" content="0;url={PAGE_URL}"></head></html>'
    result = universal.scan_meta_refresh_url(PAGE_URL, html)
    assert result is None


def test_scan_meta_refresh_url_no_refresh_tag():
    html = "<html><head><meta name='description' content='test'></head></html>"
    result = universal.scan_meta_refresh_url(PAGE_URL, html)
    assert result is None


def test_scan_meta_refresh_url_with_delay():
    html = '<meta http-equiv="REFRESH" content="5; URL=https://example.com/dest">'
    result = universal.scan_meta_refresh_url(PAGE_URL, html)
    assert result == "https://example.com/dest"


# ── reorder_by_preferred_quality ─────────────────────────────────────────────

def test_reorder_by_preferred_quality_best():
    info = {
        "_type": "playlist",
        "entries": [
            {"url": "https://cdn.example.com/video_480p.mp4"},
            {"url": "https://cdn.example.com/video_1080p.mp4"},
            {"url": "https://cdn.example.com/video_720p.mp4"},
        ],
    }
    reordered = universal.reorder_by_preferred_quality(info, "best")
    urls = [e["url"] for e in reordered["entries"]]
    assert "1080p" in urls[0]


def test_reorder_by_preferred_quality_worst():
    info = {
        "_type": "playlist",
        "entries": [
            {"url": "https://cdn.example.com/video_480p.mp4"},
            {"url": "https://cdn.example.com/video_1080p.mp4"},
            {"url": "https://cdn.example.com/video_720p.mp4"},
        ],
    }
    reordered = universal.reorder_by_preferred_quality(info, "worst")
    urls = [e["url"] for e in reordered["entries"]]
    assert "480p" in urls[0]


def test_reorder_by_preferred_quality_specific():
    info = {
        "_type": "playlist",
        "entries": [
            {"url": "https://cdn.example.com/video_480p.mp4"},
            {"url": "https://cdn.example.com/video_1080p.mp4"},
            {"url": "https://cdn.example.com/video_720p.mp4"},
        ],
    }
    reordered = universal.reorder_by_preferred_quality(info, "720")
    urls = [e["url"] for e in reordered["entries"]]
    assert "720p" in urls[0]


def test_reorder_by_preferred_quality_no_hints():
    # URLs with no quality hint — original order preserved
    entries = [
        {"url": "https://cdn.example.com/a.mp4"},
        {"url": "https://cdn.example.com/b.mp4"},
    ]
    info = {"_type": "playlist", "entries": entries}
    reordered = universal.reorder_by_preferred_quality(info, "best")
    assert reordered["entries"] == entries


def test_reorder_by_preferred_quality_non_playlist():
    # Single-video result — returned unchanged
    info = {"url": "https://cdn.example.com/video.mp4"}
    reordered = universal.reorder_by_preferred_quality(info, "best")
    assert reordered == info


# ── scan_canonical_url ────────────────────────────────────────────────────────

def test_scan_canonical_url_finds_different():
    html = '<link rel="canonical" href="https://example.com/canonical-article">'
    result = universal.scan_canonical_url("https://example.com/amp/article", html)
    assert result == "https://example.com/canonical-article"


def test_scan_canonical_url_ignores_same_url():
    html = '<link rel="canonical" href="https://example.com/page">'
    result = universal.scan_canonical_url("https://example.com/page", html)
    assert result is None


def test_scan_canonical_url_returns_none_when_absent():
    html = '<link rel="alternate" href="https://example.com/feed.rss">'
    result = universal.scan_canonical_url("https://example.com/page", html)
    assert result is None


def test_scan_canonical_url_resolves_relative():
    html = '<link rel="canonical" href="/real-page">'
    result = universal.scan_canonical_url("https://example.com/amp/real-page", html)
    assert result == "https://example.com/real-page"


# ── scan_feed_link_from_header ────────────────────────────────────────────────

def test_scan_feed_link_from_header_finds_rss():
    header = '</feed.rss>; rel="alternate"; type="application/rss+xml"'
    result = universal.scan_feed_link_from_header(PAGE_URL, header)
    assert result and "feed.rss" in result


def test_scan_feed_link_from_header_finds_atom():
    header = '<https://podcast.example.com/atom.xml>; rel="alternate"; type="application/atom+xml"'
    result = universal.scan_feed_link_from_header(PAGE_URL, header)
    assert result == "https://podcast.example.com/atom.xml"


def test_scan_feed_link_from_header_ignores_non_feed():
    header = '<https://example.com/style.css>; rel="stylesheet"; type="text/css"'
    result = universal.scan_feed_link_from_header(PAGE_URL, header)
    assert result is None


def test_scan_feed_link_from_header_multiple_links():
    header = (
        '<https://example.com/style.css>; rel="stylesheet"; type="text/css", '
        '<https://podcast.example.com/feed.rss>; rel="alternate"; type="application/rss+xml"'
    )
    result = universal.scan_feed_link_from_header(PAGE_URL, header)
    assert result == "https://podcast.example.com/feed.rss"


# ── noscript inner HTML scanning ──────────────────────────────────────────────

def test_extract_html_scans_noscript_images():
    html_text = """
    <html><body>
    <noscript><img src="https://cdn.example.com/photo-full.jpg" /></noscript>
    <img data-src="placeholder.jpg" class="lazy" />
    </body></html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("photo-full.jpg" in u for u in urls)


# ── broader hydration patterns ────────────────────────────────────────────────

def test_hydration_detects_preloaded_state():
    html_text = """
    <script>
    window.__PRELOADED_STATE__ = {"video": {"video_url": "https://cdn.example.com/episode.mp4"}};
    </script>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("episode.mp4" in u for u in urls)


def test_hydration_detects_video_data():
    html_text = """
    <script>
    window.videoData = {"hls_url": "https://cdn.example.com/live.m3u8"};
    </script>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("live.m3u8" in u for u in urls)


# ── window.* player config patterns ──────────────────────────────────────────

def test_player_config_finds_window_player_config():
    html_text = """
    <script>
    window.PlayerConfig = {src: "https://cdn.example.com/clip.mp4"};
    </script>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("clip.mp4" in u for u in urls)


# ── RSS <media:group> support ─────────────────────────────────────────────────

def test_feed_rss_media_group():
    xml = """<?xml version="1.0"?>
    <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
      <channel>
        <title>Video Podcast</title>
        <item>
          <title>Episode 1</title>
          <media:group>
            <media:content url="https://cdn.example.com/ep1.mp4" type="video/mp4" medium="video"/>
          </media:group>
        </item>
      </channel>
    </rss>"""
    info = universal.extract_universal_from_feed(PAGE_URL, xml)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("ep1.mp4" in u for u in urls)


# ── Atom <content type="video/..."> support ───────────────────────────────────

def test_feed_atom_content_video():
    xml = """<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Video Feed</title>
      <entry>
        <title>Clip</title>
        <content type="video/mp4" src="https://cdn.example.com/clip-atom.mp4"/>
      </entry>
    </feed>"""
    info = universal.extract_universal_from_feed(PAGE_URL, xml)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("clip-atom.mp4" in u for u in urls)


# ── JSON Feed external_url ────────────────────────────────────────────────────

def test_json_feed_external_url():
    feed = """{
      "version": "https://jsonfeed.org/version/1.1",
      "title": "Podcast",
      "items": [
        {
          "id": "1",
          "title": "Episode",
          "external_url": "https://cdn.example.com/episode.mp3"
        }
      ]
    }"""
    info = universal.extract_universal_from_json_feed(PAGE_URL, feed)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("episode.mp3" in u for u in urls)


def test_json_feed_external_url_skipped_when_has_attachment():
    feed = """{
      "version": "https://jsonfeed.org/version/1.1",
      "title": "Podcast",
      "items": [
        {
          "id": "1",
          "title": "Episode",
          "external_url": "https://cdn.example.com/episode.mp3",
          "attachments": [{"url": "https://cdn.example.com/file.mp4", "mime_type": "video/mp4"}]
        }
      ]
    }"""
    info = universal.extract_universal_from_json_feed(PAGE_URL, feed)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("file.mp4" in u for u in urls)


# ── JSON-LD expanded types ────────────────────────────────────────────────────

def test_json_ld_broadcast_event():
    html_text = """
    <script type="application/ld+json">
    {"@type": "BroadcastEvent", "contentUrl": "https://cdn.example.com/live.m3u8"}
    </script>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("live.m3u8" in u for u in urls)


def test_json_ld_music_video():
    html_text = """
    <script type="application/ld+json">
    {"@type": "MusicVideo", "contentUrl": "https://cdn.example.com/mv.mp4"}
    </script>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("mv.mp4" in u for u in urls)


def test_json_ld_has_part_video_object():
    html_text = """
    <script type="application/ld+json">
    {
      "@type": "Article",
      "name": "My Article",
      "hasPart": {"@type": "VideoObject", "contentUrl": "https://cdn.example.com/embedded.mp4"}
    }
    </script>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("embedded.mp4" in u for u in urls)


def test_json_ld_radio_episode():
    html_text = """
    <script type="application/ld+json">
    {"@type": "RadioEpisode", "contentUrl": "https://cdn.example.com/podcast.mp3"}
    </script>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("podcast.mp3" in u for u in urls)


# ── <script type="text/html"> template scanning ───────────────────────────────

def test_html_template_script_video():
    html_text = """
    <html><body>
    <script type="text/html" id="video-tmpl">
      <video src="https://cdn.example.com/tmpl-video.mp4"></video>
    </script>
    </body></html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("tmpl-video.mp4" in u for u in urls)


def test_html_template_script_hbs():
    html_text = """
    <script type="text/x-handlebars-template">
      <source src="https://cdn.example.com/hbs-clip.mp4" type="video/mp4">
    </script>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("hbs-clip.mp4" in u for u in urls)


# ── feed channel thumbnail fallback ──────────────────────────────────────────

def test_feed_channel_itunes_image_fallback():
    xml = """<?xml version="1.0"?>
    <rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
      <channel>
        <title>Podcast</title>
        <itunes:image href="https://cdn.example.com/channel-art.jpg"/>
        <item>
          <title>Episode 1</title>
          <enclosure url="https://cdn.example.com/ep1.mp3" type="audio/mpeg"/>
        </item>
      </channel>
    </rss>"""
    info = universal.extract_universal_from_feed(PAGE_URL, xml)
    assert info is not None
    assert info.get("thumbnail") == "https://cdn.example.com/channel-art.jpg"


def test_feed_channel_image_fallback_not_overwrite_episode_thumb():
    xml = """<?xml version="1.0"?>
    <rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
         xmlns:media="http://search.yahoo.com/mrss/">
      <channel>
        <title>Podcast</title>
        <itunes:image href="https://cdn.example.com/channel-art.jpg"/>
        <item>
          <title>Episode 1</title>
          <enclosure url="https://cdn.example.com/ep1.mp3" type="audio/mpeg"/>
          <itunes:image href="https://cdn.example.com/ep-art.jpg"/>
        </item>
      </channel>
    </rss>"""
    info = universal.extract_universal_from_feed(PAGE_URL, xml)
    assert info is not None
    assert info.get("thumbnail") == "https://cdn.example.com/ep-art.jpg"


# ── _is_junk SVG/font filter ──────────────────────────────────────────────────

def test_is_junk_svg_filtered():
    info = universal.extract_universal_from_html(PAGE_URL, """
    <html><body>
    <img src="https://cdn.example.com/icon.svg" />
    <video src="https://cdn.example.com/clip.mp4"></video>
    </body></html>
    """)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert not any("icon.svg" in u for u in urls)
    assert any("clip.mp4" in u for u in urls)


# ── _scan_json_data_attributes ────────────────────────────────────────────────

def test_json_data_attr_data_config_hls():
    html_text = """
    <div class="video-player"
         data-config='{"hls_url": "https://cdn.example.com/live.m3u8"}'></div>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("live.m3u8" in u for u in urls)


def test_json_data_attr_data_setup_sources():
    html_text = """
    <video data-setup='{"sources": [{"src": "https://cdn.example.com/video.mp4", "type": "video/mp4"}]}'>
    </video>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("video.mp4" in u for u in urls)


def test_json_data_attr_content_triggered():
    # Attribute name doesn't match, but content has known key
    html_text = """
    <div data-player-options='{"video_url": "https://cdn.example.com/clip.mp4"}'></div>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("clip.mp4" in u for u in urls)


def test_json_data_attr_skips_non_media_json():
    html_text = """
    <div data-config='{"theme": "dark", "lang": "en", "pagination": true}'></div>
    """
    # Should not crash and should return None (no media found)
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is None


# ── _scan_page_title ──────────────────────────────────────────────────────────

def test_page_title_used_for_single_entry():
    html_text = """
    <html>
    <head>
      <title>My Awesome Video - Site Name</title>
    </head>
    <body>
      <video src="https://cdn.example.com/awesome.mp4"></video>
    </body>
    </html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    assert info.get("title") == "My Awesome Video - Site Name"


def test_og_title_preferred_over_title_tag():
    html_text = """
    <html>
    <head>
      <title>Site Name - Article</title>
      <meta property="og:title" content="Real Video Title" />
    </head>
    <body>
      <video src="https://cdn.example.com/vid.mp4"></video>
    </body>
    </html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    assert info.get("title") == "Real Video Title"


def test_page_title_used_for_playlist():
    html_text = """
    <html>
    <head><title>Photo Gallery</title></head>
    <body>
      <img src="https://cdn.example.com/photo1.jpg" />
      <img src="https://cdn.example.com/photo2.jpg" />
    </body>
    </html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None and info.get("_type") == "playlist"
    assert info.get("title") == "Photo Gallery"


# ── Round 6 tests ─────────────────────────────────────────────────────────────

def test_json_api_walks_json_ld_video_object():
    json_text = '{"@context":"https://schema.org","@type":"VideoObject","name":"Schema API Video","contentUrl":"https://cdn.example.com/video.mp4"}'
    info = universal.extract_universal_from_json_api(PAGE_URL, json_text)
    assert info is not None
    entries = [info] if info.get("url") else info.get("entries", [])
    assert any(e.get("url") == "https://cdn.example.com/video.mp4" for e in entries)


def test_scan_feed_link_url_includes_json_feed_type():
    html_text = """<link rel="alternate" type="application/feed+json" href="https://example.com/feed.json" />"""
    url = universal.scan_feed_link_url(PAGE_URL, html_text)
    assert url == "https://example.com/feed.json"


def test_entry_includes_referer_header():
    html_text = '<video src="https://cdn.example.com/clip.mp4"></video>'
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    assert info.get("http_headers", {}).get("Referer") == PAGE_URL


def test_json_ld_broadcast_event_ts_parity():
    """Python already tests broadcastevent; this confirms scan_feed_link_url new type."""
    url = universal.scan_feed_link_url(PAGE_URL, '<link rel="alternate" type="application/atom+xml" href="/atom.xml" />')
    assert url == "https://example.com/atom.xml"


def test_json_ld_radio_episode_walks_correctly():
    html_text = """
    <script type="application/ld+json">
    {"@type": "RadioEpisode", "name": "Ep 1", "contentUrl": "https://cdn.example.com/ep1.mp3"}
    </script>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    assert info.get("url") == "https://cdn.example.com/ep1.mp3"


def test_json_ld_work_example_traversed():
    html_text = """
    <script type="application/ld+json">
    {"@type": "TVSeries", "name": "Show", "workExample": {"@type": "TVEpisode", "contentUrl": "https://cdn.example.com/ep.mp4"}}
    </script>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    assert info.get("url") == "https://cdn.example.com/ep.mp4"


# ── Round 7 tests ─────────────────────────────────────────────────────────────

def test_hydration_finds_audio_url():
    html_text = """
    <script>
    var __INITIAL_STATE__ = {"audio_url": "https://cdn.example.com/track.mp3", "title": "My Song"};
    </script>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    assert info.get("url") == "https://cdn.example.com/track.mp3"


def test_player_config_finds_audio_url():
    html_text = """
    <script>
    jwplayer("player").setup({audio_url: "https://cdn.example.com/podcast.mp3"});
    </script>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    assert info.get("url") == "https://cdn.example.com/podcast.mp3"


def test_json_api_extracts_title():
    json_text = '{"title":"My Music Video","hls_url":"https://cdn.example.com/stream.m3u8"}'
    info = universal.extract_universal_from_json_api(PAGE_URL, json_text)
    assert info is not None
    assert info.get("title") == "My Music Video"
    assert info.get("url") == "https://cdn.example.com/stream.m3u8"


def test_json_api_title_from_name_field():
    json_text = '{"name":"Album Track","audio_url":"https://cdn.example.com/audio.m4a"}'
    info = universal.extract_universal_from_json_api(PAGE_URL, json_text)
    assert info is not None
    assert info.get("title") == "Album Track"


def test_extract_json_title_from_list_wrapper():
    """Some APIs return [{...}] — should unwrap first item for title."""
    data = [{"title": "Episode 1", "hls_url": "https://cdn.example.com/ep1.m3u8"}]
    title = universal._extract_json_title(data)
    assert title == "Episode 1"


# ── Round 8 tests ─────────────────────────────────────────────────────────────

def test_player_config_prefilter_passes_audio_url_script():
    """A script with only audio_url (no jwplayer/hls/etc) should now be scanned."""
    html_text = """
    <script>
    var config = {audio_url: "https://cdn.example.com/ep.mp3"};
    </script>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    assert info.get("url") == "https://cdn.example.com/ep.mp3"


def test_video_poster_extracted_as_image():
    html_text = """<video poster="https://cdn.example.com/thumb.jpg" src="https://cdn.example.com/vid.mp4"></video>"""
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    # Result could be a single video entry or playlist with both
    urls = [info.get("url")] if info.get("url") else [e.get("url") for e in info.get("entries", [])]
    assert "https://cdn.example.com/thumb.jpg" in urls


def test_scan_feed_link_url_podcast_xml():
    html_text = """<link rel="alternate" type="application/podcast+xml" href="https://feeds.example.com/podcast" />"""
    url = universal.scan_feed_link_url(PAGE_URL, html_text)
    assert url == "https://feeds.example.com/podcast"


def test_extract_json_title_nested_data_key():
    """_extract_json_title should find title one level deep under 'data'."""
    import sys, os
    data = {"data": {"title": "Nested Video Title", "hls_url": "https://cdn.example.com/v.m3u8"}}
    title = universal._extract_json_title(data)
    assert title == "Nested Video Title"


def test_extract_json_title_nested_video_key():
    data = {"video": {"name": "Track Name", "audio_url": "https://cdn.example.com/t.mp3"}}
    title = universal._extract_json_title(data)
    assert title == "Track Name"


def test_json_api_title_from_nested_data():
    json_text = '{"data":{"title":"Deep Title","hls_url":"https://cdn.example.com/deep.m3u8"}}'
    info = universal.extract_universal_from_json_api(PAGE_URL, json_text)
    assert info is not None
    assert info.get("title") == "Deep Title"


# ── Round 9: media element attrs, m3u8Url/liveUrl hydration ──────────────────

def test_media_element_data_lazy_src_video():
    """extract_universal_from_html picks up data-lazy-src on <video>."""
    html = '<video data-lazy-src="https://cdn.example.com/lazy.mp4"></video>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert "lazy.mp4" in info.get("url", "")


def test_hydration_m3u8_url_key():
    """Hydration scanner recognises m3u8_url key as HLS."""
    html = '<script id="__INITIAL_STATE__">{"m3u8_url":"https://cdn.example.com/live.m3u8"}</script>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert "live.m3u8" in info.get("url", "")


def test_hydration_live_url_key():
    """Hydration scanner recognises live_url key and treats it as video."""
    html = '<script id="__INITIAL_STATE__">{"live_url":"https://live.example.com/stream.mp4"}</script>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert "stream.mp4" in info.get("url", "")


def test_player_config_m3u8url_key():
    """Player-config scanner accepts m3u8Url as an explicit HLS key."""
    html = '<script>var player={m3u8Url:"https://cdn.example.com/video.m3u8"};</script>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert "video.m3u8" in info.get("url", "")


# ── Round 10: template scanner attrs, JSON data RE, playerMime keys ───────────

def test_template_script_data_lazy_src():
    """HTML template scanner picks up data-lazy-src on <img> inside <script type=text/html>."""
    html = '<script type="text/html" id="tmpl"><img data-lazy-src="https://cdn.example.com/lazy.jpg"></script>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert "lazy.jpg" in info.get("url", "")


def test_template_script_data_stream_url():
    """HTML template scanner picks up data-stream-url on <video> inside non-JS script."""
    html = '<script type="text/x-handlebars-template"><video data-stream-url="https://cdn.example.com/stream.mp4"></video></script>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert "stream.mp4" in info.get("url", "")


def test_json_data_attr_live_url_key():
    """JSON data attribute scanner triggers when live_url key appears in embedded JSON."""
    html = '<div data-player=\'{"live_url":"https://live.example.com/live.mp4"}\'></div>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    all_urls = [e.get("url", "") for e in info.get("entries", [])] if info.get("_type") == "playlist" else [info.get("url", "")]
    assert any("live.mp4" in u for u in all_urls)


def test_json_data_attr_m3u8_url_key():
    """JSON data attribute scanner triggers when m3u8_url key appears in embedded JSON."""
    html = '<div data-player=\'{"m3u8_url":"https://cdn.example.com/hls.m3u8"}\'></div>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    all_urls = [e.get("url", "") for e in info.get("entries", [])] if info.get("_type") == "playlist" else [info.get("url", "")]
    assert any("hls.m3u8" in u for u in all_urls)


# ── Round 11: makeItem thumbnail/duration/Referer; player hint keys ───────────

def test_json_ld_thumbnail_propagated_to_entry():
    """_walk_json_ld extracts thumbnailUrl from VideoObject and stores in thumbnail field."""
    html = '''<script type="application/ld+json">
    {"@type":"VideoObject","name":"Demo","contentUrl":"https://cdn.example.com/v.mp4",
     "thumbnailUrl":"https://cdn.example.com/thumb.jpg"}
    </script>'''
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    # Single entry: thumbnail should be populated
    assert "thumb.jpg" in (info.get("thumbnail") or "")


def test_json_ld_name_used_as_title():
    """VideoObject name field propagates as entry title."""
    html = '''<script type="application/ld+json">
    {"@type":"VideoObject","name":"My Video Title","contentUrl":"https://cdn.example.com/v.mp4"}
    </script>'''
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert info.get("title") == "My Video Title"


def test_entry_http_headers_referer():
    """_entry() always adds http_headers with Referer set to page_url."""
    html = '<video src="https://cdn.example.com/video.mp4"></video>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert info.get("http_headers", {}).get("Referer") == PAGE_URL


def test_player_config_m3u8_mime_hint():
    """player config m3u8Url key yields HLS protocol, not just 'video/mp4'."""
    html = '<script>var cfg={m3u8Url:"https://cdn.example.com/live.m3u8"};</script>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert info.get("protocol") == "m3u8"


# ── Round 12: microdata lazy-src, data-attr lazy keyword, template confidence ─

def test_microdata_data_lazy_src():
    """scanMicrodataMedia picks up data-lazy-src on itemprop=thumbnailUrl."""
    html = '<img itemprop="thumbnailUrl" data-lazy-src="https://cdn.example.com/thumb.jpg">'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert "thumb.jpg" in info.get("url", "")


def test_data_attr_lazy_src_accepted():
    """_strong_data_attribute accepts data-lazy-src (lazy keyword added to allow-list)."""
    html = '<div data-lazy-src="https://cdn.example.com/photo.jpg"></div>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert "photo.jpg" in info.get("url", "")


def test_data_attr_lazy_bg_accepted():
    """_strong_data_attribute accepts data-lazy-bg (lazy keyword covers lazy-loading BG images)."""
    html = '<div data-lazy-bg="https://cdn.example.com/bg.jpg"></div>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert "bg.jpg" in info.get("url", "")


def test_template_script_src_video_passes_confidence():
    """html-template confidence is now above threshold — <video src> in text/html script is extracted."""
    html = '<script type="text/html"><video src="https://cdn.example.com/tpl.mp4"></video></script>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert "tpl.mp4" in info.get("url", "")


# ── Round 13: <track> element subtitle extraction ─────────────────────────────

def test_track_subtitles_extracted():
    """<track kind=subtitles> src is extracted as a subtitle entry."""
    html = """
    <video src="https://cdn.example.com/video.mp4">
      <track kind="subtitles" src="https://cdn.example.com/subs/en.vtt" srclang="en" label="English">
    </video>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    # Video should come first (higher rank than subtitle)
    if info.get("_type") == "playlist":
        urls = [e["url"] for e in info["entries"]]
        video_idx = next((i for i, u in enumerate(urls) if "video.mp4" in u), None)
        sub_idx = next((i for i, u in enumerate(urls) if "en.vtt" in u), None)
        assert video_idx is not None
        assert sub_idx is not None
        assert video_idx < sub_idx
    else:
        # Single-entry: either the video or the subtitle
        assert "video.mp4" in info["url"] or "en.vtt" in info["url"]


def test_track_captions_extracted():
    """<track kind=captions> is also extracted as a subtitle entry."""
    html = """
    <video src="https://cdn.example.com/clip.mp4">
      <track kind="captions" src="https://cdn.example.com/captions/cc.vtt" srclang="en">
    </video>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    if info.get("_type") == "playlist":
        urls = [e["url"] for e in info["entries"]]
        assert any("cc.vtt" in u for u in urls)
    else:
        assert "cc.vtt" in info["url"] or "clip.mp4" in info["url"]


def test_track_chapters_not_extracted():
    """<track kind=chapters> is not a media track and should not be extracted."""
    html = """
    <video src="https://cdn.example.com/video.mp4">
      <track kind="chapters" src="https://cdn.example.com/chapters.vtt">
    </video>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    if info.get("_type") == "playlist":
        urls = [e["url"] for e in info["entries"]]
        assert not any("chapters.vtt" in u for u in urls)
    else:
        assert "chapters.vtt" not in info["url"]


def test_track_metadata_not_extracted():
    """<track kind=metadata> is a non-display track and should not be extracted."""
    html = """
    <video src="https://cdn.example.com/video.mp4">
      <track kind="metadata" src="https://cdn.example.com/meta.vtt">
    </video>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    if info.get("_type") == "playlist":
        urls = [e["url"] for e in info["entries"]]
        assert not any("meta.vtt" in u for u in urls)
    else:
        assert "meta.vtt" not in info["url"]


def test_subtitle_kind_sorted_after_video():
    """Subtitles sort after video and audio in the entries list."""
    html = """
    <video src="https://cdn.example.com/main.mp4">
      <track kind="subtitles" src="https://cdn.example.com/sub-en.vtt" srclang="en">
      <track kind="subtitles" src="https://cdn.example.com/sub-ja.vtt" srclang="ja">
    </video>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    if info.get("_type") == "playlist":
        kinds = [universal._media_kind(e["url"]) for e in info["entries"]]
        # All video entries appear before all subtitle entries
        last_video = max((i for i, k in enumerate(kinds) if k == "video"), default=-1)
        first_sub = min((i for i, k in enumerate(kinds) if k == "subtitle"), default=len(kinds))
        assert last_video < first_sub, f"Subtitle appeared before video: kinds={kinds}"


# ── Round 14: RSS/Atom feed extraction ───────────────────────────────────────

RSS_FEED = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Test Podcast</title>
    <itunes:image href="https://cdn.example.com/artwork.jpg"/>
    <item>
      <title>Episode 1</title>
      <enclosure url="https://cdn.example.com/ep1.mp3" type="audio/mpeg" length="12345678"/>
    </item>
    <item>
      <title>Episode 2</title>
      <enclosure url="https://cdn.example.com/ep2.m4a" type="audio/mp4" length="9876543"/>
    </item>
  </channel>
</rss>"""

ATOM_FEED = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test Video Feed</title>
  <entry>
    <title>Video 1</title>
    <link rel="enclosure" href="https://cdn.example.com/video1.mp4" type="video/mp4"/>
  </entry>
  <entry>
    <title>Video 2</title>
    <content type="video/webm" src="https://cdn.example.com/video2.webm"/>
  </entry>
</feed>"""

MEDIA_RSS_FEED = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Media RSS Test</title>
    <item>
      <title>Media Item</title>
      <media:content url="https://cdn.example.com/video.mp4" type="video/mp4" medium="video"/>
    </item>
  </channel>
</rss>"""


def test_rss_feed_extracts_enclosures():
    """RSS 2.0 <enclosure> elements are extracted as audio/video entries."""
    info = universal.extract_universal_from_feed(PAGE_URL, RSS_FEED)
    assert info is not None
    assert info.get("_type") == "playlist"
    urls = [e["url"] for e in info["entries"]]
    assert any("ep1.mp3" in u for u in urls)
    assert any("ep2.m4a" in u for u in urls)


def test_rss_feed_enclosure_ext():
    """RSS enclosure MIME type is converted to the correct extension."""
    info = universal.extract_universal_from_feed(PAGE_URL, RSS_FEED)
    assert info is not None
    ep1 = next(e for e in info["entries"] if "ep1.mp3" in e["url"])
    assert ep1["ext"] == "mp3"
    ep2 = next(e for e in info["entries"] if "ep2.m4a" in e["url"])
    assert ep2["ext"] == "m4a"


def test_rss_feed_returns_none_for_html():
    """HTML content is not mis-detected as a feed."""
    html = "<html><body><video src='https://cdn.example.com/v.mp4'></video></body></html>"
    info = universal.extract_universal_from_feed(PAGE_URL, html)
    assert info is None


def test_atom_feed_enclosure_link():
    """Atom 1.0 <link rel=enclosure> elements are extracted."""
    info = universal.extract_universal_from_feed(PAGE_URL, ATOM_FEED)
    assert info is not None
    if info.get("_type") == "playlist":
        urls = [e["url"] for e in info["entries"]]
        assert any("video1.mp4" in u for u in urls)


def test_media_rss_content_extracted():
    """<media:content> with medium=video is extracted from Media RSS feeds."""
    info = universal.extract_universal_from_feed(PAGE_URL, MEDIA_RSS_FEED)
    assert info is not None
    if info.get("_type") == "playlist":
        urls = [e["url"] for e in info["entries"]]
        assert any("video.mp4" in u for u in urls)
    else:
        assert "video.mp4" in info.get("url", "")


# ── Round 15: _media_kind subtitle ext auto-detection ────────────────────────

def test_media_kind_vtt_extension():
    """.vtt URLs are auto-detected as subtitle kind without a hint."""
    assert universal._media_kind("https://cdn.example.com/subs/en.vtt") == "subtitle"


def test_media_kind_srt_extension():
    """.srt URLs are auto-detected as subtitle kind without a hint."""
    assert universal._media_kind("https://cdn.example.com/captions/cc.srt") == "subtitle"


def test_media_kind_ttml_extension():
    """.ttml URLs are auto-detected as subtitle kind without a hint."""
    assert universal._media_kind("https://cdn.example.com/dfxp/en.ttml") == "subtitle"


def test_media_kind_subtitle_hint_preserved():
    """kind_hint='subtitle' is passed through even for a URL without a subtitle ext."""
    assert universal._media_kind("https://cdn.example.com/captions/stream", "subtitle") == "subtitle"


def test_media_kind_video_hint_takes_precedence():
    """An explicit video hint overrides the URL's subtitle extension."""
    assert universal._media_kind("https://cdn.example.com/sub.vtt", "video") == "video"


def test_subtitle_entry_gets_vtt_ext():
    """A subtitle entry from a <track> with no extension in the URL gets ext='vtt'."""
    html = """
    <video src="https://cdn.example.com/video.mp4">
      <track kind="subtitles" src="https://cdn.example.com/captions/stream">
    </video>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    if info.get("_type") == "playlist":
        sub = next((e for e in info["entries"] if "captions/stream" in e.get("url", "")), None)
        if sub:
            assert sub.get("ext") == "vtt"


# ── Round 16: iframe embed detection & JSON Feed 1.0 ─────────────────────────

def test_scan_iframe_youtube_detected():
    """An article page with a YouTube embed iframe is detected by scan_iframe_embed_urls."""
    html = """
    <html><body>
      <article><p>Watch the video:</p>
        <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315"></iframe>
      </article>
    </body></html>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("youtube.com/embed/dQw4w9WgXcQ" in u for u in urls)


def test_scan_iframe_vimeo_detected():
    """A Vimeo player embed iframe is detected by scan_iframe_embed_urls."""
    html = '<iframe src="https://player.vimeo.com/video/76979871"></iframe>'
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("player.vimeo.com/video/76979871" in u for u in urls)


def test_scan_iframe_unknown_player_ignored():
    """An iframe pointing to an unknown/non-player URL is not returned."""
    html = '<iframe src="https://ads.example.com/banner?id=123" width="728" height="90"></iframe>'
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert urls == []


def test_json_feed_audio_attachment():
    """JSON Feed 1.0 audio attachment is extracted."""
    feed = """{
      "version": "https://jsonfeed.org/version/1.1",
      "title": "My Podcast",
      "items": [
        {
          "id": "1",
          "title": "Episode 1: Introduction",
          "attachments": [
            {"url": "https://cdn.example.com/podcast/ep1.mp3", "mime_type": "audio/mpeg", "size_in_bytes": 12000000}
          ]
        }
      ]
    }"""
    info = universal.extract_universal_from_json_feed(PAGE_URL, feed)
    assert info is not None
    url = info.get("url") or ""
    assert "ep1.mp3" in url


def test_json_feed_multiple_episodes_playlist():
    """Multiple JSON Feed items produce a playlist."""
    feed = """{
      "version": "https://jsonfeed.org/version/1.1",
      "title": "Video Series",
      "items": [
        {"id": "1", "title": "Ep 1", "attachments": [{"url": "https://cdn.example.com/ep1.mp4", "mime_type": "video/mp4"}]},
        {"id": "2", "title": "Ep 2", "attachments": [{"url": "https://cdn.example.com/ep2.mp4", "mime_type": "video/mp4"}]}
      ]
    }"""
    info = universal.extract_universal_from_json_feed(PAGE_URL, feed)
    assert info is not None
    assert info.get("_type") == "playlist"
    urls = [e["url"] for e in info["entries"]]
    assert any("ep1.mp4" in u for u in urls)
    assert any("ep2.mp4" in u for u in urls)


def test_json_feed_non_av_attachment_ignored():
    """JSON Feed attachments with non-audio/video MIME types are ignored."""
    feed = """{
      "version": "https://jsonfeed.org/version/1.1",
      "title": "Blog",
      "items": [
        {"id": "1", "title": "Post", "attachments": [
          {"url": "https://cdn.example.com/doc.pdf", "mime_type": "application/pdf"}
        ]}
      ]
    }"""
    info = universal.extract_universal_from_json_feed(PAGE_URL, feed)
    assert info is None


# ── Round 17: ISO 8601 duration + page title + DASH live (server-side) ────────

def test_parse_iso_duration_hours_minutes_seconds():
    """PT1H32M45S → 5565 seconds."""
    assert universal._parse_iso_duration("PT1H32M45S") == 5565


def test_parse_iso_duration_minutes_only():
    """PT4M20S → 260 seconds."""
    assert universal._parse_iso_duration("PT4M20S") == 260


def test_parse_iso_duration_days():
    """P1D → 86400 seconds."""
    assert universal._parse_iso_duration("P1D") == 86400


def test_parse_iso_duration_numeric_passthrough():
    """Plain integer durations pass through as-is."""
    assert universal._parse_iso_duration(120) == 120


def test_parse_iso_duration_invalid_returns_none():
    """Non-ISO strings return None."""
    assert universal._parse_iso_duration("not a duration") is None
    assert universal._parse_iso_duration(None) is None


def test_json_ld_duration_string_parsed():
    """JSON-LD VideoObject with ISO 8601 duration string gets duration in output."""
    html = """
    <html><head>
    <script type="application/ld+json">
    {
      "@type": "VideoObject",
      "name": "Episode",
      "contentUrl": "https://cdn.example.com/episode.mp4",
      "duration": "PT22M30S"
    }
    </script>
    </head></html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    # PT22M30S = 1350 seconds
    assert info.get("duration") == 1350


def test_json_ld_duration_plain_number_preserved():
    """JSON-LD VideoObject with plain numeric duration keeps it."""
    html = """
    <html><head>
    <script type="application/ld+json">
    {"@type": "VideoObject", "contentUrl": "https://cdn.example.com/clip.mp4", "duration": 300}
    </script>
    </head></html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert info.get("duration") == 300


def test_scan_page_title_og_priority():
    """og:title takes precedence over bare <title> tag."""
    html = """<html><head>
    <title>Bare title</title>
    <meta property="og:title" content="OG Title">
    </head></html>"""
    assert universal._scan_page_title(html) == "OG Title"


def test_scan_page_title_fallback_to_title_tag():
    """Falls back to <title> when no og:title is present."""
    html = "<html><head><title>Page Title</title></head></html>"
    assert universal._scan_page_title(html) == "Page Title"


def test_scan_page_title_empty_when_missing():
    """Returns empty string when no title element or meta is present."""
    assert universal._scan_page_title("<html><body>no title</body></html>") == ""


# ── Round 18: JSON-LD width/height + new iframe embeds ───────────────────────

def test_json_ld_width_height_propagated():
    """JSON-LD VideoObject with numeric width/height populates entry fields."""
    html = """
    <html><head>
    <script type="application/ld+json">
    {
      "@type": "VideoObject",
      "name": "Tutorial",
      "contentUrl": "https://cdn.example.com/tutorial.mp4",
      "width": 1920,
      "height": 1080
    }
    </script>
    </head></html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert info.get("width") == 1920
    assert info.get("height") == 1080


def test_json_ld_width_height_schema_object():
    """JSON-LD QuantitativeValue for width/height (schema.org verbose form)."""
    html = """
    <html><head>
    <script type="application/ld+json">
    {
      "@type": "VideoObject",
      "contentUrl": "https://cdn.example.com/video.mp4",
      "width": {"@type": "QuantitativeValue", "value": 1280},
      "height": {"@type": "QuantitativeValue", "value": 720}
    }
    </script>
    </head></html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert info.get("width") == 1280
    assert info.get("height") == 720


def test_scan_iframe_ted_detected():
    """A TED embed iframe is detected by scan_iframe_embed_urls."""
    html = """<iframe src="https://embed.ted.com/talks/richard_feynman_fun_to_imagine"></iframe>"""
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("embed.ted.com" in u for u in urls)


def test_scan_iframe_facebook_video_detected():
    """A Facebook video plugin embed iframe is detected."""
    html = """<iframe src="https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fvideo%2F1234567890"></iframe>"""
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("facebook.com/plugins/video" in u for u in urls)


def test_scan_iframe_panopto_detected():
    """A Panopto university video embed iframe is detected."""
    html = """<iframe src="https://university.panopto.com/Panopto/Pages/Viewer.aspx?id=abc-123"></iframe>"""
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("panopto.com" in u for u in urls)


# ── Round 19: AMP element and social embed support ───────────────────────────


def test_amp_video_element_detected():
    """<amp-video src="..."> is treated like <video src="..."> and yields a media entry."""
    html = """
    <html amp>
    <body>
      <amp-video src="https://cdn.example.com/amp/promo.mp4" width="640" height="360"></amp-video>
    </body>
    </html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    url = info.get("url") or ""
    assert "promo.mp4" in url, f"amp-video src not in result: {info}"


def test_amp_audio_element_detected():
    """<amp-audio src="..."> is treated like <audio src="..."> and yields a media entry."""
    html = """
    <html amp>
    <body>
      <amp-audio src="https://cdn.example.com/amp/podcast.mp3"></amp-audio>
    </body>
    </html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    url = info.get("url") or ""
    assert "podcast.mp3" in url


def test_amp_video_poster_detected():
    """<amp-video poster="..."> yields an image entry for the poster."""
    html = """
    <html amp>
    <body>
      <amp-video src="https://cdn.example.com/amp/clip.mp4"
                 poster="https://cdn.example.com/amp/poster.jpg"
                 width="1280" height="720">
      </amp-video>
    </body>
    </html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    # The result may be a playlist when there are multiple entries
    if info.get("_type") == "playlist":
        urls = [e.get("url", "") for e in info.get("entries", [])]
    else:
        urls = [info.get("url", "")]
    assert any("clip.mp4" in u for u in urls)
    assert any("poster.jpg" in u for u in urls)


def test_amp_youtube_embed_detected_by_iframe_scanner():
    """<amp-youtube data-videoid="..."> generates a YouTube embed URL detected by scan_iframe_embed_urls."""
    html = """
    <html amp>
    <body>
      <amp-youtube data-videoid="dQw4w9WgXcQ" layout="responsive" width="480" height="270"></amp-youtube>
    </body>
    </html>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("youtube.com/embed/dQw4w9WgXcQ" in u for u in urls), f"YouTube embed not found: {urls}"


def test_amp_vimeo_embed_detected_by_iframe_scanner():
    """<amp-vimeo data-videoid="..."> generates a Vimeo embed URL."""
    html = """
    <html amp><body>
      <amp-vimeo data-videoid="76979871" layout="responsive" width="16" height="9"></amp-vimeo>
    </body></html>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("player.vimeo.com/video/76979871" in u for u in urls), f"Vimeo embed not found: {urls}"


def test_amp_dailymotion_embed_detected_by_iframe_scanner():
    """<amp-dailymotion data-videoid="..."> generates a Dailymotion embed URL."""
    html = """
    <html amp><body>
      <amp-dailymotion data-videoid="x7tgd28" layout="responsive" width="480" height="270"></amp-dailymotion>
    </body></html>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("dailymotion.com/embed/video/x7tgd28" in u for u in urls), f"Dailymotion embed not found: {urls}"


def test_amp_brightcove_embed_detected_by_iframe_scanner():
    """<amp-brightcove data-account="..." data-video-id="..."> generates a Brightcove embed URL."""
    html = """
    <html amp><body>
      <amp-brightcove data-account="1234567890001" data-video-id="ref:my-video-ref"
                      layout="responsive" width="16" height="9">
      </amp-brightcove>
    </body></html>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("players.brightcove.net/1234567890001" in u for u in urls), f"Brightcove embed not found: {urls}"


# ── Round 20: JSON-LD ItemList / ListItem traversal ──────────────────────────


def test_json_ld_item_list_traverses_list_items():
    """JSON-LD ItemList with ListItem.item VideoObject entries are all extracted."""
    html = """
    <html><head>
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      "name": "Video Playlist",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "item": {
            "@type": "VideoObject",
            "name": "Intro",
            "contentUrl": "https://cdn.example.com/intro.mp4"
          }
        },
        {
          "@type": "ListItem",
          "position": 2,
          "item": {
            "@type": "VideoObject",
            "name": "Main Feature",
            "contentUrl": "https://cdn.example.com/main.mp4"
          }
        }
      ]
    }
    </script>
    </head></html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    if info.get("_type") == "playlist":
        urls = [e.get("url", "") for e in info.get("entries", [])]
    else:
        urls = [info.get("url", "")]
    assert any("intro.mp4" in u for u in urls), f"intro.mp4 not found: {urls}"
    assert any("main.mp4" in u for u in urls), f"main.mp4 not found: {urls}"


def test_json_ld_item_list_mixed_types():
    """ItemList with PodcastEpisode and VideoObject entries both extracted."""
    html = """
    <html><head>
    <script type="application/ld+json">
    {
      "@type": "ItemList",
      "itemListElement": [
        {"@type": "ListItem", "item": {"@type": "PodcastEpisode", "contentUrl": "https://cdn.example.com/ep1.mp3", "duration": "PT30M"}},
        {"@type": "ListItem", "item": {"@type": "VideoObject", "contentUrl": "https://cdn.example.com/vid.mp4"}}
      ]
    }
    </script>
    </head></html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    if info.get("_type") == "playlist":
        urls = [e.get("url", "") for e in info.get("entries", [])]
    else:
        urls = [info.get("url", "")]
    assert any("ep1.mp3" in u for u in urls), f"podcast episode not found: {urls}"
    assert any("vid.mp4" in u for u in urls), f"video not found: {urls}"


def test_json_ld_content_url_list_uses_first_item():
    """contentUrl as a JSON array should use the first string element."""
    html = """
    <html><head>
    <script type="application/ld+json">
    {
      "@type": "VideoObject",
      "name": "Multi-CDN video",
      "contentUrl": [
        "https://cdn1.example.com/video.mp4",
        "https://cdn2.example.com/video.mp4"
      ]
    }
    </script>
    </head></html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    url = info.get("url") or (info.get("entries") or [{}])[0].get("url", "")
    assert "cdn1.example.com/video.mp4" in url, f"Expected first CDN URL, got: {url}"


def test_background_video_confidence_below_threshold():
    """<video autoplay loop muted> without controls should be below the auto-download threshold."""
    html = """
    <html><body>
    <video autoplay loop muted playsinline src="https://cdn.example.com/bg/hero.mp4"></video>
    </body></html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    # Background video should either be absent or have low confidence
    if info is None:
        return  # filtered out entirely — acceptable
    if info.get("_type") == "playlist":
        entries = info.get("entries", [])
        bg_entry = next((e for e in entries if "hero.mp4" in e.get("url", "")), None)
    else:
        bg_entry = info if "hero.mp4" in info.get("url", "") else None
    if bg_entry is not None:
        assert bg_entry.get("_universal_confidence", 1.0) < 0.75, (
            f"Background video confidence should be below 0.75, got {bg_entry.get('_universal_confidence')}"
        )


def test_video_with_controls_keeps_full_confidence():
    """<video controls> should keep the normal high confidence."""
    html = """
    <html><body>
    <video controls src="https://cdn.example.com/main/episode.mp4"></video>
    </body></html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    if info.get("_type") == "playlist":
        entries = info.get("entries", [])
        entry = next((e for e in entries if "episode.mp4" in e.get("url", "")), None)
    else:
        entry = info if "episode.mp4" in info.get("url", "") else None
    assert entry is not None, "Video with controls should be extracted"
    assert entry.get("_universal_confidence", 0.0) >= 0.75, (
        f"Video with controls should have confidence >= 0.75, got {entry.get('_universal_confidence')}"
    )


def test_wistia_div_embed_detected():
    """Wistia div embeds (class=wistia_async_ID) should produce an iframe embed URL via scan_iframe_embed_urls."""
    html = """
    <html><body>
    <div class="wistia_embed wistia_async_abc123xyz" style="width:640px;height:360px;">&nbsp;</div>
    <script src="https://fast.wistia.com/assets/external/E-v1.js" async></script>
    </body></html>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("fast.wistia.com/embed/iframe/abc123xyz" in u for u in urls), (
        f"Wistia iframe embed URL not found in: {urls}"
    )


def test_tiktok_embed_iframe_detected():
    """TikTok embed iframes should be captured as known-player embed URLs."""
    html = """
    <html><body>
    <blockquote class="tiktok-embed">
      <iframe src="https://www.tiktok.com/embed/v2/7123456789012345678" allow="autoplay"></iframe>
    </blockquote>
    </body></html>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("tiktok.com/embed" in u for u in urls), f"TikTok embed URL not found: {urls}"


def test_anchor_podcast_embed_detected():
    """Anchor.fm (Spotify for Podcasters) embed iframes should be captured."""
    html = """
    <html><body>
    <iframe src="https://anchor.fm/myshow/embed/episodes/ep-title-e12345/a-67890" height="102px"></iframe>
    </body></html>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("anchor.fm" in u for u in urls), f"Anchor.fm embed URL not found: {urls}"


def test_brightcove_div_embed_detected():
    """<video-js data-account data-video-id> should produce a Brightcove player embed URL."""
    html = """
    <html><body>
    <video-js
      data-account="1234567890"
      data-video-id="ref:my-promo-video"
      data-player="H1xP2rEWl"
      data-embed="default"
      controls
      class="vjs-fluid">
    </video-js>
    <script src="https://players.brightcove.net/1234567890/H1xP2rEWl_default/index.min.js"></script>
    </body></html>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("players.brightcove.net/1234567890" in u for u in urls), (
        f"Brightcove embed URL not found: {urls}"
    )
    assert any("my-promo-video" in u for u in urls), (
        f"Brightcove video ID not in URL: {urls}"
    )


def test_dplayer_config_url_extracted():
    """DPlayer { video: { url: '...' } } config should be picked up from inline script."""
    html = """
    <html><body>
    <div id="player"></div>
    <script>
      var dp = new DPlayer({
        container: document.getElementById('player'),
        video: {
          url: 'https://cdn.example.com/live/stream.m3u8',
          type: 'hls',
          pic: 'https://cdn.example.com/poster.jpg'
        }
      });
    </script>
    </body></html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    if info.get("_type") == "playlist":
        urls = [e.get("url", "") for e in info.get("entries", [])]
    else:
        urls = [info.get("url", "")]
    assert any("stream.m3u8" in u for u in urls), f"DPlayer HLS URL not found: {urls}"


def test_plyr_sources_config_extracted():
    """Plyr { source: { sources: [{src, type}] } } should be extracted."""
    html = """
    <html><body>
    <video id="player"></video>
    <script>
      const player = new Plyr('#player', {
        source: {
          type: 'video',
          sources: [
            { src: 'https://cdn.example.com/video/clip.mp4', type: 'video/mp4' },
            { src: 'https://cdn.example.com/video/clip.webm', type: 'video/webm' }
          ]
        }
      });
    </script>
    </body></html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    if info.get("_type") == "playlist":
        urls = [e.get("url", "") for e in info.get("entries", [])]
    else:
        urls = [info.get("url", "")]
    assert any("clip.mp4" in u for u in urls), f"Plyr MP4 source not found: {urls}"


def test_consent_deferred_iframe_detected():
    """GDPR consent-deferred iframes with data-consent-src should be detected."""
    html = """
    <html><body>
    <iframe data-consent-src="https://player.vimeo.com/video/987654321"
            src="about:blank" width="640" height="360"
            data-cookieconsent="statistics"></iframe>
    </body></html>
    """
    found = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("player.vimeo.com/video/987654321" in u for u in found), \
        f"data-consent-src iframe not found: {found}"


def test_cmp_deferred_iframe_detected():
    """OneTrust CMP-deferred iframes with data-cmp-src should be detected."""
    html = """
    <html><body>
    <iframe data-cmp-src="https://www.youtube.com/embed/dQw4w9WgXcQ"
            src="about:blank"></iframe>
    </body></html>
    """
    found = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("youtube.com/embed" in u for u in found), \
        f"data-cmp-src iframe not found: {found}"


def test_nextjs_image_url_unwrapped():
    """Next.js /_next/image?url=ENCODED proxy URLs should be unwrapped to original CDN URL."""
    html = """
    <html><body>
    <img src="/_next/image?url=https%3A%2F%2Fcdn.example.com%2Fphotos%2Foriginal.jpg&w=1920&q=75"
         width="1920" height="1080">
    </body></html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    if info.get("_type") == "playlist":
        urls = [e.get("url", "") for e in info.get("entries", [])]
    else:
        urls = [info.get("url", "")]
    assert any("cdn.example.com/photos/original.jpg" in u for u in urls), \
        f"Next.js image URL not unwrapped: {urls}"


def test_nextjs_image_url_unwrapped_via_clean_url():
    """_clean_url directly unwraps /_next/image proxy URLs."""
    raw = "/_next/image?url=https%3A%2F%2Fimages.example.com%2Fphoto.webp&w=800&q=80"
    result = universal._clean_url(raw, PAGE_URL)
    assert "images.example.com/photo.webp" in result, f"Unexpected result: {result}"
    assert "_next/image" not in result, f"Proxy URL not unwrapped: {result}"


def test_amp_video_iframe_detected():
    """<amp-video-iframe src="..."> with known player host should be detected."""
    html = """
    <html><body>
    <amp-video-iframe src="https://player.vimeo.com/video/555123456"
                      width="640" height="360" layout="responsive">
    </amp-video-iframe>
    </body></html>
    """
    found = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("player.vimeo.com/video/555123456" in u for u in found), \
        f"amp-video-iframe not found: {found}"


def test_amp_jwplayer_reconstructs_embed_url():
    """<amp-jwplayer data-player-id data-media-id> should reconstruct JW Platform URL."""
    html = """
    <html><body>
    <amp-jwplayer data-player-id="abc12345" data-media-id="xyz67890"
                  layout="responsive" width="16" height="9"></amp-jwplayer>
    </body></html>
    """
    found = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("content.jwplatform.com/players/xyz67890-abc12345.html" in u for u in found), \
        f"amp-jwplayer URL not found: {found}"


def test_flv_url_hydration_key_extracted():
    """flv_url key in page hydration data should be extracted as a video URL."""
    html = """
    <html><head>
    <script id="__INITIAL_STATE__" type="application/json">
    {"flv_url":"https://live.example.com/stream/abc.flv?key=xyz"}
    </script>
    </head><body></body></html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    if info.get("_type") == "playlist":
        urls = [e.get("url", "") for e in info.get("entries", [])]
    else:
        urls = [info.get("url", "")]
    assert any("live.example.com/stream/abc.flv" in u for u in urls), \
        f"flv_url not extracted: {urls}"


def test_cloudflare_stream_element_detected():
    """<stream src="VIDEO_ID"> Cloudflare Stream custom element should be detected."""
    html = """
    <html><body>
    <stream src="5d5bc37ffcf54c9b82e996823bffbb81" controls loop></stream>
    </body></html>
    """
    found = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("iframe.cloudflarestream.com/5d5bc37ffcf54c9b82e996823bffbb81" in u for u in found), \
        f"Cloudflare Stream element not found: {found}"


def test_data_jw_config_attribute_parsed():
    """data-jw-config='{"file":"..."}' JW Player 8 config attribute should be parsed."""
    html = """
    <html><body>
    <div id="player" data-jw-config='{"file":"https://cdn.example.com/video/episode.mp4","width":640,"height":360}'></div>
    </body></html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    if info.get("_type") == "playlist":
        urls = [e.get("url", "") for e in info.get("entries", [])]
    else:
        urls = [info.get("url", "")]
    assert any("episode.mp4" in u for u in urls), \
        f"JW Player data-jw-config file not found: {urls}"


def test_smooth_streaming_url_detected():
    """Smooth Streaming .ism/manifest URL should be detected and classified as DASH-like."""
    html = """
    <html><head></head><body>
    <script>
    var player = amp('videoPlayer', {
      src: [{src: 'https://example.streaming.mediaservices.windows.net/video.ism/manifest', type: 'application/vnd.ms-sstr+xml'}]
    });
    </script>
    </body></html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    if info.get("_type") == "playlist":
        urls = [e.get("url", "") for e in info.get("entries", [])]
    else:
        urls = [info.get("url", "")]
    assert any(".ism/manifest" in u for u in urls), \
        f"Smooth Streaming URL not extracted: {urls}"


def test_smooth_streaming_protocol_classified_as_dash():
    """_protocol() should classify .ism/manifest URLs as http_dash_segments."""
    proto = universal._protocol("https://example.com/video.ism/manifest")
    assert proto == "http_dash_segments", f"Expected http_dash_segments, got {proto}"


def test_vtt_url_hydration_key_extracted():
    """vtt_url hydration key should surface subtitle URL."""
    html = """
    <html><head>
    <script id="__NEXT_DATA__" type="application/json">
    {"props":{"pageProps":{"episode":{"video_url":"https://cdn.example.com/video.mp4","vtt_url":"https://cdn.example.com/captions/en.vtt"}}}}
    </script>
    </head><body></body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_hydration_data(html, PAGE_URL, entries, seen)
    urls = [e.get("url", "") for e in entries]
    assert any("captions/en.vtt" in u for u in urls), \
        f"vtt_url not extracted from hydration data: {urls}"


def test_subtitle_url_key_extracted():
    """subtitle_url hydration key should surface subtitle URL."""
    html = """
    <html><head>
    <script>window.__INITIAL_STATE__={"subtitle_url":"https://cdn.example.com/subs/episode.vtt","title":"Test"};</script>
    </head><body></body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_hydration_data(html, PAGE_URL, entries, seen)
    urls = [e.get("url", "") for e in entries]
    assert any("subs/episode.vtt" in u for u in urls), \
        f"subtitle_url not extracted from hydration data: {urls}"


def test_srt_url_key_extracted():
    """srt_url hydration key should surface subtitle URL."""
    html = """
    <html><head>
    <script>window.__STORE__={"srt_url":"https://cdn.example.com/subs/episode.srt","video_url":"https://cdn.example.com/video.mp4"};</script>
    </head><body></body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_hydration_data(html, PAGE_URL, entries, seen)
    urls = [e.get("url", "") for e in entries]
    assert any("subs/episode.srt" in u for u in urls), \
        f"srt_url not extracted from hydration data: {urls}"


def test_vidyard_div_embed_detected():
    """Vidyard <div class='vidyard-player-container' data-uuid='UUID'> should be detected."""
    html = """
    <html><body>
    <div class="vidyard-player-container" data-uuid="abcd1234efgh5678" data-type="inline"></div>
    <script src="https://play.vidyard.com/embed/v4.js"></script>
    </body></html>
    """
    found = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("play.vidyard.com/abcd1234efgh5678" in u for u in found), \
        f"Vidyard div embed not found: {found}"


def test_vidyard_thumbnail_img_detected():
    """Vidyard thumbnail <img src='https://play.vidyard.com/UUID.jpg'> should be detected."""
    html = """
    <html><body>
    <img src="https://play.vidyard.com/xyz99887766.jpg" style="width:100%;display:block;">
    </body></html>
    """
    found = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("play.vidyard.com/xyz99887766" in u for u in found), \
        f"Vidyard thumbnail img not found: {found}"


def test_episode_url_hydration_key():
    """episode_url hydration key should surface video URL."""
    html = """
    <html><head>
    <script>window.__INITIAL_STATE__={"episode":{"episode_url":"https://cdn.example.com/episodes/ep42.mp4","title":"Episode 42"}};</script>
    </head><body></body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_hydration_data(html, PAGE_URL, entries, seen)
    urls = [e.get("url", "") for e in entries]
    assert any("ep42.mp4" in u for u in urls), \
        f"episode_url not extracted: {urls}"


def test_recording_url_hydration_key():
    """recording_url hydration key should surface video URL."""
    html = """
    <html><head>
    <script id="__NEXT_DATA__" type="application/json">
    {"props":{"pageProps":{"recording_url":"https://cdn.example.com/recordings/session.mp4"}}}
    </script>
    </head><body></body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_hydration_data(html, PAGE_URL, entries, seen)
    urls = [e.get("url", "") for e in entries]
    assert any("session.mp4" in u for u in urls), \
        f"recording_url not extracted: {urls}"


def test_video_config_global_recognized_as_hydration():
    """window.videoConfig = {...} should be recognized as a hydration script."""
    html = """
    <html><head>
    <script>window.videoConfig={"video_url":"https://cdn.example.com/video.mp4","title":"Test"};</script>
    </head><body></body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_hydration_data(html, PAGE_URL, entries, seen)
    urls = [e.get("url", "") for e in entries]
    assert any("cdn.example.com/video.mp4" in u for u in urls), \
        f"videoConfig global not recognized as hydration: {urls}"


def test_bunny_net_stream_iframe_detected():
    """Bunny.net Stream iframe (iframe.mediadelivery.net) should be detected."""
    html = """
    <html><body>
    <iframe src="https://iframe.mediadelivery.net/embed/12345/abc-def-ghi" loading="lazy" allow="accelerometer"></iframe>
    </body></html>
    """
    found = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("iframe.mediadelivery.net/embed/" in u for u in found), \
        f"Bunny.net Stream iframe not found: {found}"


def test_episode_url_in_player_config():
    """episode_url in a player config script block should be detected."""
    html = """
    <html><head>
    <script>var videoConfig={episode_url:"https://cdn.example.com/episodes/s01e03.mp4",title:"Episode 3"};</script>
    </head><body></body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_player_configs(html, PAGE_URL, entries, seen)
    urls = [e.get("url", "") for e in entries]
    assert any("s01e03.mp4" in u for u in urls), \
        f"episode_url in player config not found: {urls}"


def test_recording_url_in_player_config():
    """recording_url in a player config script block should be detected."""
    html = """
    <html><head>
    <script>var playerConfig={recording_url:"https://cdn.example.com/recordings/meeting.mp4",duration:3600};</script>
    </head><body></body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_player_configs(html, PAGE_URL, entries, seen)
    urls = [e.get("url", "") for e in entries]
    assert any("meeting.mp4" in u for u in urls), \
        f"recording_url in player config not found: {urls}"


def test_div_data_src_known_player_detected():
    """<div data-src='EMBED_URL'> pointing to a known player should be detected."""
    html = """
    <html><body>
    <div class="video-wrapper" data-src="https://www.youtube.com/embed/dQw4w9WgXcQ"></div>
    </body></html>
    """
    result = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("youtube.com/embed/dQw4w9WgXcQ" in u for u in result), \
        f"div data-src youtube embed not found: {result}"


def test_div_data_url_vimeo_detected():
    """<section data-url='VIMEO_EMBED'> should be detected."""
    html = """
    <html><body>
    <section data-url="https://player.vimeo.com/video/123456789"></section>
    </body></html>
    """
    result = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("vimeo.com/video/123456789" in u for u in result), \
        f"section data-url vimeo embed not found: {result}"


def test_data_vimeo_id_attribute_detected():
    """data-vimeo-id on any element should reconstruct Vimeo embed URL."""
    html = """
    <html><body>
    <div class="video-embed" data-vimeo-id="987654321"></div>
    </body></html>
    """
    result = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("player.vimeo.com/video/987654321" in u for u in result), \
        f"data-vimeo-id not reconstructed: {result}"


def test_data_youtube_id_attribute_detected():
    """data-youtube-id on any element should reconstruct YouTube embed URL."""
    html = """
    <html><body>
    <article data-youtube-id="abcdef12345"></article>
    </body></html>
    """
    result = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("youtube.com/embed/abcdef12345" in u for u in result), \
        f"data-youtube-id not reconstructed: {result}"


def test_data_dailymotion_id_attribute_detected():
    """data-dailymotion-id on any element should reconstruct Dailymotion embed URL."""
    html = """
    <html><body>
    <div data-dailymotion-id="x7tgd2s"></div>
    </body></html>
    """
    result = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("dailymotion.com/embed/video/x7tgd2s" in u for u in result), \
        f"data-dailymotion-id not reconstructed: {result}"


def test_player_config_global_recognized_as_hydration():
    """__PLAYER_CONFIG__ global should be recognized as a hydration script."""
    script_text = "window.__PLAYER_CONFIG__={videoUrl:'https://cdn.example.com/video.mp4'}"
    assert universal._is_hydration_script("", script_text), \
        "__PLAYER_CONFIG__ should match hydration script pattern"


def test_media_config_global_recognized_as_hydration():
    """__MEDIA_CONFIG__ global should be recognized as a hydration script."""
    script_text = "window.__MEDIA_CONFIG__={src:'https://cdn.example.com/video.mp4'}"
    assert universal._is_hydration_script("", script_text), \
        "__MEDIA_CONFIG__ should match hydration script pattern"


def test_bitchute_iframe_detected():
    """Bitchute embed iframe should be detected as a known player."""
    html = """
    <html><body>
    <iframe src="https://www.bitchute.com/embed/AbCdEf123456/"></iframe>
    </body></html>
    """
    result = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("bitchute.com/embed/" in u for u in result), \
        f"Bitchute embed not detected: {result}"


def test_mp3_url_hydration_key_extracted():
    """mp3_url hydration key should surface audio URL with audio MIME type."""
    html = """
    <html><head>
    <script>window.__INITIAL_STATE__={"episode":{"mp3_url":"https://cdn.example.com/episodes/ep100.mp3","title":"Episode 100"}};</script>
    </head><body></body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_hydration_data(html, PAGE_URL, entries, seen)
    assert any("ep100.mp3" in e.get("url", "") for e in entries), \
        f"mp3_url hydration key not found: {[e.get('url') for e in entries]}"


def test_podcast_url_hydration_key_extracted():
    """podcast_url hydration key should surface audio URL."""
    html = """
    <html><head>
    <script>window.__INITIAL_STATE__={"media":{"podcast_url":"https://media.example.com/podcast/show1.mp3"}};</script>
    </head><body></body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_hydration_data(html, PAGE_URL, entries, seen)
    assert any("show1.mp3" in e.get("url", "") for e in entries), \
        f"podcast_url hydration key not found: {[e.get('url') for e in entries]}"


def test_enclosure_url_hydration_key_extracted():
    """enclosure_url hydration key (RSS enclosure) should surface audio URL."""
    html = """
    <html><head>
    <script>window.__INITIAL_STATE__={"item":{"enclosure_url":"https://cdn.example.com/audio/enclosure.mp3"}};</script>
    </head><body></body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_hydration_data(html, PAGE_URL, entries, seen)
    assert any("enclosure.mp3" in e.get("url", "") for e in entries), \
        f"enclosure_url hydration key not found: {[e.get('url') for e in entries]}"


def test_data_hls_url_on_video_element():
    """<video data-hls-url='...'> should be detected as HLS media."""
    html = """
    <html><body>
    <video class="video-player" data-hls-url="https://stream.example.com/live.m3u8" controls></video>
    </body></html>
    """
    result = universal.extract_universal_from_html(PAGE_URL, html)
    assert result is not None, "data-hls-url on video element should be detected"
    entries = result.get("entries", [result]) if result.get("_type") == "playlist" else [result]
    assert any("live.m3u8" in e.get("url", "") for e in entries), \
        f"data-hls-url not found: {[e.get('url') for e in entries]}"


def test_data_hls_src_on_video_element():
    """<video data-hls-src='...'> should be detected."""
    html = """
    <html><body>
    <video data-hls-src="https://cdn.example.com/playlist.m3u8" controls></video>
    </body></html>
    """
    result = universal.extract_universal_from_html(PAGE_URL, html)
    assert result is not None, "data-hls-src on video element should be detected"
    entries = result.get("entries", [result]) if result.get("_type") == "playlist" else [result]
    assert any("playlist.m3u8" in e.get("url", "") for e in entries), \
        f"data-hls-src not found: {[e.get('url') for e in entries]}"


def test_mp3_url_player_config_key():
    """mp3_url in a player config script block should be detected."""
    html = """
    <html><head>
    <script>var playerConfig={mp3_url:"https://cdn.example.com/audio/track.mp3",title:"My Track"};</script>
    </head><body></body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_player_configs(html, PAGE_URL, entries, seen)
    urls = [e.get("url", "") for e in entries]
    assert any("track.mp3" in u for u in urls), \
        f"mp3_url in player config not found: {urls}"


def test_data_original_attribute_on_img():
    """<img data-original='URL'> lazy load (bLazy/Lazyload.js) should be detected."""
    html = """
    <html><body>
    <img data-original="https://cdn.example.com/photo/fullsize.jpg" src="placeholder.gif">
    </body></html>
    """
    result = universal.extract_universal_from_html(PAGE_URL, html)
    assert result is not None, "data-original img should produce a result"
    entries = result.get("entries", [result]) if result.get("_type") == "playlist" else [result]
    assert any("fullsize.jpg" in e.get("url", "") for e in entries), \
        f"data-original img URL not found: {[e.get('url') for e in entries]}"


def test_data_original_src_attribute_on_img():
    """<img data-original-src='URL'> lazy load should be detected."""
    html = """
    <html><body>
    <img data-original-src="https://cdn.example.com/gallery/image.jpg">
    </body></html>
    """
    result = universal.extract_universal_from_html(PAGE_URL, html)
    assert result is not None, "data-original-src img should produce a result"
    entries = result.get("entries", [result]) if result.get("_type") == "playlist" else [result]
    assert any("gallery/image.jpg" in e.get("url", "") for e in entries), \
        f"data-original-src img URL not found: {[e.get('url') for e in entries]}"


def test_data_lazy_attribute_on_img():
    """<img data-lazy='URL'> (jQuery Lazy) should be detected."""
    html = """
    <html><body>
    <img class="lazy" data-lazy="https://cdn.example.com/images/lazy.jpg" src="data:image/gif;base64,R0lGOD">
    </body></html>
    """
    result = universal.extract_universal_from_html(PAGE_URL, html)
    assert result is not None, "data-lazy img should produce a result"
    entries = result.get("entries", [result]) if result.get("_type") == "playlist" else [result]
    assert any("lazy.jpg" in e.get("url", "") for e in entries), \
        f"data-lazy img URL not found: {[e.get('url') for e in entries]}"


def test_peertube_embed_iframe_detected():
    """PeerTube /videos/embed/UUID iframe should be detected as a known player."""
    html = """
    <html><body>
    <iframe title="My Video" src="https://peertube.example.com/videos/embed/a1b2c3d4-e5f6-7890-abcd-ef1234567890" sandbox="allow-same-origin allow-scripts" frameborder="0" allowfullscreen></iframe>
    </body></html>
    """
    result = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("peertube.example.com/videos/embed/" in u for u in result), \
        f"PeerTube embed not detected: {result}"


def test_kick_com_embed_iframe_detected():
    """Kick.com player embed should be detected as a known player."""
    html = """
    <html><body>
    <iframe src="https://player.kick.com/?channel=somechannel" frameborder="0" allowfullscreen></iframe>
    </body></html>
    """
    result = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("player.kick.com" in u for u in result), \
        f"Kick.com embed not detected: {result}"


def test_file_url_hydration_key_extracted():
    """file_url hydration key should surface video URL."""
    html = """
    <html><head>
    <script>window.__INITIAL_STATE__={"track":{"file_url":"https://cdn.example.com/media/track.mp4","title":"My Track"}};</script>
    </head><body></body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_hydration_data(html, PAGE_URL, entries, seen)
    assert any("track.mp4" in e.get("url", "") for e in entries), \
        f"file_url hydration key not found: {[e.get('url') for e in entries]}"


def test_file_url_player_config_key():
    """fileUrl in a player config script block should be detected."""
    html = """
    <html><head>
    <script>var playerConfig={fileUrl:"https://cdn.example.com/media/video.mp4",title:"Test"};</script>
    </head><body></body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_player_configs(html, PAGE_URL, entries, seen)
    urls = [e.get("url", "") for e in entries]
    assert any("video.mp4" in u for u in urls), \
        f"fileUrl in player config not found: {urls}"


# ── Round 10 tests ────────────────────────────────────────────────────────────

def test_video_controls_elevated_confidence():
    """<video controls> should receive an elevated confidence (>=0.82) via _add."""
    import html as html_mod
    entries: list[dict] = []
    seen: set[str] = set()
    tag = '<video controls src="https://cdn.example.com/media/episode.mp4">'
    attrs = universal._meta_attrs(tag)
    src = attrs.get("src", "")
    # Build a mini HTML and use the full pipeline to confirm the URL is returned.
    html_text = f"<html><body>{tag}</video></body></html>"
    result = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert result is not None, "<video controls> should produce a result"
    entries_out = result.get("entries", [result]) if result.get("_type") == "playlist" else [result]
    matched = [e for e in entries_out if "episode.mp4" in e.get("url", "")]
    assert matched, f"<video controls> not found in output: {[e.get('url') for e in entries_out]}"
    assert matched[0].get("_universal_confidence", 0) >= 0.82, \
        f"Expected >=0.82 confidence for <video controls>, got {matched[0].get('_universal_confidence')}"


def test_video_playsinline_elevated_confidence():
    """<video playsinline> should receive an elevated confidence (>=0.82)."""
    html_text = '<html><body><video playsinline src="https://cdn.example.com/media/mobile.mp4"></video></body></html>'
    result = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert result is not None, "<video playsinline> should produce a result"
    entries = result.get("entries", [result]) if result.get("_type") == "playlist" else [result]
    matched = [e for e in entries if "mobile.mp4" in e.get("url", "")]
    assert matched, f"<video playsinline> not found"
    assert matched[0].get("_universal_confidence", 0) >= 0.82, \
        f"Expected >=0.82 confidence for <video playsinline>, got {matched[0].get('_universal_confidence')}"


def test_background_video_penalised_and_excluded():
    """Background video (autoplay+loop+muted, no controls) should be filtered out by threshold."""
    html_text = '<html><body><video autoplay loop muted src="https://cdn.example.com/hero/bg.mp4"></video></body></html>'
    result = universal.extract_universal_from_html(PAGE_URL, html_text)
    # Background video confidence 0.55 is below the 0.75 threshold → filtered out.
    # Either result is None or no entry contains bg.mp4.
    if result is None:
        return
    entries = result.get("entries", [result]) if result.get("_type") == "playlist" else [result]
    bg_entries = [e for e in entries if "bg.mp4" in e.get("url", "")]
    assert not bg_entries, f"Background video should be filtered out, but found: {bg_entries}"


def test_iframe_srcdoc_media_detected():
    """<iframe srcdoc> inline HTML should be scanned for known player URLs."""
    import urllib.parse
    inner = '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>'
    srcdoc_escaped = inner.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    html = f'<html><body><iframe srcdoc="{srcdoc_escaped}"></iframe></body></html>'
    result = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("youtube.com/embed/" in u for u in result), \
        f"iframe srcdoc inner player not detected: {result}"


def test_video_url_meta_tag_detected():
    """meta[name='video_url'] should be detected as a video URL."""
    html = """
    <html><head>
    <meta name="video_url" content="https://cdn.example.com/media/meta-video.mp4">
    </head><body></body></html>
    """
    result = universal.extract_universal_from_html(PAGE_URL, html)
    assert result is not None
    entries = result.get("entries", [result]) if result.get("_type") == "playlist" else [result]
    assert any("meta-video.mp4" in e.get("url", "") for e in entries), \
        f"video_url meta tag not found: {[e.get('url') for e in entries]}"


def test_media_url_meta_property_detected():
    """meta[property='media:url'] should be detected as a video URL."""
    html = """
    <html><head>
    <meta property="media:url" content="https://cdn.example.com/media/media-prop.mp4">
    </head><body></body></html>
    """
    result = universal.extract_universal_from_html(PAGE_URL, html)
    assert result is not None
    entries = result.get("entries", [result]) if result.get("_type") == "playlist" else [result]
    assert any("media-prop.mp4" in e.get("url", "") for e in entries), \
        f"media:url meta property not found: {[e.get('url') for e in entries]}"


def test_app_config_hydration_global_detected():
    """__APP_CONFIG__ hydration global should surface embedded video URL via video_url key."""
    html = """
    <html><head>
    <script>window.__APP_CONFIG__={"video_url":"https://cdn.example.com/app-config/video.mp4"};</script>
    </head><body></body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_hydration_data(html, PAGE_URL, entries, seen)
    assert any("app-config/video.mp4" in e.get("url", "") for e in entries), \
        f"__APP_CONFIG__ global not detected: {[e.get('url') for e in entries]}"


def test_page_data_hydration_global_detected():
    """__PAGE_DATA__ hydration global should surface embedded media URL via mp4_url key."""
    html = """
    <html><head>
    <script>window.__PAGE_DATA__={"mp4_url":"https://cdn.example.com/page-data/clip.mp4"};</script>
    </head><body></body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_hydration_data(html, PAGE_URL, entries, seen)
    assert any("page-data/clip.mp4" in e.get("url", "") for e in entries), \
        f"__PAGE_DATA__ global not detected: {[e.get('url') for e in entries]}"


def test_json_ld_videos_array_key_traversed():
    """JSON-LD with a 'videos' array key should be traversed for VideoObjects."""
    html = """
    <html><head>
    <script type="application/ld+json">
    {"@type":"ItemList","videos":[{"@type":"VideoObject","contentUrl":"https://cdn.example.com/jsonld/list-video.mp4","name":"List Video"}]}
    </script>
    </head><body></body></html>
    """
    result = universal.extract_universal_from_html(PAGE_URL, html)
    assert result is not None
    entries = result.get("entries", [result]) if result.get("_type") == "playlist" else [result]
    assert any("list-video.mp4" in e.get("url", "") for e in entries), \
        f"JSON-LD 'videos' key not traversed: {[e.get('url') for e in entries]}"


def test_json_ld_clips_array_key_traversed():
    """JSON-LD with a 'clips' array key should be traversed for VideoObjects."""
    html = """
    <html><head>
    <script type="application/ld+json">
    {"@type":"Article","clips":[{"@type":"VideoObject","contentUrl":"https://cdn.example.com/jsonld/clip-item.mp4","name":"Clip"}]}
    </script>
    </head><body></body></html>
    """
    result = universal.extract_universal_from_html(PAGE_URL, html)
    assert result is not None
    entries = result.get("entries", [result]) if result.get("_type") == "playlist" else [result]
    assert any("clip-item.mp4" in e.get("url", "") for e in entries), \
        f"JSON-LD 'clips' key not traversed: {[e.get('url') for e in entries]}"


# ── Round 11 tests ────────────────────────────────────────────────────────────

def test_mux_video_element_reconstructs_hls_url():
    """<mux-video playback-id="..."> should reconstruct the Mux CDN HLS URL."""
    html = """
    <html><body>
    <mux-video playback-id="DS00Spx1CV902MCtPj5WknGlR102V5HFkDe4NtXDyWoM" controls></mux-video>
    </body></html>
    """
    result = universal.extract_universal_from_html(PAGE_URL, html)
    assert result is not None, "<mux-video> should produce a result"
    entries = result.get("entries", [result]) if result.get("_type") == "playlist" else [result]
    assert any("stream.mux.com" in e.get("url", "") for e in entries), \
        f"Mux CDN URL not found: {[e.get('url') for e in entries]}"
    assert any(e.get("url", "").endswith(".m3u8") for e in entries if "stream.mux.com" in e.get("url", "")), \
        "Mux URL should end in .m3u8"


def test_mux_audio_element_reconstructs_hls_url():
    """<mux-audio playback-id="..."> should reconstruct Mux CDN URL."""
    html = """
    <html><body>
    <mux-audio playback-id="AbCdEfGhIjKlMnOp12345678" controls></mux-audio>
    </body></html>
    """
    result = universal.extract_universal_from_html(PAGE_URL, html)
    assert result is not None, "<mux-audio> should produce a result"
    entries = result.get("entries", [result]) if result.get("_type") == "playlist" else [result]
    assert any("stream.mux.com" in e.get("url", "") for e in entries), \
        f"Mux audio URL not found: {[e.get('url') for e in entries]}"


def test_wp_playlist_hydration_global():
    """wp_playlist variable in script should be recognized and surfaced."""
    html = """
    <html><head>
    <script>var wp_playlist = [{"hls_url":"https://cdn.example.com/wp/audio.m3u8","type":"audio/mpeg","title":"Track"}];</script>
    </head><body></body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_hydration_data(html, PAGE_URL, entries, seen)
    assert any("wp/audio.m3u8" in e.get("url", "") for e in entries), \
        f"wp_playlist global not detected: {[e.get('url') for e in entries]}"


def test_bcl_hydration_global():
    """BCL (Brightcove Client Library) variable in script should be surfaced."""
    html = """
    <html><head>
    <script>window.BCL = {"hls_url":"https://cdn.example.com/bcl/master.m3u8"};</script>
    </head><body></body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_hydration_data(html, PAGE_URL, entries, seen)
    assert any("bcl/master.m3u8" in e.get("url", "") for e in entries), \
        f"BCL global not detected: {[e.get('url') for e in entries]}"


def test_data_brightcove_json_attr():
    """data-brightcove JSON attribute should be scanned for hls_url."""
    html = """
    <html><body>
    <div data-brightcove='{"hls_url":"https://cdn.example.com/brightcove/stream.m3u8"}'></div>
    </body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_json_data_attributes(html, PAGE_URL, entries, seen)
    assert any("brightcove/stream.m3u8" in e.get("url", "") for e in entries), \
        f"data-brightcove JSON attribute not detected: {[e.get('url') for e in entries]}"


def test_data_embed_json_attr():
    """data-embed JSON attribute (previously missing from name regex) should be scanned."""
    html = """
    <html><body>
    <div data-embed='{"sources":[{"src":"https://cdn.example.com/embed/video.mp4","type":"video/mp4"}]}'></div>
    </body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_json_data_attributes(html, PAGE_URL, entries, seen)
    assert any("embed/video.mp4" in e.get("url", "") for e in entries), \
        f"data-embed JSON attribute not detected: {[e.get('url') for e in entries]}"


# ── Round 12: Plyr embed elements ──────────────────────────────────────────────

def test_plyr_youtube_reconstructs_embed_url():
    """data-plyr-provider=youtube + data-plyr-id should reconstruct YouTube embed URL."""
    html = """
    <html><body>
    <div data-plyr-provider="youtube" data-plyr-id="dQw4w9WgXcQ"></div>
    </body></html>
    """
    result = universal.extract_universal_from_html(PAGE_URL, html)
    assert result is not None, "Should return a result"
    url = result.get("url") or result.get("webpage_url", "")
    entries = result.get("entries", [result])
    assert any("youtube.com/embed/dQw4w9WgXcQ" in e.get("url", "") for e in entries), \
        f"Plyr YouTube embed URL not reconstructed: {[e.get('url') for e in entries]}"


def test_plyr_vimeo_reconstructs_player_url():
    """data-plyr-provider=vimeo + data-plyr-id should reconstruct Vimeo player URL."""
    html = """
    <html><body>
    <div data-plyr-provider="vimeo" data-plyr-id="123456789"></div>
    </body></html>
    """
    result = universal.extract_universal_from_html(PAGE_URL, html)
    assert result is not None, "Should return a result"
    entries = result.get("entries", [result])
    assert any("player.vimeo.com/video/123456789" in e.get("url", "") for e in entries), \
        f"Plyr Vimeo player URL not reconstructed: {[e.get('url') for e in entries]}"


def test_plyr_html5_src_detected():
    """data-plyr-src pointing to a direct media URL should be surfaced."""
    html = """
    <html><body>
    <div data-plyr-provider="html5" data-plyr-src="https://cdn.example.com/plyr/video.mp4"></div>
    </body></html>
    """
    result = universal.extract_universal_from_html(PAGE_URL, html)
    assert result is not None, "Should return a result"
    entries = result.get("entries", [result])
    assert any("plyr/video.mp4" in e.get("url", "") for e in entries), \
        f"Plyr HTML5 src URL not detected: {[e.get('url') for e in entries]}"


# ── Round 13: og:audio:secure_url, data-bg-video ──────────────────────────────

def test_og_audio_secure_url_detected():
    """og:audio:secure_url meta property should be detected (was missing from regex)."""
    html = """
    <html><head>
    <meta property="og:audio:secure_url" content="https://cdn.example.com/audio/track.mp3">
    <meta property="og:audio:type" content="audio/mpeg">
    </head><body></body></html>
    """
    result = universal.extract_universal_from_html(PAGE_URL, html)
    assert result is not None, "Should return a result"
    entries = result.get("entries", [result])
    assert any("audio/track.mp3" in e.get("url", "") for e in entries), \
        f"og:audio:secure_url not detected: {[e.get('url') for e in entries]}"


def test_data_bg_video_attr_detected():
    """data-bg-video attribute on a div element should surface the video URL."""
    html = """
    <html><body>
    <div class="hero" data-bg-video="https://cdn.example.com/bg/hero.mp4"></div>
    </body></html>
    """
    result = universal.extract_universal_from_html(PAGE_URL, html)
    assert result is not None, "Should return a result"
    entries = result.get("entries", [result])
    assert any("bg/hero.mp4" in e.get("url", "") for e in entries), \
        f"data-bg-video URL not detected: {[e.get('url') for e in entries]}"


def test_data_background_video_attr_variant():
    """data-background-video attribute variant should also be detected."""
    html = """
    <html><body>
    <section data-background-video="https://cdn.example.com/section/bg.mp4"></section>
    </body></html>
    """
    result = universal.extract_universal_from_html(PAGE_URL, html)
    assert result is not None, "Should return a result"
    entries = result.get("entries", [result])
    assert any("section/bg.mp4" in e.get("url", "") for e in entries), \
        f"data-background-video URL not detected: {[e.get('url') for e in entries]}"


# ── Round 14: player config camelCase key parity ──────────────────────────────

def test_player_config_hls_url_camel():
    """hlsUrl camelCase key in player config script should be detected."""
    html = """
    <html><body>
    <script>jwplayer("player").setup({ hlsUrl: "https://cdn.example.com/r14/stream.m3u8" });</script>
    </body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_player_configs(html, PAGE_URL, entries, seen)
    assert any("r14/stream.m3u8" in e.get("url", "") for e in entries), \
        f"hlsUrl key not detected: {[e.get('url') for e in entries]}"


def test_player_config_dash_url_camel():
    """dashUrl camelCase key in player config script should be detected."""
    html = """
    <html><body>
    <script>videojs("player", { dashUrl: "https://cdn.example.com/r14/manifest.mpd" });</script>
    </body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_player_configs(html, PAGE_URL, entries, seen)
    assert any("r14/manifest.mpd" in e.get("url", "") for e in entries), \
        f"dashUrl key not detected: {[e.get('url') for e in entries]}"


def test_player_config_mp4_url_camel():
    """mp4Url camelCase key in player config script should be detected."""
    html = """
    <html><body>
    <script>var playerConfig = { mp4Url: "https://cdn.example.com/r14/video.mp4" };</script>
    </body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_player_configs(html, PAGE_URL, entries, seen)
    assert any("r14/video.mp4" in e.get("url", "") for e in entries), \
        f"mp4Url key not detected: {[e.get('url') for e in entries]}"


def test_player_config_video_url_camel():
    """videoUrl camelCase key in player config script should be detected."""
    html = """
    <html><body>
    <script>var playerConfig = { videoUrl: "https://cdn.example.com/r14/clip.mp4" };</script>
    </body></html>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_player_configs(html, PAGE_URL, entries, seen)
    assert any("r14/clip.mp4" in e.get("url", "") for e in entries), \
        f"videoUrl key not detected: {[e.get('url') for e in entries]}"


# ── Round 15: new embed patterns + Wistia v2 custom element ──────────────────

def test_wistia_player_custom_element():
    """<wistia-player media-id="ID"> should reconstruct the Wistia iframe embed URL."""
    html = '<wistia-player media-id="abc123xyz9"></wistia-player>'
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    match = next((u for u in urls if "abc123xyz9" in u), None)
    assert match is not None, f"<wistia-player> not detected: {urls}"
    assert "fast.wistia.com/embed/iframe/" in match, \
        f"Expected fast.wistia.com/embed/iframe/ URL, got: {match}"


def test_bandcamp_embedded_player_iframe():
    """Bandcamp EmbeddedPlayer iframe should be detected as a known embed."""
    html = '<iframe src="https://bandcamp.com/EmbeddedPlayer/album=1234567890/size=large/"></iframe>'
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("bandcamp.com/EmbeddedPlayer" in u for u in urls), \
        f"Bandcamp EmbeddedPlayer not detected: {urls}"


def test_bandcamp_embedded_player_iframe_with_www():
    """Bandcamp EmbeddedPlayer with a www. host prefix should also be detected
    (TS parity check: Python's _KNOWN_PLAYER_HOST_RE was missing the optional
    (?:www\\.)? prefix that TS's EMBED_IFRAME_RE already had for bandcamp.com)."""
    html = '<iframe src="https://www.bandcamp.com/EmbeddedPlayer/album=1234567890/size=large/"></iframe>'
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("bandcamp.com/EmbeddedPlayer" in u for u in urls), \
        f"Bandcamp EmbeddedPlayer with www prefix not detected: {urls}"


def test_twitter_platform_embed_iframe():
    """Twitter/X platform embed iframe should be detected."""
    html = '<iframe src="https://platform.twitter.com/embed/Tweet.html?id=1234567890"></iframe>'
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("platform.twitter.com/embed" in u for u in urls), \
        f"Twitter platform embed not detected: {urls}"


def test_instagram_reel_embed_iframe():
    """Instagram reel embed iframe should be detected."""
    html = '<iframe src="https://www.instagram.com/reel/CaB123xyzXY/embed/"></iframe>'
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("instagram.com/reel" in u for u in urls), \
        f"Instagram reel embed not detected: {urls}"


def test_dailymotion_short_url_iframe():
    """dai.ly short Dailymotion URL in iframe should be detected."""
    html = '<iframe src="https://dai.ly/x7abc12"></iframe>'
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("dai.ly" in u for u in urls), \
        f"dai.ly iframe not detected: {urls}"


# ── Round 16: Flash flashvars + extended data-attr names ──────────────────────

def test_flash_object_flashvars_file_key():
    """Flash <object> with <param name="flashvars" value="file=URL"> should surface the video URL."""
    html = """
    <object type="application/x-shockwave-flash" data="player.swf">
      <param name="flashvars" value="file=https://cdn.example.com/r16/video.mp4&amp;autostart=false"/>
    </object>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "extract_universal_from_html returned None"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r16/video.mp4" in u for u in urls), \
        f"Flash flashvars file= not detected: {urls}"


def test_flash_embed_flashvars_mp4_key():
    """Flash <embed> with flashvars='mp4=URL' should surface the video URL."""
    html = '<embed type="application/x-shockwave-flash" src="player.swf" flashvars="mp4=https://cdn.example.com/r16/embed.mp4"/>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "extract_universal_from_html returned None"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r16/embed.mp4" in u for u in urls), \
        f"Flash embed flashvars mp4= not detected: {urls}"


def test_data_flowplayer_config_attr():
    """data-flowplayer-config JSON attribute should be parsed for media URLs."""
    html = (
        '<div data-flowplayer-config=\'{"clip":{"sources":[{"src":"https://cdn.example.com/r16/fp.mp4",'
        '"type":"video/mp4"}]}}\'></div>'
    )
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "extract_universal_from_html returned None for data-flowplayer-config"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r16/fp.mp4" in u for u in urls), \
        f"data-flowplayer-config src not detected: {urls}"


def test_data_player_config_attr():
    """data-player-config JSON attribute should be parsed for media URLs."""
    html = (
        '<div data-player-config=\'{"source":{"src":"https://cdn.example.com/r16/player-cfg.mp4",'
        '"type":"video/mp4"}}\'></div>'
    )
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "extract_universal_from_html returned None for data-player-config"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r16/player-cfg.mp4" in u for u in urls), \
        f"data-player-config src not detected: {urls}"


# ── Round 17: anchor media links + noscript iframe expansion ──────────────────

def test_anchor_mp3_href_no_download_attr():
    """Plain <a href='...mp3'> without download attribute should be detected."""
    html = """
    <ul>
      <li><a href="https://cdn.example.com/r17/episode1.mp3">Episode 1</a></li>
      <li><a href="https://cdn.example.com/r17/episode2.mp3">Episode 2</a></li>
    </ul>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "anchor mp3 href not detected"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r17/episode1.mp3" in u for u in urls), f"episode1.mp3 not found: {urls}"


def test_anchor_mp4_href_no_download_attr():
    """Plain <a href='...mp4'> without download attribute should be detected."""
    html = '<a href="https://cdn.example.com/r17/clip.mp4">Watch video</a>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "anchor mp4 href not detected"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r17/clip.mp4" in u for u in urls), f"clip.mp4 not found: {urls}"


def test_anchor_hls_href_no_download_attr():
    """<a href='...m3u8'> should be detected as HLS media link."""
    html = '<a href="https://cdn.example.com/r17/stream.m3u8">Live stream</a>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "anchor m3u8 href not detected"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r17/stream.m3u8" in u for u in urls), f"stream.m3u8 not found: {urls}"


def test_noscript_iframe_youtube_detected():
    """<iframe> inside <noscript> (blog JS fallback) should be detected via noscript expansion."""
    html = """
    <div class="video-wrapper">
      <noscript>
        <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315"></iframe>
      </noscript>
    </div>
    """
    urls = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("youtube.com/embed" in u for u in urls), \
        f"noscript YouTube iframe not detected: {urls}"


# ── Round 18: extended data-attr keywords, rel="video_src", object/embed direct media ──

def test_data_src_hd_attr_detected():
    """data-src-hd attribute should be matched by the extended mediaName keyword list."""
    html = '<video data-src-hd="https://cdn.example.com/r18/video-hd.mp4"></video>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "data-src-hd not detected"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r18/video-hd.mp4" in u for u in urls), f"video-hd.mp4 not found: {urls}"


def test_data_sd_src_attr_detected():
    """data-sd-src attribute should be matched by the extended mediaName keyword list."""
    html = '<div data-sd-src="https://cdn.example.com/r18/video-sd.mp4"></div>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "data-sd-src not detected"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r18/video-sd.mp4" in u for u in urls), f"video-sd.mp4 not found: {urls}"


def test_link_rel_video_src_detected():
    """<link rel="video_src"> (old-style Facebook video hint) should be detected."""
    html = (
        '<html><head>'
        '<link rel="video_src" href="https://cdn.example.com/r18/fb-video.mp4" type="video/mp4"/>'
        '</head></html>'
    )
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "link rel=video_src not detected"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r18/fb-video.mp4" in u for u in urls), f"fb-video.mp4 not found: {urls}"


def test_object_direct_video_detected():
    """<object data='video.mp4' type='video/mp4'> should be detected as a direct media embed."""
    html = (
        '<object data="https://cdn.example.com/r18/object.mp4" '
        'type="video/mp4" width="640" height="360"></object>'
    )
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "object direct video not detected"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r18/object.mp4" in u for u in urls), f"object.mp4 not found: {urls}"


def test_embed_direct_audio_detected():
    """<embed src='audio.mp3' type='audio/mpeg'> should be detected as a direct audio embed."""
    html = '<embed src="https://cdn.example.com/r18/podcast.mp3" type="audio/mpeg"/>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "embed direct audio not detected"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r18/podcast.mp3" in u for u in urls), f"podcast.mp3 not found: {urls}"


# ── Round 19: <template> elements, WordPress Gutenberg blocks, videojs.players ─

def test_template_element_video_src():
    """<video src> inside an HTML5 <template> element should be detected."""
    html = (
        '<html><body>'
        '<template id="video-tmpl">'
        '  <video src="https://cdn.example.com/r19/tmpl-video.mp4" controls></video>'
        '</template>'
        '</body></html>'
    )
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "template element video not detected"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r19/tmpl-video.mp4" in u for u in urls), f"tmpl-video.mp4 not found: {urls}"


def test_template_element_data_src():
    """data-src on <img> inside a <template> should be detected."""
    html = (
        '<template id="img-tmpl">'
        '  <img data-src="https://cdn.example.com/r19/tmpl-photo.jpg" alt="photo"/>'
        '</template>'
    )
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "template element data-src not detected"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r19/tmpl-photo.jpg" in u for u in urls), f"tmpl-photo.jpg not found: {urls}"


def test_wordpress_gutenberg_video_block():
    """<!-- wp:video {"src":"..."} /--> block comment should expose the video URL."""
    html = (
        '<html><body>'
        '<!-- wp:video {"id":123,"src":"https://cdn.example.com/r19/wp-video.mp4"} /-->'
        '<figure class="wp-block-video">'
        '<video controls src="https://cdn.example.com/r19/wp-video.mp4"></video>'
        '</figure>'
        '<!-- /wp:video -->'
        '</body></html>'
    )
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "WordPress video block not detected"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r19/wp-video.mp4" in u for u in urls), f"wp-video.mp4 not found: {urls}"


def test_wordpress_gutenberg_audio_block():
    """<!-- wp:audio {"src":"..."} /--> block comment should expose the audio URL."""
    html = (
        '<!-- wp:audio {"id":456,"src":"https://cdn.example.com/r19/wp-audio.mp3"} /-->'
    )
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "WordPress audio block not detected"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r19/wp-audio.mp3" in u for u in urls), f"wp-audio.mp3 not found: {urls}"


# ── Round 20: typed anchors, rel=alternate, custom media elements ─────────────

def test_typed_anchor_video_mp4_no_extension():
    """<a href='...' type='video/mp4'> without a file extension should be detected."""
    html = '<a href="https://cdn.example.com/r20/stream-no-ext" type="video/mp4">Watch</a>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "typed anchor without extension not detected"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r20/stream-no-ext" in u for u in urls), f"stream-no-ext not found: {urls}"


def test_typed_anchor_audio_mpeg_no_extension():
    """<a href='...' type='audio/mpeg'> without a file extension should be detected."""
    html = '<a href="https://cdn.example.com/r20/podcast-no-ext" type="audio/mpeg">Listen</a>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "typed audio anchor without extension not detected"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r20/podcast-no-ext" in u for u in urls), f"podcast-no-ext not found: {urls}"


def test_link_rel_alternate_video_type():
    """<link rel='alternate' type='video/mp4'> should expose the alternate media URL."""
    html = (
        '<html><head>'
        '<link rel="alternate" type="video/mp4" href="https://cdn.example.com/r20/alt-video.mp4"/>'
        '</head></html>'
    )
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "link rel=alternate video not detected"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r20/alt-video.mp4" in u for u in urls), f"alt-video.mp4 not found: {urls}"


def test_custom_video_player_element():
    """<video-player src='...'> custom element should be detected."""
    html = '<video-player src="https://cdn.example.com/r20/custom-video.mp4"></video-player>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "custom video-player element not detected"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r20/custom-video.mp4" in u for u in urls), f"custom-video.mp4 not found: {urls}"


def test_custom_audio_player_element():
    """<audio-player file='...'> custom element should be detected."""
    html = '<audio-player file="https://cdn.example.com/r20/custom-audio.mp3"></audio-player>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "custom audio-player element not detected"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r20/custom-audio.mp3" in u for u in urls), f"custom-audio.mp3 not found: {urls}"


def test_custom_media_player_element():
    """<media-player src='...'> custom element should be detected."""
    html = '<media-player src="https://cdn.example.com/r20/media-clip.webm"></media-player>'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None, "custom media-player element not detected"
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r20/media-clip.webm" in u for u in urls), f"media-clip.webm not found: {urls}"


# ── Round 22: JSON-LD width/height TS parity check, Kumu embed parity ────────

def test_json_ld_width_height_propagated_round22():
    """JSON-LD VideoObject with numeric width/height populates entry fields (TS parity check)."""
    html = """
    <script type="application/ld+json">
    {"@type":"VideoObject","contentUrl":"https://cdn.example.com/r22/dim-video.mp4","name":"Dim Video","width":1920,"height":1080}
    </script>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert info.get("width") == 1920
    assert info.get("height") == 1080


def test_kumu_iframe_detected():
    """Kumu.io embed iframe should be detected as a known player."""
    html = """
    <html><body>
    <iframe src="https://embed.kumu.io/abc123def456"></iframe>
    </body></html>
    """
    result = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("embed.kumu.io/" in u for u in result), \
        f"Kumu embed not detected: {result}"


def test_podbean_iframe_real_embed_shape_detected():
    """TS parity check: real Podbean embed (www.podbean.com/player-v2/) is detected."""
    html = """
    <html><body>
    <iframe src="https://www.podbean.com/player-v2/?i=abc&from=pb6admin"></iframe>
    </body></html>
    """
    result = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("podbean.com/player" in u for u in result), \
        f"Podbean embed not detected: {result}"


def test_panopto_eu_iframe_detected():
    """Panopto EU data-residency embed (panopto.eu) should be detected, not just panopto.com."""
    html = """
    <html><body>
    <iframe src="https://university.panopto.eu/Panopto/Pages/Embed.aspx?id=VIDEO-GUID"></iframe>
    </body></html>
    """
    result = universal.scan_iframe_embed_urls(PAGE_URL, html)
    assert any("panopto.eu" in u for u in result), \
        f"Panopto.eu embed not detected: {result}"


def test_bare_url_key_in_player_config_with_cdn_match():
    """Generic 'url' key (e.g. Plyr/Video.js sources) on a known media CDN should be detected."""
    html = """
    <script>var playerConfig={sources:[{url:"https://stream.mux.com/abc123.m3u8",type:"application/x-mpegURL"}]};</script>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_player_configs(html, PAGE_URL, entries, seen)
    urls = [e.get("url", "") for e in entries]
    assert any("stream.mux.com/abc123.m3u8" in u for u in urls), \
        f"bare 'url' key player config entry not found: {urls}"


def test_player_config_key_substring_no_false_positive():
    """Key names that merely end in a known token (e.g. 'errorFile' containing 'file')
    must not be misread as that token thanks to word-boundary anchoring."""
    html = """
    <script>var playerConfig={errorFile: "https://cdn.example.com/r22/fallback-error-page", type: "video/mp4"};</script>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_player_configs(html, PAGE_URL, entries, seen)
    urls = [e.get("url", "") for e in entries]
    assert not any("fallback-error-page" in u for u in urls), \
        f"'errorFile' should not be misread as 'file' key: {urls}"


# ── Round 23: subtitle extension parity (.sub/.sbv missing from _SUBTITLE_EXTS) ──

def test_media_kind_sub_extension():
    """'.sub' subtitle files (MicroDVD/SubViewer) should classify as subtitle, not video."""
    assert universal._media_kind("https://cdn.example.com/r23/captions/en.sub") == "subtitle"


def test_media_kind_sbv_extension():
    """'.sbv' subtitle files (YouTube SubViewer) should classify as subtitle, not video."""
    assert universal._media_kind("https://cdn.example.com/r23/captions/en.sbv") == "subtitle"


def test_json_feed_external_url_direct_audio_extension():
    """JSON Feed item with no attachments but a direct-media external_url should be
    detected (TS parity check: TS's scanJsonFeed previously only checked attachments)."""
    feed = """{
        "version": "https://jsonfeed.org/version/1.1",
        "title": "R25 Feed",
        "items": [
            {"id": "1", "title": "Episode 1", "external_url": "https://cdn.example.com/r25/episode1.mp3"}
        ]
    }"""
    info = universal.extract_universal_from_json_feed(PAGE_URL, feed)
    assert info is not None
    assert info["url"] == "https://cdn.example.com/r25/episode1.mp3"


def test_json_feed_external_url_non_media_page_ignored():
    """JSON Feed external_url without a direct AV extension (a regular article page link)
    must not be treated as media."""
    feed = """{
        "version": "https://jsonfeed.org/version/1.1",
        "title": "R25 Feed",
        "items": [
            {"id": "1", "title": "Article", "external_url": "https://example.com/r25/article-page"}
        ]
    }"""
    info = universal.extract_universal_from_json_feed(PAGE_URL, feed)
    assert info is None


def test_caption_url_webvtt_extension_extracted():
    """caption_url hydration key with a .webvtt extension should be recognized as subtitle
    (TS parity check: TS's isStrongHydrationUrl previously lacked the .webvtt extension)."""
    html = """
    <script id="__NEXT_DATA__" type="application/json">
    {"props":{"pageProps":{"video":{"caption_url":"https://cdn.example.com/r23/captions/en.webvtt","video_url":"https://cdn.example.com/r23/video.mp4"}}}}
    </script>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_hydration_data(html, PAGE_URL, entries, seen)
    urls = [e.get("url", "") for e in entries]
    assert any("r23/captions/en.webvtt" in u for u in urls), \
        f"caption_url with .webvtt extension not extracted: {urls}"


def test_data_bg_video_attr_inside_noscript_detected():
    """data-bg-video hidden inside entity-escaped <noscript> fallback markup should still
    be detected (TS parity check: TS gives scanBgVideoAttrs noscript-expanded HTML; Python's
    bg-video scan previously only ran against the original, still-entity-escaped html_text)."""
    html = (
        "<html><body><noscript>"
        "&lt;div class=&quot;hero&quot; data-bg-video=&quot;"
        "https://cdn.example.com/r26/bg/hero.mp4&quot;&gt;&lt;/div&gt;"
        "</noscript></body></html>"
    )
    result = universal.extract_universal_from_html(PAGE_URL, html)
    assert result is not None, "Should return a result"
    entries = result.get("entries", [result])
    assert any("r26/bg/hero.mp4" in e.get("url", "") for e in entries), \
        f"data-bg-video inside <noscript> not detected: {[e.get('url') for e in entries]}"


def test_data_attribute_ism_manifest_gets_dash_protocol_hint():
    """A data-* attribute pointing at a Smooth Streaming .ism/manifest URL should be
    classified as DASH-protocol (parity confirmation: TS's dataAttributeMimeFor was
    missing this branch and has been updated to match)."""
    html = """
    <div data-stream-url="https://example.streaming.mediaservices.windows.net/r28/asset.ism/manifest"></div>
    """
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_data_attributes(html, PAGE_URL, entries, seen)
    matches = [e for e in entries if "r28/asset.ism/manifest" in e.get("url", "")]
    assert matches, f"Smooth Streaming .ism/manifest data attribute not detected: {entries}"
    assert matches[0]["protocol"] == "http_dash_segments"


# ── Round 29: Kaltura kWidget.embed() / KalturaPlayer.setup() JS config scanner ──
# (TS parity: scanKalturaEmbeds existed in TS but had no Python equivalent — pages
# that embed Kaltura purely via the JS SDK, with no <iframe> to a kaltura.com player
# URL, were completely undetected by extract_universal_from_html.)

def test_kaltura_kwidget_embed_detected():
    html = """
    <div id="kalturaPlayer"></div>
    <script>
      kWidget.embed({
        targetId: "kalturaPlayer",
        wid: "_1234567",
        uiconf_id: 23448190,
        entry_id: "1_abc12def"
      });
    </script>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("cdnapisec.kaltura.com" in u for u in urls), f"Kaltura kWidget.embed() not detected: {urls}"
    match = next(u for u in urls if "cdnapisec.kaltura.com" in u)
    assert "/p/1234567/" in match
    assert "entryId/1_abc12def/" in match
    assert match.endswith("manifest.m3u8")


def test_kaltura_player_v7_setup_detected():
    html = """
    <script>
      var player = KalturaPlayer.setup({
        targetId: "kaltura_player",
        provider: { partnerId: 9876543, uiConfId: 44629851 }
      });
      player.loadMedia({ entryId: "1_xyz99abc" });
    </script>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("cdnapisec.kaltura.com" in u and "entryId/1_xyz99abc" in u for u in urls), \
        f"Kaltura V7 (KalturaPlayer.setup) not detected: {urls}"


def test_clean_url_unescapes_u003d():
    """A literal \\u003d (escaped '=') sequence inside an extracted URL should be
    unescaped to a real '=' character (parity confirmation: TS's cleanCandidateUrl
    was missing this and has been updated to match _clean_url)."""
    # Use an og:video meta tag rather than a player-config <script> field: the latter's
    # value-capturing regex excludes raw backslashes entirely, so it can never see one.
    escaped_eq = chr(92) + "u003d"  # literal backslash + "u003d", i.e. an escaped "="
    html = ('<meta property="og:video" content="https://cdn.example.com/r30/clip.mp4?id'
            + escaped_eq + '123">')
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    entries = info.get("entries", [info])
    urls = [e.get("url", "") for e in entries]
    assert any("r30/clip.mp4" in u for u in urls), f"og:video URL not detected: {urls}"
    match = next(u for u in urls if "r30/clip.mp4" in u)
    assert "id=123" in match, f"escaped '=' should be unescaped to a real '=' in: {match}"
    assert escaped_eq not in match, f"literal escaped '=' should not remain in: {match}"


def test_kaltura_kwidget_without_ids_does_not_emit():
    html = """<script>kWidget.embed({ targetId: "player" });</script>"""
    info = universal.extract_universal_from_html(PAGE_URL, html)
    if info is not None:
        entries = info.get("entries", [info])
        assert not any("cdnapisec.kaltura.com" in e.get("url", "") for e in entries), \
            "Kaltura match without wid/entry_id should not emit"


# ── Round 33: og:video:width/height and og:image:width/height dimension metadata ──

def test_og_video_width_height_propagated():
    html = """
    <meta property="og:video" content="https://cdn.example.com/r33/video.mp4">
    <meta property="og:video:width" content="1920">
    <meta property="og:video:height" content="1080">
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert info.get("width") == 1920
    assert info.get("height") == 1080


def test_og_image_width_height_propagated():
    html = """
    <meta property="og:image" content="https://cdn.example.com/r33/share-card.jpg">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert info.get("width") == 1200
    assert info.get("height") == 630


def test_twitter_image_width_height_propagated():
    html = """
    <meta name="twitter:image" content="https://cdn.example.com/r33/card.jpg">
    <meta name="twitter:image:width" content="800">
    <meta name="twitter:image:height" content="418">
    """
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert info.get("width") == 800
    assert info.get("height") == 418


def test_og_video_without_dimensions_omits_width_height():
    html = '<meta property="og:video" content="https://cdn.example.com/r33/no-dims.mp4">'
    info = universal.extract_universal_from_html(PAGE_URL, html)
    assert info is not None
    assert "width" not in info
    assert "height" not in info


# ── Round 34: \b boundary in attribute regexes incorrectly matched inside hyphenated
# attribute names (e.g. "href" inside "data-href"), since "-" is a non-word character
# and satisfies \b. TS's attr() and Python's plain-<a href> scanner shared this bug;
# both were fixed to require whitespace (not just a word boundary) before the name.

def test_anchor_href_not_confused_by_later_data_href():
    """A later 'data-href' attribute on the same <a> tag must not override the real,
    earlier 'href' value (greedy backtracking previously made this order-dependent)."""
    html = ('<a href="https://cdn.example.com/r34/real.mp3" '
            'data-href="https://wrong.example.com/should-not-be-picked.mp3">Download</a>')
    entries: list[dict] = []
    seen: set[str] = set()
    universal._scan_resource_links(html, PAGE_URL, entries, seen)
    urls = [e.get("url", "") for e in entries]
    assert any("r34/real.mp3" in u for u in urls), f"real href not detected: {urls}"
    assert not any("should-not-be-picked" in u for u in urls), f"data-href wrongly picked: {urls}"


def test_template_script_data_type_does_not_mask_real_type():
    """A 'data-type' attribute on a <script> tag must not be confused with its real
    'type' attribute — the old \\btype\\s*= regex would wrongly read 'json' from
    data-type and skip a real text/html template script."""
    html_text = """
    <html><body>
    <script data-type="json" type="text/html" id="video-tmpl">
      <video src="https://cdn.example.com/r35/tmpl-video.mp4"></video>
    </script>
    </body></html>
    """
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("r35/tmpl-video.mp4" in u for u in urls), f"template video not detected: {urls}"


# ── Round 37: 1.5M char cap on extract_universal_from_html (TS parity check —
# TS's probeUniversalMedia previously had no cap at all on the HTML it scanned) ──

def test_html_before_1_5m_cap_detected():
    html_text = '<video src="https://cdn.example.com/r37/before-cap.mp4"></video>' + ("x" * 1_600_000)
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    assert info is not None
    urls = [info["url"]] if info.get("url") else [e["url"] for e in info.get("entries", [])]
    assert any("r37/before-cap.mp4" in u for u in urls), f"video before cap not detected: {urls}"


def test_html_past_1_5m_cap_not_detected():
    html_text = ("x" * 1_600_000) + '<video src="https://cdn.example.com/r37/after-cap.mp4"></video>'
    info = universal.extract_universal_from_html(PAGE_URL, html_text)
    urls = ([info["url"]] if info and info.get("url") else [e["url"] for e in info.get("entries", [])]) if info else []
    assert not any("r37/after-cap.mp4" in u for u in urls), f"video past cap should not be detected: {urls}"
