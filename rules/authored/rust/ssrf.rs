use axum::extract::Query;

async fn preview(Query(q): Query<Params>) -> String {
    // ruleid: radr.rust.ssrf
    let body = reqwest::get(&q.url).await.unwrap().text().await.unwrap();
    let client = reqwest::Client::new();
    // ruleid: radr.rust.ssrf
    let r = client.get(format!("{}/api", q.host)).send().await;
    // ok: radr.rust.ssrf
    let s = reqwest::get("https://api.example.com/status").await;
    body
}
