# School History Mobile UI

Implemented mobile-first School History display in `web/Schools.jsx`.

## Decision
- Removed the Contacts dropdown because it adds interaction without solving the layout problem.
- Contacts are now always visible as compact two-column rows with optional Call action.
- All history fields use a responsive label/value grid.
- Mobile labels get 48% width and values get 52% width.
- Desktop keeps the wider fixed label column.
- Numeric values are kept on one line and right-aligned with tabular numerals.
- Long names/text wrap inside the value column instead of pushing the page horizontally.
- Card padding and section spacing are reduced on phones.

This avoids hidden information and keeps the mobile view scannable without an unnecessary dropdown.
