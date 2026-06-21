import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts.test_comprehensive_ios import (
    TASKS_STORAGE_KEY,
    get_tasks_db_file,
    normalize_page_url,
)


class IOSReportHelperTests(unittest.TestCase):
    def test_resolves_exact_tasks_storage_file(self):
        with tempfile.TemporaryDirectory() as temporary_dir:
            db_dir = Path(temporary_dir)
            (db_dir / 'manifest.json').write_text(
                json.dumps({TASKS_STORAGE_KEY: None, '@fcdownloader/other': None}),
                encoding='utf-8',
            )
            expected = db_dir / hashlib.md5(TASKS_STORAGE_KEY.encode()).hexdigest()
            expected.write_text('[]', encoding='utf-8')
            (db_dir / ('0' * 32)).write_text('[{"wrong": true}]', encoding='utf-8')

            self.assertEqual(get_tasks_db_file(db_dir), expected)

    def test_rejects_inline_task_storage(self):
        with tempfile.TemporaryDirectory() as temporary_dir:
            db_dir = Path(temporary_dir)
            (db_dir / 'manifest.json').write_text(
                json.dumps({TASKS_STORAGE_KEY: '[]'}),
                encoding='utf-8',
            )

            with self.assertRaisesRegex(RuntimeError, 'inline'):
                get_tasks_db_file(db_dir)

    def test_normalizes_encoded_paths_without_dropping_query(self):
        self.assertEqual(
            normalize_page_url('HTTPS://Example.COM/a%20b/?x=1#fragment'),
            'https://example.com/a b?x=1',
        )


if __name__ == '__main__':
    unittest.main()
