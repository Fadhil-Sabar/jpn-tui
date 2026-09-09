# Dictionary data notice

`data/jmdict.sqlite` is not covered by the application's MIT license. It is a transformed/derived JMdict work distributed under the **Creative Commons Attribution-ShareAlike 4.0 International license (CC BY-SA 4.0)**.

## Attribution and source

JMdict is provided by the [Electronic Dictionary Research and Development Group (EDRDG)](https://www.edrdg.org/) and was initiated by Jim Breen. This database was built from the [`scriptin/jmdict-simplified`](https://github.com/scriptin/jmdict-simplified) project:

- Release/tag: `3.6.2+20260907165411`
- Exact archive: <https://github.com/scriptin/jmdict-simplified/releases/download/3.6.2%2B20260907165411/jmdict-eng-3.6.2%2B20260907165411.json.tgz>
- Archive SHA-256: `c9e7f99a21d6974a38d6b917f6a3fafa1890e2f316c1402fe780e552b398a52d`
- Transformation date: 2026-09-08

## Modifications

The source definitions/glosses were removed. Readings and written forms, together with common/priority, restriction, usually-kana, and source-order information used to derive rank metadata, were selected and transformed into deterministic SQLite tables and an index. The resulting database contains no definitions.

The data is licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). A local copy of the full legal code is included at [`LICENSE-CC-BY-SA-4.0.txt`](LICENSE-CC-BY-SA-4.0.txt). Attribution and ShareAlike requirements apply when redistributing this database or adaptations of it.
