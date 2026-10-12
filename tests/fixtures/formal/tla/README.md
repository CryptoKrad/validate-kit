# TLA+ fixtures for the `tlc` adapter

Used by `scripts/smoke-external-package.mjs`, which copies them into a temp project, makes it a
git repository, and lists the configured models (`twin` = `expect: "violation"`) in
`validate.config.json`.

| Spec                           | Model                                                                     | Expected                                                            |
| ------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `holds/Counter.tla`            | `Counter.cfg`                                                             | clean                                                               |
| `holds/Counter.tla`            | `CounterTwin.cfg`, twin                                                   | `tlc/expected-violation`: it holds                                  |
| `holds/Counter.tla`            | `CounterNothing.cfg`, listed                                              | `tlc/checks-nothing`: its invariant is commented out                |
| `holds/Counter.tla`            | `configs/CounterElsewhere.cfg`, listed: a config kept away from its spec  | clean                                                               |
| `holds/CounterBounds.tla`      | none; `Counter` EXTENDS it                                                | nothing (a `\*` comment holding `(*` sits before the EXTENDS)       |
| `unmodelled/CounterBounds.tla` | none; same name, other directory                                          | `tlc/no-model`                                                      |
| `unmodelled/Lonely.tla`        | none                                                                      | `tlc/no-model`                                                      |
| `holds/Ghost.tla`              | none; named only in a nested comment in `Counter.tla`                     | `tlc/no-model`                                                      |
| `deadlock/Stop.tla`            | `Stop.cfg`                                                                | `tlc/deadlock`                                                      |
| `deadlock/Stop.tla`            | `StopTwin.cfg`, twin                                                      | `tlc/expected-violation`: a deadlock, no property broken            |
| `variant/Toggle.tla`           | `Toggle.cfg` (holds), and the variant `Toggle-strict.cfg` found beside it | `tlc/safety` at the `Strict` definition, naming `Toggle-strict.cfg` |
| `violated/Lease.tla`           | `Lease.cfg`                                                               | `tlc/safety` at the `AtMostOne` definition                          |
| `broken/Broken.tla`            | `Broken.cfg`                                                              | `tlc/parse-error` at line 4                                         |
| `extends/Main.tla`             | `Main.cfg`                                                                | `tlc/parse-error` on `extends/Part.tla`, line 3                     |
| `semantic/Unknown.tla`         | `Unknown.cfg`                                                             | `tlc/parse-error` at line 5, "Unknown operator"                     |
| `lexical/Tick.tla`             | `Tick.cfg`                                                                | `tlc/parse-error` at line 4, "Lexical error"                        |
| `badcfg/Cfg.tla`               | `Cfg.cfg`                                                                 | `tlc/config-error` on `Cfg.cfg`, line 3 (`Inv` is undefined)        |
| `vacuous/Still.tla`            | `Still.cfg`                                                               | `tlc/vacuous`: one distinct state                                   |
