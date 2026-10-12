module div {
  var x: int
  action init = x' = 0
  action step = x' = x + 10 / (3 - x)
  val inv = x >= 0
}
