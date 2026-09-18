# Original offline-import fixtures

`frame.json` is newly authored synthetic data in the documented REST nodes
envelope shape. It is not exported from Figma or based on Albums Pivot content.
Tests derive malformed, missing-resource, advanced paint, mixed-text and
unsupported-node cases from it. The declared version is synthetic metadata,
not a REST capture.

Font declaration tests reuse the foundation fixture's explicitly declared
ABeeZee face. The importer neither reads that font file nor substitutes it for
a real source font. No confidential JSON, PNG, design labels, or source assets
belong in this directory.
