# SpreadsheetCode API

Use `SpreadsheetCode` only when `OfficeRuntime` JSON create or patch operations cannot express the requested workbook transformation. The script is a reviewable workspace artifact and runs inside ArcForge's bundled sidecar, not system Python.

## Tool arguments

- `script_path` (required): workspace `.py` file.
- `input_path` (optional): existing workspace `.xlsx`; omit to receive a new workbook with one default worksheet.
- `output_path` (required): workspace `.xlsx` destination.
- `force` (optional): overwrite only after explicit approval for that exact path.
- `timeout_seconds` (optional): 1 through 600; default 180.

## Script surface

The runtime injects these names:

- Workbook object: `workbook` (canonical). The runtime also exposes `wb` only as a compatibility alias for older scripts.
- Styles: `Alignment`, `Border`, `Font`, `GradientFill`, `NamedStyle`, `PatternFill`, `Protection`, `Side`
- Charts: `AreaChart`, `BarChart`, `LineChart`, `PieChart`, `Reference`
- Worksheet helpers: `Comment`, `Table`, `TableStyleInfo`, `get_column_letter`
- Values: `Decimal`, `date`, `datetime`, `timedelta`, `copy`
- Safe builtins: `abs`, `all`, `any`, `bool`, `dict`, `enumerate`, `float`, `int`, `isinstance`, `len`, `list`, `max`, `min`, `range`, `reversed`, `round`, `set`, `sorted`, `str`, `sum`, `tuple`, `zip`, and common exception classes.

Always generate new scripts with `workbook`; never introduce `wb` in new code. The `wb` alias is runtime-only backward compatibility. Use normal openpyxl workbook and worksheet methods through `workbook`, and do not import openpyxl.

## Example: create a workbook

```python
sheet = workbook.active
sheet.title = "Summary"
sheet.append(["Month", "Revenue", "Cost", "Profit"])

rows = [
    ["Jan", 120000, 76000],
    ["Feb", 135000, 81000],
    ["Mar", 148000, 87000],
]
for row_index, row in enumerate(rows, start=2):
    sheet.append(row)
    sheet.cell(row=row_index, column=4, value=f"=B{row_index}-C{row_index}")

for cell in sheet[1]:
    cell.font = Font(bold=True, color="FFFFFF")
    cell.fill = PatternFill("solid", fgColor="0F172A")
sheet.freeze_panes = "A2"
sheet.column_dimensions["A"].width = 14
for column in ("B", "C", "D"):
    sheet.column_dimensions[column].width = 16
    for cell in sheet[column][1:]:
        cell.number_format = '#,##0'

chart = BarChart()
chart.title = "Quarter performance"
chart.add_data(Reference(sheet, min_col=2, max_col=4, min_row=1, max_row=4), titles_from_data=True)
chart.set_categories(Reference(sheet, min_col=1, min_row=2, max_row=4))
sheet.add_chart(chart, "F2")
```

## Example: modify an inspected workbook

```python
sheet = workbook["Orders"]
profit_column = sheet.max_column + 1
sheet.cell(row=1, column=profit_column, value="Profit")
for row in range(2, sheet.max_row + 1):
    sheet.cell(row=row, column=profit_column, value=f"=E{row}-F{row}")
sheet.freeze_panes = "A2"
```

## Enforcement and evidence

ArcForge rejects imports, dynamic evaluation, dangerous builtins, private names or attributes, rebinding injected names, and direct workbook `save` or `close` access. It also limits source size, AST size, `range()` length, runtime duration, captured output, and all input, script, and output paths to the workspace.

The runtime loads or creates the workbook, validates and executes the script, saves atomically, reopens the result, and returns structural inspection evidence plus the script path, SHA-256 digest, byte size, and AST node count. Formulas are stored but not calculated by openpyxl; Excel or another spreadsheet application calculates their displayed values.
