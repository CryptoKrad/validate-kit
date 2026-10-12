module counter {
  import helpers.* from "./helpers"
  import plain.* from "plain"
  var x: int
  action init = x' = 0
  action step = x' = wrap(x + 1)
  val inv = x < limit
  run stepsTest = init.then(step).then(step).expect(x == 2)
}
