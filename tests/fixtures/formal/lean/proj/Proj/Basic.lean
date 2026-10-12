-- An axiom the audit must report, and a theorem that needs none.
axiom bad : False
theorem uses : 1 = 2 := bad.elim
theorem clean : 1 + 1 = 2 := rfl
