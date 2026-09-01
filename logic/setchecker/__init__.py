"""NSW train carriage number -> set number, ported from the standalone set checker."""

from .checker import catalogue, lookup, normalise, resolve_carriage, resolve_set

__all__ = ['catalogue', 'lookup', 'normalise', 'resolve_carriage', 'resolve_set']
