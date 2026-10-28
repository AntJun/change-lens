# CSV reconciliation policy

## Input and header records

Each input is a UTF-8, comma-separated CSV with a header record. Double quotes enclose
fields; doubled quotes escape a literal quote. Multiline data fields are supported.
A UTF-8 byte-order mark is accepted. The SHA-256 digest covers the original file bytes,
including line endings and the byte-order mark.

Header names are exact strings, with no trimming, case folding, or Unicode normalization.
Exact duplicate, empty, whitespace-only, control-character, or oversized names are rejected.
Names that differ only by case remain separate fields. The parser receives only a bounded
first physical header line. Quoted multiline header names are rejected.

A separate worker performs step-based structural validation with Papa Parse and enforces
data limits. Its parsed data-record count and ordered cell digest must agree with the
database reader. Each digest frames every cell by its Unicode codepoint count and value,
in record and column order. Ambiguous dialect interpretations fail the comparison.
DuckDB parses the complete registered file against an explicit all-text schema with
strict widths and quoting. The first parsed record supplies the header and is excluded
from data. Invalid UTF-8 and malformed CSV fail the operation.

## Text and null values

The default policy preserves all parsed cell values as text, including empty strings,
leading zeroes, whitespace, and case.

Marker mode maps an exact backslash followed by N to null in data cells. This applies
to both quoted and unquoted markers. Empty strings remain empty strings. No other
string, numeric, date, or boolean conversion occurs.

## Identity and ambiguity

The selected column names must exist on both sides. A composite key is an ordered tuple
of its component values. Components are grouped separately; delimiters inside values
cannot create a collision between different tuples. The interface displays keys as
JSON-quoted arrays so component boundaries and literal null-like text remain visible.

If any component is null or empty text, that record is unkeyed.

For every remaining tuple, count its occurrences on each side. If either count exceeds
one, all members on both sides belong to the ambiguity group. This includes a unique
record opposite a repeated group. There is no guessed pairing among those members.

Remaining tuples can occur at most once per side. A before-only tuple is removed;
an after-only tuple is added. Matched tuples compare shared non-key fields with exact,
null-aware equality. Every shared non-key field must match for an unchanged result.

Added and removed schema fields are listed separately. Their presence does not by itself
change a matched row's changed/unchanged category.

## Conservation

The result must satisfy both equations:

~~~text
before rows = changed + unchanged + removed + ambiguous before + unkeyed before
after rows  = changed + unchanged + added   + ambiguous after  + unkeyed after
~~~

A failed conservation check prevents a successful summary.

## Ordering and provenance

Rows use 1-based parsed data-record ordinals after the header. These are independent
source references. Quoted multiline fields can span several physical lines.

The pinned DuckDB 1.4.3 reader ignores bare blank lines in multi-column files. In a
one-column file, a bare blank line is an empty-text record and becomes unkeyed if
that column is selected as the key. A quoted empty value is a parsed empty-text field.

Review pages sort by the component key values under the engine's default string
ordering. Unkeyed records appear in source order. A page is bounded to 50 results.
Ambiguous evidence includes at most 50 source records, sampled from both sides when
both have members. It includes the full member total and an explicit truncation flag.

## Export interpretation

Summary JSON contains the complete category counts, schema changes, policies, source
hashes, and runtime method information. It contains no raw row values or original filenames.

Selected-row JSON includes cell values and source ordinals. Each cell distinguishes an
absent field, null, and text. Ambiguous-group JSON contains member records rather than
a paired comparison, and states whether the member list is partial.
