---- MODULE Lease ----
EXTENDS Naturals
VARIABLE holders
Init == holders = 0
Acquire == holders' = holders + 1
Release == holders > 0 /\ holders' = holders - 1
Next == Acquire \/ Release
\* Keeps the state space finite for the model checker.
Small == holders < 3
\* Two workers must never hold the lease at once.
AtMostOne == holders <= 1
====
