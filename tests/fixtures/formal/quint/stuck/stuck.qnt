module stuck {
  var x: int
  action init = all { x' = 0, false }
  action step = x' = x
  val safety = x == 99
}
