// benchmarks/src/bin/harness.rs
// CLI for running benchmark via Rust

use sci_benchmarks::measure_round_trip;
use std::io::{self, BufRead};

fn main() {
    let stdin = io::stdin();
    let mut handle = stdin.lock();
    let mut line = String::new();

    while handle.read_line(&mut line).unwrap() > 0 {
        let text = line.trim();

        if text.is_empty() {
            line.clear();
            continue;
        }

        let result = measure_round_trip(text);
        println!("{}", serde_json::to_string(&result).unwrap());

        line.clear();
    }
}
