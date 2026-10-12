---- MODULE Stop ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
\* Stops at 2: no successor state, which TLC reports as a deadlock.
Next == x < 2 /\ x' = x + 1
Inv == x <= 2
====
