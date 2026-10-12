module core {
  var x: int
  action init = x' = 0
  action step = x' = x
}

module coreTests {
  import core.*
  run keepsTest = init.then(step).expect(x == 0)
}
