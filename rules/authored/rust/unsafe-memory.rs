fn audit(v: &mut Vec<u8>, p: *const u8, n: usize) -> u32 {
    unsafe {
        // ruleid: radr.rust.unsafe-memory
        v.set_len(n);
        // ruleid: radr.rust.unsafe-memory
        let s = std::slice::from_raw_parts(p, n);
        // ruleid: radr.rust.unsafe-memory
        let x: u32 = std::mem::transmute([s[0], s[1], s[2], s[3]]);
        x
    }
}

fn safe(v: &[u8]) -> Option<u8> {
    // ok: radr.rust.unsafe-memory
    v.get(0).copied()
}
