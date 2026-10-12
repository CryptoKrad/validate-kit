module spec {
  var x: int
  action init = x' = 0
  action step = x' = x
  val safety = x == 0
}
