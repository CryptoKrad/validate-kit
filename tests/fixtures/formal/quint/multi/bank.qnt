module bank {
  var balance: int
  action init = balance' = 0
  action step = balance' = balance + 1
  val inv = balance >= 0
}

module bankTests {
  import bank.*
  run depositTest = init.then(step).expect(balance == 5)
}
