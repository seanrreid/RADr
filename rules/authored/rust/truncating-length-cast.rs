fn frame(payload: &[u8], out: &mut Vec<u8>) {
    // ruleid: radr.rust.truncating-length-cast
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    // ruleid: radr.rust.truncating-length-cast
    let n = (payload.len() + 4) as u16;
    // ok: radr.rust.truncating-length-cast
    let m = payload.len() as u64;
    // ok: radr.rust.truncating-length-cast
    let k = u32::try_from(payload.len()).unwrap();
}
