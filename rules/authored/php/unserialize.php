<?php
// ruleid: radr.php.unserialize
$prefs = unserialize($_COOKIE['prefs']);
$raw = base64_decode($_POST['state']);
// ruleid: radr.php.unserialize
$state = unserialize($raw);
// ok: radr.php.unserialize
$prefs = json_decode($_COOKIE['prefs'], true);
// ok: radr.php.unserialize
$x = unserialize(file_get_contents('/var/cache/app.ser'));
