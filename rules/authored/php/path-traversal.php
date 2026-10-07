<?php
$f = $_GET['file'];
// ruleid: radr.php.path-traversal
readfile('/var/data/' . $f);
// ruleid: radr.php.path-traversal
$h = fopen($_POST['path'], 'r');
// ok: radr.php.path-traversal
readfile('/var/data/' . basename($f));
// ok: radr.php.path-traversal
readfile('/var/data/report.txt');
