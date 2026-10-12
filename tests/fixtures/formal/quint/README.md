# Quint fixtures for the `quint` adapter

Used by `scripts/smoke-external-package.mjs`, which copies them into a temp project, makes it a
git repository, and lists invariants (and one `main`) for seven specs (`maxSamples` 200).

| Spec                   | Configured                                        | Expected                                                    |
| ---------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| `good/counter.qnt`     | invariant `inv`; a test                           | nothing                                                     |
| `good/helpers.qnt`     | imported by `counter`                             | nothing                                                     |
| `good/plain.qnt`       | imported by `counter` as `"plain"` (no `./`)      | nothing                                                     |
| `testfail/tests.qnt`   | two tests, one failing                            | `quint/test-failed` at line 6                               |
| `violated/lease.qnt`   | invariant `atMostOne`                             | `quint/invariant` at line 8                                 |
| `broken/broken.qnt`    | none                                              | `quint/error` at line 4 (parse)                             |
| `typed/typed.qnt`      | none                                              | `quint/error` at line 3 (type)                              |
| `stuck/stuck.qnt`      | invariant `safety`                                | `quint/vacuous`: `init` cannot hold                         |
| `frozen/frozen.qnt`    | invariant `safety`                                | `quint/vacuous`: `step` never fires                         |
| `unchecked/lonely.qnt` | none                                              | `quint/unchecked`                                           |
| `missinginv/spec.qnt`  | invariant `nope`                                  | `quint/config-error`                                        |
| `multi/bank.qnt`       | modules `bank` and `bankTests`, `main: bankTests` | `quint/test-failed` at line 10                              |
| `twomods/two.qnt`      | two modules, no `main`                            | `quint/config-error`, and Quint's `QNT405` as `quint/error` |
| `divzero/div.qnt`      | invariant `inv`; `step` divides by zero           | `quint/error` at line 4, column 26                          |
