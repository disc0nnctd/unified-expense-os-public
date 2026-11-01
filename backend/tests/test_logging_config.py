import json
import logging

from app.logging_config import JsonFormatter


def test_json_formatter_emits_parseable_json_with_expected_fields():
    formatter = JsonFormatter()
    record = logging.LogRecord(
        name="app.test", level=logging.INFO, pathname=__file__, lineno=1, msg="hello %s", args=("world",), exc_info=None
    )
    line = formatter.format(record)
    parsed = json.loads(line)
    assert parsed["message"] == "hello world"
    assert parsed["level"] == "INFO"
    assert parsed["logger"] == "app.test"
    assert "ts" in parsed
