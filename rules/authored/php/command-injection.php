<?php
$host = $_GET['host'];
// ruleid: radr.php.command-injection
system("ping -c 1 " . $host);
// ruleid: radr.php.command-injection
$out = shell_exec("nslookup " . $_REQUEST['d']);
// ok: radr.php.command-injection
system("ping -c 1 " . escapeshellarg($host));
// ok: radr.php.command-injection
exec("uptime");
