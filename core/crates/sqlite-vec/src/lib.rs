//! Bundled [sqlite-vec](https://github.com/asg017/sqlite-vec) v0.1.9.
//!
//! sqlite-vec is a SQLite extension that adds a `vec0` virtual table for
//! approximate nearest-neighbour vector search. This crate vendors the
//! amalgamation source because the upstream crates.io package (alpha.3) was
//! published without the required generated C headers.
//!
//! # Usage with rusqlite
//!
//! ```no_run
//! let conn = rusqlite::Connection::open_in_memory().unwrap();
//! unsafe { sqlite_vec::load(&conn).unwrap(); }
//! // vec0 virtual tables are now available.
//! ```

use std::ffi::c_void;

unsafe extern "C" {
    /// SQLite extension entry point compiled in `SQLITE_CORE` mode.
    ///
    /// Registers all sqlite-vec functions and virtual-table modules into `db`.
    /// Returns `SQLITE_OK` (0) on success.
    pub fn sqlite3_vec_init(
        db:      *mut c_void,
        err_msg: *mut *mut std::ffi::c_char,
        api:     *const c_void,
    ) -> std::ffi::c_int;
}

/// Load the sqlite-vec extension into an open rusqlite connection.
///
/// # Safety
/// `conn` must be an open, valid connection. This calls into C code.
pub unsafe fn load(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    // SAFETY: conn.handle() returns a valid SQLite database pointer, guaranteed by
    // rusqlite's safety contract. The sqlite3_vec_init call requires an unsafe block
    // because it's an FFI function that takes raw pointers.
    let rc = unsafe {
        sqlite3_vec_init(
            conn.handle() as *mut c_void,
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rc),
            Some(format!("sqlite3_vec_init returned {rc}")),
        ))
    }
}
