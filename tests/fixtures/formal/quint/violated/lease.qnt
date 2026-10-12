module lease {
  var holders: int
  action init = holders' = 0
  action acquire = holders' = holders + 1
  action release = all { holders > 0, holders' = holders - 1 }
  action step = any { acquire, release }
  // Two workers must never hold the lease at once.
  val atMostOne = holders <= 1
}
