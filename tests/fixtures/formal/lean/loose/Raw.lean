-- A raw string ending in a backslash, and a quote as a character: the
-- #eval after each must still be seen.
def p := r"C:\"
#eval IO.println "after raw"
def q : Char × Nat := ⟨'"', 1⟩
#eval IO.println "after char"
