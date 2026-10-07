use bincode::Options;

fn decode(bytes: &[u8]) -> Msg {
    // ruleid: radr.rust.unbounded-deserialization
    let a: Msg = bincode::deserialize(bytes).unwrap();
    // ruleid: radr.rust.unbounded-deserialization
    let b: Msg = bincode::options().with_big_endian().deserialize(bytes).unwrap();
    // ok: radr.rust.unbounded-deserialization
    let c: Msg = bincode::options().with_limit(1 << 20).deserialize(bytes).unwrap();
    c
}
