from __future__ import annotations

import dataclasses
import enum
import os
from datetime import date, datetime, time
from pathlib import Path
from typing import Any, Callable

from pdf2zh_next.config.model import SettingsModel
from pdf2zh_next.config.translate_engine_model import BingSettings, GoogleSettings
from pdf2zh_next.high_level import do_translate_async_stream

from pdf2zh_engine.job import EngineJob


def configure_babeldoc_asset_upstream() -> None:
    preferred = os.getenv("PDF2ZH_ASSET_UPSTREAM", "").strip().lower()
    if not preferred:
        return

    if preferred not in {"modelscope", "huggingface", "github"}:
        return

    try:
        from babeldoc.assets import assets as babel_assets
        from babeldoc.assets import embedding_assets_metadata as metadata
    except Exception:
        return

    def keep_only(mapping: dict[str, Any], key: str) -> None:
        if key not in mapping:
            return
        value = mapping[key]
        mapping.clear()
        mapping[key] = value

    keep_only(metadata.FONT_METADATA_URL, preferred)
    keep_only(metadata.FONT_URL_BY_UPSTREAM, preferred)
    keep_only(metadata.DOC_LAYOUT_ONNX_MODEL_URL, preferred)
    keep_only(metadata.TABLE_DETECTION_RAPIDOCR_MODEL_URL, preferred)

    babel_assets._FASTEST_FONT_UPSTREAM = None
    babel_assets._FASTEST_FONT_METADATA = None


def _to_jsonable(obj: Any, _seen: set[int] | None = None) -> Any:
    # Convert arbitrary objects from upstream events into JSON-serializable
    # data without changing the event schema.
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj

    if isinstance(obj, Path):
        return str(obj)

    if isinstance(obj, (datetime, date, time)):
        try:
            return obj.isoformat()
        except Exception:
            return str(obj)

    if isinstance(obj, enum.Enum):
        return _to_jsonable(obj.value, _seen)

    if isinstance(obj, (bytes, bytearray, memoryview)):
        b = bytes(obj)
        try:
            return b.decode("utf-8")
        except Exception:
            return b.hex()

    if isinstance(obj, dict):
        return {
            (k if isinstance(k, str) else str(_to_jsonable(k, _seen))): _to_jsonable(
                v, _seen
            )
            for k, v in obj.items()
        }

    if isinstance(obj, (list, tuple, set, frozenset)):
        return [_to_jsonable(v, _seen) for v in obj]

    # Pydantic v2
    model_dump = getattr(obj, "model_dump", None)
    if callable(model_dump):
        try:
            return _to_jsonable(model_dump(mode="python"), _seen)
        except Exception:
            try:
                return _to_jsonable(model_dump(), _seen)
            except Exception:
                pass

    # Pydantic v1
    model_dict = getattr(obj, "dict", None)
    if callable(model_dict):
        try:
            return _to_jsonable(model_dict(), _seen)
        except Exception:
            pass

    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        try:
            return _to_jsonable(dataclasses.asdict(obj), _seen)
        except Exception:
            pass

    # Generic object; avoid recursion loops.
    if hasattr(obj, "__dict__"):
        if _seen is None:
            _seen = set()
        oid = id(obj)
        if oid in _seen:
            return str(obj)
        _seen.add(oid)
        try:
            return _to_jsonable(vars(obj), _seen)
        except Exception:
            return str(obj)

    return str(obj)


def build_settings(job: EngineJob) -> SettingsModel:
    if job.service == "google":
        engine_settings = GoogleSettings()
    elif job.service == "bing":
        engine_settings = BingSettings()
    else:
        # Should never happen due to validation
        raise ValueError(f"Unsupported service: {job.service}")

    settings = SettingsModel(translate_engine_settings=engine_settings)

    settings.report_interval = float(job.reportInterval)
    settings.translation.output = job.outputDir
    settings.translation.ignore_cache = bool(job.ignoreCache)
    settings.translation.pool_max_workers = int(job.threads)
    settings.translation.term_pool_max_workers = int(job.threads)
    settings.pdf.pages = job.pages
    settings.pdf.no_dual = not bool(job.dual)
    settings.pdf.no_mono = not bool(job.mono)

    if job.langIn:
        settings.translation.lang_in = job.langIn
    if job.langOut:
        settings.translation.lang_out = job.langOut
    if job.qps is not None:
        settings.translation.qps = int(job.qps)

    return settings


async def run_job_stream(
    job: EngineJob, emit: Callable[[dict[str, Any]], None]
) -> None:
    configure_babeldoc_asset_upstream()
    settings = build_settings(job)

    # do_translate_async_stream translates one file at a time.
    for input_path in job.inputs:
        async for event in do_translate_async_stream(settings, input_path):
            event_type = None
            try:
                event_type = event.get("type")
            except Exception:
                pass

            # Ensure all event payloads are JSON-serializable (e.g. finish may
            # include TranslateResult objects).
            emit(_to_jsonable(event))

            if event_type == "finish":
                break
