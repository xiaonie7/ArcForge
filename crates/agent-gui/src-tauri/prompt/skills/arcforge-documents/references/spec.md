# ArcForge DOCX Specification

The `spec_path` file is a UTF-8 JSON document interpreted by ArcForge as an atomic Office batch. It is data, not a command line. The top-level value must be an array of operation objects. Keep the specification in the workspace.

```json
[
  {
    "command": "add",
    "parent": "/body",
    "type": "paragraph",
    "props": {
      "text": "Project report",
      "style": "Heading1"
    }
  },
  {
    "command": "add",
    "parent": "/body",
    "type": "paragraph",
    "props": {
      "text": "Summary text goes here."
    }
  }
]
```

## Operations

The first implementation accepts only these `command` names:

- `add`: add a paragraph, table, row, cell, break, header, footer, or other explicitly supported safe DOCX element under `parent`.
- `set`: update approved properties such as `text`, `style`, `bold`, `italic`, `font`, `size`, `color`, `alignment`, `direction`, or table cell properties at `path`.
- `remove`: remove the element at `path`.
- `move`: move the element at `path` to an approved `parent`, optionally using `index`.
- `swap`: exchange two approved document paths using `path` and `to`.
- `get` and `query`: read a bounded node or selector during a batch when the provider supports it; they do not grant arbitrary file access.

All paths are Office document paths such as `/body`, `/body/p[1]`, `/body/tbl[1]`, or `/body/tbl[1]/tr[1]/tc[1]`. Use `OfficeRuntime` inspection output to learn a path before patching an existing document. Positional paths can change after insertion; prefer stable identifiers when the inspection output provides one.

Use the `command` spelling shown above (the provider also accepts `op` as a compatibility alias). `props` must be a JSON object of scalar values or bounded arrays. Keep individual text values and the operation count reasonable for the requested document. External image, media, OLE, template, and other asset references are intentionally blocked in this first provider release. Do not embed arbitrary XML.

## Action contracts

- `create` requires a `.docx` `output_path`; it creates a new blank document. Apply content with a subsequent `patch` using a batch specification.
- `patch` requires a `.docx` `input_path`, `spec_path`, and a `.docx` `output_path`; it leaves the input untouched and applies operations atomically to the output.
- `inspect` and `validate` require a `.docx` `input_path`, do not use `spec_path` or `output_path`, and do not modify the file.
- `render` requires a `.docx` `input_path` and an `.html` or `.png` `output_path`; it does not modify the DOCX.

The ArcForge tool enforces workspace paths, bounded timeouts, and overwrite policy. A specification cannot relax those controls.
