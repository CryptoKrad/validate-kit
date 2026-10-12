---- MODULE Main ----
EXTENDS Naturals, Part
VARIABLE x
Init == x = 0
Next == x' = (x + 1) % 3
Inv == x < 3
====
