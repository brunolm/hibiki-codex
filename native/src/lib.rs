#![deny(clippy::all)]

use napi_derive::napi;

#[napi]
pub fn hello(name: String) -> String {
    format!("Hello, {}! Greetings from Rust.", name)
}

/// Approximate π using the Leibniz series. Pure CPU work — useful for
/// confirming the call really runs in native code.
#[napi]
pub fn compute_pi(iterations: u32) -> f64 {
    let mut sum = 0.0_f64;
    for k in 0..iterations {
        let term = 1.0 / (2.0 * k as f64 + 1.0);
        if k % 2 == 0 {
            sum += term;
        } else {
            sum -= term;
        }
    }
    sum * 4.0
}
