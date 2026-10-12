module tests {
  var x: int
  action init = x' = 0
  action step = x' = x + 1
  run passingTest = init.then(step).expect(x == 1)
  run failingTest = init.then(step).expect(x == 5)
}
