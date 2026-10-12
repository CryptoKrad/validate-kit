-- Axioms with long names: Lean wraps the #print axioms list over several lines.
axiom firstAllowedAxiomWithAQuiteLongName : True
axiom secondAllowedAxiomWithAQuiteLongName : True
axiom thirdAllowedAxiomWithAQuiteLongName : True
axiom fourthAllowedAxiomWithAQuiteLongName : True
theorem many : True ∧ True ∧ True ∧ True :=
  ⟨firstAllowedAxiomWithAQuiteLongName, secondAllowedAxiomWithAQuiteLongName,
    thirdAllowedAxiomWithAQuiteLongName, fourthAllowedAxiomWithAQuiteLongName⟩
