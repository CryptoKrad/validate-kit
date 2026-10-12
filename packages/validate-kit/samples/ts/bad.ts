// Intentionally bad fixture — each line trips a specific custom rule.
export function compare(a: any, b: any): boolean {
  console.log("comparing", a, b);
  return a == b;
}
