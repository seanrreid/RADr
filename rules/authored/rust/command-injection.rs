use std::process::Command;
use axum::extract::Query;

async fn ping(Query(q): Query<Params>) -> String {
    let out = Command::new("sh")
        .arg("-c")
        // ruleid: radr.rust.command-injection
        .arg(format!("ping -c 1 {}", q.host))
        .output()
        .unwrap();
    // ruleid: radr.rust.command-injection
    let o2 = Command::new(q.program.clone()).output();
    // ok: radr.rust.command-injection
    let o3 = Command::new("ping").arg("-c").arg("1").arg(&q.host).output();
    String::new()
}
