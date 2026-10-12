---- MODULE Toggle ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == x' = 1 - x
Good == x \in {0, 1}
Strict == x = 0
====
