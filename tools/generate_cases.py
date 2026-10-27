"""Generate constructed CSV inputs and an independent row-array reconciliation oracle.

The oracle uses Python tuples, counters, and exact string comparisons. It shares no
SQL, CSV reader, or comparison implementation with the browser application.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
from collections import Counter
from pathlib import Path

NULL_MARKER = "\\N"
HEADERS = ["id", "region", "quantity", "status", "note"]


def csv_text(headers, rows, *, quote_all=False):
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n",
                        quoting=csv.QUOTE_ALL if quote_all else csv.QUOTE_MINIMAL)
    writer.writerow(headers)
    writer.writerows(rows)
    return output.getvalue()


def normalize(value, null_mode):
    return None if null_mode == "marker" and value == NULL_MARKER else value


def records(headers, rows, null_mode):
    assert headers and len(headers) == len(set(headers))
    assert all(type(header) is str for header in headers)
    result = []
    for row in rows:
        assert len(row) == len(headers)
        assert all(type(value) is str for value in row)
        result.append(dict(zip(headers, (normalize(value, null_mode) for value in row))))
    return result


def oracle(before_headers, before_rows, after_headers, after_rows, keys, null_mode):
    assert null_mode in ("text", "marker")
    assert keys and len(keys) == len(set(keys))
    assert all(key in before_headers and key in after_headers for key in keys)
    before = records(before_headers, before_rows, null_mode)
    after = records(after_headers, after_rows, null_mode)
    schema = {
        "added": [field for field in after_headers if field not in before_headers],
        "removed": [field for field in before_headers if field not in after_headers],
        "compared": [field for field in before_headers
                     if field in after_headers and field not in keys],
    }

    def keyed_rows(rows):
        keyed, unkeyed = [], 0
        for row in rows:
            key = tuple(row[field] for field in keys)
            if any(component is None or component == "" for component in key):
                unkeyed += 1
            else:
                keyed.append((key, row))
        return keyed, unkeyed

    before_keyed, unkeyed_before = keyed_rows(before)
    after_keyed, unkeyed_after = keyed_rows(after)
    before_counts = Counter(key for key, _ in before_keyed)
    after_counts = Counter(key for key, _ in after_keyed)
    ambiguous = {key for counts in (before_counts, after_counts)
                 for key, count in counts.items() if count > 1}
    # Every row of an ambiguous key is excluded from matching on both sides.
    before_unique = {key: row for key, row in before_keyed if key not in ambiguous}
    after_unique = {key: row for key, row in after_keyed if key not in ambiguous}
    matched = before_unique.keys() & after_unique.keys()
    unchanged = sum(
        all(before_unique[key][field] == after_unique[key][field]
            for field in schema["compared"])
        for key in matched
    )
    expected = {
        "changed": len(matched) - unchanged,
        "added": len(after_unique.keys() - before_unique.keys()),
        "removed": len(before_unique.keys() - after_unique.keys()),
        "unchanged": unchanged,
        "ambiguousKeys": len(ambiguous),
        "ambiguousBefore": sum(count for key, count in before_counts.items() if key in ambiguous),
        "ambiguousAfter": sum(count for key, count in after_counts.items() if key in ambiguous),
        "unkeyedBefore": unkeyed_before,
        "unkeyedAfter": unkeyed_after,
        "beforeRows": len(before_rows),
        "afterRows": len(after_rows),
    }
    assert expected["beforeRows"] == (
        expected["changed"] + expected["unchanged"] + expected["removed"]
        + expected["ambiguousBefore"] + expected["unkeyedBefore"]
    )
    assert expected["afterRows"] == (
        expected["changed"] + expected["unchanged"] + expected["added"]
        + expected["ambiguousAfter"] + expected["unkeyedAfter"]
    )
    return expected, schema


def make_case(name, before_headers, before_rows, after_headers, after_rows, keys,
              null_mode="text", *, quote_before=False, quote_after=False):
    expected, schema = oracle(before_headers, before_rows, after_headers, after_rows,
                              keys, null_mode)
    return {
        "name": name,
        "before": csv_text(before_headers, before_rows, quote_all=quote_before),
        "after": csv_text(after_headers, after_rows, quote_all=quote_after),
        "keys": list(keys),
        "nullMode": null_mode,
        "expected": expected,
        "schema": schema,
    }


def small_cases():
    return [
        make_case(
            "basic_changes", ["id", "value", "status"],
            [["a", "10", "ready"], ["b", "20", "ready"], ["c", "30", "hold"]],
            ["id", "value", "status"],
            [["a", "11", "ready"], ["b", "20", "ready"], ["d", "40", "ready"]], ["id"]),
        make_case(
            "composite_key_boundaries", ["region", "id", "value"],
            [["a|b", "c", "first"], ["a", "b|c", "second"], ["x", "y", "stable"]],
            ["region", "id", "value"],
            [["a|b", "c", "changed"], ["a", "b|c", "second"], ["x", "y", "stable"]],
            ["region", "id"]),
        make_case(
            "text_identifiers_keep_leading_zeros", ["id", "value"],
            [["001", "one"], ["1", "another"]], ["id", "value"],
            [["001", "updated"], ["1", "another"]], ["id"]),
        make_case(
            "whitespace_and_case_are_values", ["id", "status", "note"],
            [["row", "Ready", " padded "], ["Row", "ready", "same"], ["trim", "x", "line "]],
            ["id", "status", "note"],
            [["row", "ready", "padded"], ["ROW", "ready", "same"], ["trim", "x", "line"]],
            ["id"]),
        make_case(
            "quoted_fields_and_utf8", ["id", "note", "value"],
            [["alpha", "comma, inside", "line\nbreak"],
             ["beta", 'He said "ready".', "snowman \u2603"]],
            ["id", "note", "value"],
            [["alpha", "comma, changed", "line\nbreak"],
             ["beta", 'He said "ready".', "snowman \u2603"]], ["id"]),
        make_case(
            "case_distinct_headers", ["id", "Foo", "foo"],
            [["a", "same", "lower"], ["b", "other", "same"]], ["id", "Foo", "foo"],
            [["a", "same", "updated"], ["b", "other", "same"]], ["id"]),
        make_case(
            "headers_are_data",
            ["id", "select; DROP TABLE review; --", 'quote"field', "line\nheader"],
            [["a", "old", "quoted", "multiline"], ["b", "stable", "same", "same"]],
            ["id", "select; DROP TABLE review; --", 'quote"field', "line\nheader"],
            [["a", "new", "quoted", "multiline"], ["b", "stable", "same", "same"]], ["id"]),
        make_case(
            "empty_and_marker_text_mode", ["id", "value"],
            [["a", ""], ["b", NULL_MARKER], ["c", "NULL"], ["d", "null"]],
            ["id", "value"],
            [["a", NULL_MARKER], ["b", ""], ["c", "NULL"], ["d", "NULL"]], ["id"]),
        make_case(
            "marker_mode_values_and_keys", ["id", "value"],
            [["a", NULL_MARKER], ["b", ""], [NULL_MARKER, "skipped"],
             ["", "also skipped"], ["n", NULL_MARKER]],
            ["id", "value"],
            [["a", ""], ["b", NULL_MARKER], [NULL_MARKER, "changed but unkeyed"],
             ["", "also unkeyed"], ["n", NULL_MARKER]], ["id"], "marker", quote_before=True),
        make_case(
            "duplicate_key_one_side", ["id", "value"],
            [["dup", "old-a"], ["dup", "old-b"], ["solo", "stable"]],
            ["id", "value"], [["dup", "new"], ["solo", "stable"]], ["id"]),
        make_case(
            "duplicate_key_both_sides", ["id", "value"],
            [["dup", "before-a"], ["dup", "before-b"], ["keep", "stable"]],
            ["id", "value"],
            [["dup", "after-a"], ["dup", "after-b"], ["dup", "after-c"], ["keep", "stable"]],
            ["id"]),
        make_case(
            "unkeyed_composite_rows", ["id", "region", "value"],
            [["", "west", "empty id"], ["x", "", "empty region"], ["x", "east", "old"]],
            ["id", "region", "value"],
            [["", "west", "updated empty id"], ["x", "", "updated empty region"],
             ["x", "east", "new"], ["y", "north", "added"]], ["id", "region"]),
        make_case(
            "reordered_headers_and_schema", ["id", "value", "removed", "note"],
            [["a", "10", "legacy", "hold"], ["b", "20", "legacy", "go"]],
            ["note", "added", "value", "id"],
            [["hold", "new field", "10", "a"], ["go", "new field", "21", "b"]], ["id"]),
        make_case(
            "header_only_empty_snapshots", ["id", "value"], [],
            ["id", "value"], [], ["id"]),
        make_case(
            "schema_only_changes", ["id", "retired"],
            [["a", "old"], ["b", "old"]], ["new", "id"],
            [["new value", "a"], ["new value", "b"]], ["id"]),
    ]


def benchmark_case():
    def row(index):
        return [f"id{index:05d}", ("north", "east", "south", "west")[index % 4],
                str(index % 997), "ready", f"fixture-{index % 31:02d}"]

    before = [row(index) for index in range(50_000)]
    after = [list(item) for item in before[250:]]
    for item in after[:500]:
        item[2] = str(int(item[2]) + 1_000)
    after.extend(row(index) for index in range(50_000, 50_300))
    case = make_case("generated_50000_row_migration", HEADERS, before, HEADERS, after, ["id"])
    assert case["expected"] == {
        "changed": 500, "added": 300, "removed": 250, "unchanged": 49_250,
        "ambiguousKeys": 0, "ambiguousBefore": 0, "ambiguousAfter": 0,
        "unkeyedBefore": 0, "unkeyedAfter": 0, "beforeRows": 50_000, "afterRows": 50_050,
    }
    for side in ("before", "after"):
        assert len(case[side].encode("utf-8")) < 8 * 1024 * 1024
    case.pop("name")
    return case


def main():
    parser = argparse.ArgumentParser(description="Generate independent CSV reconciliation fixtures.")
    parser.add_argument("--output", type=Path, default=Path("artifacts/cases.json"))
    args = parser.parse_args()
    cases = small_cases()
    assert len(cases) == 15 and len({case["name"] for case in cases}) == len(cases)
    payload = {"cases": cases, "benchmark": benchmark_case()}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                           encoding="utf-8", newline="\n")
    print("Generated 15 correctness cases and a 50,000-row benchmark.")


if __name__ == "__main__":
    main()
