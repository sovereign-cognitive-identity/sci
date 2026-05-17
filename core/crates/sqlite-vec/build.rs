fn main() {
    let mut build = cc::Build::new();
    build.file("sqlite-vec.c").define("SQLITE_CORE", None);

    // When rusqlite is built with `bundled`, its build script exports the
    // path to the SQLite headers as DEP_SQLITE3_INCLUDE. Use that so we
    // compile against the exact same sqlite3.h as the rest of the binary.
    if let Ok(inc) = std::env::var("DEP_SQLITE3_INCLUDE") {
        build.include(&inc);
    }

    build.compile("sqlite_vec0");

    // Expose the crate directory as DEP_SQLITE_VEC0_INCLUDE so dependents
    // can find sqlite-vec.h if they need the C headers directly.
    println!(
        "cargo:include={}",
        std::env::var("CARGO_MANIFEST_DIR").unwrap()
    );
}
