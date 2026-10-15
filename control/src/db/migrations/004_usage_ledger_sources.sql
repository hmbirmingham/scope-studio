-- Which plug-ins supplied the context for an answer (e.g. {github},
-- {kicad,zotero}). Plug-in names, never content: enough to measure what each
-- plug-in costs per answer, which is the number every new plug-in is judged on.
ALTER TABLE usage_ledger ADD COLUMN sources TEXT[] NOT NULL DEFAULT '{}';
