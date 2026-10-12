---- MODULE Counter ----
\* A line comment holding (* must not hide the EXTENDS below.
EXTENDS Naturals, CounterBounds
VARIABLE x
Init == x = 0
Next == x' = (x + 1) % Limit
Inv == x < Limit
(* A block comment (* nested *) EXTENDS Ghost *)
====
