use std::fs::File;
use std::path::Path;
use axum::extract::Path as AxPath;
use actix_web::web;

async fn read(web::Path(name): web::Path<String>) -> String {
    // ruleid: radr.rust.path-traversal
    std::fs::read_to_string(format!("/srv/files/{}", name)).unwrap()
}

async fn open(q: web::Query<Params>) -> String {
    let base = Path::new("/srv/files");
    // ruleid: radr.rust.path-traversal
    let p = base.join(&q.file);
    // ok: radr.rust.path-traversal
    let f = File::open("/srv/files/terms.txt").unwrap();
    String::new()
}
