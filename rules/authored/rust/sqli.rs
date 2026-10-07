async fn find(pool: &PgPool, name: &str) -> Result<Vec<User>, sqlx::Error> {
    // ruleid: radr.rust.sqli
    let rows = sqlx::query(&format!("SELECT * FROM users WHERE name = '{}'", name)).fetch_all(pool).await?;
    // ruleid: radr.rust.sqli
    conn.execute(&format!("DELETE FROM t WHERE id = {}", id), [])?;
    // ok: radr.rust.sqli
    let ok = sqlx::query("SELECT * FROM users WHERE name = $1").bind(name).fetch_all(pool).await?;
    // ok: radr.rust.sqli
    let msg = format!("found {}", name);
    Ok(vec![])
}
