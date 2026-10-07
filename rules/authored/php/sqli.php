<?php
function find($conn, $pdo, $request) {
    $id = $_GET['id'];
    // ruleid: radr.php.sqli
    mysqli_query($conn, "SELECT * FROM users WHERE id = " . $id);
    // ruleid: radr.php.sqli
    $pdo->query("SELECT * FROM users WHERE name = '" . $_POST['name'] . "'");
    // ruleid: radr.php.sqli
    $rows = DB::select("SELECT * FROM t WHERE x = " . $request->input('x'));
    // ok: radr.php.sqli
    mysqli_query($conn, "SELECT * FROM users WHERE id = " . intval($_GET['id']));
    // ok: radr.php.sqli
    $stmt = $pdo->prepare("SELECT * FROM users WHERE id = ?");
    $stmt->execute([$id]);
    // ok: radr.php.sqli
    $pdo->query("SELECT count(*) FROM users");
}
