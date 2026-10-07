fn clients() {
    // ruleid: radr.rust.tls-verification-disabled
    let c = reqwest::Client::builder().danger_accept_invalid_certs(true).build();
    let mut b = SslConnector::builder(SslMethod::tls()).unwrap();
    // ruleid: radr.rust.tls-verification-disabled
    b.set_verify(SslVerifyMode::NONE);
    // ok: radr.rust.tls-verification-disabled
    let d = reqwest::Client::builder().danger_accept_invalid_certs(false).build();
}
