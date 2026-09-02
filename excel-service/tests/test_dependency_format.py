"""Unit tests voor app/dependency_format.py — het gedeelde formatteren/parsen
van activiteit-afhankelijkheden (type + vertraging in dagen), gebruikt door
zowel project_workbook.py als exporter.py/parser.py."""
from __future__ import annotations

from app.dependency_format import format_dependency, parse_dependency_entry


class TestFormatDependency:
    def test_fs_zonder_vertraging_blijft_kaal(self):
        assert format_dependency('Taak A', 'FS', 0) == 'Taak A'
        assert format_dependency('Taak A', None, None) == 'Taak A'

    def test_ander_type_of_vertraging_krijgt_suffix(self):
        assert format_dependency('Taak B', 'SS', 0) == 'Taak B (SS)'
        assert format_dependency('Taak C', 'FS', 2) == 'Taak C (FS+2)'
        assert format_dependency('Taak D', 'FF', -1) == 'Taak D (FF-1)'


class TestParseDependencyEntry:
    def test_parse_is_inverse_van_format(self):
        for name, dep_type, lag in [
            ('Taak A', 'FS', 0), ('Taak B', 'SS', 0), ('Taak C', 'FS', 2), ('Taak D', 'FF', -1),
        ]:
            formatted = format_dependency(name, dep_type, lag)
            assert parse_dependency_entry(formatted) == (name, dep_type, lag)

    def test_onherkend_type_valt_terug_op_fs(self):
        assert parse_dependency_entry('Taak E (XX)') == ('Taak E', 'FS', 0)

    def test_kale_naam_zonder_haakjes(self):
        assert parse_dependency_entry('Taak F') == ('Taak F', 'FS', 0)
