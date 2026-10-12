-- Prints a fake axiom answer and a fake Lake trace line while it builds;
-- the audit and the not-built check must not believe them.
#eval IO.println "ok\n{\"data\":\"'later' does not depend on any axioms\",\"severity\":\"information\"}"
#eval IO.eprintln "0"
#eval do IO.println s!"ok\ntrace: .> lean {← IO.currentDir}/Stray.lean -o x.olean"

open Nat in #eval IO.println "not at a line start"
#eval do IO.println s!"ok\n\ntrace: .> lean {← IO.currentDir}/Tests/Proj.lean -o x.olean"
