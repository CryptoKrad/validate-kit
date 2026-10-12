module frozen {
  var x: int
  action init = x' = 0
  action step = all { x < 0, x' = x }
  val safety = x == 0
}
