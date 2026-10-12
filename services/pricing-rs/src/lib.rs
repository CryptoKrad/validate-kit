//! Tiny pricing crate — a dogfood fixture for validate-kit's Rust layer.

/// Apply a percentage discount to a price.
pub fn discount(price: f64, pct: f64) -> f64 {
    price * (1.0 - pct / 100.0)
}

/// Parse a price string into a float.
///
/// NOTE: the `.unwrap()` below intentionally trips the custom rule
/// `rust-no-unwrap` so the dogfood fixtures prove the rule fires on real code.
pub fn parse_price(s: &str) -> f64 {
    s.parse::<f64>().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discount_halves() {
        assert!((discount(100.0, 50.0) - 50.0).abs() < f64::EPSILON);
    }
}
