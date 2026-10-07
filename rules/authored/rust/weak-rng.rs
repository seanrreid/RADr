fn token() -> u64 {
    // ruleid: radr.rust.weak-rng
    let mut r = StdRng::seed_from_u64(42);
    // ruleid: radr.rust.weak-rng
    let mut s = SmallRng::from_entropy();
    // ok: radr.rust.weak-rng
    let mut o = rand::rngs::OsRng;
    r.gen()
}
