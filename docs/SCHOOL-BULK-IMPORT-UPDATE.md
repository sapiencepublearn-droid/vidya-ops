# School Bulk Import Update

The Admin Schools screen now supports selecting multiple `.xlsx` workbooks at once.

The importer recognizes the supplied School History form even when school/location
are in merged/title rows, including `LOCATION: MADAMBAKKAM` and split cells such as
`LOCATION:` followed by `Madambakkam`.

For workbooks containing several sheets, each usable School History sheet is considered;
blank/template sheets and placeholder names such as `School_name` and `FRANCIS` are ignored.

For an existing school, the importer updates the school master contact/location-zone details
without changing its active/inactive state or coordinates, then replaces only the stored
School History JSON. For a new school it creates an active School Master record with no guessed
coordinates and stores the imported history. Coordinates must be confirmed separately before
school GPS check-in can be used.
