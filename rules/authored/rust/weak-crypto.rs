fn digests(data: &[u8]) {
    // ruleid: radr.rust.weak-crypto
    let h = md5::compute(data);
    // ruleid: radr.rust.weak-crypto
    let mut s = Sha1::new();
    // ruleid: radr.rust.weak-crypto
    let c = Cipher::aes_128_ecb();
    // ok: radr.rust.weak-crypto
    let g = Sha256::new();
    // ok: radr.rust.weak-crypto
    let a = Cipher::aes_256_gcm();
}
